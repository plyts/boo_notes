/**
 * « Côte à côte »: the video's Chrome window and the notes' window share the
 * screen's work area (taskbar / Dock excluded), each in its own zone, with a
 * common border: resizing one resizes the other. Pure geometry, in screen
 * pixels (chrome.windows bounds).
 */

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

/** Narrowest zone either window may get (px). */
export const TILE_MIN = { video: 400, notes: 340 } as const;

/** The two zones, split at `border` (screen x of the line between them). */
function zones(area: Bounds, side: 'left' | 'right', border: number): { video: Bounds; notes: Bounds } {
  const lo = side === 'right' ? TILE_MIN.video : TILE_MIN.notes;
  const hi = side === 'right' ? TILE_MIN.notes : TILE_MIN.video;
  // A work area too small for both minima: split it in the middle.
  const x = area.width >= lo + hi ? Math.round(Math.min(area.left + area.width - hi, Math.max(area.left + lo, border))) : Math.round(area.left + area.width / 2);
  const first: Bounds = { left: area.left, top: area.top, width: x - area.left, height: area.height };
  const second: Bounds = { left: x, top: area.top, width: area.left + area.width - x, height: area.height };
  return side === 'right' ? { video: first, notes: second } : { video: second, notes: first };
}

/** The zones of the video window and of the notes for a choice of split. */
export function tileBounds(area: Bounds, notesShare: number, side: 'left' | 'right'): { video: Bounds; notes: Bounds } {
  const notesWidth = area.width * notesShare;
  return zones(area, side, side === 'right' ? area.left + area.width - notesWidth : area.left + notesWidth);
}

/**
 * One window was resized by the user (`which`, now at `b`): the border moves
 * with its inner edge and the other window fills the rest.
 */
export function followBorder(area: Bounds, side: 'left' | 'right', which: 'video' | 'notes', b: Bounds): { video: Bounds; notes: Bounds } {
  // The inner edge: the video's right / the notes' left when the notes are on the right, and the reverse.
  const videoFirst = side === 'right';
  const border = which === 'video' ? (videoFirst ? b.left + b.width : b.left) : videoFirst ? b.left : b.left + b.width;
  return zones(area, side, border);
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
