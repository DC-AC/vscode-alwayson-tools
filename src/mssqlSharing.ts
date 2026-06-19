import * as vscode from 'vscode';
import { SharedConnection } from './sqlClient';

/** Our own extension id, required by the mssql connection-sharing API. */
export const EXTENSION_ID = 'dcac.alwayson-tools';

const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';

// Minimal shapes from the public vscode-mssql connection-sharing API. We define
// only what we use rather than taking a dependency on the typings package.
interface DbCellValue {
  displayValue: string;
  isNull: boolean;
}
interface IDbColumn {
  columnName: string;
}
interface SimpleExecuteResult {
  rowCount: number;
  columnInfo: IDbColumn[];
  rows: DbCellValue[][];
}
interface IConnectionSharingService {
  connect(extensionId: string, connectionId: string, database?: string): Promise<string | undefined>;
  disconnect(connectionUri: string): void;
  isConnected(connectionUri: string): boolean;
  executeSimpleQuery(connectionUri: string, queryString: string): Promise<SimpleExecuteResult>;
  editConnectionSharingPermissions(extensionId: string): Promise<'approved' | 'denied' | undefined>;
}
/** Subset of the mssql IConnectionInfo we map onto our ConnectionProfile. */
export interface MssqlConnectionInfo {
  server: string;
  database?: string;
  user?: string;
  password?: string;
  port?: number;
  authenticationType?: string; // 'SqlLogin' | 'Integrated' | 'AzureMFA' | ...
  encrypt?: string | boolean;
  trustServerCertificate?: boolean;
  connectionString?: string;
}

interface IMssqlExtension {
  connectionSharing?: IConnectionSharingService;
  promptForConnection?(ignoreFocusOut?: boolean): Promise<MssqlConnectionInfo | undefined>;
}

async function getMssqlApi(): Promise<IMssqlExtension | undefined> {
  const ext = vscode.extensions.getExtension<IMssqlExtension>(MSSQL_EXTENSION_ID);
  if (!ext) {
    return undefined;
  }
  return ext.isActive ? ext.exports : await ext.activate();
}

/**
 * Show the Microsoft SQL Server extension's own connection picker (select an
 * existing connection or create a new one) and return the chosen connection.
 * Returns undefined if mssql is unavailable or the user cancelled.
 */
export async function promptForMssqlConnection(): Promise<MssqlConnectionInfo | undefined> {
  const api = await getMssqlApi();
  if (!api?.promptForConnection) {
    return undefined;
  }
  return api.promptForConnection(true);
}

/** Whether the Microsoft SQL Server extension is installed. */
export function isMssqlInstalled(): boolean {
  return !!vscode.extensions.getExtension(MSSQL_EXTENSION_ID);
}

async function getSharingService(): Promise<IConnectionSharingService | undefined> {
  const api = await getMssqlApi();
  return api?.connectionSharing;
}

function mapResult(result: SimpleExecuteResult): Record<string, unknown>[] {
  const columns = result.columnInfo.map((c) => c.columnName);
  return result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    row.forEach((cell, i) => {
      obj[columns[i]] = cell.isNull ? null : cell.displayValue;
    });
    return obj;
  });
}

/**
 * Open a shared connection to a saved mssql connection (by its connection id,
 * which is the Object Explorer node's connectionProfile.id). The mssql
 * extension prompts the user to approve connection sharing the first time.
 * Returns undefined if sharing is unavailable or not approved.
 */
export async function openSharedConnection(connectionId: string): Promise<SharedConnection | undefined> {
  const svc = await getSharingService();
  if (!svc) {
    return undefined;
  }

  let uri: string | undefined;
  try {
    uri = await svc.connect(EXTENSION_ID, connectionId, 'master');
  } catch (err) {
    // Most commonly a denied / not-yet-granted permission.
    const choice = await vscode.window.showWarningMessage(
      'The SQL Server extension declined to share this connection. Grant permission to AlwaysOn Tools?',
      'Edit Permissions'
    );
    if (choice === 'Edit Permissions') {
      await svc.editConnectionSharingPermissions(EXTENSION_ID);
    }
    return undefined;
  }
  if (!uri) {
    return undefined;
  }

  const connectionUri = uri;
  return {
    isConnected: () => svc.isConnected(connectionUri),
    rows: async (tsql: string) => mapResult(await svc.executeSimpleQuery(connectionUri, tsql)),
    exec: async (tsql: string) => {
      await svc.executeSimpleQuery(connectionUri, tsql);
    }
  };
}
