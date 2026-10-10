import { followBorder, sameBounds, tileBounds, tileChoice, type Bounds, type TileId } from '../shared/tiling';

/**
 * « Côte à côte »: the video tab's Chrome window and the notes' window share
 * the screen's work area, each in its zone; resizing one by its inner edge
 * resizes the other (chrome.windows.onBoundsChanged). Ended (« Quitter », the
 * notes' window closed), the video window gets its bounds and state back.
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
  /** Bounds Boo Notes last gave each window: their echo is not the user's resize. */
  expect: { video: Bounds; notes: Bounds };
}

const KEY = 'tiles';

export interface TilerDeps {
  /** Opens (or moves) the notes' window of the tab at `bounds`; resolves to its window id. */
  openNotes(tabId: number, bounds: Bounds): Promise<number>;
}

const boundsOf = (w: chrome.windows.Window): Bounds => ({ left: w.left ?? 0, top: w.top ?? 0, width: w.width ?? 0, height: w.height ?? 0 });

export class Tiler {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TilerDeps) {}

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
      const zones = tileBounds(area, choice.notes, choice.side);
      // Only a « normal » window takes bounds (maximized, fullscreen: first given back).
      if (win.state && win.state !== 'normal') await chrome.windows.update(win.id, { state: 'normal' });
      await chrome.windows.update(win.id, zones.video);
      const notesWindow = await this.deps.openNotes(tabId, zones.notes);
      tiles[tabId] = { tabId, tile: id, side: choice.side, area, videoWindow: win.id, notesWindow, saved, expect: zones };
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

  /** A window of a tiling resized or moved: the other one follows the common border. */
  onBoundsChanged(win: chrome.windows.Window): Promise<void> {
    if (win.id === undefined) return Promise.resolve();
    const id = win.id;
    return this.update(async (tiles) => {
      const t = Object.values(tiles).find((x) => x.videoWindow === id || x.notesWindow === id);
      if (!t) return;
      const which = t.videoWindow === id ? 'video' : 'notes';
      const other = which === 'video' ? 'notes' : 'video';
      const b = boundsOf(win);
      // Its own echo (bounds Boo Notes gave it), or a window no longer normal (maximized by the user).
      if (sameBounds(b, t.expect[which]) || (win.state && win.state !== 'normal')) return;
      const next = followBorder(t.area, t.side, which, b);
      t.expect = { ...t.expect, [which]: b, [other]: next[other] } as TileState['expect'];
      await chrome.windows.update(which === 'video' ? t.notesWindow : t.videoWindow, next[other]).catch(() => undefined);
    });
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
