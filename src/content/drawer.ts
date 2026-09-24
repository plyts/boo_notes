import { h } from '../shared/icons';
import { DEFAULT_SETTINGS, DRAWER_MAX_WIDTH, DRAWER_MIN_WIDTH, type DrawerLayout } from '../shared/settings';
import { attachStyles } from './overlay';

const DEFAULT_WIDTH = DEFAULT_SETTINGS.drawerWidth;

/**
 * Right-hand retractable drawer. It only hosts an <iframe> of the extension's
 * panel page: keystrokes typed in the notes never reach the page (no clash
 * with YouTube's `k`, `j`, `f`… shortcuts) and page CSS cannot leak in.
 *
 * In `side-by-side` layout the page is narrowed by the drawer width so the
 * player and its controls stay fully visible.
 */
const CSS = `
:host { all: initial; }
.drawer {
  position: fixed; top: var(--top, 0px); right: 0; bottom: 0; width: var(--w, 360px); display: flex; box-sizing: border-box;
  transform: translateX(100%); visibility: hidden;
  transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), visibility 0s linear 0.18s;
  box-shadow: -10px 0 30px rgba(0, 0, 0, 0.28); border-left: 1px solid rgba(127, 127, 127, 0.25);
}
.drawer.open { transform: none; visibility: visible; transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), visibility 0s; }
.drawer.resizing { transition: none; }
iframe { flex: 1; width: 100%; height: 100%; border: 0; display: block; background: transparent; }
.drawer.resizing iframe { pointer-events: none; }
.resize { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 1; touch-action: none; }
.resize::after {
  content: ""; position: absolute; left: 3px; top: 0; bottom: 0; width: 2px; background: #6d5ef0;
  opacity: 0; transition: opacity 0.12s ease;
}
.resize:hover::after, .drawer.resizing .resize::after { opacity: 1; }
/* Overlay layout & fullscreen: a floating card that clearly sits above the page. */
.drawer.floating {
  top: calc(var(--top, 0px) + 10px); right: 10px; bottom: 10px; border: 0; border-radius: 14px; overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(127, 127, 127, 0.28);
  transform: translateX(calc(100% + 20px));
}
.drawer.floating.open { transform: none; }
.drawer.floating .resize { left: 0; }
.drawer.floating .resize::after { left: 0; }
@media (prefers-reduced-motion: reduce) { .drawer, .drawer.open { transition: none; } }
`;

export interface DrawerOptions {
  panelUrl: () => string;
  width: number;
  layout: DrawerLayout;
  topInset: () => number;
  onResized: (width: number) => void;
}

export class Drawer {
  readonly host: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private iframe: HTMLIFrameElement | null = null;
  private opened = false;
  private width: number;
  private layout: DrawerLayout;
  private fullscreenTarget: Element | null = null;
  private savedMargin: { value: string; priority: string } | null = null;

  constructor(private readonly opts: DrawerOptions) {
    this.width = opts.width;
    this.layout = opts.layout;
    this.host = h('div', { id: 'boo-notes-drawer' });
    this.host.style.cssText = 'all:initial;display:block;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;';
    const root = this.host.attachShadow({ mode: 'open' });
    attachStyles(root, CSS);
    const handle = h('div', { class: 'resize', 'aria-hidden': 'true', title: 'Glisser pour redimensionner · double-clic : largeur par défaut' });
    this.panel = h('div', { class: 'drawer', role: 'complementary', 'aria-label': 'Notes Boo Notes' }, handle);
    root.append(this.panel);
    this.bindResize(handle);
    this.applyWidth();
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
    this.panel.style.setProperty('--top', `${this.fullscreenTarget ? 0 : this.opts.topInset()}px`);
    this.opened = true;
    this.panel.classList.add('open');
    this.applyDock();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.panel.classList.remove('open');
    this.blurToPage();
    this.applyDock();
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

  /** Removes the editor iframe (notes detached to a pop-out window). */
  destroyFrame(): void {
    this.close();
    this.iframe?.remove();
    this.iframe = null;
  }

  setWidth(width: number): void {
    this.width = Math.round(Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, width)));
    this.applyWidth();
    this.applyDock();
  }

  setLayout(layout: DrawerLayout): void {
    this.layout = layout;
    this.applyDock();
  }

  /** Fullscreen: the drawer must live inside the fullscreen element to be visible. */
  setFullscreenTarget(target: Element | null): void {
    this.fullscreenTarget = target;
    if (target && this.opened) this.moveHost(target);
    if (!target && this.host.isConnected && this.host.parentElement !== document.documentElement) {
      this.moveHost(document.documentElement);
    }
    this.panel.style.setProperty('--top', `${target ? 0 : this.opts.topInset()}px`);
    this.applyDock();
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
    return x >= r.left - 4 && x <= r.right && y >= r.top && y <= r.bottom;
  }

  destroy(): void {
    this.opened = false;
    this.applyDock();
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

  private applyWidth(): void {
    this.panel.style.setProperty('--w', `${this.width}px`);
  }

  private applyFloating(): void {
    this.panel.classList.toggle('floating', this.layout === 'overlay' || this.fullscreenTarget !== null);
  }

  /** Side-by-side layout: reserve the drawer width on the right of the page. */
  private applyDock(): void {
    this.applyFloating();
    const shouldDock = this.opened && this.layout === 'side-by-side' && !this.fullscreenTarget;
    const html = document.documentElement;
    if (shouldDock) {
      this.savedMargin ??= {
        value: html.style.getPropertyValue('margin-right'),
        priority: html.style.getPropertyPriority('margin-right'),
      };
      const next = `${this.width}px`;
      if (html.style.getPropertyValue('margin-right') !== next) {
        html.style.setProperty('margin-right', next, 'important');
        window.dispatchEvent(new Event('resize'));
      }
    } else if (this.savedMargin) {
      html.style.setProperty('margin-right', this.savedMargin.value, this.savedMargin.priority);
      this.savedMargin = null;
      window.dispatchEvent(new Event('resize'));
    }
  }

  private bindResize(handle: HTMLElement): void {
    let startX = 0;
    let startWidth = 0;
    let frame = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startX = e.clientX;
      startWidth = this.width;
      handle.setPointerCapture(e.pointerId);
      this.panel.classList.add('resizing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const next = startWidth + (startX - e.clientX);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => this.setWidth(next));
    });
    const end = (e: PointerEvent) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      this.panel.classList.remove('resizing');
      this.opts.onResized(this.width);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    // Double-click resets the default width (macOS split-view convention).
    handle.addEventListener('dblclick', () => {
      this.setWidth(DEFAULT_WIDTH);
      this.opts.onResized(this.width);
    });
  }
}
