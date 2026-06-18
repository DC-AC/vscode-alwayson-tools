import * as vscode from 'vscode';
import { ConnectionProfile } from '../connection';
import { ProfileStore } from '../profileStore';
import { SqlClient } from '../sqlClient';

export type NodeKind = 'server' | 'ag' | 'replica';

export class TreeNode extends vscode.TreeItem {
  constructor(
    public readonly kind: NodeKind,
    public readonly label: string,
    public readonly profile: ConnectionProfile,
    collapsibleState: vscode.TreeItemCollapsibleState,
    /** AG name for ag/replica nodes. */
    public readonly agName?: string,
    /** Replica server name for replica nodes. */
    public readonly replicaName?: string
  ) {
    super(label, collapsibleState);
    this.contextValue = kind;
    switch (kind) {
      case 'server':
        this.iconPath = new vscode.ThemeIcon('server-environment');
        this.description = describeAuth(profile);
        this.tooltip = `${profile.server} (${describeAuth(profile)})`;
        break;
      case 'ag':
        this.iconPath = new vscode.ThemeIcon('symbol-namespace');
        break;
      case 'replica':
        this.iconPath = new vscode.ThemeIcon('database');
        break;
    }
  }
}

function describeAuth(p: ConnectionProfile): string {
  switch (p.authType) {
    case 'sql':
      return 'SQL auth';
    case 'windows':
      return 'Windows auth';
    case 'entra-password':
      return 'Entra (password)';
    case 'entra-integrated':
      return 'Entra (integrated)';
  }
}

export class AlwaysOnTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: ProfileStore,
    private readonly client: SqlClient
  ) {}

  refresh(node?: TreeNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return this.store.getAll().map(
        (p) =>
          new TreeNode(
            'server',
            p.server,
            p,
            vscode.TreeItemCollapsibleState.Collapsed
          )
      );
    }

    try {
      if (element.kind === 'server') {
        if (!this.client.isConnected(element.profile.id)) {
          const placeholder = new TreeNode(
            'ag',
            'Disconnected — click Reconnect',
            element.profile,
            vscode.TreeItemCollapsibleState.None
          );
          placeholder.iconPath = new vscode.ThemeIcon('debug-disconnect');
          placeholder.contextValue = 'disconnected';
          return [placeholder];
        }
        const ags = await this.client.getAvailabilityGroups(element.profile.id);
        if (ags.length === 0) {
          return [infoNode(element.profile, 'No availability groups found')];
        }
        return ags.map(
          (ag) =>
            new TreeNode(
              'ag',
              ag,
              element.profile,
              vscode.TreeItemCollapsibleState.Collapsed,
              ag
            )
        );
      }

      if (element.kind === 'ag') {
        const replicas = await this.client.getReplicas(
          element.profile.id,
          element.agName!
        );
        return replicas.map(
          (r) =>
            new TreeNode(
              'replica',
              r,
              element.profile,
              vscode.TreeItemCollapsibleState.None,
              element.agName,
              r
            )
        );
      }
    } catch (err) {
      return [infoNode(element.profile, errMessage(err))];
    }

    return [];
  }
}

function infoNode(profile: ConnectionProfile, label: string): TreeNode {
  const node = new TreeNode('ag', label, profile, vscode.TreeItemCollapsibleState.None);
  node.iconPath = new vscode.ThemeIcon('info');
  node.contextValue = 'info';
  return node;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
