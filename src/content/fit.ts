/**
 * Keeps the whole picture visible next to the notes.
 *
 * - Side by side: the page is narrowed by the notes' width (or shortened by
 *   their height, docked at the top or bottom), but many players size
 *   themselves from the window (YouTube), or take `100vw`: they stay as wide
 *   as before and slide under the notes, or past the window's edge. The
 *   player is then scaled down to end where the notes begin (its top-left
 *   corner stays put, or moves just out of the notes' way).
 * - Fullscreen: the notes stay beside the video, which is scaled to fill the
 *   rest of the screen, centred (split screen). When the page put its whole
 *   player fullscreen, all of it is scaled — its controls too — while the
 *   notes and the HUD it holds keep their size and place.
 *
 * Only the `scale` / `translate` properties are set (restored as they were
 * afterwards): they add to the page's own `transform`, and still apply to a
 * fullscreen element (whose `transform` the browser forces to none). Content,
 * controls and events are untouched.
 */

import type { Area } from '../shared/placement';

/** False for the elements whose children are never drawn (a fullscreen <video> or frame shows nothing else). */
export function hostsChildren(el: Element): boolean {
  return !/^(VIDEO|AUDIO|IFRAME|FRAME|EMBED|OBJECT|CANVAS|IMG)$/.test(el.tagName);
}

/** `p ↦ a + s·p` (viewport coordinates): where the page's picture of the element is drawn. */
interface Mapping {
  ax: number;
  ay: number;
  s: number;
}

type Saved = Array<[property: string, value: string, priority: string]>;

const FIT_PROPS = ['translate', 'scale', 'box-shadow'];
/** Black all around the player (the fullscreen backdrop of a page fullscreen as a whole). */
const BACKDROP = '0 0 0 200vmax #000';
// Longhands only: a shorthand restored from '' would wipe the longhands set without it.
const KEEP_PROPS = ['translate', 'scale', 'transform-origin', 'top', 'right', 'bottom', 'left', 'width', 'height', 'pointer-events'];

function save(el: HTMLElement, props: string[]): Saved {
  return props.map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
}

function restore(el: HTMLElement, saved: Saved): void {
  for (const [p, value, priority] of saved) el.style.setProperty(p, value, priority);
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Viewport point the element's `transform-origin` stands at, from its box as the page draws it. */
function originOf(el: HTMLElement, drawn: { left: number; top: number }): { x: number; y: number } {
  const cs = getComputedStyle(el);
  const [ox = 0, oy = 0] = cs.transformOrigin.split(' ').map(parseFloat);
  if (!cs.transform || cs.transform === 'none') return { x: drawn.left + ox, y: drawn.top + oy };
  // The page's own transform moves the box around that point: where its drawn corner comes from.
  const m = new DOMMatrixReadOnly(cs.transform);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const corners = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ].map(([x, y]) => m.transformPoint({ x: x - ox, y: y - oy }));
  return { x: drawn.left - Math.min(...corners.map((p) => p.x)), y: drawn.top - Math.min(...corners.map((p) => p.y)) };
}

export class PlayerFit {
  private el: HTMLElement | null = null;
  private saved: Saved | null = null;
  private applied: Mapping | null = null;
  /** Boxes inside the scaled element drawn as if it were not (the notes, the HUD). */
  private readonly kept = new Map<HTMLElement, Saved>();

  /**
   * Fits `el` into `area` (its unbounded sides far out, see areaBeside).
   * `mode`: `shrink` (side by side: only scaled down, anchored at its
   * corner) or `fill` (fullscreen: scaled to fill, centred). `keep`: fixed
   * boxes inside `el` that must stay as they are. `backdrop`: black around
   * it (the page's own fullscreen of the whole page, its other parts hidden).
   */
  apply(el: HTMLElement | null, area: Area | null, mode: 'shrink' | 'fill', keep: HTMLElement[] = [], backdrop = false): void {
    if (!el || !area || area.right - area.left < 80 || area.bottom - area.top < 60) {
      this.clear();
      return;
    }
    if (el !== this.el) this.clear();
    // Its box as the page draws it: the mapping applied so far taken out.
    const r = el.getBoundingClientRect();
    const was = this.applied ?? { ax: 0, ay: 0, s: 1 };
    const left = (r.left - was.ax) / was.s;
    const top = (r.top - was.ay) / was.s;
    const width = r.width / was.s;
    const height = r.height / was.s;
    if (width < 40 || height < 30) {
      this.clear();
      return;
    }
    let s: number;
    let ax: number;
    let ay: number;
    if (mode === 'shrink') {
      // Wholly beside the free area (under the notes): not the player beside them.
      if (left >= area.right || left + width <= area.left) {
        this.clear();
        return;
      }
      // Out of the notes' way: a box fixed on the window moves down past notes docked at the top;
      // a box of the page scrolled up past them stays where the page put it.
      const fixed = getComputedStyle(el).position === 'fixed';
      const x0 = Math.max(left, area.left);
      const y0 = fixed ? Math.max(top, area.top) : top;
      const fitsX = x0 - left < 1 && left + width <= area.right + 1;
      // Its height counts only when it starts in the free area.
      const bounded = y0 >= area.top - 1;
      const fitsY = y0 - top < 1 && (!bounded || top + height <= area.bottom + 1);
      // Nothing under the notes: nothing to do.
      if (fitsX && fitsY) {
        this.clear();
        return;
      }
      // Moved out of the notes' way, it ends no further than it did (a player beside notes on the left is
      // narrowed by their gap, not pushed into what stands on its right).
      const xEnd = Math.min(area.right, left + width);
      const yEnd = Math.min(area.bottom, top + height);
      const fit = Math.min((xEnd - x0) / width, bounded ? (yEnd - y0) / height : 1, 1);
      s = Math.max(0.3, fit);
      ax = x0 - s * left;
      ay = y0 - s * top;
    } else {
      const aw = area.right - area.left;
      const ah = area.bottom - area.top;
      s = Math.min(aw / width, ah / height);
      ax = area.left + (aw - width * s) / 2 - s * left;
      ay = area.top + (ah - height * s) / 2 - s * top;
    }
    const next = { ax: round(ax, 1), ay: round(ay, 1), s: round(s, 4) };
    // Where its corner would go: nowhere, at the same size.
    if (Math.abs(next.s - 1) < 0.005 && Math.abs(next.ax + (next.s - 1) * left) < 1 && Math.abs(next.ay + (next.s - 1) * top) < 1) {
      this.clear();
      return;
    }
    const kept = keep.filter((k) => k !== el && el.contains(k));
    const same = this.applied && next.ax === this.applied.ax && next.ay === this.applied.ay && next.s === this.applied.s;
    if (same && kept.length === this.kept.size && kept.every((k) => this.kept.has(k))) return;
    if (!this.saved) {
      this.el = el;
      this.saved = save(el, FIT_PROPS);
    }
    this.applied = next;
    // `translate` and `scale` apply around the element's own transform-origin.
    const o = originOf(el, { left, top });
    el.style.setProperty('scale', String(next.s), 'important');
    el.style.setProperty('translate', `${round(next.ax - (1 - next.s) * o.x, 2)}px ${round(next.ay - (1 - next.s) * o.y, 2)}px`, 'important');
    if (backdrop) el.style.setProperty('box-shadow', BACKDROP, 'important');
    el.dataset.booNotesFit = mode;
    this.keepAsIs(kept, next, { left, top });
  }

  /**
   * The inverse mapping on `boxes`: each becomes a fixed box over the whole
   * scaled element (their containing block now), so what it holds is laid
   * out and drawn in the page's coordinates, at its usual size.
   */
  private keepAsIs(boxes: HTMLElement[], m: Mapping, corner: { left: number; top: number }): void {
    for (const [k, saved] of this.kept) {
      if (!boxes.includes(k)) {
        restore(k, saved);
        this.kept.delete(k);
      }
    }
    for (const k of boxes) {
      if (!this.kept.has(k)) this.kept.set(k, save(k, KEEP_PROPS));
      for (const side of ['top', 'right', 'bottom', 'left']) k.style.setProperty(side, '0', 'important');
      k.style.setProperty('width', 'auto', 'important');
      k.style.setProperty('height', 'auto', 'important');
      k.style.setProperty('pointer-events', 'none', 'important');
      k.style.setProperty('transform-origin', '0 0', 'important');
      k.style.setProperty('scale', String(round(1 / m.s, 5)), 'important');
      const tx = ((1 - m.s) * corner.left - m.ax) / m.s;
      const ty = ((1 - m.s) * corner.top - m.ay) / m.s;
      k.style.setProperty('translate', `${round(tx, 2)}px ${round(ty, 2)}px`, 'important');
    }
  }

  /** The player as it was. */
  clear(): void {
    const el = this.el;
    if (el && this.saved) {
      restore(el, this.saved);
      delete el.dataset.booNotesFit;
    }
    for (const [k, saved] of this.kept) restore(k, saved);
    this.kept.clear();
    this.el = null;
    this.saved = null;
    this.applied = null;
  }
}
