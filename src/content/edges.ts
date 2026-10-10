import type { DockSide } from '../shared/placement';

/**
 * Docked notes narrow the page with a margin on <html>, but the page's
 * elements fixed to the window (`position: fixed`) do not follow it: one
 * fixed to the edge the notes take — Udemy's « Contenu du cours » column, a
 * chat button — ends up under the notes, and the room the page keeps for it
 * stays empty beside the video. Such elements are moved by the notes' size,
 * as if the window had narrowed (their `left` / `right`, or `top` / `bottom`,
 * set inline, then given back as they were).
 *
 * Elements across the whole width (headers) are left alone: the notes start
 * under the site's header.
 */

/** Points sampled along the edge to find what is fixed there. */
const SAMPLES = 12;
/** Anchored to an edge: within this many px of it. */
const SNAP = 3;

type Saved = Array<[property: string, value: string, priority: string]>;

interface Moved {
  saved: Saved;
  /** How far it was moved: (dx, dy). */
  dx: number;
  dy: number;
}

export interface EdgeShiftOptions {
  /** Boo Notes' own boxes (the notes, the HUD). */
  isOwn: (el: Element) => boolean;
  /** The player: fitted beside the notes on its own (see PlayerFit). */
  player: () => Element | null;
}

const PROPS: Record<'h' | 'v', [string, string]> = { h: ['left', 'right'], v: ['top', 'bottom'] };

export class EdgeShift {
  private readonly moved = new Map<HTMLElement, Moved>();

  constructor(private readonly opts: EdgeShiftOptions) {}

  /**
   * Moves the page's elements fixed to `side` by `size` px, away from it
   * (`side` null, or `top`: none; all given back).
   */
  apply(side: DockSide | null, size: number): void {
    const want = new Map<HTMLElement, { dx: number; dy: number }>();
    if (side && side !== 'top' && size > 0) {
      const dx = side === 'right' ? -size : side === 'left' ? size : 0;
      const dy = side === 'bottom' ? -size : 0;
      // Those moved already: still fixed to that edge where they would stand.
      for (const [el, m] of this.moved) {
        if (el.isConnected && this.anchored(el, side, m.dx, m.dy)) want.set(el, { dx, dy });
      }
      for (const el of this.candidates(side)) if (!want.has(el) && this.anchored(el, side, 0, 0)) want.set(el, { dx, dy });
    }
    for (const [el, m] of this.moved) {
      if (want.has(el)) continue;
      restore(el, m.saved);
      this.moved.delete(el);
    }
    for (const [el, d] of want) {
      // Now along the other axis (the notes moved to another edge): given back first.
      const m = this.moved.get(el);
      if (m && ((m.dx !== 0) !== (d.dx !== 0) || (m.dy !== 0) !== (d.dy !== 0))) {
        restore(el, m.saved);
        this.moved.delete(el);
      }
      this.shift(el, d.dx, d.dy);
    }
  }

  clear(): void {
    this.apply(null, 0);
  }

  /** Fixed elements found along the edge (topmost ancestor of each point that is fixed). */
  private candidates(side: DockSide): Set<HTMLElement> {
    const out = new Set<HTMLElement>();
    const seen = new Set<Element>();
    const vw = innerWidth;
    const vh = innerHeight;
    for (let i = 0; i < SAMPLES; i++) {
      const f = (i + 0.5) / SAMPLES;
      const [x, y] = side === 'right' ? [vw - 2, f * vh] : side === 'left' ? [1, f * vh] : [f * vw, vh - 2];
      for (const hit of document.elementsFromPoint(x, y)) {
        const fixed = this.fixedAncestor(hit, seen);
        if (fixed) out.add(fixed);
      }
    }
    return out;
  }

  /** The element itself or its closest ancestor fixed to the window, if any (not Boo Notes', not the page itself). */
  private fixedAncestor(el: Element, seen: Set<Element>): HTMLElement | null {
    for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (seen.has(e)) return null;
      seen.add(e);
      if (this.opts.isOwn(e)) return null;
      if (e instanceof HTMLElement && getComputedStyle(e).position === 'fixed') return e;
    }
    return null;
  }

  /** Fixed to `side` where it stands without the move (dx, dy), not across the window, not the player. */
  private anchored(el: HTMLElement, side: DockSide, dx: number, dy: number): boolean {
    if (getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const left = r.left - dx;
    const right = r.right - dx;
    const bottom = r.bottom - dy;
    const player = this.opts.player();
    if (player && (el.contains(player) || player.contains(el))) return false;
    if (side === 'right') return Math.abs(right - innerWidth) <= SNAP && r.width < innerWidth * 0.6;
    if (side === 'left') return Math.abs(left) <= SNAP && r.width < innerWidth * 0.6;
    return Math.abs(bottom - innerHeight) <= SNAP && r.height < innerHeight * 0.6;
  }

  /** Moves `el` by (dx, dy) from where its own styles put it. */
  private shift(el: HTMLElement, dx: number, dy: number): void {
    let m = this.moved.get(el);
    if (m && m.dx === dx && m.dy === dy) return;
    const axis = dx !== 0 ? 'h' : 'v';
    const [start, end] = PROPS[axis];
    if (!m) {
      m = { saved: [start, end].map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]), dx: 0, dy: 0 };
      this.moved.set(el, m);
    }
    // Where its own styles put it (the move so far taken out), then moved by the notes' size.
    const cs = getComputedStyle(el);
    const d = axis === 'h' ? dx : dy;
    const was = axis === 'h' ? m.dx : m.dy;
    const a = parseFloat(cs.getPropertyValue(start)) - was;
    const b = parseFloat(cs.getPropertyValue(end)) + was;
    if (Number.isFinite(a)) el.style.setProperty(start, `${Math.round(a + d)}px`, 'important');
    if (Number.isFinite(b)) el.style.setProperty(end, `${Math.round(b - d)}px`, 'important');
    m.dx = dx;
    m.dy = dy;
  }
}

function restore(el: HTMLElement, saved: Saved): void {
  for (const [p, value, priority] of saved) el.style.setProperty(p, value, priority);
}
