import * as vscode from 'vscode';
import { SqlClient, RoutingListEntry } from '../sqlClient';
import { ConnectionProfile } from '../connection';
import { buildRoutingListScript, buildRoutingUrlStatement, routingUrl } from '../scripts';

interface ReplicaItem {
  name: string;
  checked: boolean;
}

/**
 * Webview editor for a replica's read-only routing list: a checkable,
 * reorderable list of partner replicas in priority order, with Generate Script
 * and Apply actions. Replaces the WinForms CheckedListBox / Move Up-Down UI.
 */
export class RoutingListPanel {
  static async show(
    context: vscode.ExtensionContext,
    client: SqlClient,
    profile: ConnectionProfile,
    agName: string,
    replicaName: string,
    onApplied: () => void
  ): Promise<void> {
    const entries = await client.getRoutingList(profile.id, agName, replicaName);
    const items = orderEntries(entries);
    const roundRobinAvailable = await isRoundRobinAvailable(client, profile.id);

    const panel = vscode.window.createWebviewPanel(
      'alwaysonRoutingList',
      `Routing List: ${replicaName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = renderHtml(
      panel.webview,
      context,
      agName,
      replicaName,
      items,
      roundRobinAvailable
    );

    // Serialize message handling: prompts must never overlap, or VS Code's
    // single input box gets cancelled out from under the user.
    let busy = false;

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type !== 'generate' && msg.type !== 'apply') {
        return;
      }
      if (busy) {
        return;
      }
      busy = true;
      try {
        const ordered: string[] = (msg.checked as string[]) ?? [];
        const execute = msg.type === 'apply';

        // Resolve a routing URL for every selected replica (existing URLs are
        // read from the server; missing ones are prompted for). When applying,
        // missing URLs are written to the server here.
        const urlStatements = await resolveRoutingUrls(
          client,
          profile,
          agName,
          ordered,
          panel,
          execute
        );
        if (urlStatements === null) {
          return; // user cancelled; resolveRoutingUrls handled unchecking
        }

        const listScript = buildRoutingListScript(agName, replicaName, ordered, !!msg.roundRobin);

        if (msg.type === 'generate') {
          // Emit a self-contained script: each replica's routing URL first,
          // then the primary's routing list.
          const parts = [
            '-- Read-only routing URLs for the read-only replicas',
            ...urlStatements.map((s) => s + '\nGO'),
            '-- Read-only routing list for the primary replica',
            listScript + '\nGO'
          ];
          const doc = await vscode.workspace.openTextDocument({
            language: 'sql',
            content: parts.join('\n\n')
          });
          await vscode.window.showTextDocument(doc, { preview: false });
          return;
        }

        // apply
        if (ordered.length === 0) {
          const choice = await vscode.window.showWarningMessage(
            'No read-only replicas are selected. This disables read-only routing for this replica. Continue?',
            { modal: true },
            'Yes'
          );
          if (choice !== 'Yes') {
            return;
          }
        }

        await client.execute(profile.id, listScript);
        vscode.window.showInformationMessage(
          `Setting saved for Availability Group ${agName} replica ${replicaName}.`
        );
        onApplied();
        panel.dispose();
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        busy = false;
      }
    });
  }
}

/**
 * Resolve the READ_ONLY_ROUTING_URL for every selected replica and return the
 * SECONDARY_ROLE statements (in selection order). Existing URLs are read from
 * the server; replicas without one are prompted for in a single sequential
 * flow. When `execute` is true, newly-entered URLs are written to the server
 * immediately (Apply); otherwise nothing is written (Generate).
 *
 * Returns null if the user cancelled (still-missing replicas are unchecked).
 */
async function resolveRoutingUrls(
  client: SqlClient,
  profile: ConnectionProfile,
  agName: string,
  ordered: string[],
  panel: vscode.WebviewPanel,
  execute: boolean
): Promise<string[] | null> {
  const urls = new Map<string, string>();
  const missing: string[] = [];
  for (const r of ordered) {
    const existing = await client.getRoutingUrl(profile.id, agName, r).catch(() => null);
    if (existing) {
      urls.set(r, existing);
    } else {
      missing.push(r);
    }
  }

  if (missing.length > 0) {
    const label =
      missing.length === 1
        ? `Replica '${missing[0]}' has`
        : `${missing.length} selected replicas have`;
    const choice = await vscode.window.showWarningMessage(
      `${label} no read-only routing URL, which is required before ${missing.length === 1 ? 'it' : 'they'} can receive read-only connections:\n\n` +
        missing.join('\n') +
        `\n\nConfigure ${missing.length === 1 ? 'it' : 'them'} now?`,
      { modal: true },
      'Configure'
    );
    if (choice !== 'Configure') {
      panel.webview.postMessage({ type: 'uncheck', replica: missing });
      return null;
    }

    // Read the suggested domain once for the whole batch.
    const domain = await client.getMachineDomain(profile.id).catch(() => null);

    for (let i = 0; i < missing.length; i++) {
      const replica = missing[i];
      const url = await promptRoutingUrl(replica, domain, i + 1, missing.length);
      if (!url) {
        // User cancelled; uncheck the ones still without a URL and abort.
        panel.webview.postMessage({ type: 'uncheck', replica: missing.slice(i) });
        vscode.window.showWarningMessage('Cancelled — not all routing URLs were configured.');
        return null;
      }
      urls.set(replica, url);
      if (execute) {
        await client.execute(profile.id, buildRoutingUrlStatement(agName, replica, url));
        vscode.window.showInformationMessage(`Read-only routing URL configured for ${replica}.`);
      }
    }
  }

  return ordered.map((r) => buildRoutingUrlStatement(agName, r, urls.get(r)!));
}

/** Prompt for one replica's routing URL (FQDN + port). Returns the full URL. */
async function promptRoutingUrl(
  replicaName: string,
  domain: string | null,
  position: number,
  total: number
): Promise<string | null> {
  const step = total > 1 ? ` (${position} of ${total})` : '';
  const title = `Read-Only Routing URL for ${replicaName}${step}`;

  let suggested = replicaName;
  let promptText = 'Fully qualified domain name for the replica (recommended over the bare server name)';
  if (domain && !replicaName.includes('.')) {
    suggested = `${replicaName}.${domain}`;
    promptText = `Auto-detected domain "${domain}". Confirm or edit the full routing FQDN (it must resolve to ${replicaName}).`;
  }

  const fqdn = await vscode.window.showInputBox({
    title,
    prompt: promptText,
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A host name is required')
  });
  if (!fqdn) {
    return null;
  }

  const portStr = await vscode.window.showInputBox({
    title,
    prompt: `TCP port for ${fqdn.trim()}`,
    value: '1433',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 65535
        ? undefined
        : 'Enter a whole number between 1 and 65535';
    }
  });
  if (!portStr) {
    return null;
  }

  return routingUrl(fqdn.trim(), Number(portStr));
}

/** Checked entries first (by priority), then unchecked candidates (by name). */
function orderEntries(entries: RoutingListEntry[]): ReplicaItem[] {
  const checked = entries
    .filter((e) => e.routingPriority !== 255)
    .sort((a, b) => a.routingPriority - b.routingPriority)
    .map((e) => ({ name: e.replicaServerName, checked: true }));
  const unchecked = entries
    .filter((e) => e.routingPriority === 255)
    .sort((a, b) => a.replicaServerName.localeCompare(b.replicaServerName))
    .map((e) => ({ name: e.replicaServerName, checked: false }));
  // De-duplicate (a replica can appear in both halves of the union query).
  const seen = new Set<string>();
  return [...checked, ...unchecked].filter((i) => {
    if (seen.has(i.name)) {
      return false;
    }
    seen.add(i.name);
    return true;
  });
}

async function isRoundRobinAvailable(client: SqlClient, profileId: string): Promise<boolean> {
  try {
    const info = await client.getServerInfo(profileId);
    return info.majorVersion > 13; // SQL 2017+ supports load-balanced groups.
  } catch {
    return false;
  }
}

function renderHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  agName: string,
  replicaName: string,
  items: ReplicaItem[],
  roundRobinAvailable: boolean
): string {
  const nonce = String(Math.random()).slice(2);
  const data = JSON.stringify(items);
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  h2 { margin: 0 0 4px 0; font-size: 1.1em; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  li:last-child { border-bottom: none; }
  li.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  li .name { flex: 1; cursor: default; }
  .controls { margin-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.5; cursor: default; }
  label.rr { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 8px; }
</style>
</head>
<body>
  <h2>Read-Only Routing List</h2>
  <div class="sub">Availability Group <b>${escapeHtml(agName)}</b> &middot; primary replica <b>${escapeHtml(replicaName)}</b></div>

  <div class="controls" style="margin-bottom:8px;">
    <button id="up" class="secondary">Move Up</button>
    <button id="down" class="secondary">Move Down</button>
    <label class="rr"><input type="checkbox" id="roundRobin" ${roundRobinAvailable ? '' : 'disabled'}> Load balance (round-robin)</label>
  </div>

  <ul id="list"></ul>

  <div class="hint">Check the replicas to route read-only traffic to, in priority order. Use Move Up / Move Down to set priority. Any selected replica that has no read-only routing URL yet will be configured when you click Apply.</div>

  <div class="controls">
    <button id="apply">Apply to Server</button>
    <button id="generate" class="secondary">Generate Script</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let items = ${data};
  let selected = items.length ? 0 : -1;

  const listEl = document.getElementById('list');

  function render() {
    listEl.innerHTML = '';
    items.forEach((it, idx) => {
      const li = document.createElement('li');
      if (idx === selected) li.className = 'selected';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = it.checked;
      cb.addEventListener('change', () => { it.checked = cb.checked; });
      const span = document.createElement('span');
      span.className = 'name';
      span.textContent = it.name;
      span.addEventListener('click', () => { selected = idx; render(); });
      li.appendChild(cb);
      li.appendChild(span);
      li.addEventListener('click', (e) => { if (e.target !== cb) { selected = idx; render(); } });
      listEl.appendChild(li);
    });
    document.getElementById('up').disabled = selected <= 0;
    document.getElementById('down').disabled = selected < 0 || selected >= items.length - 1;
  }

  function move(delta) {
    const j = selected + delta;
    if (j < 0 || j >= items.length) return;
    const tmp = items[selected];
    items[selected] = items[j];
    items[j] = tmp;
    selected = j;
    render();
  }

  document.getElementById('up').addEventListener('click', () => move(-1));
  document.getElementById('down').addEventListener('click', () => move(1));

  function checkedNames() {
    return items.filter(i => i.checked).map(i => i.name);
  }

  document.getElementById('generate').addEventListener('click', () => {
    vscode.postMessage({ type: 'generate', checked: checkedNames(), roundRobin: document.getElementById('roundRobin').checked });
  });
  document.getElementById('apply').addEventListener('click', () => {
    vscode.postMessage({ type: 'apply', checked: checkedNames(), roundRobin: document.getElementById('roundRobin').checked });
  });

  // The extension tells us to uncheck replicas the user declined to configure.
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'uncheck') {
      const names = Array.isArray(msg.replica) ? msg.replica : [msg.replica];
      items.forEach(i => { if (names.indexOf(i.name) >= 0) i.checked = false; });
      render();
    }
  });

  render();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
