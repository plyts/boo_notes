import { h, icon } from '../shared/icons';
import {
  clampBox,
  dockZone,
  FLOAT_MIN,
  GLASS_DEFAULT,
  MINI_DEFAULT,
  MINI_MIN,
  resizeBox,
  SIDE_LABELS,
  SPLIT_DEFAULT,
  splitRatio,
  splitSize,
  type Box,
  type DockSide,
  type PanelPlace,
} from '../shared/placement';
import {
  DEFAULT_SETTINGS,
  DRAWER_MAX_WIDTH,
  DRAWER_MIN_WIDTH,
  STRIP_MAX_HEIGHT,
  STRIP_MIN_HEIGHT,
  type DrawerLayout,
} from '../shared/settings';
import { attachStyles } from './overlay';

const DEFAULT_WIDTH = DEFAULT_SETTINGS.drawerWidth;
const DEFAULT_STRIP = DEFAULT_SETTINGS.stripHeight;
/** Room always left to the page beside the notes (and to the grip, to narrow them back). */
const PAGE_ROOM = 160;
/** Room left to the page above or below notes docked as a strip. */
const PAGE_ROOM_V = 160;
/** Longest wait for a removed editor to save what was just typed. */
const RETIRE_MS = 1500;
/** Pointer travel before a press on the grip becomes a drag (a click stays a click). */
const DRAG_SLOP = 4;
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

/**
 * Retractable notes panel. It only hosts an <iframe> of the extension's
 * panel page: keystrokes typed in the notes never reach the page (no clash
 * with YouTube's `k`, `j`, `f`… shortcuts) and page CSS cannot leak in.
 *
 * Where it stands (see PanelPlace):
 * - docked to a side of the window — right (default), left, top or bottom —:
 *   the page is narrowed (or shortened) by the notes so the player and its
 *   controls stay fully visible; its inner edge resizes it;
 * - floating: a card over the page, put anywhere by its grip ⠿, resized by
 *   its edges;
 * - Mini: a small translucent widget showing the line being said.
 * Dragged against an edge of the window, the panel offers to dock there.
 * In fullscreen, docked notes take their side of the screen (70 / 30 by
 * default) and the separator sets the split.
 */
const CSS = `
:host { all: initial; }
.drawer {
  position: fixed; display: flex; box-sizing: border-box;
  pointer-events: auto; /* its host may be a box over the whole player (see PlayerFit) */
  visibility: hidden;
  transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.18s ease, visibility 0s linear 0.18s;
}
.drawer.dock-right {
  top: var(--top, 0px); right: 0; bottom: 0; width: var(--w, 360px); transform: translateX(100%);
  box-shadow: -10px 0 30px rgba(0, 0, 0, 0.28); border-left: 1px solid rgba(127, 127, 127, 0.25);
}
.drawer.dock-left {
  top: var(--top, 0px); left: 0; bottom: 0; width: var(--w, 360px); transform: translateX(-100%);
  box-shadow: 10px 0 30px rgba(0, 0, 0, 0.28); border-right: 1px solid rgba(127, 127, 127, 0.25);
}
.drawer.dock-bottom {
  left: 0; right: 0; bottom: 0; height: var(--h, 300px); transform: translateY(100%);
  box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.24); border-top: 1px solid rgba(127, 127, 127, 0.25);
}
.drawer.dock-top {
  left: 0; right: 0; top: var(--top, 0px); height: var(--h, 300px); transform: translateY(-100%); opacity: 0;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.24); border-bottom: 1px solid rgba(127, 127, 127, 0.25);
}
/* Floating card and Mini widget: a box of their own, over the page. */
.drawer.floating, .drawer.mini {
  left: var(--x, 0px); top: var(--y, 0px); width: var(--bw, 360px); height: var(--bh, 480px);
  border-radius: 14px; overflow: hidden; transform: scale(0.97); opacity: 0;
}
.drawer.floating { box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(127, 127, 127, 0.28); }
/* Mini: frosted glass, the video seen through it. */
.drawer.mini {
  border-radius: 16px; background: rgba(24, 24, 32, var(--glass, ${GLASS_DEFAULT}));
  -webkit-backdrop-filter: blur(20px) saturate(1.4); backdrop-filter: blur(20px) saturate(1.4);
  box-shadow: 0 26px 60px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(255, 255, 255, 0.22);
}
/* Same colour scheme on both sides of the frame: its page stays see-through. */
.drawer.mini iframe { color-scheme: dark; }
.drawer.open { transform: none; opacity: 1; visibility: visible; transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.18s ease, visibility 0s; }
.drawer.resizing, .drawer.dragging { transition: none; }
iframe { flex: 1; width: 100%; height: 100%; border: 0; display: block; background: transparent; }
iframe.retired { display: none; }
.drawer.resizing iframe, .drawer.dragging iframe { pointer-events: none; }

/* The separator of docked notes: their inner edge. */
.resize { position: absolute; z-index: 2; touch-action: none; outline: none; }
.dock-right .resize, .dock-left .resize { top: 0; bottom: 0; width: 8px; cursor: ew-resize; }
.dock-right .resize { left: -4px; }
.dock-left .resize { right: -4px; }
.dock-top .resize, .dock-bottom .resize { left: 0; right: 0; height: 8px; cursor: ns-resize; }
.dock-bottom .resize { top: -4px; }
.dock-top .resize { bottom: -4px; }
.floating .resize, .mini .resize { display: none; }
.resize::after { content: ""; position: absolute; background: #6d5ef0; opacity: 0; transition: opacity 0.12s ease; }
.dock-right .resize::after, .dock-left .resize::after { left: 3px; top: 0; bottom: 0; width: 2px; }
.dock-top .resize::after, .dock-bottom .resize::after { top: 3px; left: 0; right: 0; height: 2px; }
/* The pill: always visible, so the notes are seen to be resizable. */
.resize::before {
  content: ""; position: absolute; border-radius: 3px;
  background: rgba(128, 128, 140, 0.55); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.35); transition: background 0.12s ease;
}
.dock-right .resize::before, .dock-left .resize::before { left: 1px; top: 50%; width: 6px; height: 44px; margin-top: -22px; }
.dock-top .resize::before, .dock-bottom .resize::before { top: 1px; left: 50%; height: 6px; width: 44px; margin-left: -22px; }
.resize:hover::after, .resize:focus-visible::after, .drawer.resizing .resize::after { opacity: 1; }
.resize:hover::before, .resize:focus-visible::before, .drawer.resizing .resize::before { background: #6d5ef0; }

/* Edges and corners of a floating card / the Mini: drag to resize. */
.edge { position: absolute; z-index: 2; touch-action: none; display: none; }
.floating .edge, .mini .edge { display: block; }
.edge.n, .edge.s { left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
.edge.n { top: 0; }
.edge.s { bottom: 0; }
.edge.e, .edge.w { top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
.edge.e { right: 0; }
.edge.w { left: 0; }
.edge.ne, .edge.nw, .edge.se, .edge.sw { width: 12px; height: 12px; }
.edge.ne { top: 0; right: 0; cursor: nesw-resize; }
.edge.sw { bottom: 0; left: 0; cursor: nesw-resize; }
.edge.nw { top: 0; left: 0; cursor: nwse-resize; }
.edge.se { bottom: 0; right: 0; cursor: nwse-resize; }

/* The grip ⠿, over the panel's own header: grab it to move the panel. */
.grip {
  position: absolute; z-index: 3; left: 4px; top: 11px; width: 22px; height: 28px; display: grid; place-items: center;
  border-radius: 7px; color: rgba(128, 128, 140, 0.9); cursor: grab; touch-action: none; outline: none;
  transition: background 0.12s ease, color 0.12s ease;
}
.grip svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 3.2; stroke-linecap: round; }
.grip:hover, .grip:focus-visible, .dragging .grip { background: rgba(128, 128, 140, 0.18); color: #6d5ef0; }
.grip:focus-visible { box-shadow: 0 0 0 2px #6d5ef0; }
.dragging .grip { cursor: grabbing; }
.mini .grip { top: 8px; left: 8px; color: rgba(255, 255, 255, 0.78); }
.mini .grip:hover, .mini .grip:focus-visible, .mini.dragging .grip { background: rgba(255, 255, 255, 0.14); color: #fff; }

/* Where the panel will dock if dropped now. */
.zone {
  position: fixed; z-index: 1; box-sizing: border-box; display: none; place-items: center; pointer-events: none;
  border: 2px dashed #6d5ef0; border-radius: 12px; background: rgba(109, 94, 240, 0.16);
  font: 600 13px/1.3 -apple-system, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
}
.zone.on { display: grid; }
.zone span { padding: 7px 14px; border-radius: 999px; background: #5143c9; color: #fff; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
@media (prefers-reduced-motion: reduce) { .drawer, .drawer.open { transition: none; } }
`;

export interface DrawerOptions {
  panelUrl: () => string;
  width: number;
  layout: DrawerLayout;
  topInset: () => number;
  onResized: (width: number) => void;
  side?: DockSide;
  stripHeight?: number;
  splitRatio?: number;
  /** The video's box: the Mini goes low on it by default. */
  videoRect?: () => DOMRect | null;
  onStripResized?: (height: number) => void;
  onSplit?: (ratio: number) => void;
  /** Moved, docked, undocked or resized by the user: remembered for the site. */
  onPlaced?: () => void;
  /** Double-click (or Entrée) on the Mini's grip: the full panel back. */
  onExpand?: () => void;
}

export class Drawer {
  readonly host: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly zone: HTMLDivElement;
  private readonly grip: HTMLDivElement;
  private iframe: HTMLIFrameElement | null = null;
  private opened = false;
  private width: number;
  private stripHeight: number;
  private split: number;
  private mode: 'dock' | 'float';
  private side: DockSide;
  private float: Box | null = null;
  private miniBox: Box | null = null;
  private glass = GLASS_DEFAULT;
  private mini = false;
  private fullscreenTarget: Element | null = null;
  /** Margins of the page set aside by docked notes, as they were. */
  private readonly savedMargins = new Map<string, { value: string; priority: string }>();
  private handle!: HTMLElement;
  private readonly abort = new AbortController();

  constructor(private readonly opts: DrawerOptions) {
    this.width = opts.width;
    this.stripHeight = opts.stripHeight ?? DEFAULT_STRIP;
    this.split = opts.splitRatio ?? SPLIT_DEFAULT;
    this.mode = opts.layout === 'overlay' ? 'float' : 'dock';
    this.side = opts.side ?? 'right';
    this.host = h('div', { id: 'boo-notes-drawer' });
    this.host.style.cssText = 'all:initial;display:block;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;';
    const root = this.host.attachShadow({ mode: 'open' });
    attachStyles(root, CSS);
    const handle = h('div', {
      class: 'resize',
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': 'Largeur des notes',
      'aria-valuemin': String(DRAWER_MIN_WIDTH),
      'aria-valuemax': String(DRAWER_MAX_WIDTH),
    });
    this.grip = h(
      'div',
      { class: 'grip', role: 'button', tabindex: '0', 'aria-label': 'Déplacer le panneau' },
      icon('grip', 18),
    );
    const edges = EDGES.map((e) => h('div', { class: `edge ${e}`, 'aria-hidden': 'true' }));
    this.panel = h('div', { class: 'drawer dock-right', role: 'complementary', 'aria-label': 'Notes Boo Notes' }, handle, this.grip, ...edges);
    this.zone = h('div', { class: 'zone', 'aria-hidden': 'true' }, h('span', {}));
    root.append(this.zone, this.panel);
    this.handle = handle;
    this.bindResize(handle);
    this.bindDrag(this.grip);
    for (const el of edges) this.bindEdge(el, el.classList[1]);
    this.apply();
    // A smaller window: the notes narrow with it (their chosen size comes back when it grows).
    window.addEventListener('resize', () => this.apply(), { signal: this.abort.signal });
  }

  // --- State -------------------------------------------------------------------------

  /** In a fullscreen (not a dialog's top layer): the notes and the video split the screen. */
  private get splitScreen(): boolean {
    return this.fullscreenTarget !== null && document.fullscreenElement !== null;
  }

  /** The side the docked notes take: in fullscreen, the left or the right of the screen. */
  get dockSide(): DockSide {
    if (this.splitScreen && (this.side === 'top' || this.side === 'bottom')) return 'right';
    return this.side;
  }

  /** Docked (the page beside the notes): not floating, not reduced to the Mini. */
  get docked(): boolean {
    return this.mode === 'dock' && !this.mini;
  }

  get isMini(): boolean {
    return this.mini;
  }

  get inFullscreen(): boolean {
    return this.splitScreen;
  }

  /** Where the panel stands, to be remembered for the site. */
  get placement(): PanelPlace {
    return { mode: this.mode, side: this.side, float: this.float, mini: this.miniBox, glass: this.glass };
  }

  /** The place remembered for the site. */
  restore(place: PanelPlace): void {
    this.mode = place.mode;
    this.side = place.side;
    this.float = place.float;
    this.miniBox = place.mini;
    this.glass = place.glass;
    this.apply();
  }

  /** Docks the notes to `side` (the page beside them). */
  dock(side: DockSide): void {
    this.mode = 'dock';
    this.side = side;
    this.apply();
  }

  /** Lets the notes float over the page, where they last floated. */
  undock(): void {
    this.mode = 'float';
    this.apply();
  }

  setMini(on: boolean): void {
    if (this.mini === on) return;
    this.mini = on;
    this.apply();
  }

  /** Tint of the Mini's glass (0.15 clear – 0.9 dark). */
  setGlass(value: number): void {
    this.glass = Math.min(0.9, Math.max(0.15, value));
    this.panel.style.setProperty('--glass', String(this.glass));
  }

  /** The width shown: the one chosen, as far as the window leaves room for the page. */
  private get shown(): number {
    const vw = window.innerWidth || this.width + PAGE_ROOM;
    if (this.splitScreen) return splitSize(vw, this.split, DRAWER_MIN_WIDTH, PAGE_ROOM);
    return Math.round(Math.max(DRAWER_MIN_WIDTH, Math.min(this.width, vw - PAGE_ROOM)));
  }

  /** Height of notes docked as a strip (top / bottom). */
  private get shownHeight(): number {
    const room = (window.innerHeight || this.stripHeight + PAGE_ROOM_V) - this.top - PAGE_ROOM_V;
    return Math.round(Math.max(Math.min(STRIP_MIN_HEIGHT, room), Math.min(this.stripHeight, room)));
  }

  private get top(): number {
    return this.fullscreenTarget ? 0 : this.opts.topInset();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  get hasFrame(): boolean {
    return this.iframe !== null;
  }

  mount(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  open(): void {
    this.mount();
    this.ensureFrame();
    if (this.fullscreenTarget && this.host.parentElement !== this.fullscreenTarget) this.moveHost(this.fullscreenTarget);
    this.opened = true;
    this.panel.classList.add('open');
    this.apply();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.panel.classList.remove('open');
    this.blurToPage();
    this.apply();
  }

  /** Gives keyboard focus to the panel iframe (the panel then focuses its editor). */
  focus(): void {
    this.iframe?.focus();
  }

  /** Moves keyboard focus back to the page, e.g. so native player shortcuts work again. */
  blurToPage(): void {
    if (this.iframe && document.activeElement === this.host) this.iframe.blur();
    if (document.activeElement === this.host) (document.activeElement as HTMLElement).blur();
  }

  /** Removes the editor iframe (notes detached to a pop-out window, or shown in another frame). */
  destroyFrame(): void {
    this.close();
    const old = this.iframe;
    this.iframe = null;
    if (old) retire(old);
  }

  setWidth(width: number): void {
    this.width = Math.round(Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, width)));
    this.apply();
  }

  setStripHeight(height: number): void {
    this.stripHeight = Math.round(Math.min(STRIP_MAX_HEIGHT, Math.max(STRIP_MIN_HEIGHT, height)));
    this.apply();
  }

  setSplitRatio(ratio: number): void {
    this.split = ratio;
    this.apply();
  }

  setLayout(layout: DrawerLayout): void {
    this.mode = layout === 'overlay' ? 'float' : 'dock';
    this.apply();
  }

  setSide(side: DockSide): void {
    this.side = side;
    this.apply();
  }

  /**
   * The element the notes must live in to be seen: the fullscreen element,
   * or the page's modal dialog / popover (the top layer, drawn above
   * everything else); null: the page itself.
   */
  setFullscreenTarget(target: Element | null): void {
    this.fullscreenTarget = target;
    if (target && this.opened) this.moveHost(target);
    if (!target && this.host.isConnected && this.host.parentElement !== document.documentElement) {
      this.moveHost(document.documentElement);
    }
    // Its layer went away with the notes in it (a dialog removed): back in the page.
    if (!target && this.opened && !this.host.isConnected) document.documentElement.append(this.host);
    this.apply();
  }

  /** `side-by-side` when docked (the page beside the notes), `overlay` when they float over it. */
  get layoutMode(): DrawerLayout {
    return this.docked ? 'side-by-side' : 'overlay';
  }

  /**
   * What covers the open panel (an element of the page drawn above it), null
   * when it is seen. `own`: other boxes of Boo Notes.
   */
  coveredBy(own: Element[] = []): Element | null {
    if (!this.opened || !this.host.isConnected) return null;
    const r = this.panel.getBoundingClientRect();
    if (r.width < 40 || r.height < 80) return null;
    for (const [x, y] of [
      [r.left + r.width / 2, r.top + Math.min(r.height / 2, 220)],
      [r.left + r.width / 2, r.bottom - 48],
    ]) {
      // Still sliding in, or out of the window.
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && hit !== this.host && !this.host.contains(hit) && !own.some((o) => o === hit || o.contains(hit))) return hit;
    }
    return null;
  }

  /** Last of its parent: above a page element of the same z-index added after it. */
  bringToFront(): void {
    const parent = this.host.parentElement;
    if (parent && parent.lastElementChild !== this.host) this.moveHost(parent);
  }

  /** On-screen box of the open drawer, null when closed. */
  rect(): DOMRect | null {
    return this.opened ? this.panel.getBoundingClientRect() : null;
  }

  /** True for the drawer's own elements (never part of the page's text). */
  owns(el: Element): boolean {
    return el === this.host || this.host.contains(el);
  }

  containsPoint(x: number, y: number): boolean {
    if (!this.opened) return false;
    const r = this.panel.getBoundingClientRect();
    return x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4;
  }

  destroy(): void {
    this.opened = false;
    this.apply();
    this.abort.abort();
    this.host.remove();
  }

  private ensureFrame(): void {
    if (this.iframe) return;
    this.iframe = h('iframe', {
      src: this.opts.panelUrl(),
      title: 'Boo Notes — éditeur de notes',
      // On-device translation of the subtitles (Chrome built-in AI) runs in the panel.
      allow: 'clipboard-write; translator; language-detector',
    });
    this.panel.append(this.iframe);
  }

  /** State-preserving move when supported (keeps the iframe alive), plain append otherwise. */
  private moveHost(parent: Element): void {
    const moveBefore = (parent as Element & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore;
    try {
      if (moveBefore && this.host.isConnected) {
        moveBefore.call(parent, this.host, null);
        return;
      }
    } catch {
      // Fall back to a regular move.
    }
    parent.append(this.host);
  }

  // --- Geometry ----------------------------------------------------------------------

  /** The floating card's box: where it was put, else along the right edge, full height. */
  private floatBox(): Box {
    const vw = innerWidth;
    const vh = innerHeight;
    const top = this.top;
    const fallback = (() => {
      const w = Math.min(this.width, Math.max(FLOAT_MIN.w, vw - PAGE_ROOM));
      return { x: vw - w - 10, y: top + 10, w, h: vh - top - 20 };
    })();
    return clampBox(this.float ?? fallback, vw, vh, FLOAT_MIN);
  }

  /** The Mini's box: where it was put, else low on the video, above its controls. */
  private miniRect(): Box {
    const vw = innerWidth;
    const vh = innerHeight;
    if (this.miniBox) return clampBox(this.miniBox, vw, vh, MINI_MIN);
    const w = Math.min(MINI_DEFAULT.w, vw - 32);
    const hgt = MINI_DEFAULT.h;
    const v = this.opts.videoRect?.();
    const seen = v && v.width > w && v.bottom > 0 && v.top < vh;
    const x = seen ? v.left + (v.width - w) / 2 : (vw - w) / 2;
    const y = seen ? Math.min(v.bottom, vh) - hgt - 64 : vh - hgt - 32;
    return clampBox({ x, y, w, h: hgt }, vw, vh, MINI_MIN);
  }

  /** Classes, size and place of the panel; the page's margins for docked notes. */
  private apply(): void {
    const p = this.panel;
    const kind = this.mini ? 'mini' : this.mode === 'float' ? 'float' : 'dock';
    const side = this.dockSide;
    p.classList.toggle('mini', kind === 'mini');
    p.classList.toggle('floating', kind === 'float');
    for (const s of ['right', 'left', 'top', 'bottom'] as const) p.classList.toggle(`dock-${s}`, kind === 'dock' && side === s);
    p.style.setProperty('--top', `${this.top}px`);
    p.style.setProperty('--glass', String(this.glass));
    if (kind === 'dock') {
      const across = side === 'top' || side === 'bottom';
      const size = across ? this.shownHeight : this.shown;
      p.style.setProperty(across ? '--h' : '--w', `${size}px`);
      this.handle.setAttribute('aria-orientation', across ? 'horizontal' : 'vertical');
      this.handle.setAttribute('aria-label', this.splitScreen ? 'Partage de l’écran entre la vidéo et les notes' : across ? 'Hauteur des notes' : 'Largeur des notes');
      this.handle.setAttribute('aria-valuemin', String(across ? STRIP_MIN_HEIGHT : DRAWER_MIN_WIDTH));
      this.handle.setAttribute('aria-valuemax', String(across ? STRIP_MAX_HEIGHT : DRAWER_MAX_WIDTH));
      this.handle.setAttribute('aria-valuenow', String(size));
      this.handle.title = this.splitScreen
        ? 'Glisser pour partager l’écran entre la vidéo et les notes · double-clic : 70 / 30'
        : across
          ? 'Glisser pour agrandir ou réduire les notes · double-clic : hauteur par défaut · flèches ↑ ↓ au clavier'
          : 'Glisser pour élargir ou rétrécir les notes · double-clic : largeur par défaut · flèches ← → au clavier';
    } else {
      const b = kind === 'mini' ? this.miniRect() : this.floatBox();
      p.style.setProperty('--x', `${b.x}px`);
      p.style.setProperty('--y', `${b.y}px`);
      p.style.setProperty('--bw', `${b.w}px`);
      p.style.setProperty('--bh', `${b.h}px`);
    }
    this.grip.title =
      kind === 'mini'
        ? 'Glisser pour déplacer le Mini · double-clic : panneau complet'
        : kind === 'float'
          ? 'Glisser pour déplacer le panneau · contre un bord : l’y ancrer · double-clic : ancrer'
          : `Ancré ${SIDE_LABELS[side]} · glisser pour le détacher et le déplacer · double-clic : flottant`;
    this.grip.dataset.place = kind === 'dock' ? `dock-${side}` : kind;
    this.applyMargins();
  }

  /** Docked notes: the page gives them its side (margin of the root element); restored after. */
  private applyMargins(): void {
    const want = new Map<string, string>();
    if (this.opened && this.docked && !this.fullscreenTarget) {
      const side = this.side;
      want.set(`margin-${side}`, `${side === 'top' || side === 'bottom' ? this.shownHeight : this.shown}px`);
    }
    const html = document.documentElement;
    let changed = false;
    for (const prop of ['margin-right', 'margin-left', 'margin-top', 'margin-bottom']) {
      const next = want.get(prop);
      if (next !== undefined) {
        if (!this.savedMargins.has(prop)) this.savedMargins.set(prop, { value: html.style.getPropertyValue(prop), priority: html.style.getPropertyPriority(prop) });
        if (html.style.getPropertyValue(prop) !== next || html.style.getPropertyPriority(prop) !== 'important') {
          html.style.setProperty(prop, next, 'important');
          changed = true;
        }
      } else {
        const saved = this.savedMargins.get(prop);
        if (!saved) continue;
        html.style.setProperty(prop, saved.value, saved.priority);
        this.savedMargins.delete(prop);
        changed = true;
      }
    }
    if (changed) window.dispatchEvent(new Event('resize'));
  }

  private showZone(side: DockSide | null): void {
    this.zone.classList.toggle('on', side !== null);
    if (!side) return;
    const top = this.top;
    const z = this.zone.style;
    const across = side === 'top' || side === 'bottom';
    const size = across ? Math.min(this.stripHeight, innerHeight - top - PAGE_ROOM_V) : Math.min(this.width, innerWidth - PAGE_ROOM);
    z.top = `${side === 'bottom' ? innerHeight - size : top}px`;
    z.left = `${side === 'right' ? innerWidth - size : 0}px`;
    z.width = `${across ? innerWidth : size}px`;
    z.height = `${across ? size : innerHeight - top}px`;
    (this.zone.firstElementChild as HTMLElement).textContent = `Relâchez : ancré ${SIDE_LABELS[side]}`;
  }

  // --- Moving and resizing --------------------------------------------------------------

  private placed(): void {
    this.opts.onPlaced?.();
  }

  /** Dock ↔ float (double-click or Entrée on the grip). */
  private toggleFloat(): void {
    this.mode = this.mode === 'dock' ? 'float' : 'dock';
    this.apply();
    this.placed();
  }

  private bindDrag(grip: HTMLElement): void {
    let drag: { x: number; y: number; off: { x: number; y: number }; size: { w: number; h: number }; moved: boolean; zone: DockSide | null } | null = null;
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.opened) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const r = this.panel.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, off: { x: e.clientX - r.left, y: e.clientY - r.top }, size: { w: r.width, h: r.height }, moved: false, zone: null };
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag || !grip.hasPointerCapture(e.pointerId)) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_SLOP) return;
        drag.moved = true;
        this.panel.classList.add('dragging');
        if (!this.mini && this.mode === 'dock') {
          // Undocked: the card it was when it last floated (else as wide, three quarters of the height),
          // the grip still under the pointer.
          const across = this.side === 'top' || this.side === 'bottom';
          const b = this.float
            ? this.floatBox()
            : { w: Math.min(across ? this.width : drag.size.w, innerWidth), h: Math.max(FLOAT_MIN.h, Math.round((innerHeight - this.top) * 0.75)) };
          drag.size = { w: b.w, h: b.h };
          drag.off = { x: Math.min(drag.off.x, 40), y: Math.min(drag.off.y, 40) };
          this.mode = 'float';
        }
      }
      const b = clampBox({ x: e.clientX - drag.off.x, y: e.clientY - drag.off.y, w: drag.size.w, h: drag.size.h }, innerWidth, innerHeight);
      if (this.mini) this.miniBox = b;
      else this.float = b;
      // In fullscreen, the notes take the left or the right of the screen.
      drag.zone = this.mini ? null : dockZone(e.clientX, e.clientY, innerWidth, innerHeight, this.splitScreen ? ['left', 'right'] : undefined);
      this.showZone(drag.zone);
      this.apply();
    });
    const end = (e: PointerEvent) => {
      if (!drag || !grip.hasPointerCapture(e.pointerId)) return;
      grip.releasePointerCapture(e.pointerId);
      const done = drag;
      drag = null;
      this.panel.classList.remove('dragging');
      this.showZone(null);
      if (!done.moved) return;
      if (done.zone) {
        this.mode = 'dock';
        this.side = done.zone;
      }
      this.apply();
      this.placed();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('dblclick', () => {
      if (this.mini) this.opts.onExpand?.();
      else this.toggleFloat();
    });
    // From the keyboard: arrows move the card (Maj: by larger steps) or dock to that side; Entrée: dock / float.
    grip.addEventListener('keydown', (e) => {
      const arrows: Record<string, DockSide> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' };
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (this.mini) this.opts.onExpand?.();
        else this.toggleFloat();
        return;
      }
      const dir = arrows[e.key];
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      if (!this.mini && this.mode === 'dock') {
        this.side = dir;
        this.apply();
        this.placed();
        return;
      }
      const step = e.shiftKey ? 80 : 20;
      const b = this.mini ? this.miniRect() : this.floatBox();
      const dx = dir === 'left' ? -step : dir === 'right' ? step : 0;
      const dy = dir === 'top' ? -step : dir === 'bottom' ? step : 0;
      const next = clampBox({ ...b, x: b.x + dx, y: b.y + dy }, innerWidth, innerHeight);
      if (this.mini) this.miniBox = next;
      else this.float = next;
      this.apply();
      this.placed();
    });
  }

  /** An edge or corner of the floating card / the Mini. */
  private bindEdge(el: HTMLElement, edges: string): void {
    let start: { x: number; y: number; box: Box } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, box: this.mini ? this.miniRect() : this.floatBox() };
      this.panel.classList.add('resizing');
    });
    el.addEventListener('pointermove', (e) => {
      if (!start || !el.hasPointerCapture(e.pointerId)) return;
      const b = resizeBox(start.box, edges, e.clientX - start.x, e.clientY - start.y, innerWidth, innerHeight, this.mini ? MINI_MIN : FLOAT_MIN);
      if (this.mini) this.miniBox = b;
      else this.float = b;
      this.apply();
    });
    const end = (e: PointerEvent) => {
      if (!start || !el.hasPointerCapture(e.pointerId)) return;
      el.releasePointerCapture(e.pointerId);
      start = null;
      this.panel.classList.remove('resizing');
      this.placed();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** The separator of docked notes: their width (height for a strip), the split in fullscreen. */
  private bindResize(handle: HTMLElement): void {
    let start: { x: number; y: number; size: number } | null = null;
    let frame = 0;
    const across = () => this.dockSide === 'top' || this.dockSide === 'bottom';
    const sizeNow = () => (across() ? this.shownHeight : this.shown);
    const setSize = (size: number) => {
      if (this.splitScreen) this.split = splitRatio(innerWidth, size);
      else if (across()) this.stripHeight = Math.round(Math.min(STRIP_MAX_HEIGHT, Math.max(STRIP_MIN_HEIGHT, size)));
      else this.width = Math.round(Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, size)));
      this.apply();
    };
    const commit = () => {
      if (this.splitScreen) this.opts.onSplit?.(this.split);
      else if (across()) this.opts.onStripResized?.(this.stripHeight);
      else this.opts.onResized(this.width);
    };
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY, size: sizeNow() };
      handle.setPointerCapture(e.pointerId);
      this.panel.classList.add('resizing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start || !handle.hasPointerCapture(e.pointerId)) return;
      // Towards the page: larger notes.
      const side = this.dockSide;
      const delta = side === 'right' ? start.x - e.clientX : side === 'left' ? e.clientX - start.x : side === 'bottom' ? start.y - e.clientY : e.clientY - start.y;
      const next = start.size + delta;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSize(next));
    });
    const end = (e: PointerEvent) => {
      if (!start || !handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      start = null;
      this.panel.classList.remove('resizing');
      commit();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    // Double-click resets the default size (macOS split-view convention); in fullscreen, 70 / 30.
    handle.addEventListener('dblclick', () => {
      if (this.splitScreen) this.split = SPLIT_DEFAULT;
      else if (across()) this.stripHeight = DEFAULT_STRIP;
      else this.width = DEFAULT_WIDTH;
      this.apply();
      commit();
    });
    // From the keyboard: towards the page, larger (Maj: by larger steps); Entrée: the default size.
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 80 : 20;
      const side = this.dockSide;
      const grow: Record<DockSide, string> = { right: 'ArrowLeft', left: 'ArrowRight', top: 'ArrowDown', bottom: 'ArrowUp' };
      const shrink: Record<DockSide, string> = { right: 'ArrowRight', left: 'ArrowLeft', top: 'ArrowUp', bottom: 'ArrowDown' };
      const min = across() ? STRIP_MIN_HEIGHT : DRAWER_MIN_WIDTH;
      const max = across() ? STRIP_MAX_HEIGHT : DRAWER_MAX_WIDTH;
      const now = sizeNow();
      const next =
        e.key === grow[side] ? now + step
        : e.key === shrink[side] ? now - step
        : e.key === 'Home' ? min
        : e.key === 'End' ? max
        : e.key === 'Enter' ? null
        : undefined;
      if (next === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      if (next === null) {
        handle.dispatchEvent(new MouseEvent('dblclick'));
        return;
      }
      setSize(next);
      commit();
    });
  }
}

/**
 * Removes an editor once it has saved what was just typed (the panel saves
 * a moment after the last keystroke: removed at once, those keystrokes could
 * be lost while the notes reopen elsewhere). Hidden meanwhile; removed anyway
 * if it does not answer.
 */
function retire(iframe: HTMLIFrameElement): void {
  iframe.classList.add('retired');
  const win = iframe.contentWindow;
  let timer = 0;
  const onMessage = (e: MessageEvent) => {
    if (e.source === win && (e.data as { booNotesFlushed?: unknown } | null)?.booNotesFlushed === true) done();
  };
  const done = () => {
    clearTimeout(timer);
    window.removeEventListener('message', onMessage);
    iframe.remove();
  };
  if (!win || !iframe.isConnected) {
    done();
    return;
  }
  window.addEventListener('message', onMessage);
  timer = window.setTimeout(done, RETIRE_MS);
  try {
    win.postMessage({ booNotesFlush: true }, new URL(iframe.src).origin);
  } catch {
    done();
  }
}
