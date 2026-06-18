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

/**
 * Manages a connection pool per server profile and exposes the AlwaysOn
 * queries the original tool ran against sys.availability_* DMVs.
 */
export class SqlClient {
  private pools = new Map<string, sql.ConnectionPool>();

  /** Open (or reuse) a pool for a profile. Throws on failure. */
  async connect(profile: ConnectionProfile, password?: string): Promise<sql.ConnectionPool> {
    const existing = this.pools.get(profile.id);
    if (existing && existing.connected) {
      return existing;
    }
    if (existing) {
      try {
        await existing.close();
      } catch {
        /* ignore */
      }
      this.pools.delete(profile.id);
    }

    const config = buildSqlConfig(profile, password);
    const pool = new sql.ConnectionPool(config);
    await pool.connect();
    this.pools.set(profile.id, pool);
    return pool;
  }

  isConnected(profileId: string): boolean {
    const pool = this.pools.get(profileId);
    return !!pool && pool.connected;
  }

  async disconnect(profileId: string): Promise<void> {
    const pool = this.pools.get(profileId);
    if (pool) {
      try {
        await pool.close();
      } catch {
        /* ignore */
      }
      this.pools.delete(profileId);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const id of Array.from(this.pools.keys())) {
      await this.disconnect(id);
    }
  }

  private pool(profileId: string): sql.ConnectionPool {
    const pool = this.pools.get(profileId);
    if (!pool || !pool.connected) {
      throw new Error('Not connected to this server. Use Reconnect.');
    }
    return pool;
  }

  /**
   * Validate the instance is SQL 2012+ with HADR enabled. Mirrors the checks
   * the WinForms Connection form performed on connect.
   */
  async getServerInfo(profileId: string): Promise<ServerInfo> {
    const result = await this.pool(profileId).request().query(
      "select cast(SERVERPROPERTY('ProductVersion') as varchar(64)) ProductVersion, " +
        "cast(SERVERPROPERTY('IsHadrEnabled') as int) IsHadrEnabled"
    );
    const row = result.recordset[0];
    const productVersion: string = row.ProductVersion ?? '';
    const majorVersion = parseInt(productVersion.split('.')[0] || '0', 10);
    return {
      productVersion,
      majorVersion,
      isHadrEnabled: row.IsHadrEnabled === 1
    };
  }

  /** select name from sys.availability_groups */
  async getAvailabilityGroups(profileId: string): Promise<string[]> {
    const result = await this.pool(profileId)
      .request()
      .query('select name from sys.availability_groups order by name');
    return result.recordset.map((r) => r.name as string);
  }

  /** Replicas belonging to an availability group. */
  async getReplicas(profileId: string, agName: string): Promise<string[]> {
    const result = await this.pool(profileId)
      .request()
      .input('name', sql.VarChar(255), agName).query(`select replica_server_name
from sys.availability_replicas
join sys.availability_groups on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = @name
order by replica_server_name`);
    return result.recordset.map((r) => r.replica_server_name as string);
  }

  /** The configured read-only routing URL for a replica (null if unset). */
  async getRoutingUrl(profileId: string, agName: string, replicaName: string): Promise<string | null> {
    const result = await this.pool(profileId)
      .request()
      .input('name', sql.VarChar(255), agName)
      .input('replica_server_name', sql.VarChar(255), replicaName).query(`select availability_replicas.read_only_routing_url
from sys.availability_replicas
join sys.availability_groups on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = @name
and replica_server_name = @replica_server_name`);
    const row = result.recordset[0];
    return row && row.read_only_routing_url != null ? (row.read_only_routing_url as string) : null;
  }

  /**
   * The candidate routing list for a primary replica: every other replica in
   * the AG, with its current routing priority (255 = not currently routed to).
   * Ported from ReadOnlyRouting.Replica_SelectedIndexChanged.
   */
  async getRoutingList(profileId: string, agName: string, replicaName: string): Promise<RoutingListEntry[]> {
    const request = this.pool(profileId)
      .request()
      .input('name', sql.VarChar(255), agName)
      .input('replica_name', sql.VarChar(255), replicaName);

    const result = await request.query(`select secondary.replica_server_name, routing_priority
from sys.availability_groups
inner join sys.availability_replicas on availability_replicas.group_id = availability_groups.group_id
left outer join sys.availability_read_only_routing_lists on availability_read_only_routing_lists.replica_id = availability_replicas.replica_id
left outer join sys.availability_replicas secondary on availability_read_only_routing_lists.read_only_replica_id = secondary.replica_id
where availability_groups.name = @name
  and availability_replicas.replica_server_name = @replica_name
union all
select replica_server_name, 255
from sys.availability_replicas
join sys.availability_groups on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = @name
  and replica_server_name not in (select secondary.replica_server_name
                from sys.availability_groups
                inner join sys.availability_replicas on availability_replicas.group_id = availability_groups.group_id
                left outer join sys.availability_read_only_routing_lists on availability_read_only_routing_lists.replica_id = availability_replicas.replica_id
                left outer join sys.availability_replicas secondary on availability_read_only_routing_lists.read_only_replica_id = secondary.replica_id
                where availability_groups.name = @name
                  and availability_replicas.replica_server_name = @replica_name)
  and replica_server_name <> @replica_name
order by 2, 1`);

    let rows = result.recordset;

    // If the only row is a NULL routing list, fall back to "all other replicas".
    if (rows.length === 1 && rows[0].replica_server_name == null) {
      const fallback = await this.pool(profileId)
        .request()
        .input('name', sql.VarChar(255), agName)
        .input('replica_name', sql.VarChar(255), replicaName).query(`select replica_server_name, 255 as routing_priority
from sys.availability_groups
inner join sys.availability_replicas on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = @name
  and availability_replicas.replica_server_name <> @replica_name
order by 2, 1`);
      rows = fallback.recordset;
    }

    return rows
      .filter((r) => r.replica_server_name != null)
      .map((r) => ({
        replicaServerName: r.replica_server_name as string,
        routingPriority: r.routing_priority as number
      }));
  }

  /** Execute an arbitrary T-SQL batch (the generated ALTER statements). */
  async execute(profileId: string, tsql: string): Promise<void> {
    await this.pool(profileId).request().batch(tsql);
  }
}
