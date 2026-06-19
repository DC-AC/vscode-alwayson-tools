# Changelog

All notable changes to the **AlwaysOn Read-Only Routing Configuration** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0]

Initial release — a VS Code port of the DCAC AlwaysOn Tools (originally a
VB.NET WinForms app) for configuring SQL Server AlwaysOn Availability Group
read-only routing.

### Added

- Activity-bar tree view: Server → Availability Group (primary only) → replica.
- Configure a replica's **read-only routing list** with a checkable, reorderable editor.
- Configure a replica's **read-only routing URL** (`TCP://fqdn:port`), with an
  FQDN suggested from the server's domain.
- **Generate** a self-contained T-SQL script (routing URLs + routing list) or
  **apply** changes directly to the server.
- Guard against SQL Server Msg 19404 — selected replicas without a routing URL
  are configured before the routing list is applied.
- Optional load-balanced (round-robin) routing list on SQL Server 2017+.
- Validation on connect: SQL Server 2012+, HADR enabled, and a sysadmin warning.
- All authentication types: SQL, Windows, and Microsoft Entra.
- Integration with the Microsoft **SQL Server (ms-mssql.mssql)** extension:
  - "Configure AlwaysOn Read-Only Routing…" on the Object Explorer server menu.
  - The tree-view connect reuses the SQL Server extension's connection picker
    and shares its connections (all auth types, no re-authentication).
