import * as vscode from 'vscode';
import { AuthType, ConnectionProfile } from './connection';
import { ProfileStore } from './profileStore';
import { SqlClient } from './sqlClient';
import { AlwaysOnTreeProvider, TreeNode, errMessage } from './tree/treeProvider';
import { RoutingListPanel } from './views/routingListPanel';
import { buildRoutingUrlScript } from './scripts';
import {
  openSharedConnection,
  isMssqlInstalled,
  promptForMssqlConnection,
  MssqlConnectionInfo
} from './mssqlSharing';

export function activate(context: vscode.ExtensionContext): void {
  const store = new ProfileStore(context);
  const client = new SqlClient();
  const tree = new AlwaysOnTreeProvider(store, client);

  const view = vscode.window.createTreeView('alwaysonTools.servers', {
    treeDataProvider: tree
  });
  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.commands.registerCommand('alwaysonTools.addServer', () =>
      addServer(store, client, tree)
    ),
    vscode.commands.registerCommand('alwaysonTools.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('alwaysonTools.removeServer', (node?: TreeNode) =>
      removeServer(store, client, tree, node)
    ),
    vscode.commands.registerCommand('alwaysonTools.reconnect', (node?: TreeNode) =>
      reconnect(store, client, tree, node)
    ),
    vscode.commands.registerCommand('alwaysonTools.configureRoutingList', (node?: TreeNode) =>
      configureRoutingList(context, client, tree, node)
    ),
    vscode.commands.registerCommand('alwaysonTools.configureRoutingUrl', (node?: TreeNode) =>
      configureRoutingUrl(client, tree, node)
    ),
    vscode.commands.registerCommand('alwaysonTools.clearServerList', () =>
      clearServerList(store, client, tree)
    ),
    vscode.commands.registerCommand('alwaysonTools.about', about),
    vscode.commands.registerCommand(
      'alwaysonTools.configureFromObjectExplorer',
      (node?: unknown) => configureFromObjectExplorer(context, store, client, tree, node)
    )
  );
}

export async function deactivate(): Promise<void> {
  // Pools are closed by the SqlClient instance going out of scope; nothing to do.
}

// ---------------------------------------------------------------------------
// Connect flow (replaces the WinForms Connection form)
// ---------------------------------------------------------------------------

const AUTH_CHOICES: { label: string; value: AuthType; detail: string }[] = [
  { label: 'SQL Server Authentication', value: 'sql', detail: 'User name and password' },
  { label: 'Windows Authentication', value: 'windows', detail: 'NTLM: domain\\user and password' },
  { label: 'Microsoft Entra - Password', value: 'entra-password', detail: 'Azure AD user and password' },
  {
    label: 'Microsoft Entra - Integrated',
    value: 'entra-integrated',
    detail: 'Use the signed-in Azure identity (no credentials)'
  }
];

async function addServer(
  store: ProfileStore,
  client: SqlClient,
  tree: AlwaysOnTreeProvider
): Promise<void> {
  // Prefer the Microsoft SQL Server extension's own connection picker so the
  // connect experience matches that extension. Fall back to our own prompts
  // when it is not installed.
  if (isMssqlInstalled()) {
    const connInfo = await promptForMssqlConnection();
    if (!connInfo) {
      return; // user cancelled
    }
    const { profile, password, connectionString } = mssqlInfoToProfile(connInfo);
    await connectAndRegister(store, client, tree, profile, password, connectionString);
    return;
  }
  await addServerManual(store, client, tree);
}

/** Map a Microsoft connection-picker result onto our profile model. */
function mssqlInfoToProfile(info: MssqlConnectionInfo): {
  profile: ConnectionProfile;
  password?: string;
  connectionString?: string;
} {
  const authType = mapMssqlAuthType(info.authenticationType);
  const encrypt =
    info.encrypt === true || info.encrypt === 'Mandatory' || info.encrypt === 'Strict';
  const profile: ConnectionProfile = {
    id: `${info.server}::${authType}::${info.user ?? ''}`,
    server: info.server,
    port: info.port,
    authType,
    userName: info.user || undefined,
    encrypt: encrypt || authType.startsWith('entra'),
    trustServerCertificate: info.trustServerCertificate ?? !encrypt,
    fromConnectionString: !info.server && !!info.connectionString
  };
  return { profile, password: info.password || undefined, connectionString: info.connectionString };
}

function mapMssqlAuthType(authenticationType?: string): AuthType {
  switch (authenticationType) {
    case 'Integrated':
      return 'windows';
    case 'AzureMFA':
      return 'entra-integrated';
    case 'SqlLogin':
      return 'sql';
    default:
      return authenticationType?.toLowerCase().includes('password') ? 'entra-password' : 'sql';
  }
}

/** Connect, validate SQL 2012+/HADR, and persist the profile on success. */
async function connectAndRegister(
  store: ProfileStore,
  client: SqlClient,
  tree: AlwaysOnTreeProvider,
  profile: ConnectionProfile,
  password?: string,
  connectionString?: string
): Promise<void> {
  await vscode.window.withProgress(
    { location: { viewId: 'alwaysonTools.servers' }, title: `Connecting to ${profile.server}...` },
    async () => {
      try {
        if (profile.fromConnectionString && connectionString) {
          await client.connectWithString(profile.id, connectionString);
        } else {
          await client.connect(profile, password);
        }
        const info = await client.getServerInfo(profile.id);

        if (info.majorVersion < 11) {
          await client.disconnect(profile.id);
          vscode.window.showErrorMessage(
            'This version of SQL Server does not support AlwaysOn Availability Groups (requires SQL Server 2012 or later).'
          );
          return;
        }
        if (!info.isHadrEnabled) {
          await client.disconnect(profile.id);
          vscode.window.showErrorMessage(
            'AlwaysOn Availability Groups is not enabled on this instance. Enable it and configure an Availability Group before using this tool.'
          );
          return;
        }

        // For connection-string profiles, persist the string as the secret so
        // reconnect can reuse it; otherwise persist the password.
        await store.upsert(profile, profile.fromConnectionString ? connectionString : password);
        tree.refresh();
        vscode.window.showInformationMessage(`Connected to ${profile.server}.`);
        await warnIfNotSysadmin(client, profile.id);
      } catch (err) {
        vscode.window.showErrorMessage(`Connection failed: ${errMessage(err)}`);
      }
    }
  );
}

async function addServerManual(
  store: ProfileStore,
  client: SqlClient,
  tree: AlwaysOnTreeProvider
): Promise<void> {
  const server = await vscode.window.showInputBox({
    title: 'Connect to SQL Server',
    prompt: 'Server / instance name (e.g. SERVER, SERVER\\INSTANCE, or listener.contoso.com)',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Server name is required')
  });
  if (!server) {
    return;
  }

  const authPick = await vscode.window.showQuickPick(AUTH_CHOICES, {
    title: 'Authentication',
    ignoreFocusOut: true
  });
  if (!authPick) {
    return;
  }

  let userName: string | undefined;
  let domain: string | undefined;
  let password: string | undefined;

  if (authPick.value === 'windows') {
    const userInput = await vscode.window.showInputBox({
      title: 'Windows Authentication',
      prompt: 'Account as DOMAIN\\user (or user)',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Account is required')
    });
    if (!userInput) {
      return;
    }
    const slash = userInput.indexOf('\\');
    if (slash >= 0) {
      domain = userInput.substring(0, slash);
      userName = userInput.substring(slash + 1);
    } else {
      userName = userInput;
    }
    password = await promptPassword();
    if (password === undefined) {
      return;
    }
  } else if (authPick.value === 'sql' || authPick.value === 'entra-password') {
    userName = await vscode.window.showInputBox({
      title: authPick.label,
      prompt: 'User name',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'User name is required')
    });
    if (!userName) {
      return;
    }
    password = await promptPassword();
    if (password === undefined) {
      return;
    }
  }

  const requiresEncrypt = authPick.value.startsWith('entra');
  const profile: ConnectionProfile = {
    id: `${server}::${authPick.value}::${userName ?? ''}`,
    server: server.trim(),
    authType: authPick.value,
    userName,
    domain,
    encrypt: requiresEncrypt,
    trustServerCertificate: !requiresEncrypt
  };

  await connectAndRegister(store, client, tree, profile, password);
}

/**
 * Read-only routing changes require sysadmin, so warn (non-blocking) if the
 * connected login is not a member of the sysadmin fixed server role.
 */
async function warnIfNotSysadmin(client: SqlClient, profileId: string): Promise<void> {
  try {
    if (!(await client.isSysadmin(profileId))) {
      vscode.window.showWarningMessage(
        'You are not a member of the sysadmin fixed server role on this instance. ' +
          'Configuring read-only routing requires sysadmin, so changes will fail until you connect with a sysadmin login.'
      );
    }
  } catch {
    /* don't block on the permission probe */
  }
}

function promptPassword(): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Password',
    prompt: 'Password',
    password: true,
    ignoreFocusOut: true
  });
}

// ---------------------------------------------------------------------------
// Server node commands
// ---------------------------------------------------------------------------

async function reconnect(
  store: ProfileStore,
  client: SqlClient,
  tree: AlwaysOnTreeProvider,
  node?: TreeNode
): Promise<void> {
  const profile = node?.profile;
  if (!profile) {
    return;
  }
  const secret = await store.getPassword(profile.id);
  let password = secret;
  if (!profile.fromConnectionString && password === undefined && profile.authType !== 'entra-integrated') {
    password = await promptPassword();
    if (password === undefined) {
      return;
    }
    await store.upsert(profile, password);
  }
  await vscode.window.withProgress(
    { location: { viewId: 'alwaysonTools.servers' }, title: `Connecting to ${profile.server}...` },
    async () => {
      try {
        if (profile.fromConnectionString && secret) {
          await client.connectWithString(profile.id, secret);
        } else {
          await client.connect(profile, password);
        }
        tree.refresh();
        await warnIfNotSysadmin(client, profile.id);
      } catch (err) {
        vscode.window.showErrorMessage(`Connection failed: ${errMessage(err)}`);
      }
    }
  );
}

async function removeServer(
  store: ProfileStore,
  client: SqlClient,
  tree: AlwaysOnTreeProvider,
  node?: TreeNode
): Promise<void> {
  const profile = node?.profile;
  if (!profile) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Remove server ${profile.server}?`,
    { modal: true },
    'Remove'
  );
  if (choice !== 'Remove') {
    return;
  }
  await client.disconnect(profile.id);
  await store.remove(profile.id);
  tree.refresh();
}

async function clearServerList(
  store: ProfileStore,
  client: SqlClient,
  tree: AlwaysOnTreeProvider
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Clear the entire saved server list?',
    { modal: true },
    'Clear'
  );
  if (choice !== 'Clear') {
    return;
  }
  await client.disconnectAll();
  await store.clear();
  tree.refresh();
}

// ---------------------------------------------------------------------------
// Replica node commands
// ---------------------------------------------------------------------------

async function configureRoutingList(
  context: vscode.ExtensionContext,
  client: SqlClient,
  tree: AlwaysOnTreeProvider,
  node?: TreeNode
): Promise<void> {
  if (!node || node.kind !== 'replica' || !node.agName || !node.replicaName) {
    return;
  }
  await openRoutingList(context, client, tree, node.profile, node.agName, node.replicaName);
}

/** Reusable: open the routing-list editor for a (profile, AG, replica). */
async function openRoutingList(
  context: vscode.ExtensionContext,
  client: SqlClient,
  tree: AlwaysOnTreeProvider,
  profile: ConnectionProfile,
  agName: string,
  replicaName: string
): Promise<void> {
  try {
    await RoutingListPanel.show(
      context,
      client,
      profile,
      agName,
      replicaName,
      () => tree.refresh()
    );
  } catch (err) {
    vscode.window.showErrorMessage(errMessage(err));
  }
}

async function configureRoutingUrl(
  client: SqlClient,
  tree: AlwaysOnTreeProvider,
  node?: TreeNode
): Promise<void> {
  if (!node || node.kind !== 'replica' || !node.agName || !node.replicaName) {
    return;
  }
  await runRoutingUrl(client, tree, node.profile, node.agName, node.replicaName);
}

/** Reusable: the routing-URL prompt/apply flow for a (profile, AG, replica). */
async function runRoutingUrl(
  client: SqlClient,
  tree: AlwaysOnTreeProvider,
  profile: ConnectionProfile,
  agName: string,
  replicaName: string
): Promise<void> {
  const existing = await client.getRoutingUrl(profile.id, agName, replicaName).catch(() => null);

  const fqdn = await vscode.window.showInputBox({
    title: `Read-Only Routing URL for ${replicaName}`,
    prompt: 'Fully qualified domain name for the replica (recommended over the bare server name)',
    value: existing ? extractHost(existing) : replicaName,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A host name is required')
  });
  if (!fqdn) {
    return;
  }

  const portStr = await vscode.window.showInputBox({
    title: `Read-Only Routing URL for ${replicaName}`,
    prompt: 'TCP port',
    value: existing ? extractPort(existing) : '1433',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return 'Enter a whole number between 1 and 65535';
      }
      return undefined;
    }
  });
  if (!portStr) {
    return;
  }

  if (fqdn.trim() === replicaName && fqdn.indexOf('.') < 0) {
    const proceed = await vscode.window.showWarningMessage(
      'The routing URL uses only the server name, not a fully qualified domain name. This is not recommended. Continue?',
      { modal: true },
      'Yes'
    );
    if (proceed !== 'Yes') {
      return;
    }
  }

  const script = buildRoutingUrlScript(agName, replicaName, fqdn.trim(), Number(portStr));

  const action = await vscode.window.showQuickPick(
    [
      { label: 'Apply to Server', value: 'apply' },
      { label: 'Generate Script', value: 'generate' }
    ],
    { title: 'Read-Only Routing URL', ignoreFocusOut: true }
  );
  if (!action) {
    return;
  }

  if (action.value === 'generate') {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: script });
    await vscode.window.showTextDocument(doc, { preview: false });
    return;
  }

  try {
    await client.execute(profile.id, script);
    vscode.window.showInformationMessage(`Read-only routing URL configured for ${replicaName}.`);
    tree.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(errMessage(err));
  }
}

function extractHost(url: string): string {
  const m = /TCP:\/\/(.+):(\d+)/i.exec(url);
  return m ? m[1] : url;
}

function extractPort(url: string): string {
  const m = /TCP:\/\/(.+):(\d+)/i.exec(url);
  return m ? m[2] : '1433';
}

// ---------------------------------------------------------------------------
// Integration with the Microsoft SQL Server (ms-mssql.mssql) Object Explorer.
// Invoked from the server right-click menu in that extension's tree. The node
// argument is mssql's tree node; we read its connectionProfile defensively
// since its exact shape is not a documented contract.
// ---------------------------------------------------------------------------

function readMssqlNode(node: any): { connectionId?: string; server?: string } {
  const profile =
    node?.connectionProfile ??
    node?.connectionInfo ??
    node?.sqlConnectionInfo ??
    node?.connection;
  return {
    connectionId: typeof profile?.id === 'string' ? profile.id : undefined,
    server: typeof profile?.server === 'string' ? profile.server : undefined
  };
}

async function configureFromObjectExplorer(
  context: vscode.ExtensionContext,
  _store: ProfileStore,
  client: SqlClient,
  tree: AlwaysOnTreeProvider,
  node?: unknown
): Promise<void> {
  const { connectionId, server } = readMssqlNode(node);
  if (!connectionId) {
    vscode.window.showErrorMessage(
      'Could not read the connection from the selected SQL Server node. Make sure the server is connected in the SQL Server extension.'
    );
    return;
  }

  // Reuse the SQL Server extension's existing connection (no credentials
  // needed) via its connection-sharing API, registered under a synthetic id.
  const profile: ConnectionProfile = {
    id: `mssql-shared::${connectionId}`,
    server: server ?? 'SQL Server',
    authType: 'sql',
    encrypt: false,
    trustServerCertificate: true
  };

  const ok = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${profile.server} via the SQL Server extension...`
    },
    async () => {
      try {
        const shared = await openSharedConnection(connectionId);
        if (!shared) {
          return false; // openSharedConnection surfaced its own message.
        }
        client.registerShared(profile.id, shared);
        const info = await client.getServerInfo(profile.id);
        if (info.majorVersion < 11 || !info.isHadrEnabled) {
          vscode.window.showErrorMessage(
            'This instance is not a SQL Server 2012+ instance with AlwaysOn Availability Groups enabled.'
          );
          return false;
        }
        await warnIfNotSysadmin(client, profile.id);
        return true;
      } catch (err) {
        vscode.window.showErrorMessage(`Connection failed: ${errMessage(err)}`);
        return false;
      }
    }
  );
  if (!ok) {
    return;
  }

  // Guided pick: Availability Group -> replica -> action.
  const ags = await client.getAvailabilityGroups(profile.id);
  if (ags.length === 0) {
    vscode.window.showInformationMessage(
      'No AlwaysOn Availability Groups are primary on this instance. Connect to the primary replica (or the AG listener).'
    );
    return;
  }
  const agName = ags.length === 1 ? ags[0] : await vscode.window.showQuickPick(ags, {
    title: 'Select an Availability Group',
    ignoreFocusOut: true
  });
  if (!agName) {
    return;
  }

  const replicas = await client.getReplicas(profile.id, agName);
  const replicaName = await vscode.window.showQuickPick(replicas, {
    title: `Configure read-only routing for which primary replica in ${agName}?`,
    placeHolder:
      'Pick the replica to act as primary — you’ll set which replicas serve read-only traffic (and in what order) when it is primary',
    ignoreFocusOut: true
  });
  if (!replicaName) {
    return;
  }

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(list-ordered) Configure Read-Only Routing List...', value: 'list' },
      { label: '$(link) Configure Read-Only Routing URL...', value: 'url' }
    ],
    { title: `${replicaName}`, ignoreFocusOut: true }
  );
  if (!action) {
    return;
  }

  if (action.value === 'list') {
    await openRoutingList(context, client, tree, profile, agName, replicaName);
  } else {
    await runRoutingUrl(client, tree, profile, agName, replicaName);
  }
}

function about(): void {
  vscode.window.showInformationMessage(
    'AlwaysOn Tools — Read-Only Routing Configuration. A VS Code port of the Denny Cherry & Associates Consulting AlwaysOn Tools.'
  );
}
