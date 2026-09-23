import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore, generateToken, type SecretBox } from '../../src/core/config';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'boo-config-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const box: SecretBox = {
  encrypt: (s) => `enc:${[...s].reverse().join('')}`,
  decrypt: (s) => [...s.slice(4)].reverse().join(''),
};

describe('ConfigStore', () => {
  it('generates a readable pairing token on first run and keeps it', async () => {
    expect(generateToken()).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    const file = join(dir, 'config.json');
    const a = await ConfigStore.load(file, join(dir, 'Notes'), box);
    const b = await ConfigStore.load(file, join(dir, 'Autre'), box);
    expect(b.get().token).toBe(a.get().token);
    expect(b.get().vault).toBe(join(dir, 'Notes'));
    expect(await a.regenerateToken()).not.toBe(b.get().token);
  });

  it('never writes the Notion secret in clear text', async () => {
    const file = join(dir, 'config.json');
    const store = await ConfigStore.load(file, dir, box);
    await store.setNotionToken('ntn_secret_123');
    expect(await readFile(file, 'utf8')).not.toContain('ntn_secret_123');
    expect(store.notionToken()).toBe('ntn_secret_123');
    await store.update({ notion: { autoSync: false } });
    expect(store.get().notion).toMatchObject({ autoSync: false });
    expect(store.notionToken()).toBe('ntn_secret_123');
    await store.setNotionToken(null);
    expect(store.notionToken()).toBe('');
  });
});
