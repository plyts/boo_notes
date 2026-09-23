import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { DesktopSync } from '../../../src/background/sync';
import { NoteStore } from '../../../src/shared/store';
import { MemoryArea } from '../../../tests/unit/helpers';
import { Library } from '../../src/core/library';
import { ExtensionServer, isAllowedOrigin } from '../../src/core/server';

let dir: string;
let lib: Library;
let server: ExtensionServer;
const exports: Array<[string, string]> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'boo-server-'));
  lib = new Library(join(dir, 'vault'));
  await lib.open();
  exports.length = 0;
  server = new ExtensionServer({
    library: lib,
    port: 0,
    getToken: () => 'ABCD-EFGH-JKLM-NPQR',
    app: { name: 'Boo Notes Desktop', version: '0.1.0' },
    onExport: async (noteId, target) => {
      exports.push([noteId, target]);
      if (target === 'notion') throw new Error('Notion n’est pas connecté');
      return 'Enregistré';
    },
  });
  await server.start(0);
});

afterEach(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

function connect(origin = 'chrome-extension://abcdefghijklmnop'): Promise<{ ws: WebSocket; next(): Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin });
    const queue: any[] = [];
    const waiters: Array<(m: any) => void> = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    });
    ws.on('open', () =>
      resolve({
        ws,
        next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
      }),
    );
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

describe('ExtensionServer', () => {
  it('only accepts browser extensions', async () => {
    expect(isAllowedOrigin('chrome-extension://abc')).toBe(true);
    expect(isAllowedOrigin('moz-extension://abc')).toBe(true);
    expect(isAllowedOrigin('https://evil.test')).toBe(false);
    await expect(connect('https://evil.test')).rejects.toThrow(/401/);
  });

  it('requires the pairing token', async () => {
    const { ws, next } = await connect();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'wrong' }));
    expect(await next()).toMatchObject({ type: 'error', code: 'unauthorized' });
    const code = await new Promise((r) => ws.on('close', r));
    expect(code).toBe(4001);
  });

  it('stores notes, captures and progress, and answers exports', async () => {
    const clients: number[] = [];
    server.on('clients', (n) => clients.push(n));
    const { ws, next } = await connect();
    const send = (m: object) => ws.send(JSON.stringify(m));
    send({ type: 'hello', protocol: 1, token: 'ABCD-EFGH-JKLM-NPQR', client: { name: 'test', version: '1' } });
    expect(await next()).toMatchObject({ type: 'welcome', protocol: 1, app: { name: 'Boo Notes Desktop' } });
    expect(server.clients).toBe(1);

    send({ type: 'asset.put', path: 'assets/cap-00-03-abcd.png', data: Buffer.from('png').toString('base64') });
    expect(await next()).toEqual({ type: 'asset.ack', path: 'assets/cap-00-03-abcd.png' });
    send({ type: 'asset.put', path: '../evil.png', data: '' });
    expect(await next()).toMatchObject({ type: 'error', code: 'internal' });

    const note = {
      id: 'web:podcast.example.test/ep/1',
      platform: 'web',
      kind: 'audio',
      url: 'https://podcast.example.test/ep/1',
      title: 'Épisode 1',
      markdown: '[00:03] ![Capture 00:03](assets/cap-00-03-abcd.png)',
      createdAt: 1,
      updatedAt: 2,
      rev: 3,
    };
    send({ type: 'note.upsert', note, portableMarkdown: '---\ntitle: "Épisode 1"\n---\n\ncorps' });
    expect(await next()).toEqual({ type: 'ack', noteId: note.id, rev: 3 });
    expect(lib.getNote(note.id)).toMatchObject({ title: 'Épisode 1', rev: 3, resources: [note.id] });
    expect(lib.getResource(note.id)).toMatchObject({ kind: 'audio', origin: 'extension' });

    send({ type: 'media.progress', noteId: note.id, position: 30, duration: 60, updatedAt: 10 });
    send({ type: 'export', requestId: 'r1', noteId: note.id, target: 'local' });
    expect(await next()).toEqual({ type: 'export.result', requestId: 'r1', ok: true, message: 'Enregistré' });
    expect(lib.getResource(note.id)?.progress).toEqual({ position: 30, duration: 60, updatedAt: 10 });
    send({ type: 'export', requestId: 'r2', noteId: note.id, target: 'notion' });
    expect(await next()).toEqual({ type: 'export.result', requestId: 'r2', ok: false, message: 'Notion n’est pas connecté' });

    const active = new Promise((r) => server.once('active', r));
    send({ type: 'player.active', player: { noteId: note.id, title: 'Épisode 1', url: note.url } });
    expect(await active).toMatchObject({ noteId: note.id });

    send({ type: 'ping' });
    expect(await next()).toEqual({ type: 'pong' });
    ws.close();
    await vi.waitFor(() => expect(clients.at(-1)).toBe(0));
    expect(server.active).toBeNull();
  });

  it('works with the real extension sync client (offline queue, captures first, progress)', async () => {
    const store = new NoteStore(new MemoryArea());
    const asset = await store.saveAsset({
      noteId: 'youtube:abcdefghijk',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      mime: 'image/png',
      width: 2,
      height: 2,
      time: 3,
    });
    const meta = { platform: 'youtube' as const, url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Vidéo' };
    await store.saveNote('youtube:abcdefghijk', meta, `[00:03] ![Capture 00:03](${asset.path})`);
    await store.saveProgress('youtube:abcdefghijk', 42, 300);

    const sync = new DesktopSync({
      store,
      clientVersion: '0.1.0',
      getConfig: async () => ({ url: `ws://127.0.0.1:${server.port}`, token: 'ABCD-EFGH-JKLM-NPQR' }),
      onStatus: () => undefined,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    await sync.connect();
    await vi.waitFor(async () => expect((await sync.status()).pending).toBe(0));
    await vi.waitFor(() => expect(lib.getResource('youtube:abcdefghijk')?.progress?.position).toBe(42));

    const item = lib.getNote('youtube:abcdefghijk')!;
    expect(item).toMatchObject({ title: 'Vidéo', rev: 1, noteCount: 1 });
    expect(await readFile(join(lib.path, asset.path))).toEqual(Buffer.from('iVBORw0KGgo=', 'base64'));
    expect(await readFile(join(lib.path, item.noteFile), 'utf8')).toContain(
      `[00:03](https://www.youtube.com/watch?v=abcdefghijk#t=3) ![Capture 00:03](${asset.path})`,
    );
    const status = await sync.status();
    expect(status).toMatchObject({ state: 'connected', app: { name: 'Boo Notes Desktop' } });
  });
});
