import { findAssetRefs, toPortableMarkdown } from '../shared/markdown';
import type { SyncState, SyncStatus } from '../shared/messages';
import type { NoteStore } from '../shared/store';

/**
 * Link to the desktop app over a loopback WebSocket (see docs/PROTOCOL.md).
 * Local storage stays the source of truth: every saved note lands in an
 * outbox that is flushed whenever the app is reachable, so going offline
 * never loses anything.
 */
export const PROTOCOL_VERSION = 1;

export type DesktopMessage =
  | { type: 'welcome'; protocol: number; app?: { name: string; version: string } }
  | { type: 'error'; code: string; message?: string; requestId?: string }
  | { type: 'ack'; noteId: string; rev: number }
  | { type: 'asset.ack'; path: string }
  | { type: 'asset.request'; path: string }
  | { type: 'resync' }
  | { type: 'export.result'; requestId: string; ok: boolean; message?: string }
  | { type: 'pong' };

interface Waiter {
  match: (m: DesktopMessage) => boolean;
  resolve: (m: DesktopMessage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DesktopSyncOptions {
  store: NoteStore;
  getConfig: () => Promise<{ url: string; token: string }>;
  clientVersion: string;
  onStatus?: (status: SyncStatus) => void;
  WebSocketImpl?: typeof WebSocket;
  /** Requests without an answer after this delay fail and drop the socket. */
  requestTimeoutMs?: number;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const HANDSHAKE_TIMEOUT_MS = 5_000;
// Chrome keeps an MV3 service worker alive while WebSocket traffic happens at least every 30 s.
const KEEPALIVE_MS = 20_000;

export class DesktopSync {
  private ws: WebSocket | null = null;
  private state: SyncState = 'offline';
  private error: string | undefined;
  private app: { name: string; version: string } | undefined;
  private generation = 0;
  private waiters = new Set<Waiter>();
  private flushing = false;
  private flushAgain = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryIndex = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private requestSeq = 0;
  private readonly WS: typeof WebSocket;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DesktopSyncOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.timeoutMs = opts.requestTimeoutMs ?? 10_000;
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  async status(): Promise<SyncStatus> {
    const pending = Object.keys(await this.opts.store.getOutbox()).length;
    return { state: this.state, pending, error: this.error, app: this.app, at: Date.now() };
  }

  /** Opens the socket unless one is already open or opening. */
  async connect(): Promise<void> {
    if (this.state !== 'offline') return;
    this.clearRetry();
    const gen = ++this.generation;
    this.setState('connecting');
    const { url, token } = await this.opts.getConfig();
    if (gen !== this.generation) return;

    let ws: WebSocket;
    try {
      ws = new this.WS(url);
    } catch {
      this.error = `Adresse invalide : ${url}`;
      this.handleClose(gen);
      return;
    }
    this.ws = ws;
    const handshake = setTimeout(() => {
      if (gen === this.generation && this.state === 'connecting') {
        this.error = "L'application Desktop ne répond pas";
        ws.close();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          client: { name: 'boo-notes-extension', version: this.opts.clientVersion },
          token,
        }),
      );
    };
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(gen, ev.data);
    ws.onerror = () => {
      if (!this.error) this.error = 'Application Desktop injoignable';
    };
    ws.onclose = () => {
      clearTimeout(handshake);
      this.handleClose(gen);
    };
  }

  /** Drops the current socket and reconnects (settings changed, manual retry). */
  async reconnect(): Promise<void> {
    this.retryIndex = 0;
    this.error = undefined;
    this.teardown();
    await this.connect();
  }

  /** Call after every local save: updates the pending count and flushes when online. */
  async notifyChanged(): Promise<void> {
    await this.emitStatus();
    if (this.connected) void this.flush();
    else void this.connect();
  }

  /** Asks the desktop app to export a note to its local vault or to Notion. */
  async exportNote(noteId: string, target: 'local' | 'notion'): Promise<string> {
    if (!this.connected) throw new Error('Application Desktop hors-ligne');
    await this.flush();
    const requestId = `exp-${Date.now()}-${++this.requestSeq}`;
    const res = await this.request(
      { type: 'export', requestId, noteId, target },
      (m) => (m.type === 'export.result' || m.type === 'error') && m.requestId === requestId,
      30_000,
    );
    if (res.type === 'error') throw new Error(res.message ?? res.code);
    if (res.type !== 'export.result' || !res.ok) {
      throw new Error((res.type === 'export.result' && res.message) || 'Export refusé');
    }
    return res.message ?? 'Export terminé';
  }

  /** Tells the app which video is currently driven by the shortcuts. */
  announceActivePlayer(player: { noteId: string; title: string; url: string } | null): void {
    this.send({ type: 'player.active', player });
  }

  /** Sends every note of the outbox (and its new screenshots) until the app acknowledges it. */
  async flush(): Promise<void> {
    if (!this.connected) return;
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        const outbox = await this.opts.store.getOutbox();
        for (const noteId of Object.keys(outbox)) {
          const note = await this.opts.store.getNote(noteId);
          if (!note) {
            await this.opts.store.markSynced(noteId, Number.MAX_SAFE_INTEGER);
            continue;
          }
          for (const path of findAssetRefs(note.markdown)) {
            if (!(await this.opts.store.isAssetSynced(path))) await this.sendAsset(path);
          }
          await this.request(
            { type: 'note.upsert', note, portableMarkdown: toPortableMarkdown(note) },
            (m) => m.type === 'ack' && m.noteId === noteId && m.rev >= note.rev,
          );
          await this.opts.store.markSynced(noteId, note.rev);
        }
      } while (this.flushAgain && this.connected);
    } catch (e) {
      // A request timed out or the socket dropped: the outbox is kept for the next connection.
      this.error = e instanceof Error ? e.message : String(e);
      this.ws?.close();
    } finally {
      this.flushing = false;
      await this.emitStatus();
    }
  }

  private async sendAsset(path: string): Promise<void> {
    const asset = await this.opts.store.getAsset(path);
    if (!asset) return;
    const comma = asset.dataUrl.indexOf(',');
    await this.request(
      {
        type: 'asset.put',
        path: asset.path,
        noteId: asset.noteId,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
        time: asset.time,
        data: asset.dataUrl.slice(comma + 1),
      },
      (m) => m.type === 'asset.ack' && m.path === path,
    );
    await this.opts.store.markAssetSynced(path);
  }

  private handleMessage(gen: number, raw: unknown): void {
    if (gen !== this.generation || typeof raw !== 'string') return;
    let msg: DesktopMessage;
    try {
      msg = JSON.parse(raw) as DesktopMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'welcome':
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.error = `Protocole ${msg.protocol} non supporté (attendu : ${PROTOCOL_VERSION})`;
          this.ws?.close();
          return;
        }
        this.app = msg.app;
        this.error = undefined;
        this.retryIndex = 0;
        this.setState('connected');
        this.startKeepalive();
        void this.flush();
        break;
      case 'error':
        if (msg.code === 'unauthorized') {
          this.error = 'Jeton de connexion refusé par l’application Desktop';
          this.retryIndex = RETRY_DELAYS_MS.length - 1;
        }
        break;
      case 'asset.request':
        void this.sendAsset(msg.path).catch(() => undefined);
        break;
      case 'resync':
        void this.opts.store.requeueAll().then(() => this.flush());
        break;
      default:
        break;
    }
    for (const w of [...this.waiters]) {
      if (w.match(msg)) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }

  private handleClose(gen: number): void {
    if (gen !== this.generation) return;
    this.ws = null;
    this.stopKeepalive();
    this.rejectWaiters(new Error('Connexion à l’application Desktop perdue'));
    this.setState('offline');
    this.scheduleRetry();
  }

  private request(
    payload: Record<string, unknown>,
    match: (m: DesktopMessage) => boolean,
    timeoutMs = this.timeoutMs,
  ): Promise<DesktopMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error('Application Desktop hors-ligne'));
        return;
      }
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('L’application Desktop ne répond pas'));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
      this.send(payload);
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === this.WS.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private rejectWaiters(err: Error): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.clear();
  }

  private teardown(): void {
    this.generation++;
    this.clearRetry();
    this.stopKeepalive();
    this.rejectWaiters(new Error('Connexion réinitialisée'));
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.state = 'offline';
  }

  private scheduleRetry(): void {
    this.clearRetry();
    const delay = RETRY_DELAYS_MS[Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1)];
    this.retryIndex++;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setState(state: SyncState): void {
    this.state = state;
    void this.emitStatus();
  }

  private async emitStatus(): Promise<void> {
    this.opts.onStatus?.(await this.status());
  }
}
