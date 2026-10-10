/**
 * « Côte à côte »: the video's Chrome window and the notes' window share the
 * screen's work area (taskbar / Dock excluded), each in its own zone, with a
 * common border: resizing one resizes the other. Pure geometry, in screen
 * pixels (chrome.windows bounds).
 */

/**
 * « Côte à côte » is switched off: on Windows, a window snapped by the system
 * kept moving between its half of the screen and the zone Boo Notes gave it.
 * Nothing offers it any more (menu, chip) and the service worker no longer
 * watches the windows; the code and its tests stay — `true` brings it back.
 */
export const TILING_ENABLED = false;

export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type TileId = '2/3' | '1/2' | 'left' | '3/4';

export interface TileChoice {
  id: TileId;
  label: string;
  /** Share of the width the notes take. */
  notes: number;
  /** Side of the notes. */
  side: 'left' | 'right';
}

export const TILES: readonly TileChoice[] = [
  { id: '2/3', label: '2/3 · 1/3', notes: 1 / 3, side: 'right' },
  { id: '1/2', label: '1/2 · 1/2', notes: 1 / 2, side: 'right' },
  { id: 'left', label: 'Notes à gauche', notes: 1 / 3, side: 'left' },
  { id: '3/4', label: '3/4 · 1/4', notes: 1 / 4, side: 'right' },
];

export function tileChoice(id: unknown): TileChoice | null {
  return TILES.find((t) => t.id === id) ?? null;
}

/** Narrowest zone either window may get (px): Chrome refuses a browser window under ~510 px. */
export const TILE_MIN = { video: 520, notes: 340 } as const;

/** After Boo Notes places a window, how long its moves are its own settling (window manager, borders), not the user's. */
export const TILE_SETTLE_MS = 800;
/** Quiet time before a resize is followed (a drag reports many bounds on its way). */
export const TILE_DEBOUNCE_MS = 150;
/** More border follows than this within the window: another arranger is at work (the system's snap): Boo Notes lets go. */
export const TILE_FOLLOW_LIMIT = { count: 3, ms: 4000 } as const;
/** A window's inner edge back where it stood this recently (1/2 → 2/3 → 1/2): the system holds it there, Boo Notes lets go. */
export const TILE_BOUNCE_MS = 6000;
/** The two windows' inner edges this close (px) are together: invisible borders, frames, rounding. */
export const TILE_GAP = 24;

/** The two zones, split at `border` (screen x of the line between them). */
function zones(area: Bounds, side: 'left' | 'right', border: number): { video: Bounds; notes: Bounds } {
  const lo = side === 'right' ? TILE_MIN.video : TILE_MIN.notes;
  const hi = side === 'right' ? TILE_MIN.notes : TILE_MIN.video;
  // A work area too small for both minima: the border stays within the middle third.
  const fits = area.width >= lo + hi;
  const min = area.left + (fits ? lo : Math.round(area.width * 0.35));
  const max = area.left + area.width - (fits ? hi : Math.round(area.width * 0.35));
  const x = Math.round(Math.min(max, Math.max(min, border)));
  const first: Bounds = { left: area.left, top: area.top, width: x - area.left, height: area.height };
  const second: Bounds = { left: x, top: area.top, width: area.left + area.width - x, height: area.height };
  return side === 'right' ? { video: first, notes: second } : { video: second, notes: first };
}

/** The zones of the video window and of the notes for a choice of split. */
export function tileBounds(area: Bounds, notesShare: number, side: 'left' | 'right'): { video: Bounds; notes: Bounds } {
  const notesWidth = area.width * notesShare;
  return zones(area, side, side === 'right' ? area.left + area.width - notesWidth : area.left + notesWidth);
}

/** A window's edge on the common border: the video's right / the notes' left when the notes are on the right, and the reverse. */
export function innerEdge(side: 'left' | 'right', which: 'video' | 'notes', b: Bounds): number {
  const innerIsRight = (side === 'right') === (which === 'video');
  return innerIsRight ? b.left + b.width : b.left;
}

/** A window's edge against the side of the screen (the video's left when the notes are on the right…). */
export function outerEdge(side: 'left' | 'right', which: 'video' | 'notes', b: Bounds): number {
  const innerIsRight = (side === 'right') === (which === 'video');
  return innerIsRight ? b.left : b.left + b.width;
}

/**
 * One window was resized by the user (`which`, now at `b`): the border moves
 * with its inner edge and the other window fills the rest.
 */
export function followBorder(area: Bounds, side: 'left' | 'right', which: 'video' | 'notes', b: Bounds): { video: Bounds; notes: Bounds } {
  return zones(area, side, innerEdge(side, which, b));
}

/**
 * What a window's new bounds mean, against the ones it had: `same` (within
 * `tolerance`), `border` (only its inner edge moved — the common border was
 * dragged), `rearranged` (moved, snapped elsewhere, resized by its outer edge
 * or its height: the user arranges the windows another way).
 */
export function judgeChange(side: 'left' | 'right', which: 'video' | 'notes', before: Bounds, now: Bounds, tolerance = 6): 'same' | 'border' | 'rearranged' {
  if (sameBounds(before, now, tolerance)) return 'same';
  if (Math.abs(before.top - now.top) > tolerance || Math.abs(before.height - now.height) > tolerance) return 'rearranged';
  return Math.abs(outerEdge(side, which, before) - outerEdge(side, which, now)) <= tolerance ? 'border' : 'rearranged';
}

/** Share of the work area the notes take in `notes`. */
export function notesShare(area: Bounds, notes: Bounds): number {
  return area.width > 0 ? Math.round((notes.width / area.width) * 1000) / 1000 : 1 / 3;
}

/** True when two bounds are the same within `tolerance` px (window managers round, add borders). */
export function sameBounds(a: Bounds, b: Bounds, tolerance = 4): boolean {
  return (
    Math.abs(a.left - b.left) <= tolerance &&
    Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}
