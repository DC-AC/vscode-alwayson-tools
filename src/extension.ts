import * as vscode from 'vscode';
import { AuthType, ConnectionProfile } from './connection';
import { ProfileStore } from './profileStore';
import { SqlClient } from './sqlClient';
import { AlwaysOnTreeProvider, TreeNode, errMessage } from './tree/treeProvider';
import { RoutingListPanel } from './views/routingListPanel';
import { buildRoutingUrlScript } from './scripts';

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

  await vscode.window.withProgress(
    { location: { viewId: 'alwaysonTools.servers' }, title: `Connecting to ${server}...` },
    async () => {
      try {
        await client.connect(profile, password);
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

        await store.upsert(profile, password);
        tree.refresh();
        vscode.window.showInformationMessage(`Connected to ${server}.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Connection failed: ${errMessage(err)}`);
      }
    }
  );
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
  let password = await store.getPassword(profile.id);
  if (password === undefined && profile.authType !== 'entra-integrated') {
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
        await client.connect(profile, password);
        tree.refresh();
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

interface MssqlConnectionInfo {
  server?: string;
  authenticationType?: string; // 'Integrated' | 'SqlLogin' | 'AzureMFA'
  user?: string;
  password?: string;
}

function readMssqlConnection(node: any): MssqlConnectionInfo | undefined {
  const profile =
    node?.connectionProfile ??
    node?.connectionInfo ??
    node?.sqlConnectionInfo ??
    node?.connection;
  if (profile && typeof profile.server === 'string') {
    return profile as MssqlConnectionInfo;
  }
  return undefined;
}

function mapMssqlAuth(authenticationType?: string): AuthType {
  switch (authenticationType) {
    case 'Integrated':
      return 'windows';
    case 'AzureMFA':
      return 'entra-integrated';
    case 'SqlLogin':
    default:
      return 'sql';
  }
}

async function configureFromObjectExplorer(
  context: vscode.ExtensionContext,
  store: ProfileStore,
  client: SqlClient,
  tree: AlwaysOnTreeProvider,
  node?: unknown
): Promise<void> {
  const conn = readMssqlConnection(node);
  if (!conn || !conn.server) {
    vscode.window.showErrorMessage(
      'Could not read the connection details from the selected SQL Server node.'
    );
    return;
  }
  const server = conn.server;

  // Reuse a saved profile for this server if we have one (it carries a stored
  // password); otherwise derive one from the mssql node.
  let profile = store
    .getAll()
    .find((p) => p.server.toLowerCase() === server.toLowerCase());
  let password: string | undefined;

  if (profile) {
    password = await store.getPassword(profile.id);
  } else {
    const authType = mapMssqlAuth(conn.authenticationType);
    profile = {
      id: `${server}::${authType}::${conn.user ?? ''}`,
      server,
      authType,
      userName: conn.user,
      encrypt: authType.startsWith('entra'),
      trustServerCertificate: !authType.startsWith('entra')
    };
    password = conn.password;
  }

  const needsPassword =
    profile.authType === 'sql' || profile.authType === 'windows' || profile.authType === 'entra-password';
  if (needsPassword && !password) {
    if (profile.authType === 'windows') {
      vscode.window.showWarningMessage(
        'Windows authentication requires a domain password. Connect this server once via "AlwaysOn Tools: Connect to a Server" to save the credential.'
      );
      return;
    }
    password = await promptPassword();
    if (password === undefined) {
      return;
    }
  }

  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Connecting to ${server}...` },
    async () => {
      try {
        await client.connect(profile!, password);
        const info = await client.getServerInfo(profile!.id);
        if (info.majorVersion < 11 || !info.isHadrEnabled) {
          vscode.window.showErrorMessage(
            'This instance is not a SQL Server 2012+ instance with AlwaysOn Availability Groups enabled.'
          );
          return false;
        }
        await store.upsert(profile!, password);
        tree.refresh();
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
    vscode.window.showInformationMessage('This instance has no AlwaysOn Availability Groups.');
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
    title: `Select a replica in ${agName}`,
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
