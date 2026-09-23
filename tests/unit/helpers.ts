import type { StorageAreaLike } from '../../src/shared/store';

/** In-memory stand-in for chrome.storage.local. */
export class MemoryArea implements StorageAreaLike {
  readonly data = new Map<string, unknown>();

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const list = keys === null ? [...this.data.keys()] : typeof keys === 'string' ? [keys] : keys;
    const out: Record<string, unknown> = {};
    for (const k of list) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const k of typeof keys === 'string' ? [keys] : keys) this.data.delete(k);
  }
}

type Handler = ((ev: unknown) => void) | null;

/** Minimal WebSocket double driven by the test. */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  /** Called for every message the extension sends (auto-responder). */
  responder: ((msg: Record<string, unknown>, socket: FakeSocket) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    queueMicrotask(() => this.responder?.(msg, this));
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({});
  }

  serverOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.({});
  }

  receive(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  static last(): FakeSocket {
    const s = FakeSocket.instances.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  }
}

export const flush = () => new Promise<void>((r) => setTimeout(r, 0));
