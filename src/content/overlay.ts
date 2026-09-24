import { h, icon, type IconName } from '../shared/icons';
import { IS_MAC, shortcutKeys } from '../shared/keycaps';
import { formatTimecode } from '../shared/time';

/**
 * Everything drawn on top of the video lives in this shadow root: the
 * floating HUD (+ its tooltips), the capture flash, toasts and the
 * progress-bar preview marker. It is a separate layer (pointer-events: none)
 * positioned from the player's geometry: the native player DOM is never touched.
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

export interface ToastExtra {
  /** Data URL of the captured frame, shown as a thumbnail (macOS screenshot style). */
  thumb?: string;
  icon?: IconName;
}

const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SPRING = 'cubic-bezier(0.34, 1.36, 0.64, 1)';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }

/* HUD pill — top-right of the player */
.hud {
  position: fixed; top: 0; left: 0; display: flex; align-items: center; gap: 2px; padding: 3px;
  border-radius: 999px; background: rgba(18, 18, 22, 0.8); color: #f4f4f5;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.09);
  backdrop-filter: blur(14px) saturate(1.4); font: 500 12px/1 ${MONO};
  opacity: 0; translate: 0 -4px; pointer-events: none;
  transition: opacity 0.16s ease, translate 0.22s ${SPRING};
  will-change: transform, opacity;
}
.hud.visible { opacity: 1; translate: 0 0; pointer-events: auto; }
.hud button {
  all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 30px; min-width: 30px; padding: 0 7px; border-radius: 999px; cursor: pointer; color: inherit; font: inherit;
  transition: background 0.12s ease, color 0.12s ease;
}
.hud button:hover { background: rgba(255, 255, 255, 0.14); }
.hud button:active { background: rgba(255, 255, 255, 0.2); }
.hud button:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 1px; }
.hud button[aria-pressed="true"] { background: #6d5ef0; color: #fff; }
.hud .tc { padding: 0 11px; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; min-width: 72px; }
.hud .tc::before { content: "["; opacity: 0.5; margin-right: 3px; }
.hud .tc::after { content: "]"; opacity: 0.5; margin-left: 3px; }
.hud .tc.copied { color: #4ade80; font-family: ${SANS}; font-weight: 600; }
.hud .tc.copied::before, .hud .tc.copied::after { content: none; }
.hud .sep { width: 1px; height: 16px; background: rgba(255, 255, 255, 0.16); margin: 0 3px; }

/* Quick tooltips (native title tooltips are slow and unstyled) */
.tip {
  position: fixed; top: 0; left: 0; display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 10px;
  border-radius: 8px; background: rgba(14, 14, 17, 0.95); color: #f4f4f5; font: 500 12px/1.2 ${SANS};
  white-space: nowrap; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); pointer-events: none;
  opacity: 0; translate: 0 -2px; transition: opacity 0.12s ease, translate 0.12s ease;
}
.tip.visible { opacity: 1; translate: 0 0; }
.keys { display: inline-flex; gap: 3px; }
kbd {
  display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px;
  background: rgba(255, 255, 255, 0.12); box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.12);
  color: #fff; font: 600 11px/1 ${SANS};
}

/* Capture flash */
.flash { position: fixed; top: 0; left: 0; width: 0; height: 0; background: #fff; opacity: 0; pointer-events: none; }

/* Toasts — bottom-left of the player, above its controls */
.toasts { position: fixed; top: 0; left: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; pointer-events: none; }
.toast {
  display: flex; align-items: center; gap: 10px; max-width: min(440px, 80vw); padding: 7px 14px 7px 7px;
  border-radius: 11px; background: rgba(18, 18, 22, 0.94); color: #e4e4e7; font: 500 12px/1.35 ${MONO};
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(12px);
  opacity: 0; transform: translateY(10px) scale(0.97); transform-origin: bottom left;
  transition: opacity 0.16s ease, transform 0.28s ${SPRING};
}
.toast.show { opacity: 1; transform: none; }
.toast.leave { opacity: 0; transform: translateY(4px); transition: opacity 0.18s ease, transform 0.18s ease; }
.toast .ico {
  display: grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: 7px;
  background: rgba(255, 255, 255, 0.08); color: #c4b5fd;
}
.toast.success .ico { color: #4ade80; }
.toast.error .ico { color: #fbbf24; }
.toast .thumb {
  flex: none; width: 64px; height: 36px; object-fit: cover; border-radius: 6px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14);
}
.toast .t-tc { color: #fff; font-weight: 700; font-variant-numeric: tabular-nums; }
.toast .t-sep { opacity: 0.4; }
.toast .t-msg { color: #e4e4e7; }

/* Progress-bar preview marker */
.marker { position: fixed; top: 0; left: 0; opacity: 0; transition: opacity 0.12s ease; pointer-events: none; }
.marker.visible { opacity: 1; }
.marker .line {
  position: absolute; left: -2px; top: -9px; width: 4px; height: 18px; border-radius: 2px; background: #facc15;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), 0 0 10px rgba(250, 204, 21, 0.75);
}
.marker .label {
  position: absolute; left: 0; bottom: 14px; transform: translateX(-50%); padding: 3px 6px; border-radius: 5px;
  background: #facc15; color: #111; font: 700 11px/1 ${MONO}; white-space: nowrap; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

/* Reading mode: "Citer" bubble above the page selection */
.quote-bubble {
  all: unset; box-sizing: border-box; position: fixed; top: 0; left: 0; display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 11px 0 9px; border-radius: 999px; cursor: pointer;
  background: rgba(18, 18, 22, 0.92); color: #f4f4f5; font: 600 12px/1 ${SANS};
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3), inset 0 0 0 1px rgba(255, 255, 255, 0.1);
  opacity: 0; visibility: hidden; translate: 0 4px; pointer-events: none;
  transition: opacity 0.14s ease, translate 0.2s ${SPRING}, visibility 0s linear 0.14s;
}
.quote-bubble.visible { opacity: 1; visibility: visible; translate: 0 0; pointer-events: auto; transition-delay: 0s; }
.quote-bubble:hover { background: #6d5ef0; }
.quote-bubble:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
.quote-bubble kbd { background: rgba(255, 255, 255, 0.16); }

@media (prefers-reduced-motion: reduce) {
  .hud, .tip, .toast, .toast.leave, .marker, .quote-bubble { transition: none; }
}
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
const TIP_DELAY_MS = 280;
const TOAST_TIMECODE = /^((?:\d+:)?\d{1,2}:\d{2}) - (.+)$/s;

export class Overlay {
  readonly host: HTMLDivElement;
  private readonly hud: HTMLDivElement;
  private readonly tc: HTMLButtonElement;
  private readonly pinButton: HTMLButtonElement;
  private readonly captureButton: HTMLButtonElement;
  private readonly tip: HTMLDivElement;
  private readonly flashEl: HTMLDivElement;
  private readonly toasts: HTMLDivElement;
  private readonly marker: HTMLDivElement;
  private readonly markerLabel: HTMLDivElement;
  private readonly quoteBubble: HTMLButtonElement;
  private readonly quoteKeys: HTMLSpanElement;
  private onQuote: (() => void) | null = null;
  private hudVisible = false;
  private hudTimer: ReturnType<typeof setTimeout> | null = null;
  private tipTimer: ReturnType<typeof setTimeout> | null = null;
  private copiedUntil = 0;
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
      const b = h('button', { type: 'button', 'aria-label': label, 'data-tip': label, ...extra }, child);
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideTip();
        onClick();
      });
      b.addEventListener('pointerenter', () => this.scheduleTip(b));
      b.addEventListener('pointerleave', () => this.hideTip());
      b.addEventListener('focus', () => this.scheduleTip(b));
      b.addEventListener('blur', () => this.hideTip());
      return b;
    };

    this.tc = button('Copier le lien horodaté', document.createTextNode('00:00'), () => actions.copyTimestamp());
    this.tc.classList.add('tc');
    this.captureButton = button('Capturer l’image', icon('camera'), () => actions.capture());
    this.pinButton = button('Garder les notes ouvertes', icon('pin'), () => actions.togglePin(), {
      'aria-pressed': 'false',
    });
    this.hud = h(
      'div',
      { class: 'hud', role: 'toolbar', 'aria-label': 'Boo Notes' },
      this.tc,
      h('span', { class: 'sep', 'aria-hidden': 'true' }),
      this.captureButton,
      this.pinButton,
      button('Paramètres', icon('settings'), () => actions.openSettings()),
    );
    this.hud.inert = true;
    // Keep the HUD alive while the pointer is on it.
    this.hud.addEventListener('pointerenter', () => this.armHide(4000));

    this.tip = h('div', { class: 'tip', role: 'tooltip' });
    this.flashEl = h('div', { class: 'flash' });
    this.toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    this.markerLabel = h('div', { class: 'label' });
    this.marker = h('div', { class: 'marker', 'aria-hidden': 'true' }, h('div', { class: 'line' }), this.markerLabel);
    this.quoteKeys = h('span', { class: 'keys' });
    this.quoteBubble = h(
      'button',
      { type: 'button', class: 'quote-bubble', 'aria-label': 'Citer ce passage dans la note' },
      icon('quote', 15),
      h('span', {}, 'Citer'),
      this.quoteKeys,
    );
    this.quoteBubble.inert = true;
    // Keep the page selection: the button must not take the focus on press.
    this.quoteBubble.addEventListener('pointerdown', (e) => e.preventDefault());
    this.quoteBubble.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onQuote?.();
    });
    root.append(this.flashEl, this.hud, this.tip, this.toasts, this.marker, this.quoteBubble);
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
    if (this.tipTimer) clearTimeout(this.tipTimer);
    this.host.remove();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.hideHud();
  }

  setPinned(pinned: boolean): void {
    this.pinButton.setAttribute('aria-pressed', String(pinned));
    const label = pinned ? 'Ne plus garder les notes ouvertes' : 'Garder les notes ouvertes';
    this.pinButton.dataset.tip = label;
    this.pinButton.setAttribute('aria-label', label);
  }

  /** Shows the configured global shortcut in the capture button tooltip. */
  setCaptureShortcut(shortcut: string): void {
    this.captureButton.dataset.keys = shortcut;
    this.captureButton.setAttribute('aria-label', shortcut ? `Capturer l’image (${shortcut})` : 'Capturer l’image');
  }

  /** In-place confirmation on the timecode pill (feedback where the user clicked). */
  confirmCopy(): void {
    this.copiedUntil = performance.now() + 1400;
    this.tc.classList.add('copied');
    this.tc.textContent = '✓ Copié';
    this.armHide(2500);
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

  /** Last error messages shown (for « Diagnostic de cette page »). */
  readonly errors: string[] = [];

  toast(text: string, kind: ToastKind = 'info', ms = 2000, extra: ToastExtra = {}): void {
    if (kind === 'error') {
      this.errors.push(text);
      if (this.errors.length > 5) this.errors.shift();
    }
    const m = TOAST_TIMECODE.exec(text);
    const body = m
      ? [h('span', { class: 't-tc' }, m[1]), h('span', { class: 't-sep' }, ' - '), h('span', { class: 't-msg' }, m[2])]
      : [h('span', { class: 't-msg' }, text)];
    const glyph = icon(extra.icon ?? (kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'clock'), 15);
    let lead: HTMLElement = h('span', { class: 'ico', 'aria-hidden': 'true' }, glyph);
    if (extra.thumb) {
      const img = h('img', { class: 'thumb', alt: '' });
      const fallback = lead;
      // The site's CSP may refuse data: images: fall back to the icon.
      img.addEventListener('error', () => img.replaceWith(fallback), { once: true });
      img.src = extra.thumb;
      lead = img;
    }
    const el = h('div', { class: `toast ${kind}` }, lead, h('span', {}, ...body));
    this.toasts.append(el);
    while (this.toasts.childElementCount > TOAST_LIMIT) this.toasts.firstElementChild?.remove();
    this.layout();
    this.ensureLoop();
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.add('leave');
      setTimeout(() => el.remove(), 200);
    }, ms);
  }

  /** 100 ms white flash over the picture (or `area`): the capture feedback. */
  flash(area?: DOMRect): void {
    const r = area ?? this.geo.contentRect();
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

  /** Reading mode: "Citer" bubble above the end of the page selection (`rect`). */
  showQuoteButton(rect: DOMRect, shortcut: string, onQuote: () => void): void {
    this.onQuote = onQuote;
    this.quoteKeys.replaceChildren(...shortcutKeys(shortcut, IS_MAC).map((k) => h('kbd', {}, k)));
    this.quoteBubble.inert = false;
    this.quoteBubble.classList.add('visible');
    const w = this.quoteBubble.offsetWidth || 90;
    const left = Math.max(8, Math.min(innerWidth - w - 8, rect.right - w / 2));
    const top = rect.top - 40 >= 8 ? rect.top - 40 : rect.bottom + 8;
    this.quoteBubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  hideQuoteButton(): void {
    this.onQuote = null;
    this.quoteBubble.inert = true;
    this.quoteBubble.classList.remove('visible');
  }

  private scheduleTip(button: HTMLButtonElement): void {
    if (this.tipTimer) clearTimeout(this.tipTimer);
    this.tipTimer = setTimeout(() => this.showTip(button), TIP_DELAY_MS);
  }

  private showTip(button: HTMLButtonElement): void {
    if (!this.hudVisible) return;
    const keys = shortcutKeys(button.dataset.keys ?? '', IS_MAC);
    this.tip.replaceChildren(
      h('span', {}, button.dataset.tip ?? ''),
      ...(keys.length ? [h('span', { class: 'keys' }, ...keys.map((k) => h('kbd', {}, k)))] : []),
    );
    const r = button.getBoundingClientRect();
    const w = this.tip.offsetWidth;
    const left = Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2));
    this.tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(r.bottom + 8)}px)`;
    this.tip.classList.add('visible');
  }

  private hideTip(): void {
    if (this.tipTimer) clearTimeout(this.tipTimer);
    this.tipTimer = null;
    this.tip.classList.remove('visible');
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
    this.hideTip();
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
      if (performance.now() >= this.copiedUntil) {
        this.tc.classList.remove('copied');
        this.tc.textContent = formatTimecode(this.geo.currentTime());
      }
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
