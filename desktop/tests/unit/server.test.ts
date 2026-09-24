import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { DesktopSync } from '../../../src/background/sync';
import { NoteStore } from '../../../src/shared/store';
import { TranscriptStore } from '../../../src/shared/transcript-store';
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

  it('receives transcripts and recordings (passage extracts, kept sound) from the extension', async () => {
    const area = new MemoryArea();
    const store = new NoteStore(area);
    const transcripts = new TranscriptStore(area);
    const meta = { platform: 'youtube' as const, url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Stokes' };
    await store.saveNote('youtube:abcdefghijk', meta, '[00:02–00:05] ![Passage 00:02–00:05](assets/p.jpg) [Extrait](media/p.webm)');
    await transcripts.put(
      'youtube:abcdefghijk',
      { lang: 'en', label: 'Sous-titres YouTube · anglais', source: 'platform', complete: true, duration: 30 },
      [
        { id: 'c100', start: 1, end: 3, text: 'hello everyone' },
        { id: 'c300', start: 3, end: 6, text: 'the curl of F' },
      ],
      true,
    );
    await transcripts.annotate('youtube:abcdefghijk', [{ id: 'c300', tr: 'le rotationnel de F', note: 'à retenir' }]);
    // 2.5 MB: three chunks.
    const bytes = new Uint8Array(2_500_000).map((_, i) => i % 251);
    const media = new Map([['media/p.webm', { blob: new Blob([bytes], { type: 'video/webm' }), synced: false }]]);
    const sync = new DesktopSync({
      store,
      transcripts,
      media: {
        unsynced: async () =>
          [...media].filter(([, m]) => !m.synced).map(([path]) => ({ path, noteId: 'youtube:abcdefghijk', kind: 'passage' as const, mime: 'video/webm', start: 2, end: 5 })),
        read: async (path) => media.get(path)?.blob ?? null,
        markSynced: async (path) => void (media.get(path)!.synced = true),
        requeueAll: async () => undefined,
      },
      clientVersion: '0.1.0',
      getConfig: async () => ({ url: `ws://127.0.0.1:${server.port}`, token: 'ABCD-EFGH-JKLM-NPQR' }),
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    await sync.connect();
    await vi.waitFor(() => expect(media.get('media/p.webm')!.synced).toBe(true), { timeout: 5000 });
    expect(await transcripts.getOutbox()).toEqual({});

    const t = await lib.getTranscript('youtube:abcdefghijk');
    expect(t?.cues[1]).toMatchObject({ text: 'the curl of F', tr: 'le rotationnel de F', note: 'à retenir' });
    expect(lib.transcriptOf('youtube:abcdefghijk')).toMatchObject({ cues: 2, lang: 'en', translated: true });
    const md = await readFile(join(lib.path, 'transcripts/youtube-abcdefghijk.md'), 'utf8');
    expect(md).toContain('[00:03] the curl of F\n*le rotationnel de F*\n💬 à retenir');
    expect(await readFile(join(lib.path, 'transcripts/youtube-abcdefghijk.fr.vtt'), 'utf8')).toContain('le rotationnel de F');
    expect(Buffer.compare(await readFile(join(lib.path, 'media/p.webm')), Buffer.from(bytes))).toBe(0);
    expect(lib.mediaOf('youtube:abcdefghijk')).toMatchObject([{ path: 'media/p.webm', kind: 'passage', start: 2, end: 5, size: 2_500_000 }]);
  });

  it('refuses recordings outside media/ and invalid transcripts', async () => {
    const { ws, next } = await connect();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'ABCD-EFGH-JKLM-NPQR' }));
    await next();
    ws.send(JSON.stringify({ type: 'media.chunk', path: '../evil.webm', index: 0, data: 'AAAA' }));
    expect(await next()).toMatchObject({ type: 'error', code: 'internal' });
    ws.send(JSON.stringify({ type: 'transcript.put', transcript: { noteId: 'x' } }));
    expect(await next()).toMatchObject({ type: 'error', message: 'Transcription invalide' });
    ws.close();
  });
});
