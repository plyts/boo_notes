import type { MediaKind } from '../shared/platforms';

/**
 * Ephemeral routing state kept in chrome.storage.session so it survives the
 * service worker being stopped, but not a browser restart.
 */
export interface PlayerInfo {
  noteId: string;
  title: string;
  url: string;
  at: number;
  /** `page`: a page noted in reading mode (no media to drive from another tab). */
  kind?: MediaKind;
}

export interface SessionData {
  /** Tabs currently showing a supported video, by tab id. */
  players: Record<string, PlayerInfo>;
  /** The single active player: the last one that received an interaction. */
  activeTab: number | null;
  /** Detached note windows, video tab id → window id. */
  popouts: Record<string, number>;
}

const KEY = 'session';

export class SessionState {
  private cache: SessionData | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  async get(): Promise<SessionData> {
    if (!this.cache) {
      const res = await chrome.storage.session.get(KEY);
      const stored = res[KEY] as Partial<SessionData> | undefined;
      this.cache = {
        players: stored?.players ?? {},
        activeTab: stored?.activeTab ?? null,
        popouts: stored?.popouts ?? {},
      };
    }
    return this.cache;
  }

  /** Serialised read-modify-write. */
  update(fn: (data: SessionData) => void): Promise<SessionData> {
    const run = this.queue.then(async () => {
      const data = await this.get();
      fn(data);
      await chrome.storage.session.set({ [KEY]: data });
      return data;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  static popoutOwner(data: SessionData, windowId: number): number | null {
    const hit = Object.entries(data.popouts).find(([, w]) => w === windowId);
    return hit ? Number(hit[0]) : null;
  }
}
