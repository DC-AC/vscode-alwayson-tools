import * as sql from 'mssql';
import { ConnectionProfile, buildSqlConfig } from './connection';

export interface ServerInfo {
  productVersion: string;
  majorVersion: number;
  isHadrEnabled: boolean;
}

export interface RoutingListEntry {
  replicaServerName: string;
  /** 255 means "not in the routing list"; lower numbers are the priority order. */
  routingPriority: number;
}

/** Quote a string literal for inline use in T-SQL (doubling single quotes). */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Minimal query surface the AlwaysOn logic needs. Implemented either by a
 * tedious connection pool (our own connection) or by the Microsoft SQL Server
 * extension's shared connection.
 */
export interface Executor {
  readonly connected: boolean;
  /** Run a query and return the rows as plain objects keyed by column name. */
  rows(tsql: string): Promise<Record<string, unknown>[]>;
  /** Run a statement batch with no result set. */
  exec(tsql: string): Promise<void>;
  /** Release the connection if this executor owns it. */
  close(): Promise<void>;
}

class TediousExecutor implements Executor {
  constructor(private readonly pool: sql.ConnectionPool) {}
  get connected(): boolean {
    return this.pool.connected;
  }
  async rows(tsql: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.request().query(tsql);
    return (result.recordset ?? []) as Record<string, unknown>[];
  }
  async exec(tsql: string): Promise<void> {
    await this.pool.request().batch(tsql);
  }
  async close(): Promise<void> {
    try {
      await this.pool.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Adapter over an externally-owned connection (the mssql extension's shared
 * connection). The owning extension manages its lifetime, so close() is a no-op.
 */
export interface SharedConnection {
  isConnected(): boolean;
  rows(tsql: string): Promise<Record<string, unknown>[]>;
  exec(tsql: string): Promise<void>;
}

class SharedExecutor implements Executor {
  constructor(private readonly shared: SharedConnection) {}
  get connected(): boolean {
    return this.shared.isConnected();
  }
  rows(tsql: string): Promise<Record<string, unknown>[]> {
    return this.shared.rows(tsql);
  }
  exec(tsql: string): Promise<void> {
    return this.shared.exec(tsql);
  }
  async close(): Promise<void> {
    /* connection owned by the mssql extension */
  }
}

/**
 * Manages an Executor per server profile and exposes the AlwaysOn queries the
 * original tool ran against the sys.availability_* DMVs.
 */
export class SqlClient {
  private executors = new Map<string, Executor>();

  /** Open (or reuse) our own tedious connection for a profile. */
  async connect(profile: ConnectionProfile, password?: string): Promise<void> {
    const existing = this.executors.get(profile.id);
    if (existing && existing.connected) {
      return;
    }
    if (existing) {
      await existing.close();
      this.executors.delete(profile.id);
    }
    const pool = new sql.ConnectionPool(buildSqlConfig(profile, password));
    await pool.connect();
    this.executors.set(profile.id, new TediousExecutor(pool));
  }

  /** Register a connection owned by the mssql extension under a profile id. */
  registerShared(profileId: string, shared: SharedConnection): void {
    const existing = this.executors.get(profileId);
    if (existing) {
      void existing.close();
    }
    this.executors.set(profileId, new SharedExecutor(shared));
  }

  isConnected(profileId: string): boolean {
    const e = this.executors.get(profileId);
    return !!e && e.connected;
  }

  async disconnect(profileId: string): Promise<void> {
    const e = this.executors.get(profileId);
    if (e) {
      await e.close();
      this.executors.delete(profileId);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const id of Array.from(this.executors.keys())) {
      await this.disconnect(id);
    }
  }

  private executor(profileId: string): Executor {
    const e = this.executors.get(profileId);
    if (!e || !e.connected) {
      throw new Error('Not connected to this server. Use Reconnect.');
    }
    return e;
  }

  /**
   * Validate the instance is SQL 2012+ with HADR enabled. Mirrors the checks
   * the WinForms Connection form performed on connect.
   */
  async getServerInfo(profileId: string): Promise<ServerInfo> {
    const rows = await this.executor(profileId).rows(
      "select cast(SERVERPROPERTY('ProductVersion') as varchar(64)) ProductVersion, " +
        "cast(SERVERPROPERTY('IsHadrEnabled') as int) IsHadrEnabled"
    );
    const row = rows[0] ?? {};
    const productVersion = String(row.ProductVersion ?? '');
    const majorVersion = parseInt(productVersion.split('.')[0] || '0', 10);
    return {
      productVersion,
      majorVersion,
      isHadrEnabled: Number(row.IsHadrEnabled) === 1
    };
  }

  /**
   * Availability groups for which the connected instance is currently the
   * PRIMARY replica. Read-only routing changes (ALTER AVAILABILITY GROUP ...
   * MODIFY REPLICA) must be run on the primary, so only those are listed.
   */
  async getAvailabilityGroups(profileId: string): Promise<string[]> {
    const rows = await this.executor(profileId).rows(`select ag.name
from sys.availability_groups ag
join sys.dm_hadr_availability_replica_states ars
  on ars.group_id = ag.group_id
where ars.is_local = 1
  and ars.role = 1
order by ag.name`);
    return rows.map((r) => String(r.name));
  }

  /** Replicas belonging to an availability group. */
  async getReplicas(profileId: string, agName: string): Promise<string[]> {
    const rows = await this.executor(profileId).rows(`select replica_server_name
from sys.availability_replicas
join sys.availability_groups on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = ${lit(agName)}
order by replica_server_name`);
    return rows.map((r) => String(r.replica_server_name));
  }

  /** The configured read-only routing URL for a replica (null if unset). */
  async getRoutingUrl(profileId: string, agName: string, replicaName: string): Promise<string | null> {
    const rows = await this.executor(profileId).rows(`select availability_replicas.read_only_routing_url
from sys.availability_replicas
join sys.availability_groups on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = ${lit(agName)}
and replica_server_name = ${lit(replicaName)}`);
    const row = rows[0];
    return row && row.read_only_routing_url != null ? String(row.read_only_routing_url) : null;
  }

  /**
   * The candidate routing list for a primary replica: every other replica in
   * the AG, with its current routing priority (255 = not currently routed to).
   * Ported from ReadOnlyRouting.Replica_SelectedIndexChanged.
   */
  async getRoutingList(profileId: string, agName: string, replicaName: string): Promise<RoutingListEntry[]> {
    const ag = lit(agName);
    const replica = lit(replicaName);

    let rows = await this.executor(profileId).rows(`select secondary.replica_server_name, routing_priority
from sys.availability_groups
inner join sys.availability_replicas on availability_replicas.group_id = availability_groups.group_id
left outer join sys.availability_read_only_routing_lists on availability_read_only_routing_lists.replica_id = availability_replicas.replica_id
left outer join sys.availability_replicas secondary on availability_read_only_routing_lists.read_only_replica_id = secondary.replica_id
where availability_groups.name = ${ag}
  and availability_replicas.replica_server_name = ${replica}
union all
select replica_server_name, 255
from sys.availability_replicas
join sys.availability_groups on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = ${ag}
  and replica_server_name not in (select secondary.replica_server_name
                from sys.availability_groups
                inner join sys.availability_replicas on availability_replicas.group_id = availability_groups.group_id
                left outer join sys.availability_read_only_routing_lists on availability_read_only_routing_lists.replica_id = availability_replicas.replica_id
                left outer join sys.availability_replicas secondary on availability_read_only_routing_lists.read_only_replica_id = secondary.replica_id
                where availability_groups.name = ${ag}
                  and availability_replicas.replica_server_name = ${replica})
  and replica_server_name <> ${replica}
order by 2, 1`);

    // If the only row is a NULL routing list, fall back to "all other replicas".
    if (rows.length === 1 && rows[0].replica_server_name == null) {
      rows = await this.executor(profileId).rows(`select replica_server_name, 255 as routing_priority
from sys.availability_groups
inner join sys.availability_replicas on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = ${ag}
  and availability_replicas.replica_server_name <> ${replica}
order by 2, 1`);
    }

    return rows
      .filter((r) => r.replica_server_name != null)
      .map((r) => ({
        replicaServerName: String(r.replica_server_name),
        routingPriority: Number(r.routing_priority)
      }));
  }

  /** Execute an arbitrary T-SQL batch (the generated ALTER statements). */
  async execute(profileId: string, tsql: string): Promise<void> {
    await this.executor(profileId).exec(tsql);
  }
}
