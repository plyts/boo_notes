import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Library } from '../../src/core/library';
import { NotionClient } from '../../../src/shared/notion/client';
import { DATABASE_TITLE, NotionSync, type NotionConfig } from '../../src/core/notion/sync';
import type { ExtensionNote } from '../../src/core/types';
import { PARENT_PAGE_ID, startMockNotion, type MockNotion } from '../../tools/mock-notion.mjs';

let dir: string;
let lib: Library;
let mock: MockNotion;
let config: NotionConfig;
let sync: NotionSync;

const YT = 'youtube:abcdefghijk';
const note = (rev: number, markdown: string): ExtensionNote => ({
  id: YT,
  platform: 'youtube',
  kind: 'video',
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  title: 'React — Hooks',
  markdown,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000 + rev,
  rev,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'boo-notion-'));
  lib = new Library(join(dir, 'vault'));
  await lib.open();
  mock = startMockNotion();
  await mock.ready;
  config = { token: 'secret_test', parentId: null, databaseId: null, autoSync: false, apiBase: mock.url };
  sync = new NotionSync({
    library: lib,
    getConfig: () => config,
    saveDatabase: async (id) => {
      config = { ...config, databaseId: id };
    },
    clientOptions: { minIntervalMs: 0, sleep: async () => undefined },
    debounceMs: 20,
  });
});

afterEach(async () => {
  sync.dispose();
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

const calls = (method: string, pathRe: RegExp) =>
  mock.state.requests.filter((r) => r.method === method && pathRe.test(r.path)).length;

async function connect() {
  const res = await sync.connect('secret_test', `https://www.notion.so/Mes-cours-${PARENT_PAGE_ID.replace(/-/g, '')}`);
  config = { ...config, parentId: PARENT_PAGE_ID };
  return res;
}

describe('NotionSync.connect', () => {
  it('creates the course database under the chosen page', async () => {
    const res = await connect();
    expect(res.workspace).toBe('Espace de test');
    const db = [...mock.state.databases.values()][0];
    expect(db.parent.page_id).toBe(PARENT_PAGE_ID);
    expect(db.title[0].text.content).toBe(DATABASE_TITLE);
    expect(Object.keys(db.properties)).toEqual(
      expect.arrayContaining(['Nom', 'Type', 'Plateforme', 'Statut', 'Progression', 'Position', 'Source']),
    );
    expect(config.databaseId).toBe(db.id);
  });

  it('adopts an existing database and adds the missing columns', async () => {
    const created = await new NotionClient({ token: 'secret_test', baseUrl: mock.url, minIntervalMs: 0 }).createDatabase({
      parent: { type: 'page_id', page_id: PARENT_PAGE_ID },
      title: [{ type: 'text', text: { content: 'Mes cours' } }],
      properties: { Name: { title: {} } },
    });
    await sync.connect('secret_test', created.id);
    expect(config.databaseId).toBe(created.id);
    expect(Object.keys(mock.state.databases.get(created.id.replace(/-/g, ''))!.properties)).toContain('Progression');
  });

  it('explains what to fix', async () => {
    await expect(sync.connect('wrong', PARENT_PAGE_ID)).rejects.toThrow(/Jeton Notion refusé/);
    await expect(sync.connect('secret_test', 'https://www.notion.so/ffffffffffffffffffffffffffffffff')).rejects.toThrow(
      /partagez la page avec l’intégration/,
    );
    await expect(sync.connect('secret_test', 'pas un lien')).rejects.toThrow(/Lien Notion invalide/);
  });
});

describe('NotionSync.syncItem', () => {
  it('creates one page per course with its properties, the video and the note', async () => {
    await connect();
    await lib.putAsset('assets/cap-00-12-abcd.jpg', Buffer.from('jpeg'));
    await lib.upsertFromExtension(
      note(1, '# Hooks\n[00:05] Intro\n[00:12] ![Capture 00:12](assets/cap-00-12-abcd.jpg)'),
    );
    await lib.setProgress(YT, 300, 600);
    const { url, pageId } = await sync.syncItem(YT);
    expect(url).toMatch(/^https:\/\/www\.notion\.so\//);

    const page = mock.state.pages.get(pageId.replace(/-/g, ''))!;
    expect(page.icon).toEqual({ type: 'emoji', emoji: '🎬' });
    expect(page.properties).toMatchObject({
      Nom: { title: [{ text: { content: 'React — Hooks' } }] },
      Type: { select: { name: 'Vidéo' } },
      Plateforme: { select: { name: 'YouTube' } },
      Statut: { select: { name: 'En cours' } },
      Progression: { number: 0.5 },
      Position: { rich_text: [{ text: { content: '05:00 / 10:00' } }] },
      Notes: { number: 2 },
      Source: { url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    });
    expect(mock.pageContent(pageId)).toEqual([
      { type: 'video', text: '' },
      { type: 'heading_1', text: 'Hooks' },
      { type: 'paragraph', text: '00:05 Intro' },
      { type: 'image', text: '00:12' },
    ]);
    const upload = [...mock.state.uploads.values()][0];
    expect(upload).toMatchObject({ filename: 'cap-00-12-abcd.jpg', content_type: 'image/jpeg', status: 'uploaded' });
    expect(lib.get(YT)?.notion).toMatchObject({ pageId, syncedRev: 1, error: null });
    expect(lib.get(YT)?.notion?.blocks).toHaveLength(4);
  });

  it('only sends what changed', async () => {
    await connect();
    await lib.upsertFromExtension(note(1, '[00:05] Intro\n[00:10] Deux'));
    const { pageId } = await sync.syncItem(YT);

    // Appended line: one block added, nothing deleted.
    await lib.upsertFromExtension(note(2, '[00:05] Intro\n[00:10] Deux\n[00:20] Trois'));
    mock.state.requests.length = 0;
    await sync.syncItem(YT);
    expect(calls('DELETE', /blocks/)).toBe(0);
    expect(mock.state.requests.find((r) => r.method === 'PATCH' && /children/.test(r.path))?.body.children).toHaveLength(1);

    // Edited line in the middle: the tail from the edit is rewritten.
    await lib.upsertFromExtension(note(3, '[00:05] Intro\n[00:10] Deux (corrigé)\n[00:20] Trois'));
    mock.state.requests.length = 0;
    await sync.syncItem(YT);
    expect(calls('DELETE', /blocks/)).toBe(2);
    expect(mock.pageContent(pageId)!.map((b) => b.text)).toEqual(['', '00:05 Intro', '00:10 Deux (corrigé)', '00:20 Trois']);

    // Nothing changed: properties only.
    mock.state.requests.length = 0;
    await sync.syncItem(YT);
    expect(mock.state.requests.map((r) => `${r.method} ${r.path.split('/')[2]}`)).toEqual(['PATCH pages']);
  });

  it('recreates a page deleted in Notion, and the database too', async () => {
    await connect();
    await lib.upsertFromExtension(note(1, '[00:05] Intro'));
    const first = await sync.syncItem(YT);
    mock.state.pages.get(first.pageId.replace(/-/g, ''))!.in_trash = true;
    const second = await sync.syncItem(YT);
    expect(second.pageId).not.toBe(first.pageId);
    expect(mock.pageContent(second.pageId)).toHaveLength(2);

    mock.state.databases.clear();
    const fresh = new NotionSync({
      library: lib,
      getConfig: () => config,
      saveDatabase: async (id) => {
        config = { ...config, databaseId: id };
      },
      clientOptions: { minIntervalMs: 0, sleep: async () => undefined },
    });
    const third = await fresh.syncItem(YT);
    expect(mock.state.databases.size).toBe(1);
    expect(third.pageId).not.toBe(second.pageId);
  });

  it('syncs local PDFs with their highlights, in batches of 100 blocks', async () => {
    await connect();
    const pdf = join(dir, 'Cours.pdf');
    await writeFile(pdf, '%PDF-1.4');
    const item = await lib.addLocalFile(pdf);
    const lines = Array.from({ length: 150 }, (_, i) => `[p. ${i + 1}] Idée ${i + 1}`);
    await lib.saveNote(item.id, lines.join('\n'));
    await lib.setProgress(item.id, 10, 40);
    await lib.setHighlights(item.id, [
      { id: 'h1', page: 3, rects: [[0.1, 0.1, 0.5, 0.02]], text: 'Un passage important', color: 'yellow', createdAt: 1 },
    ]);
    const { pageId } = await sync.syncItem(item.id);
    const content = mock.pageContent(pageId)!;
    expect(content[0]).toEqual({ type: 'callout', text: 'Fichier local : Cours.pdf' });
    expect(content).toHaveLength(1 + 150 + 2);
    expect(content.at(-1)).toEqual({ type: 'quote', text: 'Un passage important p. 3' });
    expect(calls('PATCH', /children/)).toBe(2);
    const page = mock.state.pages.get(pageId.replace(/-/g, ''))!;
    expect(page.properties).toMatchObject({
      Type: { select: { name: 'PDF' } },
      Position: { rich_text: [{ text: { content: 'p. 10 / 40' } }] },
      Progression: { number: 0.25 },
      Source: { url: null },
    });
  });

  it('retries when Notion rate-limits, and records errors on the item', async () => {
    await connect();
    await lib.upsertFromExtension(note(1, '[00:05] Intro'));
    mock.state.rateLimitNext = 2;
    await expect(sync.syncItem(YT)).resolves.toBeTruthy();

    config = { ...config, token: 'revoked' };
    await lib.upsertFromExtension(note(2, '[00:05] Intro\nplus'));
    await expect(sync.syncItem(YT)).rejects.toThrow(/Jeton Notion refusé/);
    expect(lib.get(YT)?.notion?.error).toMatch(/Jeton Notion refusé/);
    expect(sync.state.lastError).toMatch(/Jeton Notion refusé/);
  });

  it('syncs automatically after changes when enabled (progress = properties only)', async () => {
    await connect();
    config = { ...config, autoSync: true };
    await lib.upsertFromExtension(note(1, '[00:05] Intro'));
    await vi.waitFor(() => expect(lib.get(YT)?.notion?.pageId).toBeTruthy(), { timeout: 3000 });
    mock.state.requests.length = 0;
    await lib.setProgress(YT, 590, 600);
    await vi.waitFor(() => expect(calls('PATCH', /pages/)).toBe(1), { timeout: 3000 });
    expect(calls('PATCH', /children/)).toBe(0);
    const page = mock.state.pages.get(lib.get(YT)!.notion!.pageId.replace(/-/g, ''))!;
    expect(page.properties.Statut).toEqual({ select: { name: 'Terminé' } });
  });

  it('turns [[links]] between sheets into mentions and a two-way relation', async () => {
    await connect();
    const db = [...mock.state.databases.values()][0];
    expect(db.is_inline).toBe(true);
    expect(db.properties.Liens.relation).toMatchObject({ type: 'dual_property' });
    expect(Object.keys(db.properties)).toEqual(expect.arrayContaining(['Liée depuis', 'Boo ID', 'Prochaine révision']));

    const forces = await lib.createNote('Forces', 'Une force se mesure en newtons.');
    const newton = await lib.createNote('Lois de Newton', 'Deuxième loi : voir [[Forces]] et [[Inconnue]].');
    await lib.review(newton.id, 'start', Date.UTC(2026, 4, 2, 12));
    const { pageId } = await sync.syncItem(newton.id);

    const forcesPage = lib.get(forces.id)!.notion!.pageId;
    expect(forcesPage).toBeTruthy();
    expect(mock.pageContent(pageId)).toEqual([{ type: 'paragraph', text: 'Deuxième loi : voir @Forces et Inconnue.' }]);
    const page = mock.state.pages.get(pageId.replace(/-/g, ''))!;
    expect(page.icon).toEqual({ type: 'emoji', emoji: '🗂️' });
    expect(page.properties).toMatchObject({
      Type: { select: { name: 'Fiche' } },
      Liens: { relation: [{ id: forcesPage }] },
      'Prochaine révision': { date: { start: '2026-05-02' } },
      'Boo ID': { rich_text: [{ text: { content: newton.id } }] },
    });
    // The linked sheet exists (empty until its own sync), and lists the backlink.
    const fetched = await new NotionClient({ token: 'secret_test', baseUrl: mock.url, minIntervalMs: 0 }).retrievePage(forcesPage);
    expect(fetched.properties?.['Liée depuis']).toEqual({ relation: [{ id: pageId }] });
    expect(mock.pageContent(forcesPage)).toEqual([]);
    await sync.syncItem(forces.id);
    expect(mock.pageContent(forcesPage)).toEqual([{ type: 'paragraph', text: 'Une force se mesure en newtons.' }]);
  });

  it('shows studied images in Notion', async () => {
    await connect();
    const png = join(dir, 'Offre et demande.png');
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const item = await lib.addLocalFile(png);
    await lib.saveNote(item.id, '[pin 1] Équilibre du marché');
    const { pageId } = await sync.syncItem(item.id);
    expect(mock.pageContent(pageId)).toEqual([
      { type: 'image', text: 'Offre et demande.png' },
      { type: 'paragraph', text: '◉ 1 Équilibre du marché' },
    ]);
    expect([...mock.state.uploads.values()][0]).toMatchObject({ filename: 'Offre et demande.png', content_type: 'image/png' });
  });

  it('adopts the page another device created for the same note (no duplicate)', async () => {
    await connect();
    await lib.upsertFromExtension(note(1, '[00:05] Intro'));
    const first = await sync.syncItem(YT);

    // Another device (the browser extension, another computer…) knows the note but not its page.
    const other = new Library(join(dir, 'other'));
    await other.open();
    await other.upsertFromExtension(note(2, '[00:05] Intro\n[00:09] Suite'));
    const otherSync = new NotionSync({
      library: other,
      getConfig: () => config,
      saveDatabase: async () => undefined,
      clientOptions: { minIntervalMs: 0, sleep: async () => undefined },
    });
    const second = await otherSync.syncItem(YT);
    expect(second.pageId).toBe(first.pageId);
    expect([...mock.state.pages.values()].filter((p) => p.parent?.database_id)).toHaveLength(1);
    expect(mock.pageContent(first.pageId)!.map((b) => b.text)).toEqual(['', '00:05 Intro', '00:09 Suite']);
  });
});

