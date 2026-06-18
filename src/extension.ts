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
    vscode.commands.registerCommand('alwaysonTools.about', about)
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
  try {
    await RoutingListPanel.show(
      context,
      client,
      node.profile,
      node.agName,
      node.replicaName,
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
  const agName = node.agName;
  const replicaName = node.replicaName;

  const existing = await client.getRoutingUrl(node.profile.id, agName, replicaName).catch(() => null);

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
    await client.execute(node.profile.id, script);
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

function about(): void {
  vscode.window.showInformationMessage(
    'AlwaysOn Tools — Read-Only Routing Configuration. A VS Code port of the Denny Cherry & Associates Consulting AlwaysOn Tools.'
  );
}
