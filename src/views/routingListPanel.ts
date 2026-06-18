import * as vscode from 'vscode';
import { SqlClient, RoutingListEntry } from '../sqlClient';
import { ConnectionProfile } from '../connection';
import { buildRoutingListScript } from '../scripts';

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

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'generate' || msg.type === 'apply') {
          const ordered: string[] = (msg.checked as string[]) ?? [];
          const script = buildRoutingListScript(
            agName,
            replicaName,
            ordered,
            !!msg.roundRobin
          );

          if (msg.type === 'generate') {
            const doc = await vscode.workspace.openTextDocument({
              language: 'sql',
              content: script
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
          await client.execute(profile.id, script);
          vscode.window.showInformationMessage(
            `Setting saved for Availability Group ${agName} replica ${replicaName}.`
          );
          onApplied();
          panel.dispose();
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          err instanceof Error ? err.message : String(err)
        );
      }
    });
  }
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

  <div class="hint">Check the replicas to route read-only traffic to, in priority order. Use Move Up / Move Down to set priority.</div>

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
