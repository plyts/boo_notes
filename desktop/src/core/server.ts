import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { normalizeTranscript } from '../../../src/shared/transcript';
import type { Library } from './library';
import type { ActivePlayer, ExtensionNote, MediaKind } from './types';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 43117;

export interface ServerOptions {
  library: Library;
  port: number;
  /** Pairing token: mandatory, shown in the app and typed in the extension options. */
  getToken(): string;
  app: { name: string; version: string };
  /** `export` request from the extension (`target`: `local` | `notion`); resolves to a user message. */
  onExport(noteId: string, target: string): Promise<string>;
  /** `[[Titre]]` clicked in the browser: show that note in the app. */
  onOpen?(title: string): void;
  /** Messages sent to each extension right after the handshake (e.g. the shared Notion connection). */
  welcomeExtras?(): Array<Record<string, unknown>>;
  log?(message: string): void;
}

export interface ServerEvents {
  clients: [count: number];
  active: [player: ActivePlayer | null];
  error: [error: Error];
}

type Incoming = { type: string; [key: string]: unknown };

/** Only browser extensions may connect: a web page cannot forge this Origin header. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return !origin || /^(chrome|moz|safari-web)-extension:\/\//.test(origin);
}

/**
 * Local WebSocket endpoint of the browser extension (protocol v1, see
 * docs/PROTOCOL.md). Listens on 127.0.0.1 only.
 */
export class ExtensionServer extends EventEmitter<ServerEvents> {
  private wss: WebSocketServer | null = null;
  private readonly authed = new Set<WebSocket>();
  private activePlayer: ActivePlayer | null = null;
  /** Recordings being received in chunks (path → parts). */
  private readonly uploads = new Map<string, { parts: Buffer[]; size: number; at: number }>();

  constructor(private readonly opts: ServerOptions) {
    super();
  }

  get clients(): number {
    return this.authed.size;
  }

  get active(): ActivePlayer | null {
    return this.activePlayer;
  }

  get port(): number {
    const address = this.wss?.address();
    return address && typeof address === 'object' ? address.port : this.opts.port;
  }

  start(port = this.opts.port): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port,
        maxPayload: 32 * 1024 * 1024,
        verifyClient: ({ origin }: { origin: string; req: IncomingMessage }) => isAllowedOrigin(origin),
      });
      const onError = (e: Error) => {
        wss.close();
        reject(
          (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
            ? new Error(`Le port ${port} est déjà utilisé (une autre instance de Boo Notes ?)`)
            : e,
        );
      };
      wss.once('error', onError);
      wss.once('listening', () => {
        wss.off('error', onError);
        wss.on('error', (e) => this.emit('error', e));
        this.wss = wss;
        this.opts.port = port;
        resolve();
      });
      wss.on('connection', (ws) => this.accept(ws));
    });
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    for (const client of wss.clients) client.terminate();
    this.authed.clear();
    this.setActive(null);
    this.emit('clients', 0);
    await new Promise<void>((r) => wss.close(() => r()));
  }

  async restart(port: number): Promise<void> {
    await this.stop();
    await this.start(port);
  }

  /** Disconnects every client, e.g. after the pairing token changed. */
  disconnectAll(): void {
    for (const ws of this.authed) ws.close(4001, 'token changed');
  }

  /** Asks the extensions to send every note again (new notes folder…). */
  requestResync(): void {
    this.broadcast({ type: 'resync' });
  }

  /** Sends a message to every paired extension. */
  broadcast(msg: Record<string, unknown>): void {
    for (const ws of this.authed) send(ws, msg);
  }

  private accept(ws: WebSocket): void {
    let authed = false;
    ws.on('message', (raw) => {
      let msg: Incoming;
      try {
        msg = JSON.parse(String(raw)) as Incoming;
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'hello') {
        authed = this.hello(ws, msg);
        return;
      }
      if (!authed) {
        send(ws, { type: 'error', code: 'unauthorized', message: 'Poignée de main requise' });
        ws.close(4001);
        return;
      }
      void this.handle(ws, msg).catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        this.opts.log?.(`erreur sur ${msg.type} : ${message}`);
        send(ws, { type: 'error', code: 'internal', message, requestId: msg.requestId });
      });
    });
    ws.on('close', () => {
      if (this.authed.delete(ws)) {
        if (this.authed.size === 0) this.setActive(null);
        this.emit('clients', this.authed.size);
      }
    });
    ws.on('error', () => undefined);
  }

  private hello(ws: WebSocket, msg: Incoming): boolean {
    if (msg.protocol !== PROTOCOL_VERSION) {
      send(ws, { type: 'error', code: 'protocol', message: 'Version de protocole non prise en charge' });
      ws.close(4000);
      return false;
    }
    const token = this.opts.getToken();
    if (!token || msg.token !== token) {
      send(ws, {
        type: 'error',
        code: 'unauthorized',
        message: 'Jeton d’appairage invalide : copiez celui affiché dans Boo Notes Desktop',
      });
      ws.close(4001);
      return false;
    }
    send(ws, { type: 'welcome', protocol: PROTOCOL_VERSION, app: this.opts.app });
    this.authed.add(ws);
    for (const extra of this.opts.welcomeExtras?.() ?? []) send(ws, extra);
    const client = msg.client as { name?: string; version?: string } | undefined;
    this.opts.log?.(`extension connectée (${client?.name ?? '?'} ${client?.version ?? ''})`);
    this.emit('clients', this.authed.size);
    return true;
  }

  private async handle(ws: WebSocket, msg: Incoming): Promise<void> {
    const { library } = this.opts;
    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong' });
        return;
      case 'asset.put': {
        const path = String(msg.path ?? '');
        await library.putAsset(path, Buffer.from(String(msg.data ?? ''), 'base64'));
        send(ws, { type: 'asset.ack', path });
        return;
      }
      case 'note.upsert': {
        const note = msg.note as ExtensionNote | undefined;
        if (!note || typeof note.id !== 'string' || typeof note.rev !== 'number') throw new Error('Note invalide');
        const portable = typeof msg.portableMarkdown === 'string' ? msg.portableMarkdown : undefined;
        await library.upsertFromExtension(note, portable);
        send(ws, { type: 'ack', noteId: note.id, rev: note.rev });
        return;
      }
      case 'transcript.put': {
        const t = normalizeTranscript(msg.transcript);
        if (!t) throw new Error('Transcription invalide');
        await library.saveTranscript(t);
        send(ws, { type: 'transcript.ack', noteId: t.noteId, rev: t.rev });
        return;
      }
      case 'media.chunk': {
        const path = String(msg.path ?? '');
        library.mediaPath(path);
        const now = Date.now();
        for (const [p, u] of this.uploads) if (now - u.at > 10 * 60_000) this.uploads.delete(p);
        const u = Number(msg.index) === 0 ? { parts: [], size: 0, at: now } : this.uploads.get(path);
        if (!u) throw new Error('Enregistrement incomplet');
        const part = Buffer.from(String(msg.data ?? ''), 'base64');
        u.parts[Number(msg.index)] = part;
        u.size += part.length;
        u.at = now;
        if (u.size > 512 * 1024 * 1024) {
          this.uploads.delete(path);
          throw new Error('Enregistrement trop volumineux');
        }
        this.uploads.set(path, u);
        return;
      }
      case 'media.put': {
        const path = String(msg.path ?? '');
        const u = this.uploads.get(path);
        this.uploads.delete(path);
        const count = Number(msg.chunks);
        if (!u || u.parts.length !== count || u.parts.some((p) => !p)) throw new Error('Enregistrement incomplet');
        await library.putMedia(
          String(msg.noteId ?? ''),
          {
            path,
            kind: msg.kind === 'audio' ? 'audio' : 'passage',
            mime: String(msg.mime ?? '').split(';')[0],
            start: Number(msg.start) || 0,
            end: Number(msg.end) || 0,
          },
          Buffer.concat(u.parts),
        );
        send(ws, { type: 'media.ack', path });
        return;
      }
      case 'media.progress': {
        const noteId = String(msg.noteId ?? '');
        if (!noteId) return;
        await library.setExtensionProgress(
          noteId,
          Number(msg.position),
          Number(msg.duration),
          typeof msg.updatedAt === 'number' ? msg.updatedAt : Date.now(),
        );
        return;
      }
      case 'player.active':
        this.setActive((msg.player as ActivePlayer | null) ?? null);
        return;
      case 'open':
        if (typeof msg.title === 'string' && msg.title.trim()) this.opts.onOpen?.(msg.title.trim());
        return;
      case 'export': {
        const requestId = msg.requestId;
        try {
          const message = await this.opts.onExport(String(msg.noteId ?? ''), String(msg.target ?? 'local'));
          send(ws, { type: 'export.result', requestId, ok: true, message });
        } catch (e) {
          send(ws, { type: 'export.result', requestId, ok: false, message: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      default:
        return;
    }
  }

  private setActive(player: ActivePlayer | null): void {
    if (player?.noteId === this.activePlayer?.noteId && Boolean(player) === Boolean(this.activePlayer)) return;
    this.activePlayer = player;
    this.emit('active', player);
  }
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export type { MediaKind };
