import * as vscode from 'vscode';
import { ConnectionProfile } from './connection';

const PROFILES_KEY = 'alwaysonTools.profiles';
const SECRET_PREFIX = 'alwaysonTools.pwd.';

/**
 * Persists connection profiles in globalState and their passwords in
 * SecretStorage. Replaces the VB tool's GetSetting/SaveSetting "ServerList".
 */
export class ProfileStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getAll(): ConnectionProfile[] {
    return this.context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);
  }

  get(id: string): ConnectionProfile | undefined {
    return this.getAll().find((p) => p.id === id);
  }

  async upsert(profile: ConnectionProfile, password?: string): Promise<void> {
    const profiles = this.getAll().filter((p) => p.id !== profile.id);
    profiles.push(profile);
    profiles.sort((a, b) => a.server.localeCompare(b.server));
    await this.context.globalState.update(PROFILES_KEY, profiles);
    if (password !== undefined) {
      await this.context.secrets.store(SECRET_PREFIX + profile.id, password);
    }
  }

  async remove(id: string): Promise<void> {
    const profiles = this.getAll().filter((p) => p.id !== id);
    await this.context.globalState.update(PROFILES_KEY, profiles);
    await this.context.secrets.delete(SECRET_PREFIX + id);
  }

  async clear(): Promise<void> {
    for (const p of this.getAll()) {
      await this.context.secrets.delete(SECRET_PREFIX + p.id);
    }
    await this.context.globalState.update(PROFILES_KEY, []);
  }

  getPassword(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + id);
  }
}
