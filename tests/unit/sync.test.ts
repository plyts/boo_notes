import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopSync } from '../../src/background/sync';
import type { SyncStatus } from '../../src/shared/messages';
import { NoteStore } from '../../src/shared/store';
import { FakeSocket, flush, MemoryArea } from './helpers';

const meta = { platform: 'youtube' as const, url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Vidéo' };

/** A well-behaved desktop app: acknowledges everything. */
function desktop(msg: Record<string, unknown>, socket: FakeSocket) {
  if (msg.type === 'hello') socket.receive({ type: 'welcome', protocol: 1, app: { name: 'Boo Desktop', version: '1.0.0' } });
  if (msg.type === 'asset.put') socket.receive({ type: 'asset.ack', path: msg.path });
  if (msg.type === 'note.upsert') {
    const note = msg.note as { id: string; rev: number };
    socket.receive({ type: 'ack', noteId: note.id, rev: note.rev });
  }
  if (msg.type === 'export') socket.receive({ type: 'export.result', requestId: msg.requestId, ok: true, message: 'Exporté' });
}

function setup() {
  const store = new NoteStore(new MemoryArea());
  const statuses: SyncStatus[] = [];
  const sync = new DesktopSync({
    store,
    clientVersion: '0.1.0',
    getConfig: async () => ({ url: 'ws://localhost:43117', token: 'secret' }),
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    requestTimeoutMs: 1000,
  });
  return { store, sync, statuses };
}

describe('DesktopSync', () => {
  beforeEach(() => FakeSocket.reset());
  afterEach(() => vi.useRealTimers());

  it('handshakes with the token and reports "connected"', async () => {
    const { sync, statuses } = setup();
    await sync.connect();
    const socket = FakeSocket.last();
    socket.responder = desktop;
    socket.serverOpen();
    await flush();
    expect(socket.url).toBe('ws://localhost:43117');
    expect(socket.sent[0]).toMatchObject({ type: 'hello', protocol: 1, token: 'secret' });
    expect(sync.connected).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ state: 'connected', app: { name: 'Boo Desktop' } });
  });

  it('keeps notes in the outbox while offline and flushes them (assets first) on connection', async () => {
    const { store, sync } = setup();
    const asset = await store.saveAsset({
      noteId: 'n',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      mime: 'image/png',
      width: 2,
      height: 2,
      time: 3,
    });
    await store.saveNote('n', meta, `[00:03] ![Capture 00:03](${asset.path})`);
    expect((await sync.status()).pending).toBe(1);

    await sync.connect();
    const socket = FakeSocket.last();
    socket.responder = desktop;
    socket.serverOpen();
    await vi.waitFor(async () => expect((await sync.status()).pending).toBe(0));

    const types = socket.sent.map((m) => m.type);
    expect(types).toEqual(['hello', 'asset.put', 'note.upsert']);
    expect(socket.sent[1]).toMatchObject({ path: asset.path, data: 'iVBORw0KGgo=' });
    expect(socket.sent[2]).toMatchObject({ note: { id: 'n', rev: 1 } });
    expect(String(socket.sent[2].portableMarkdown)).toContain('source: https://www.youtube.com/watch?v=abcdefghijk');
    expect(await store.isAssetSynced(asset.path)).toBe(true);
  });

  it('sends later revisions without re-sending known screenshots', async () => {
    const { store, sync } = setup();
    await sync.connect();
    const socket = FakeSocket.last();
    socket.responder = desktop;
    socket.serverOpen();
    await flush();
    await store.saveNote('n', meta, 'v1');
    await sync.notifyChanged();
    await vi.waitFor(async () => expect((await sync.status()).pending).toBe(0));
    await store.saveNote('n', meta, 'v2');
    await sync.notifyChanged();
    await vi.waitFor(async () => expect((await sync.status()).pending).toBe(0));
    const upserts = socket.sent.filter((m) => m.type === 'note.upsert');
    expect(upserts.map((m) => (m.note as { rev: number }).rev)).toEqual([1, 2]);
  });

  it('goes offline and schedules a retry when the app closes the socket', async () => {
    vi.useFakeTimers();
    const { sync, statuses } = setup();
    await sync.connect();
    FakeSocket.last().close();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.state).toBe('offline');
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('surfaces a rejected pairing token', async () => {
    const { sync, statuses } = setup();
    await sync.connect();
    const socket = FakeSocket.last();
    socket.responder = (msg, s) => {
      if (msg.type === 'hello') {
        s.receive({ type: 'error', code: 'unauthorized' });
        s.close();
      }
    };
    socket.serverOpen();
    await flush();
    await flush();
    expect(statuses.at(-1)).toMatchObject({ state: 'offline' });
    expect(statuses.at(-1)?.error).toMatch(/Jeton/);
  });

  it('forwards export requests and returns the app answer', async () => {
    const { store, sync } = setup();
    await store.saveNote('n', meta, 'x');
    await sync.connect();
    const socket = FakeSocket.last();
    socket.responder = desktop;
    socket.serverOpen();
    await flush();
    await expect(sync.exportNote('n', 'notion')).resolves.toBe('Exporté');
    expect(socket.sent.find((m) => m.type === 'export')).toMatchObject({ noteId: 'n', target: 'notion' });
  });

  it('refuses to export while offline', async () => {
    const { sync } = setup();
    await expect(sync.exportNote('n', 'local')).rejects.toThrow(/hors-ligne/);
  });

  it('sends playback progress with the note kind, and re-sends positions saved offline', async () => {
    const { store, sync } = setup();
    await store.saveNote('n', { ...meta, kind: 'audio' }, '[00:01] a');
    await store.saveProgress('n', 90, 1800);
    await sync.sendProgress('n'); // offline: kept pending, triggers a connection
    expect(await store.pendingProgress()).toEqual(['n']);

    const socket = FakeSocket.last();
    socket.responder = desktop;
    socket.serverOpen();
    await vi.waitFor(async () => expect(await store.pendingProgress()).toEqual([]));
    const progress = socket.sent.find((m) => m.type === 'media.progress');
    expect(progress).toMatchObject({
      noteId: 'n',
      kind: 'audio',
      title: 'Vidéo',
      platform: 'youtube',
      position: 90,
      duration: 1800,
    });
    // Progress follows the note it belongs to.
    const types = socket.sent.map((m) => m.type);
    expect(types.indexOf('note.upsert')).toBeLessThan(types.indexOf('media.progress'));
  });
});

