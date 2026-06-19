import * as sql from 'mssql';

/**
 * Supported authentication modes. The original WinForms tool supported Windows
 * and SQL Server authentication; this port also exposes Microsoft Entra
 * (Azure AD) options. The server rejects whatever it does not support.
 */
export type AuthType =
  | 'sql' // SQL Server Authentication (user / password)
  | 'windows' // Windows Authentication (NTLM: domain\user / password)
  | 'entra-password' // Microsoft Entra - Password
  | 'entra-integrated'; // Microsoft Entra - Integrated / Default (no credentials)

export interface ConnectionProfile {
  /** Stable identifier (also the SecretStorage key suffix for the password). */
  id: string;
  /** Server / instance name, e.g. SERVER\INSTANCE or listener.contoso.com. */
  server: string;
  /** Optional TCP port. */
  port?: number;
  authType: AuthType;
  /** SQL / Entra user name, or domain user for Windows auth. */
  userName?: string;
  /** Domain for NTLM Windows authentication. */
  domain?: string;
  /** Encrypt the connection (required for Entra). */
  encrypt: boolean;
  /** Trust a self-signed server certificate. */
  trustServerCertificate: boolean;
  /** When true, the stored secret is a full connection string, not a password. */
  fromConnectionString?: boolean;
  /**
   * When set, queries run through the Microsoft SQL Server extension's shared
   * connection with this connection id (no credentials of our own needed).
   */
  sharedConnectionId?: string;
}

/** Build an mssql config object for a profile, given its (optional) password. */
export function buildSqlConfig(
  profile: ConnectionProfile,
  password?: string
): sql.config {
  const base: sql.config = {
    server: hostOnly(profile.server),
    port: profile.port,
    database: 'master',
    options: {
      encrypt: profile.encrypt,
      trustServerCertificate: profile.trustServerCertificate,
      // Allow named instances (SERVER\INSTANCE) to resolve via SQL Browser.
      instanceName: parseInstanceName(profile.server)
    },
    connectionTimeout: 15000,
    requestTimeout: 30000
  };

  switch (profile.authType) {
    case 'sql':
      base.authentication = {
        type: 'default',
        options: {
          userName: profile.userName,
          password: password
        }
      } as sql.config['authentication'];
      break;
    case 'windows':
      base.authentication = {
        type: 'ntlm',
        options: {
          domain: profile.domain ?? '',
          userName: profile.userName ?? '',
          password: password ?? ''
        }
      } as sql.config['authentication'];
      break;
    case 'entra-password':
      base.authentication = {
        type: 'azure-active-directory-password',
        options: {
          userName: profile.userName,
          password: password
        }
      } as sql.config['authentication'];
      break;
    case 'entra-integrated':
      base.authentication = {
        type: 'azure-active-directory-default',
        options: {}
      } as sql.config['authentication'];
      break;
  }

  return base;
}

/**
 * mssql's `server` field expects a host only. When a named instance is given
 * (SERVER\INSTANCE) we strip the host into `server` and pass the instance via
 * options.instanceName.
 */
function parseInstanceName(server: string): string | undefined {
  const idx = server.indexOf('\\');
  return idx >= 0 ? server.substring(idx + 1) : undefined;
}

/** Strip an instance suffix off the host portion for mssql's `server` field. */
export function hostOnly(server: string): string {
  const idx = server.indexOf('\\');
  return idx >= 0 ? server.substring(0, idx) : server;
}
