import { h, icon } from '../shared/icons';
import { formatTimecode } from '../shared/time';

/**
 * Everything drawn on top of the video lives in this shadow root: the
 * floating HUD, the capture flash, toasts and the progress-bar preview
 * marker. It is a separate layer (pointer-events: none) positioned from the
 * player's geometry: the native player DOM is never touched.
 */
export interface OverlayGeometry {
  videoRect(): DOMRect | null;
  contentRect(): DOMRect | null;
  progressBarRect(): DOMRect | null;
  currentTime(): number;
  duration(): number;
  /** True when (x, y) is over the notes drawer. */
  isOverUi(x: number, y: number): boolean;
}

export interface OverlayActions {
  copyTimestamp(): void;
  capture(): void;
  togglePin(): void;
  openSettings(): void;
}

export type ToastKind = 'info' | 'success' | 'error';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.hud {
  position: fixed; top: 0; left: 0; display: flex; align-items: center; gap: 2px; padding: 3px;
  border-radius: 999px; background: rgba(18, 18, 22, 0.82); color: #f4f4f5;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px); font: 500 12px/1 ${MONO};
  opacity: 0; pointer-events: none; transition: opacity 0.16s ease; will-change: transform, opacity;
}
.hud.visible { opacity: 1; pointer-events: auto; }
.hud button {
  all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  height: 28px; min-width: 28px; padding: 0 6px; border-radius: 999px; cursor: pointer; color: inherit; font: inherit;
}
.hud button:hover { background: rgba(255, 255, 255, 0.14); }
.hud button:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 1px; }
.hud button[aria-pressed="true"] { background: #6d5ef0; color: #fff; }
.hud .tc { padding: 0 10px; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.hud .tc::before { content: "["; opacity: 0.55; margin-right: 3px; }
.hud .tc::after { content: "]"; opacity: 0.55; margin-left: 3px; }
.hud .sep { width: 1px; height: 16px; background: rgba(255, 255, 255, 0.16); margin: 0 2px; }
.flash { position: fixed; top: 0; left: 0; width: 0; height: 0; background: #fff; opacity: 0; pointer-events: none; }
.toasts { position: fixed; top: 0; left: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; pointer-events: none; }
.toast {
  max-width: min(420px, 80vw); padding: 7px 12px; border-radius: 8px; background: rgba(14, 14, 17, 0.92);
  color: #f4f4f5; font: 500 12px/1.35 ${MONO}; white-space: pre-wrap;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  opacity: 0; transform: translateY(6px); transition: opacity 0.16s ease, transform 0.16s ease;
}
.toast.show { opacity: 1; transform: none; }
.toast.success { box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35), inset 3px 0 0 #22c55e; }
.toast.error { box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35), inset 3px 0 0 #f59e0b; }
.marker { position: fixed; top: 0; left: 0; opacity: 0; transition: opacity 0.12s ease; pointer-events: none; }
.marker.visible { opacity: 1; }
.marker .line {
  position: absolute; left: -2px; top: -9px; width: 4px; height: 18px; border-radius: 2px; background: #facc15;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), 0 0 10px rgba(250, 204, 21, 0.75);
}
.marker .label {
  position: absolute; left: 0; bottom: 14px; transform: translateX(-50%); padding: 3px 6px; border-radius: 4px;
  background: #facc15; color: #111; font: 600 11px/1 ${MONO}; white-space: nowrap; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
@media (prefers-reduced-motion: reduce) { .hud, .toast, .marker { transition: none; } }
`;

export function attachStyles(root: ShadowRoot, css: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    root.append(h('style', {}, css));
  }
}

const HUD_MARGIN = 12;
const TOAST_LIMIT = 3;

export class Overlay {
  readonly host: HTMLDivElement;
  private readonly hud: HTMLDivElement;
  private readonly tc: HTMLButtonElement;
  private readonly pinButton: HTMLButtonElement;
  private readonly captureButton: HTMLButtonElement;
  private readonly flashEl: HTMLDivElement;
  private readonly toasts: HTMLDivElement;
  private readonly marker: HTMLDivElement;
  private readonly markerLabel: HTMLDivElement;
  private hudVisible = false;
  private hudTimer: ReturnType<typeof setTimeout> | null = null;
  private markerSeconds: number | null = null;
  private raf = 0;
  private enabled = true;

  constructor(
    private readonly geo: OverlayGeometry,
    actions: OverlayActions,
  ) {
    this.host = h('div', { id: 'boo-notes-overlay' });
    this.host.style.cssText =
      'all:initial;display:block;position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    const root = this.host.attachShadow({ mode: 'open' });
    attachStyles(root, CSS);

    const button = (label: string, child: Node, onClick: () => void, extra: Record<string, string> = {}) => {
      const b = h('button', { type: 'button', title: label, 'aria-label': label, ...extra }, child);
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    };

    this.tc = button('Copier le lien horodaté (Markdown)', document.createTextNode('00:00'), () => actions.copyTimestamp());
    this.tc.classList.add('tc');
    this.pinButton = button('Épingler le panneau de notes', icon('pin'), () => actions.togglePin(), {
      'aria-pressed': 'false',
    });
    this.captureButton = button('Capturer l’image', icon('camera'), () => actions.capture());
    this.hud = h(
      'div',
      { class: 'hud', role: 'toolbar', 'aria-label': 'Boo Notes' },
      this.tc,
      h('span', { class: 'sep', 'aria-hidden': 'true' }),
      this.captureButton,
      this.pinButton,
      button('Paramètres Boo Notes', icon('settings'), () => actions.openSettings()),
    );
    this.hud.inert = true;
    // Keep the HUD alive while the pointer is on it.
    this.hud.addEventListener('pointerenter', () => this.armHide(4000));

    this.flashEl = h('div', { class: 'flash' });
    this.toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    this.markerLabel = h('div', { class: 'label' });
    this.marker = h('div', { class: 'marker', 'aria-hidden': 'true' }, h('div', { class: 'line' }), this.markerLabel);
    root.append(this.flashEl, this.hud, this.toasts, this.marker);
  }

  mount(parent: Element = document.documentElement): void {
    if (this.host.parentElement !== parent) parent.append(this.host);
  }

  /** Moves the layer into the fullscreen element (top layer), or back. */
  reparent(target: Element | null): void {
    this.mount(target ?? document.documentElement);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    if (this.hudTimer) clearTimeout(this.hudTimer);
    this.host.remove();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.hideHud();
  }

  setPinned(pinned: boolean): void {
    this.pinButton.setAttribute('aria-pressed', String(pinned));
    const label = pinned ? 'Détacher l’épingle du panneau' : 'Épingler le panneau de notes';
    this.pinButton.title = label;
    this.pinButton.setAttribute('aria-label', label);
  }

  /** Shows the configured global shortcut in the capture button tooltip. */
  setCaptureShortcut(shortcut: string): void {
    const label = shortcut ? `Capturer l’image (${shortcut})` : 'Capturer l’image';
    this.captureButton.title = label;
    this.captureButton.setAttribute('aria-label', label);
  }

  /** Temporarily hides the whole layer (visible-tab screenshots). */
  setHidden(hidden: boolean): void {
    this.host.style.visibility = hidden ? 'hidden' : '';
  }

  onPointerMove(x: number, y: number, path: EventTarget[]): void {
    if (!this.enabled) return;
    if (path.includes(this.hud)) {
      this.armHide(4000);
      return;
    }
    const r = this.geo.videoRect();
    const inside = r !== null && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && !this.geo.isOverUi(x, y);
    if (inside) {
      this.showHud();
      this.armHide(2500);
    } else if (this.hudVisible) {
      this.armHide(250);
    }
  }

  toast(text: string, kind: ToastKind = 'info', ms = 2000): void {
    const el = h('div', { class: `toast ${kind}` }, text);
    this.toasts.append(el);
    while (this.toasts.childElementCount > TOAST_LIMIT) this.toasts.firstElementChild?.remove();
    this.layout();
    this.ensureLoop();
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 200);
    }, ms);
  }

  /** 100 ms white flash over the picture: the capture feedback. */
  flash(): void {
    const r = this.geo.contentRect();
    if (!r) return;
    Object.assign(this.flashEl.style, {
      transform: `translate(${r.left}px, ${r.top}px)`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    this.flashEl.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 100, easing: 'ease-out' });
  }

  showMarker(seconds: number): void {
    this.markerSeconds = seconds;
    this.markerLabel.textContent = formatTimecode(seconds);
    this.layout();
    this.marker.classList.toggle('visible', this.markerPosition() !== null);
    this.ensureLoop();
  }

  hideMarker(): void {
    this.markerSeconds = null;
    this.marker.classList.remove('visible');
  }

  private showHud(): void {
    if (this.hudVisible) return;
    this.hudVisible = true;
    this.hud.inert = false;
    this.layout();
    this.hud.classList.add('visible');
    this.ensureLoop();
  }

  private hideHud(): void {
    this.hudVisible = false;
    this.hud.inert = true;
    this.hud.classList.remove('visible');
  }

  private armHide(ms: number): void {
    if (this.hudTimer) clearTimeout(this.hudTimer);
    this.hudTimer = setTimeout(() => this.hideHud(), ms);
  }

  private ensureLoop(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = () => {
    this.raf = 0;
    if (!this.hudVisible && this.markerSeconds === null && this.toasts.childElementCount === 0) return;
    this.layout();
    this.raf = requestAnimationFrame(this.tick);
  };

  private markerPosition(): { x: number; y: number } | null {
    const duration = this.geo.duration();
    if (this.markerSeconds === null || !(duration > 0)) return null;
    const ratio = Math.min(1, Math.max(0, this.markerSeconds / duration));
    const bar = this.geo.progressBarRect();
    if (bar) return { x: bar.left + bar.width * ratio, y: bar.top + bar.height / 2 };
    // No native bar found: draw along the bottom edge of the video.
    const v = this.geo.videoRect();
    if (!v) return null;
    return { x: v.left + 12 + (v.width - 24) * ratio, y: v.bottom - 8 };
  }

  private layout(): void {
    const video = this.geo.videoRect();
    if (this.hudVisible && video) {
      const w = this.hud.offsetWidth;
      const left = Math.max(4, Math.min(innerWidth - w - 4, video.right - w - HUD_MARGIN));
      const top = Math.max(4, video.top + HUD_MARGIN);
      this.hud.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      this.tc.textContent = formatTimecode(this.geo.currentTime());
    } else if (this.hudVisible) {
      this.hideHud();
    }

    if (this.toasts.childElementCount > 0) {
      const bar = this.geo.progressBarRect();
      const left = video ? Math.max(8, video.left + HUD_MARGIN) : 16;
      // Bottom-left of the player, above the native control bar.
      const bottom = bar ? bar.top - 10 : video ? video.bottom - 60 : innerHeight - 16;
      this.toasts.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.min(bottom, innerHeight - 8))}px) translateY(-100%)`;
    }

    if (this.markerSeconds !== null) {
      const pos = this.markerPosition();
      this.marker.classList.toggle('visible', pos !== null);
      if (pos) this.marker.style.transform = `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)`;
    }
  }
}
