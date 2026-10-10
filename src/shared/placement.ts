/**
 * Where the notes panel stands in the page: docked to a side (the page makes
 * room for it), floating over the page where it was put, or reduced to the
 * Mini widget (the line being said and its translation). Remembered by site.
 *
 * Pure geometry, in viewport pixels: shared by the drawer, the player fit and
 * the tests.
 */

export type DockSide = 'right' | 'left' | 'top' | 'bottom';
export const DOCK_SIDES: readonly DockSide[] = ['right', 'left', 'top', 'bottom'];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelPlace {
  /** `dock`: against a side, the page beside it; `float`: a card over the page. */
  mode: 'dock' | 'float';
  side: DockSide;
  /** The floating card's box; null: its default place (the right edge, full height). */
  float: Box | null;
  /** The Mini widget's box; null: its default place (low on the video). */
  mini: Box | null;
  /** Tint of the Mini's glass, from clear to dark (0.15–0.9). */
  glass: number;
}

/** Pointer this close to an edge of the window (px): dropping docks the panel there. */
export const DOCK_ZONE = 40;
export const FLOAT_MIN = { w: 300, h: 240 } as const;
export const MINI_MIN = { w: 260, h: 104 } as const;
export const MINI_DEFAULT = { w: 480, h: 184 } as const;
export const GLASS_DEFAULT = 0.55;
/** Share of the screen the video keeps in a fullscreen split. */
export const SPLIT_MIN = 0.4;
export const SPLIT_MAX = 0.85;
export const SPLIT_DEFAULT = 0.7;
/** Storage key (chrome.storage.local) of a site's place. */
export const placeKey = (origin: string) => `place:${origin}`;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export const SIDE_LABELS: Readonly<Record<DockSide, string>> = {
  right: 'à droite',
  left: 'à gauche',
  top: 'en haut',
  bottom: 'en bas',
};

export function isDockSide(value: unknown): value is DockSide {
  return DOCK_SIDES.includes(value as DockSide);
}

function box(raw: unknown): Box | null {
  const b = raw as Partial<Box> | null;
  if (!b || !finite(b.x) || !finite(b.y) || !finite(b.w) || !finite(b.h) || b.w <= 0 || b.h <= 0) return null;
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
}

export function normalizePlace(raw: unknown, fallback: Pick<PanelPlace, 'mode' | 'side'>): PanelPlace {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof PanelPlace, unknown>>;
  return {
    mode: r.mode === 'dock' || r.mode === 'float' ? r.mode : fallback.mode,
    side: isDockSide(r.side) ? r.side : fallback.side,
    float: box(r.float),
    mini: box(r.mini),
    glass: finite(r.glass) ? clamp(r.glass, 0.15, 0.9) : GLASS_DEFAULT,
  };
}

/** `box` inside the window: no larger than it, wholly on screen. */
export function clampBox(b: Box, vw: number, vh: number, min: { w: number; h: number } = { w: 0, h: 0 }): Box {
  const w = Math.round(clamp(b.w, Math.min(min.w, vw), vw));
  const h = Math.round(clamp(b.h, Math.min(min.h, vh), vh));
  return { x: Math.round(clamp(b.x, 0, vw - w)), y: Math.round(clamp(b.y, 0, vh - h)), w, h };
}

/**
 * `start` resized by dragging its `edges` (`n`, `se`…) by (dx, dy): the
 * opposite edges stay put, never smaller than `min`, never out of the window.
 */
export function resizeBox(start: Box, edges: string, dx: number, dy: number, vw: number, vh: number, min: { w: number; h: number }): Box {
  let { x, y, w, h } = start;
  const right = x + w;
  const bottom = y + h;
  if (edges.includes('e')) w = clamp(w + dx, min.w, vw - x);
  if (edges.includes('s')) h = clamp(h + dy, min.h, vh - y);
  if (edges.includes('w')) {
    x = clamp(x + dx, 0, right - min.w);
    w = right - x;
  }
  if (edges.includes('n')) {
    y = clamp(y + dy, 0, bottom - min.h);
    h = bottom - y;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** The edge the pointer is against (within DOCK_ZONE), if one of `sides`. */
export function dockZone(x: number, y: number, vw: number, vh: number, sides: readonly DockSide[] = DOCK_SIDES): DockSide | null {
  const near: Array<[DockSide, number]> = [
    ['left', x],
    ['right', vw - x],
    ['top', y],
    ['bottom', vh - y],
  ];
  const hit = near.filter(([side, d]) => d <= DOCK_ZONE && sides.includes(side)).sort((a, b) => a[1] - b[1])[0];
  return hit ? hit[0] : null;
}

/** Size of the notes in a split of `total` px where the video keeps `ratio`. */
export function splitSize(total: number, ratio: number, min: number, room: number): number {
  const notes = Math.round(total * (1 - clamp(ratio, SPLIT_MIN, SPLIT_MAX)));
  return Math.max(Math.min(min, total), Math.min(notes, total - room));
}

/** The video's share of a split whose notes take `notes` px of `total`. */
export function splitRatio(total: number, notes: number): number {
  if (!(total > 0)) return SPLIT_DEFAULT;
  return Math.round(clamp(1 - notes / total, SPLIT_MIN, SPLIT_MAX) * 1000) / 1000;
}

export interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Larger than any screen: a side the notes do not bound. */
export const UNBOUNDED = 1e7;

/**
 * The part of the window the page keeps beside notes docked on `side`
 * (`notes`: their on-screen box). `fill` (fullscreen split): exactly the rest
 * of the screen. Otherwise (the page beside the notes): only the notes' side
 * is a bound — and the window's edge across from them, which a page moved
 * by the notes could otherwise run past.
 */
export function areaBeside(notes: Area, side: DockSide, vw: number, vh: number, fill: boolean, gap = 8): Area {
  if (fill) {
    if (side === 'left') return { left: notes.right, top: 0, right: vw, bottom: vh };
    if (side === 'top') return { left: 0, top: notes.bottom, right: vw, bottom: vh };
    if (side === 'bottom') return { left: 0, top: 0, right: vw, bottom: notes.top };
    return { left: 0, top: 0, right: notes.left, bottom: vh };
  }
  const U = UNBOUNDED;
  if (side === 'left') return { left: notes.right + gap, top: -U, right: vw, bottom: U };
  if (side === 'top') return { left: -U, top: notes.bottom + gap, right: U, bottom: vh };
  if (side === 'bottom') return { left: -U, top: -U, right: U, bottom: notes.top - gap };
  return { left: -U, top: -U, right: notes.left - gap, bottom: U };
}
