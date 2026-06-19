# AlwaysOn Tools for VS Code

Configure **SQL Server AlwaysOn Availability Group read-only routing** without leaving VS Code. This is a port of the Denny Cherry & Associates Consulting *AlwaysOn Tools* (originally a VB.NET WinForms app) to a VS Code extension.

## Features

- Connect to a SQL Server instance — an Availability Group **listener** or directly to the **primary replica**.
- Browse **Availability Groups** and their **replicas** in a tree view in the activity bar.
- Configure a replica's **read-only routing list** (the priority-ordered list of partner replicas) with a checkable, reorderable editor.
- Configure a replica's **read-only routing URL** (`TCP://fqdn:port`).
- **Generate the T-SQL** `ALTER AVAILABILITY GROUP` script or **apply it directly** to the server.
- Optional **load-balanced (round-robin)** routing list on SQL Server 2017+.

The tool validates on connect that the instance is SQL Server 2012+ with HADR enabled, mirroring the original application.

## Requirements

This extension depends on the Microsoft **SQL Server (ms-mssql.mssql)** extension (declared via `extensionDependencies`), so VS Code installs and enables it automatically. It provides the connection dialog and the connection-sharing API that lets AlwaysOn Tools reuse your existing connections for every authentication type without re-authenticating.

## Authentication

All authentication modes the original supported, plus Microsoft Entra:

| Mode | Notes |
| --- | --- |
| SQL Server Authentication | User name + password |
| Windows Authentication | NTLM — enter the account as `DOMAIN\user` + password |
| Microsoft Entra - Password | Azure AD user + password |
| Microsoft Entra - Integrated | Uses the signed-in Azure identity (no credentials) |

> Windows authentication uses NTLM (cross-platform via the `tedious`/`mssql` driver), so a `DOMAIN\user` and password are required rather than the desktop's true integrated SSPI. The server rejects any auth mode it does not support.

Passwords are stored in the VS Code **SecretStorage**; server profiles are stored in global state.

## Usage

1. Open the **AlwaysOn Tools** view in the activity bar.
2. Click **Connect to a Server**. This reuses the SQL Server extension's connection picker (select an existing connection or create a new one) so the experience matches that extension. When you pick a **saved** connection, the routing tool reuses the SQL Server extension's own connection (via the connection-sharing API), so **all authentication types work — including Windows-integrated and Entra-MFA — with no re-authentication**. A brand-new connection that isn't saved yet falls back to this extension's own engine (SQL and Entra-password). *(A built-in prompt fallback also exists as a safety net if the SQL Server extension is ever unavailable.)*
3. Expand the server → Availability Group → replica.
4. Right-click a replica:
   - **Configure Read-Only Routing List…** — opens the routing-list editor.
   - **Configure Read-Only Routing URL…** — sets the `TCP://` routing URL.

## SQL Server extension integration

If the Microsoft **SQL Server (ms-mssql.mssql)** extension is installed, **right-click a connected server** in its Object Explorer and choose **"Configure AlwaysOn Read-Only Routing…"**. This opens a guided flow (Availability Group → replica → routing list / routing URL).

This reuses the SQL Server extension's **own existing connection** through its public *connection-sharing* API — so **no credentials are re-entered**, including Windows-integrated and Entra MFA connections that this extension cannot establish on its own. The first time, the SQL Server extension asks you to approve connection sharing with AlwaysOn Tools.

Notes:

- The menu hook relies on the SQL Server extension's internal node `contextValue` (`type=Server`), which is not a documented API and could change in a future release of that extension.
- Connection sharing requires a reasonably recent version of the SQL Server extension (the `connectionSharing` API). If it is unavailable, use **AlwaysOn Tools: Connect to a Server** in the AlwaysOn Tools view instead.

## Development

```bash
npm install
npm run compile      # or: npm run watch
```

Press **F5** in VS Code to launch an Extension Development Host.

Package a `.vsix` with:

```bash
npx vsce package
```

## About DCAC

**DCAC (Denny Cherry & Associates Consulting)** is a Microsoft data-platform consulting firm. We help organizations design, secure, migrate, and operate mission-critical SQL Server and Azure environments — covering high-availability architectures such as AlwaysOn Availability Groups, performance tuning, data security and compliance, cloud migration, and 24×7 managed database services.

## License

MIT
