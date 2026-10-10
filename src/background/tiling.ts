import {
  followBorder,
  judgeChange,
  TILE_DEBOUNCE_MS,
  TILE_FOLLOW_LIMIT,
  TILE_SETTLE_MS,
  tileBounds,
  tileChoice,
  type Bounds,
  type TileId,
} from '../shared/tiling';

/**
 * « Côte à côte »: the video tab's Chrome window and the notes' window share
 * the screen's work area, each in its zone; dragging their common border
 * resizes the other one (chrome.windows.onBoundsChanged). Ended (« Quitter »,
 * the notes' window closed), the video window gets its bounds and state back.
 *
 * Boo Notes never fights the user or the system over the windows: a window
 * moved, snapped elsewhere or maximized means they are arranged another way,
 * and Boo Notes lets go (nothing moves on its own any more). After placing a
 * window, its settling (window manager, borders, minimum sizes) is taken as
 * it comes, never followed; and if the border keeps moving back and forth —
 * another arranger at work —, Boo Notes lets go too.
 *
 * Chrome windows only: another application, or reserving the area for good
 * (an app bar), takes the Desktop app.
 */

type WindowState = `${chrome.windows.WindowState}`;

export interface TileState {
  tabId: number;
  tile: TileId;
  side: 'left' | 'right';
  area: Bounds;
  videoWindow: number;
  notesWindow: number;
  /** The video window as it was: given back when the tiling ends. */
  saved: Bounds & { state: WindowState };
  /** Where each window is known to stand (what Boo Notes gave it, then where it settled). */
  expect: { video: Bounds; notes: Bounds };
  /** Until when (epoch ms) each window is still settling where Boo Notes put it. */
  settle: { video: number; notes: number };
  /** When the border was followed lately (to notice two arrangers fighting). */
  follows: number[];
}

/** Why Boo Notes let go of a tiling (shown in the notes' window). */
export type TileEnd = 'moved' | 'maximized' | 'fight';

const KEY = 'tiles';
const ENDED_KEY = 'tile:ended';

export interface TilerDeps {
  /** Opens (or moves) the notes' window of the tab at `bounds`; resolves to its window id. */
  openNotes(tabId: number, bounds: Bounds): Promise<number>;
  /** Clock (tests). */
  now?: () => number;
}

const boundsOf = (w: chrome.windows.Window): Bounds => ({ left: w.left ?? 0, top: w.top ?? 0, width: w.width ?? 0, height: w.height ?? 0 });

export class Tiler {
  private queue: Promise<unknown> = Promise.resolve();
  /** The last bounds reported per window, handled once the window is quiet. */
  private readonly pending = new Map<number, { win: chrome.windows.Window; timer: ReturnType<typeof setTimeout> | undefined; waiters: Array<() => void> }>();

  constructor(private readonly deps: TilerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async all(): Promise<Record<string, TileState>> {
    return ((await chrome.storage.session.get(KEY))[KEY] as Record<string, TileState> | undefined) ?? {};
  }

  /** Serialised read-modify-write of the tiles. */
  private update<T>(fn: (tiles: Record<string, TileState>) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const tiles = await this.all();
      const out = await fn(tiles);
      await chrome.storage.session.set({ [KEY]: tiles });
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async status(tabId: number): Promise<TileId | null> {
    return (await this.all())[tabId]?.tile ?? null;
  }

  /** Splits the work area between the tab's window and the notes' window. */
  set(tabId: number, id: TileId, area: Bounds): Promise<void> {
    const choice = tileChoice(id);
    if (!choice) return Promise.reject(new Error('Répartition inconnue'));
    if (!(area.width > 0 && area.height > 0)) return Promise.reject(new Error('Écran introuvable'));
    return this.update(async (tiles) => {
      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);
      if (win.id === undefined) throw new Error('Fenêtre de la vidéo introuvable');
      const before = tiles[tabId];
      const saved = before && before.videoWindow === win.id ? before.saved : { ...boundsOf(win), state: (win.state ?? 'normal') as WindowState };
      let zones = tileBounds(area, choice.notes, choice.side);
      // Only a « normal » window takes bounds (maximized, fullscreen: first given back).
      if (win.state && win.state !== 'normal') await chrome.windows.update(win.id, { state: 'normal' });
      const placed = await chrome.windows.update(win.id, zones.video);
      // Where it really went (Chrome keeps a browser window at least ~510 px wide): the notes take the rest.
      const actual = placed ? boundsOf(placed) : zones.video;
      if (actual.width !== zones.video.width || actual.left !== zones.video.left) zones = { ...followBorder(area, choice.side, 'video', actual), video: actual };
      const notesWindow = await this.deps.openNotes(tabId, zones.notes);
      const until = this.now() + TILE_SETTLE_MS;
      tiles[tabId] = { tabId, tile: id, side: choice.side, area, videoWindow: win.id, notesWindow, saved, expect: zones, settle: { video: until, notes: until }, follows: [] };
    });
  }

  /** Back to the video window as it was. */
  clear(tabId: number): Promise<void> {
    return this.update(async (tiles) => {
      const t = tiles[tabId];
      if (!t) return;
      delete tiles[tabId];
      await restore(t);
    });
  }

  /** A window of a tiling was resized or moved: handled once it is quiet (a drag reports many bounds). */
  onBoundsChanged(win: chrome.windows.Window): Promise<void> {
    if (win.id === undefined) return Promise.resolve();
    const id = win.id;
    const entry = this.pending.get(id) ?? { win, timer: undefined, waiters: [] };
    clearTimeout(entry.timer);
    entry.win = win;
    const done = new Promise<void>((resolve) => entry.waiters.push(resolve));
    entry.timer = setTimeout(() => {
      this.pending.delete(id);
      void this.settled(entry.win)
        .catch(() => undefined)
        .finally(() => entry.waiters.forEach((resolve) => resolve()));
    }, TILE_DEBOUNCE_MS);
    this.pending.set(id, entry);
    return done;
  }

  /**
   * The window's bounds once quiet: its own settling is taken as it comes; a
   * drag of the common border is followed by the other window; anything else
   * (moved, snapped elsewhere, maximized) ends the tiling — no window moves on
   * its own any more.
   */
  private settled(win: chrome.windows.Window): Promise<void> {
    const id = win.id as number;
    return this.update(async (tiles) => {
      const t = Object.values(tiles).find((x) => x.videoWindow === id || x.notesWindow === id);
      if (!t) return;
      const which = t.videoWindow === id ? 'video' : 'notes';
      const other = which === 'video' ? 'notes' : 'video';
      const b = boundsOf(win);
      // Minimized or in the browser's fullscreen for a while: it comes back where it was.
      if (win.state === 'minimized' || win.state === 'fullscreen') return;
      if (win.state === 'maximized') return void (await this.release(tiles, t, 'maximized'));
      const now = this.now();
      // Placed by Boo Notes a moment ago: where it settles is where it is.
      if (now < (t.settle?.[which] ?? 0)) {
        t.expect[which] = b;
        return;
      }
      const verdict = judgeChange(t.side, which, t.expect[which], b);
      if (verdict === 'same') {
        t.expect[which] = b;
        return;
      }
      if (verdict === 'rearranged') return void (await this.release(tiles, t, 'moved'));
      // The common border was dragged: the other window follows, unless the border keeps going back and forth.
      t.follows = [...(t.follows ?? []).filter((at) => now - at < TILE_FOLLOW_LIMIT.ms), now];
      if (t.follows.length > TILE_FOLLOW_LIMIT.count) return void (await this.release(tiles, t, 'fight'));
      const next = followBorder(t.area, t.side, which, b);
      t.expect = { ...t.expect, [which]: b, [other]: next[other] } as TileState['expect'];
      t.settle = { ...(t.settle ?? { video: 0, notes: 0 }), [other]: now + TILE_SETTLE_MS };
      await chrome.windows.update(other === 'video' ? t.videoWindow : t.notesWindow, next[other]).catch(() => undefined);
    });
  }

  /** Lets go of a tiling the user arranges another way: the windows stay where they are. */
  private async release(tiles: Record<string, TileState>, t: TileState, reason: TileEnd): Promise<void> {
    delete tiles[t.tabId];
    await chrome.storage.session.set({ [ENDED_KEY]: { tabId: t.tabId, reason, at: this.now() } }).catch(() => undefined);
  }

  /** The notes' window closed: the video window as it was; the video window closed: the tiling is over. */
  onRemoved(windowId: number): Promise<void> {
    return this.update(async (tiles) => {
      for (const t of Object.values(tiles)) {
        if (t.notesWindow === windowId) {
          delete tiles[t.tabId];
          await restore(t);
        } else if (t.videoWindow === windowId) delete tiles[t.tabId];
      }
    });
  }
}

/** `b` moved and narrowed into `area` (a window must stay mostly on a screen). */
export function within(b: Bounds, area: Bounds): Bounds {
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  return {
    left: Math.max(area.left, Math.min(b.left, area.left + area.width - width)),
    top: Math.max(area.top, Math.min(b.top, area.top + area.height - height)),
    width,
    height,
  };
}

async function restore(t: TileState): Promise<void> {
  const { state, ...bounds } = t.saved;
  try {
    if (state === 'maximized' || state === 'fullscreen') await chrome.windows.update(t.videoWindow, { state });
    else await chrome.windows.update(t.videoWindow, { state: 'normal', ...bounds });
  } catch {
    // Refused (no longer on the screen: another display, a smaller one): as close as the screen allows.
    await chrome.windows.update(t.videoWindow, within(bounds, t.area)).catch(() => undefined);
  }
}
