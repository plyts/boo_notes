import {
  followBorder,
  innerEdge,
  judgeChange,
  outerEdge,
  TILE_BOUNCE_MS,
  TILE_DEBOUNCE_MS,
  TILE_FOLLOW_LIMIT,
  TILE_GAP,
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
 * it comes, never followed; once both have settled, if the system kept the
 * video window elsewhere (Windows holds a snapped window at its half), the
 * notes go beside it, once. A window's edge coming back where it stood a
 * moment ago (1/2 → 2/3 → 1/2), or the border moving again and again: another
 * arranger is at work, and Boo Notes lets go too.
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
  /** Where each window's inner edge stood lately (to notice one coming back: the system holding it there). */
  edges?: Array<{ which: 'video' | 'notes'; x: number; at: number }>;
  /** When Boo Notes placed the windows (the check once they have settled is for this placement). */
  placedAt?: number;
  /** Where Boo Notes put the video window's inner edge. */
  asked?: number;
  /** The system kept the video window where it was: Boo Notes no longer asks it to move. */
  held?: boolean;
}

/** Why Boo Notes let go of a tiling (shown in the notes' window). */
export type TileEnd = 'moved' | 'maximized' | 'fight';

const KEY = 'tiles';
const ENDED_KEY = 'tile:ended';
/** The system kept the video window where it was: the notes went beside it (shown in the notes' window). */
const HELD_KEY = 'tile:held';

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
      const placedAt = this.now();
      const until = placedAt + TILE_SETTLE_MS;
      const t: TileState = { tabId, tile: id, side: choice.side, area, videoWindow: win.id, notesWindow, saved, expect: zones, settle: { video: until, notes: until }, follows: [], edges: [], placedAt, asked: innerEdge(choice.side, 'video', zones.video) };
      note(t, 'video', zones.video, placedAt);
      note(t, 'notes', zones.notes, placedAt);
      tiles[tabId] = t;
      // Once both have settled (and their last bounds handled): where did they really stay?
      setTimeout(() => void this.check(tabId, placedAt).catch(() => undefined), TILE_SETTLE_MS + TILE_DEBOUNCE_MS + 50);
    });
  }

  /**
   * The windows once settled. The system may have kept the video window
   * where it was (Windows holds a snapped window at its half): the notes go
   * beside it, once — the video window is not asked again.
   */
  private check(tabId: number, placedAt: number): Promise<void> {
    return this.update(async (tiles) => {
      const t = tiles[tabId];
      if (!t || t.placedAt !== placedAt) return;
      const [v, n] = await Promise.all([chrome.windows.get(t.videoWindow), chrome.windows.get(t.notesWindow)]);
      if (v.state !== 'normal' || n.state !== 'normal') return;
      const video = boundsOf(v);
      const notes = boundsOf(n);
      t.expect = { video, notes };
      if (Math.abs(innerEdge(t.side, 'video', video) - innerEdge(t.side, 'notes', notes)) <= TILE_GAP) return;
      const now = this.now();
      // Not against its side of the screen any more: arranged another way.
      const screenEdge = t.side === 'right' ? t.area.left : t.area.left + t.area.width;
      if (Math.abs(outerEdge(t.side, 'video', video) - screenEdge) > TILE_GAP) return void (await this.release(tiles, t, 'moved'));
      const next = followBorder(t.area, t.side, 'video', video);
      // The video window not where Boo Notes put it: the system holds it (otherwise only the notes strayed).
      t.held = Math.abs(innerEdge(t.side, 'video', video) - (t.asked ?? innerEdge(t.side, 'video', video))) > TILE_GAP;
      t.expect.notes = next.notes;
      t.settle = { ...t.settle, notes: now + TILE_SETTLE_MS };
      note(t, 'video', video, now);
      note(t, 'notes', next.notes, now);
      await chrome.windows.update(t.notesWindow, next.notes).catch(() => undefined);
      if (t.held) await chrome.storage.session.set({ [HELD_KEY]: { tabId, at: now } }).catch(() => undefined);
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
        note(t, which, b, now);
        return;
      }
      const verdict = judgeChange(t.side, which, t.expect[which], b);
      if (verdict === 'same') {
        t.expect[which] = b;
        return;
      }
      if (verdict === 'rearranged') return void (await this.release(tiles, t, 'moved'));
      // Its edge back where it stood a moment ago (1/2 → 2/3 → 1/2): the system holds this window there.
      if (cameBack(t, which, b, now)) return void (await this.release(tiles, t, 'fight'));
      // The notes' edge dragged while the system holds the video window: it is not asked again.
      if (other === 'video' && t.held) {
        t.expect.notes = b;
        note(t, which, b, now);
        return;
      }
      // The common border was dragged: the other window follows, unless the border keeps moving again and again.
      t.follows = [...(t.follows ?? []).filter((at) => now - at < TILE_FOLLOW_LIMIT.ms), now];
      if (t.follows.length > TILE_FOLLOW_LIMIT.count) return void (await this.release(tiles, t, 'fight'));
      const next = followBorder(t.area, t.side, which, b);
      t.expect = { ...t.expect, [which]: b, [other]: next[other] } as TileState['expect'];
      t.settle = { ...(t.settle ?? { video: 0, notes: 0 }), [other]: now + TILE_SETTLE_MS };
      note(t, which, b, now);
      note(t, other, next[other], now);
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

/** Remembers where a window's inner edge stood (forgotten after TILE_BOUNCE_MS). */
function note(t: TileState, which: 'video' | 'notes', b: Bounds, now: number): void {
  const x = innerEdge(t.side, which, b);
  t.edges = [...(t.edges ?? []).filter((e) => now - e.at < TILE_BOUNCE_MS), { which, x, at: now }];
}

/** True when the window's inner edge is back where it stood lately (another arranger undoing Boo Notes' move). */
function cameBack(t: TileState, which: 'video' | 'notes', b: Bounds, now: number, tolerance = 6): boolean {
  const x = innerEdge(t.side, which, b);
  return (t.edges ?? []).some((e) => e.which === which && now - e.at < TILE_BOUNCE_MS && Math.abs(e.x - x) <= tolerance);
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
