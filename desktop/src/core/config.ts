import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_PORT } from './server';

export type Theme = 'auto' | 'dark' | 'light';

export interface AppConfig {
  port: number;
  /** Pairing token typed in the extension options. */
  token: string;
  /** Notes folder (Markdown + assets). */
  vault: string;
  notion: {
    /** Integration secret, encrypted with the OS keychain (DPAPI on Windows) when available. */
    tokenEnc: string | null;
    parentId: string | null;
    databaseId: string | null;
    databaseUrl: string | null;
    workspace: string | null;
    autoSync: boolean;
    /** Development / tests only: alternative API endpoint. */
    apiBase?: string;
  };
  openAtLogin: boolean;
  /** Closing the window keeps the app (and the extension link) running in the tray. */
  closeToTray: boolean;
  theme: Theme;
  /** First run done (welcome screen). */
  onboarded: boolean;
}

/** Human-friendly pairing token: 4 groups of 4 characters, no ambiguous letters. */
export function generateToken(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export function defaultConfig(vault: string): AppConfig {
  return {
    port: DEFAULT_PORT,
    token: generateToken(),
    vault,
    notion: {
      tokenEnc: null,
      parentId: null,
      databaseId: null,
      databaseUrl: null,
      workspace: null,
      autoSync: true,
    },
    openAtLogin: false,
    closeToTray: true,
    theme: 'auto',
    onboarded: false,
  };
}

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

/** Fallback when the OS offers no keychain (the file stays readable by the user only). */
export const plainBox: SecretBox = {
  encrypt: (plain) => `plain:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (sealed) => (sealed.startsWith('plain:') ? Buffer.from(sealed.slice(6), 'base64').toString('utf8') : ''),
};

export class ConfigStore {
  private config: AppConfig;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly file: string,
    initial: AppConfig,
    private readonly box: SecretBox,
  ) {
    this.config = initial;
  }

  static async load(file: string, defaultVault: string, box: SecretBox = plainBox): Promise<ConfigStore> {
    const defaults = defaultConfig(defaultVault);
    let stored: Partial<AppConfig> = {};
    try {
      stored = JSON.parse(await readFile(file, 'utf8')) as Partial<AppConfig>;
    } catch {
      // First run.
    }
    const config: AppConfig = {
      ...defaults,
      ...stored,
      notion: { ...defaults.notion, ...(stored.notion ?? {}) },
    };
    if (!config.token) config.token = generateToken();
    const store = new ConfigStore(file, config, box);
    await store.save();
    return store;
  }

  get(): AppConfig {
    return structuredClone(this.config);
  }

  async update(patch: Partial<Omit<AppConfig, 'notion'>> & { notion?: Partial<AppConfig['notion']> }): Promise<AppConfig> {
    this.config = {
      ...this.config,
      ...patch,
      notion: { ...this.config.notion, ...(patch.notion ?? {}) },
    };
    await this.save();
    return this.get();
  }

  notionToken(): string {
    const sealed = this.config.notion.tokenEnc;
    if (!sealed) return '';
    try {
      return sealed.startsWith('plain:') ? plainBox.decrypt(sealed) : this.box.decrypt(sealed);
    } catch {
      return '';
    }
  }

  async setNotionToken(token: string | null): Promise<void> {
    await this.update({ notion: { tokenEnc: token ? this.box.encrypt(token) : null } });
  }

  async regenerateToken(): Promise<string> {
    await this.update({ token: generateToken() });
    return this.config.token;
  }

  private save(): Promise<void> {
    const run = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
