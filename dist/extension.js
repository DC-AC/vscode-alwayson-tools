"use strict";var se=Object.create;var _=Object.defineProperty;var ae=Object.getOwnPropertyDescriptor;var ce=Object.getOwnPropertyNames;var le=Object.getPrototypeOf,de=Object.prototype.hasOwnProperty;var ue=(n,e)=>{for(var t in e)_(n,t,{get:e[t],enumerable:!0})},V=(n,e,t,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of ce(e))!de.call(n,i)&&i!==t&&_(n,i,{get:()=>e[i],enumerable:!(r=ae(e,i))||r.enumerable});return n};var C=(n,e,t)=>(t=n!=null?se(le(n)):{},V(e||!n||!n.__esModule?_(t,"default",{value:n,enumerable:!0}):t,n)),ge=n=>V(_({},"__esModule",{value:!0}),n);var De={};ue(De,{activate:()=>Ce,deactivate:()=>xe});module.exports=ge(De);var a=C(require("vscode"));var I="alwaysonTools.profiles",T="alwaysonTools.pwd.",E=class{constructor(e){this.context=e}getAll(){return this.context.globalState.get(I,[])}get(e){return this.getAll().find(t=>t.id===e)}async upsert(e,t){let r=this.getAll().filter(i=>i.id!==e.id);r.push(e),r.sort((i,o)=>i.server.localeCompare(o.server)),await this.context.globalState.update(I,r),t!==void 0&&await this.context.secrets.store(T+e.id,t)}async remove(e){let t=this.getAll().filter(r=>r.id!==e);await this.context.globalState.update(I,t),await this.context.secrets.delete(T+e)}async clear(){for(let e of this.getAll())await this.context.secrets.delete(T+e.id);await this.context.globalState.update(I,[])}getPassword(e){return this.context.secrets.get(T+e)}};var M=C(require("mssql"));function j(n,e){let t={server:me(n.server),port:n.port,database:"master",options:{encrypt:n.encrypt,trustServerCertificate:n.trustServerCertificate,instanceName:pe(n.server)},connectionTimeout:15e3,requestTimeout:3e4};switch(n.authType){case"sql":t.authentication={type:"default",options:{userName:n.userName,password:e}};break;case"windows":t.authentication={type:"ntlm",options:{domain:n.domain??"",userName:n.userName??"",password:e??""}};break;case"entra-password":t.authentication={type:"azure-active-directory-password",options:{userName:n.userName,password:e}};break;case"entra-integrated":t.authentication={type:"azure-active-directory-default",options:{}};break}return t}function pe(n){let e=n.indexOf("\\");return e>=0?n.substring(e+1):void 0}function me(n){let e=n.indexOf("\\");return e>=0?n.substring(0,e):n}function x(n){return`'${n.replace(/'/g,"''")}'`}var R=class{constructor(e){this.pool=e}get connected(){return this.pool.connected}async rows(e){return(await this.pool.request().query(e)).recordset??[]}async exec(e){await this.pool.request().batch(e)}async close(){try{await this.pool.close()}catch{}}},$=class{constructor(e){this.shared=e}get connected(){return this.shared.isConnected()}rows(e){return this.shared.rows(e)}exec(e){return this.shared.exec(e)}async close(){}},A=class{constructor(){this.executors=new Map}async connect(e,t){let r=this.executors.get(e.id);if(r&&r.connected)return;r&&(await r.close(),this.executors.delete(e.id));let i=new M.ConnectionPool(j(e,t));await i.connect(),this.executors.set(e.id,new R(i))}async connectWithString(e,t){let r=this.executors.get(e);r&&(await r.close(),this.executors.delete(e));let i=new M.ConnectionPool(t);await i.connect(),this.executors.set(e,new R(i))}registerShared(e,t){let r=this.executors.get(e);r&&r.close(),this.executors.set(e,new $(t))}isConnected(e){let t=this.executors.get(e);return!!t&&t.connected}async disconnect(e){let t=this.executors.get(e);t&&(await t.close(),this.executors.delete(e))}async disconnectAll(){for(let e of Array.from(this.executors.keys()))await this.disconnect(e)}executor(e){let t=this.executors.get(e);if(!t||!t.connected)throw new Error("Not connected to this server. Use Reconnect.");return t}async getServerInfo(e){let r=(await this.executor(e).rows("select cast(SERVERPROPERTY('ProductVersion') as varchar(64)) ProductVersion, cast(SERVERPROPERTY('IsHadrEnabled') as int) IsHadrEnabled"))[0]??{},i=String(r.ProductVersion??""),o=parseInt(i.split(".")[0]||"0",10);return{productVersion:i,majorVersion:o,isHadrEnabled:Number(r.IsHadrEnabled)===1}}async isSysadmin(e){let t=await this.executor(e).rows("select IS_SRVROLEMEMBER('sysadmin') as IsSysadmin");return Number(t[0]?.IsSysadmin)===1}async getMachineDomain(e){try{let r=(await this.executor(e).rows(`DECLARE @Domain varchar(512), @key varchar(100)
SET @key = 'SYSTEM\\ControlSet001\\Services\\Tcpip\\Parameters\\'
EXEC master..xp_regread @rootkey='HKEY_LOCAL_MACHINE', @key=@key, @value_name='Domain', @value=@Domain OUTPUT
select @Domain as domain`))[0]?.domain;return r?String(r):null}catch{return null}}async getAvailabilityGroups(e){return(await this.executor(e).rows(`select ag.name
from sys.availability_groups ag
join sys.dm_hadr_availability_replica_states ars
  on ars.group_id = ag.group_id
where ars.is_local = 1
  and ars.role = 1
order by ag.name`)).map(r=>String(r.name))}async getReplicas(e,t){return(await this.executor(e).rows(`select replica_server_name
from sys.availability_replicas
join sys.availability_groups on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = ${x(t)}
order by replica_server_name`)).map(i=>String(i.replica_server_name))}async getRoutingUrl(e,t,r){let o=(await this.executor(e).rows(`select availability_replicas.read_only_routing_url
from sys.availability_replicas
join sys.availability_groups on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = ${x(t)}
and replica_server_name = ${x(r)}`))[0];return o&&o.read_only_routing_url!=null?String(o.read_only_routing_url):null}async getRoutingList(e,t,r){let i=x(t),o=x(r),c=await this.executor(e).rows(`select secondary.replica_server_name, routing_priority
from sys.availability_groups
inner join sys.availability_replicas on availability_replicas.group_id = availability_groups.group_id
left outer join sys.availability_read_only_routing_lists on availability_read_only_routing_lists.replica_id = availability_replicas.replica_id
left outer join sys.availability_replicas secondary on availability_read_only_routing_lists.read_only_replica_id = secondary.replica_id
where availability_groups.name = ${i}
  and availability_replicas.replica_server_name = ${o}
union all
select replica_server_name, 255
from sys.availability_replicas
join sys.availability_groups on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = ${i}
  and replica_server_name not in (select secondary.replica_server_name
                from sys.availability_groups
                inner join sys.availability_replicas on availability_replicas.group_id = availability_groups.group_id
                left outer join sys.availability_read_only_routing_lists on availability_read_only_routing_lists.replica_id = availability_replicas.replica_id
                left outer join sys.availability_replicas secondary on availability_read_only_routing_lists.read_only_replica_id = secondary.replica_id
                where availability_groups.name = ${i}
                  and availability_replicas.replica_server_name = ${o})
  and replica_server_name <> ${o}
order by 2, 1`);return c.length===1&&c[0].replica_server_name==null&&(c=await this.executor(e).rows(`select replica_server_name, 255 as routing_priority
from sys.availability_groups
inner join sys.availability_replicas on availability_replicas.group_id = availability_groups.group_id
where availability_groups.name = ${i}
  and availability_replicas.replica_server_name <> ${o}
order by 2, 1`)),c.filter(s=>s.replica_server_name!=null).map(s=>({replicaServerName:String(s.replica_server_name),routingPriority:Number(s.routing_priority)}))}async execute(e,t){await this.executor(e).exec(t)}};var m=C(require("vscode")),y=class extends m.TreeItem{constructor(t,r,i,o,c,s){super(r,o);this.kind=t;this.label=r;this.profile=i;this.agName=c;this.replicaName=s;switch(this.contextValue=t,t){case"server":this.iconPath=new m.ThemeIcon("server-environment"),this.description=Q(i),this.tooltip=`${i.server} (${Q(i)})`;break;case"ag":this.iconPath=new m.ThemeIcon("symbol-namespace");break;case"replica":this.iconPath=new m.ThemeIcon("database");break}}};function Q(n){switch(n.authType){case"sql":return"SQL auth";case"windows":return"Windows auth";case"entra-password":return"Entra (password)";case"entra-integrated":return"Entra (integrated)"}}var q=class{constructor(e,t){this.store=e;this.client=t;this._onDidChangeTreeData=new m.EventEmitter;this.onDidChangeTreeData=this._onDidChangeTreeData.event}refresh(e){this._onDidChangeTreeData.fire(e)}getTreeItem(e){return e}async getChildren(e){if(!e)return this.store.getAll().map(t=>new y("server",t.server,t,m.TreeItemCollapsibleState.Collapsed));try{if(e.kind==="server"){if(!this.client.isConnected(e.profile.id)){let r=new y("ag","Disconnected \u2014 click Reconnect",e.profile,m.TreeItemCollapsibleState.None);return r.iconPath=new m.ThemeIcon("debug-disconnect"),r.contextValue="disconnected",[r]}let t=await this.client.getAvailabilityGroups(e.profile.id);return t.length===0?[G(e.profile,"No availability groups are primary on this instance")]:t.map(r=>new y("ag",r,e.profile,m.TreeItemCollapsibleState.Collapsed,r))}if(e.kind==="ag")return(await this.client.getReplicas(e.profile.id,e.agName)).map(r=>new y("replica",r,e.profile,m.TreeItemCollapsibleState.None,e.agName,r))}catch(t){return[G(e.profile,f(t))]}return[]}};function G(n,e){let t=new y("ag",e,n,m.TreeItemCollapsibleState.None);return t.iconPath=new m.ThemeIcon("info"),t.contextValue="info",t}function f(n){return n instanceof Error?n.message:String(n)}var w=C(require("vscode"));function B(n,e,t,r=!1){if(t.length===0)return`ALTER AVAILABILITY GROUP [${n}]
MODIFY REPLICA ON '${e}'
WITH (PRIMARY_ROLE (READ_ONLY_ROUTING_LIST = NONE))`;let i=t.map(c=>`'${c}'`),o=r?`(${i.join(", ")})`:i.join(", ");return`ALTER AVAILABILITY GROUP [${n}]
MODIFY REPLICA ON '${e}'
WITH (PRIMARY_ROLE (READ_ONLY_ROUTING_LIST = (${o})))`}function L(n,e,t){return`ALTER AVAILABILITY GROUP [${n}]
MODIFY REPLICA ON '${e}'
WITH (SECONDARY_ROLE (READ_ONLY_ROUTING_URL='${t}'))`}function N(n,e){return`TCP://${n}:${e}`}function W(n,e,t,r){return L(n,e,N(t,r))}var k=class{static async show(e,t,r,i,o,c){let s=await t.getRoutingList(r.id,i,o),d=fe(s),g=await ye(t,r.id),l=w.window.createWebviewPanel("alwaysonRoutingList",`Routing List: ${o}`,w.ViewColumn.Active,{enableScripts:!0,retainContextWhenHidden:!0});l.webview.html=he(l.webview,e,i,o,d,g);let u=!1;l.webview.onDidReceiveMessage(async p=>{if(!(p.type!=="generate"&&p.type!=="apply")&&!u){u=!0;try{let v=p.checked??[],b=p.type==="apply",S=await we(t,r,i,v,l,b);if(S===null)return;let D=B(i,o,v,!!p.roundRobin);if(p.type==="generate"){let F=["-- Read-only routing URLs for the read-only replicas",...S.map(oe=>oe+`
GO`),"-- Read-only routing list for the primary replica",D+`
GO`],ie=await w.workspace.openTextDocument({language:"sql",content:F.join(`

`)});await w.window.showTextDocument(ie,{preview:!1});return}if(v.length===0&&await w.window.showWarningMessage("No read-only replicas are selected. This disables read-only routing for this replica. Continue?",{modal:!0},"Yes")!=="Yes")return;await t.execute(r.id,D),w.window.showInformationMessage(`Setting saved for Availability Group ${i} replica ${o}.`),c(),l.dispose()}catch(v){w.window.showErrorMessage(v instanceof Error?v.message:String(v))}finally{u=!1}}})}};async function we(n,e,t,r,i,o){let c=new Map,s=[];for(let d of r){let g=await n.getRoutingUrl(e.id,t,d).catch(()=>null);g?c.set(d,g):s.push(d)}if(s.length>0){let d=s.length===1?`Replica '${s[0]}' has`:`${s.length} selected replicas have`;if(await w.window.showWarningMessage(`${d} no read-only routing URL, which is required before ${s.length===1?"it":"they"} can receive read-only connections:

`+s.join(`
`)+`

Configure ${s.length===1?"it":"them"} now?`,{modal:!0},"Configure")!=="Configure")return i.webview.postMessage({type:"uncheck",replica:s}),null;let l=await n.getMachineDomain(e.id).catch(()=>null);for(let u=0;u<s.length;u++){let p=s[u],v=await ve(p,l,u+1,s.length);if(!v)return i.webview.postMessage({type:"uncheck",replica:s.slice(u)}),w.window.showWarningMessage("Cancelled \u2014 not all routing URLs were configured."),null;c.set(p,v),o&&(await n.execute(e.id,L(t,p,v)),w.window.showInformationMessage(`Read-only routing URL configured for ${p}.`))}}return r.map(d=>L(t,d,c.get(d)))}async function ve(n,e,t,r){let i=r>1?` (${t} of ${r})`:"",o=`Read-Only Routing URL for ${n}${i}`,c=n,s="Fully qualified domain name for the replica (recommended over the bare server name)";e&&!n.includes(".")&&(c=`${n}.${e}`,s=`Auto-detected domain "${e}". Confirm or edit the full routing FQDN (it must resolve to ${n}).`);let d=await w.window.showInputBox({title:o,prompt:s,value:c,ignoreFocusOut:!0,validateInput:l=>l.trim()?void 0:"A host name is required"});if(!d)return null;let g=await w.window.showInputBox({title:o,prompt:`TCP port for ${d.trim()}`,value:"1433",ignoreFocusOut:!0,validateInput:l=>{let u=Number(l);return Number.isInteger(u)&&u>=1&&u<=65535?void 0:"Enter a whole number between 1 and 65535"}});return g?N(d.trim(),Number(g)):null}function fe(n){let e=n.filter(i=>i.routingPriority!==255).sort((i,o)=>i.routingPriority-o.routingPriority).map(i=>({name:i.replicaServerName,checked:!0})),t=n.filter(i=>i.routingPriority===255).sort((i,o)=>i.replicaServerName.localeCompare(o.replicaServerName)).map(i=>({name:i.replicaServerName,checked:!1})),r=new Set;return[...e,...t].filter(i=>r.has(i.name)?!1:(r.add(i.name),!0))}async function ye(n,e){try{return(await n.getServerInfo(e)).majorVersion>13}catch{return!1}}function he(n,e,t,r,i,o){let c=String(Math.random()).slice(2),s=JSON.stringify(i);return`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${`default-src 'none'; style-src ${n.cspSource} 'unsafe-inline'; script-src 'nonce-${c}';`}">
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
  <div class="sub">Availability Group <b>${Y(t)}</b> &middot; primary replica <b>${Y(r)}</b></div>

  <div class="controls" style="margin-bottom:8px;">
    <button id="up" class="secondary">Move Up</button>
    <button id="down" class="secondary">Move Down</button>
    <label class="rr"><input type="checkbox" id="roundRobin" ${o?"":"disabled"}> Load balance (round-robin)</label>
  </div>

  <ul id="list"></ul>

  <div class="hint">Check the replicas to route read-only traffic to, in priority order. Use Move Up / Move Down to set priority. Any selected replica that has no read-only routing URL yet will be configured when you click Apply.</div>

  <div class="controls">
    <button id="apply">Apply to Server</button>
    <button id="generate" class="secondary">Generate Script</button>
  </div>

<script nonce="${c}">
  const vscode = acquireVsCodeApi();
  let items = ${s};
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
</html>`}function Y(n){return n.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}var h=C(require("vscode")),H="dcac.alwayson-tools",z="ms-mssql.mssql";async function K(){let n=h.extensions.getExtension(z);if(n)return n.isActive?n.exports:await n.activate()}async function X(){let n=await K();if(n?.promptForConnection)return n.promptForConnection(!0)}function J(n){let e=h.workspace.getConfiguration("mssql").inspect("connections"),t=[...e?.globalValue??[],...e?.workspaceValue??[],...e?.workspaceFolderValue??[]],r=(n.server??"").toLowerCase(),i=(n.user??"").toLowerCase(),o=n.authenticationType??"";return t.find(s=>!!s.id&&(s.server??"").toLowerCase()===r&&(s.authenticationType??"")===o&&(s.user??"").toLowerCase()===i)?.id}function Z(){return!!h.extensions.getExtension(z)}async function be(){return(await K())?.connectionSharing}function Se(n){let e=n.columnInfo.map(t=>t.columnName);return n.rows.map(t=>{let r={};return t.forEach((i,o)=>{r[e[o]]=i.isNull?null:i.displayValue}),r})}async function O(n){let e=await be();if(!e)return;let t;try{t=await e.connect(H,n,"master")}catch{await h.window.showWarningMessage("The SQL Server extension declined to share this connection. Grant permission to AlwaysOn Tools?","Edit Permissions")==="Edit Permissions"&&await e.editConnectionSharingPermissions(H);return}if(!t)return;let r=t;return{isConnected:()=>e.isConnected(r),rows:async i=>Se(await e.executeSimpleQuery(r,i)),exec:async i=>{await e.executeSimpleQuery(r,i)}}}function Ce(n){let e=new E(n),t=new A,r=new q(e,t),i=a.window.createTreeView("alwaysonTools.servers",{treeDataProvider:r});n.subscriptions.push(i),n.subscriptions.push(a.commands.registerCommand("alwaysonTools.addServer",()=>_e(e,t,r)),a.commands.registerCommand("alwaysonTools.refresh",()=>r.refresh()),a.commands.registerCommand("alwaysonTools.removeServer",o=>Ae(e,t,r,o)),a.commands.registerCommand("alwaysonTools.reconnect",o=>Re(e,t,r,o)),a.commands.registerCommand("alwaysonTools.configureRoutingList",o=>Le(n,t,r,o)),a.commands.registerCommand("alwaysonTools.configureRoutingUrl",o=>ke(t,r,o)),a.commands.registerCommand("alwaysonTools.clearServerList",()=>qe(e,t,r)),a.commands.registerCommand("alwaysonTools.about",Ue),a.commands.registerCommand("alwaysonTools.configureFromObjectExplorer",o=>Ne(n,e,t,r,o)))}async function xe(){}var Pe=[{label:"SQL Server Authentication",value:"sql",detail:"User name and password"},{label:"Windows Authentication",value:"windows",detail:"NTLM: domain\\user and password"},{label:"Microsoft Entra - Password",value:"entra-password",detail:"Azure AD user and password"},{label:"Microsoft Entra - Integrated",value:"entra-integrated",detail:"Use the signed-in Azure identity (no credentials)"}];async function _e(n,e,t){if(Z()){let r=await X();if(!r)return;let i=J(r);if(i&&await Ie(n,e,t,r,i))return;let{profile:o,password:c,connectionString:s}=Te(r);await ne(n,e,t,o,c,s);return}await Ee(n,e,t)}async function Ie(n,e,t,r,i){let o={id:`mssql-shared::${i}`,server:r.server||"SQL Server",authType:ee(r.authenticationType),userName:r.user||void 0,encrypt:!1,trustServerCertificate:!0,sharedConnectionId:i};return a.window.withProgress({location:{viewId:"alwaysonTools.servers"},title:`Connecting to ${o.server} via the SQL Server extension...`},async()=>{try{let c=await O(i);if(!c)return!1;e.registerShared(o.id,c);let s=await e.getServerInfo(o.id);return s.majorVersion<11?(await e.disconnect(o.id),a.window.showErrorMessage("This version of SQL Server does not support AlwaysOn Availability Groups (requires SQL Server 2012 or later)."),!0):s.isHadrEnabled?(await n.upsert(o),t.refresh(),a.window.showInformationMessage(`Connected to ${o.server}.`),await P(e,o.id),!0):(await e.disconnect(o.id),a.window.showErrorMessage("AlwaysOn Availability Groups is not enabled on this instance."),!0)}catch(c){return a.window.showErrorMessage(`Connection failed: ${f(c)}`),!0}})}function Te(n){let e=ee(n.authenticationType),t=n.encrypt===!0||n.encrypt==="Mandatory"||n.encrypt==="Strict";return{profile:{id:`${n.server}::${e}::${n.user??""}`,server:n.server,port:n.port,authType:e,userName:n.user||void 0,encrypt:t||e.startsWith("entra"),trustServerCertificate:n.trustServerCertificate??!t,fromConnectionString:!n.server&&!!n.connectionString},password:n.password||void 0,connectionString:n.connectionString}}function ee(n){switch(n){case"Integrated":return"windows";case"AzureMFA":return"entra-integrated";case"SqlLogin":return"sql";default:return n?.toLowerCase().includes("password")?"entra-password":"sql"}}async function ne(n,e,t,r,i,o){await a.window.withProgress({location:{viewId:"alwaysonTools.servers"},title:`Connecting to ${r.server}...`},async()=>{try{r.fromConnectionString&&o?await e.connectWithString(r.id,o):await e.connect(r,i);let c=await e.getServerInfo(r.id);if(c.majorVersion<11){await e.disconnect(r.id),a.window.showErrorMessage("This version of SQL Server does not support AlwaysOn Availability Groups (requires SQL Server 2012 or later).");return}if(!c.isHadrEnabled){await e.disconnect(r.id),a.window.showErrorMessage("AlwaysOn Availability Groups is not enabled on this instance. Enable it and configure an Availability Group before using this tool.");return}await n.upsert(r,r.fromConnectionString?o:i),t.refresh(),a.window.showInformationMessage(`Connected to ${r.server}.`),await P(e,r.id)}catch(c){a.window.showErrorMessage(`Connection failed: ${f(c)}`)}})}async function Ee(n,e,t){let r=await a.window.showInputBox({title:"Connect to SQL Server",prompt:"Server / instance name (e.g. SERVER, SERVER\\INSTANCE, or listener.contoso.com)",ignoreFocusOut:!0,validateInput:l=>l.trim()?void 0:"Server name is required"});if(!r)return;let i=await a.window.showQuickPick(Pe,{title:"Authentication",ignoreFocusOut:!0});if(!i)return;let o,c,s;if(i.value==="windows"){let l=await a.window.showInputBox({title:"Windows Authentication",prompt:"Account as DOMAIN\\user (or user)",ignoreFocusOut:!0,validateInput:p=>p.trim()?void 0:"Account is required"});if(!l)return;let u=l.indexOf("\\");if(u>=0?(c=l.substring(0,u),o=l.substring(u+1)):o=l,s=await U(),s===void 0)return}else if((i.value==="sql"||i.value==="entra-password")&&(o=await a.window.showInputBox({title:i.label,prompt:"User name",ignoreFocusOut:!0,validateInput:l=>l.trim()?void 0:"User name is required"}),!o||(s=await U(),s===void 0)))return;let d=i.value.startsWith("entra"),g={id:`${r}::${i.value}::${o??""}`,server:r.trim(),authType:i.value,userName:o,domain:c,encrypt:d,trustServerCertificate:!d};await ne(n,e,t,g,s)}async function P(n,e){try{await n.isSysadmin(e)||a.window.showWarningMessage("You are not a member of the sysadmin fixed server role on this instance. Configuring read-only routing requires sysadmin, so changes will fail until you connect with a sysadmin login.")}catch{}}function U(){return a.window.showInputBox({title:"Password",prompt:"Password",password:!0,ignoreFocusOut:!0})}async function Re(n,e,t,r){let i=r?.profile;if(!i)return;if(i.sharedConnectionId){await a.window.withProgress({location:{viewId:"alwaysonTools.servers"},title:`Connecting to ${i.server} via the SQL Server extension...`},async()=>{try{let s=await O(i.sharedConnectionId);if(!s)return;e.registerShared(i.id,s),t.refresh(),await P(e,i.id)}catch(s){a.window.showErrorMessage(`Connection failed: ${f(s)}`)}});return}let o=await n.getPassword(i.id),c=o;if(!i.fromConnectionString&&c===void 0&&i.authType!=="entra-integrated"){if(c=await U(),c===void 0)return;await n.upsert(i,c)}await a.window.withProgress({location:{viewId:"alwaysonTools.servers"},title:`Connecting to ${i.server}...`},async()=>{try{i.fromConnectionString&&o?await e.connectWithString(i.id,o):await e.connect(i,c),t.refresh(),await P(e,i.id)}catch(s){a.window.showErrorMessage(`Connection failed: ${f(s)}`)}})}async function Ae(n,e,t,r){let i=r?.profile;!i||await a.window.showWarningMessage(`Remove server ${i.server}?`,{modal:!0},"Remove")!=="Remove"||(await e.disconnect(i.id),await n.remove(i.id),t.refresh())}async function qe(n,e,t){await a.window.showWarningMessage("Clear the entire saved server list?",{modal:!0},"Clear")==="Clear"&&(await e.disconnectAll(),await n.clear(),t.refresh())}async function Le(n,e,t,r){!r||r.kind!=="replica"||!r.agName||!r.replicaName||await te(n,e,t,r.profile,r.agName,r.replicaName)}async function te(n,e,t,r,i,o){try{await k.show(n,e,r,i,o,()=>t.refresh())}catch(c){a.window.showErrorMessage(f(c))}}async function ke(n,e,t){!t||t.kind!=="replica"||!t.agName||!t.replicaName||await re(n,e,t.profile,t.agName,t.replicaName)}async function re(n,e,t,r,i){let o=await n.getRoutingUrl(t.id,r,i).catch(()=>null),c=await a.window.showInputBox({title:`Read-Only Routing URL for ${i}`,prompt:"Fully qualified domain name for the replica (recommended over the bare server name)",value:o?Oe(o):i,ignoreFocusOut:!0,validateInput:l=>l.trim()?void 0:"A host name is required"});if(!c)return;let s=await a.window.showInputBox({title:`Read-Only Routing URL for ${i}`,prompt:"TCP port",value:o?Me(o):"1433",ignoreFocusOut:!0,validateInput:l=>{let u=Number(l);if(!Number.isInteger(u)||u<1||u>65535)return"Enter a whole number between 1 and 65535"}});if(!s||c.trim()===i&&c.indexOf(".")<0&&await a.window.showWarningMessage("The routing URL uses only the server name, not a fully qualified domain name. This is not recommended. Continue?",{modal:!0},"Yes")!=="Yes")return;let d=W(r,i,c.trim(),Number(s)),g=await a.window.showQuickPick([{label:"Apply to Server",value:"apply"},{label:"Generate Script",value:"generate"}],{title:"Read-Only Routing URL",ignoreFocusOut:!0});if(g){if(g.value==="generate"){let l=await a.workspace.openTextDocument({language:"sql",content:d});await a.window.showTextDocument(l,{preview:!1});return}try{await n.execute(t.id,d),a.window.showInformationMessage(`Read-only routing URL configured for ${i}.`),e.refresh()}catch(l){a.window.showErrorMessage(f(l))}}}function Oe(n){let e=/TCP:\/\/(.+):(\d+)/i.exec(n);return e?e[1]:n}function Me(n){let e=/TCP:\/\/(.+):(\d+)/i.exec(n);return e?e[2]:"1433"}function $e(n){let e=n?.connectionProfile??n?.connectionInfo??n?.sqlConnectionInfo??n?.connection;return{connectionId:typeof e?.id=="string"?e.id:void 0,server:typeof e?.server=="string"?e.server:void 0}}async function Ne(n,e,t,r,i){let{connectionId:o,server:c}=$e(i);if(!o){a.window.showErrorMessage("Could not read the connection from the selected SQL Server node. Make sure the server is connected in the SQL Server extension.");return}let s={id:`mssql-shared::${o}`,server:c??"SQL Server",authType:"sql",encrypt:!1,trustServerCertificate:!0};if(!await a.window.withProgress({location:a.ProgressLocation.Notification,title:`Connecting to ${s.server} via the SQL Server extension...`},async()=>{try{let b=await O(o);if(!b)return!1;t.registerShared(s.id,b);let S=await t.getServerInfo(s.id);return S.majorVersion<11||!S.isHadrEnabled?(a.window.showErrorMessage("This instance is not a SQL Server 2012+ instance with AlwaysOn Availability Groups enabled."),!1):(await P(t,s.id),!0)}catch(b){return a.window.showErrorMessage(`Connection failed: ${f(b)}`),!1}}))return;let g=await t.getAvailabilityGroups(s.id);if(g.length===0){a.window.showInformationMessage("No AlwaysOn Availability Groups are primary on this instance. Connect to the primary replica (or the AG listener).");return}let l=g.length===1?g[0]:await a.window.showQuickPick(g,{title:"Select an Availability Group",ignoreFocusOut:!0});if(!l)return;let u=await t.getReplicas(s.id,l),p=await a.window.showQuickPick(u,{title:`Configure read-only routing for which primary replica in ${l}?`,placeHolder:"Pick the replica to act as primary \u2014 you\u2019ll set which replicas serve read-only traffic (and in what order) when it is primary",ignoreFocusOut:!0});if(!p)return;let v=await a.window.showQuickPick([{label:"$(list-ordered) Configure Read-Only Routing List...",value:"list"},{label:"$(link) Configure Read-Only Routing URL...",value:"url"}],{title:`${p}`,ignoreFocusOut:!0});v&&(v.value==="list"?await te(n,t,r,s,l,p):await re(t,r,s,l,p))}function Ue(){a.window.showInformationMessage("AlwaysOn Tools \u2014 Read-Only Routing Configuration. A VS Code port of the Denny Cherry & Associates Consulting AlwaysOn Tools.")}0&&(module.exports={activate,deactivate});
