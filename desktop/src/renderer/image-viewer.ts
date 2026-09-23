import type { ItemView, Pin } from '../ipc';
import { h, icon, iconButton, showMenu } from './ui';

export interface ImageViewerOptions {
  item: ItemView;
  pins: Pin[];
  onPinsChange(pins: Pin[]): void;
  /** A pin was just placed: a note line starts with it. */
  onPinCreated(n: number): void;
  /** A pin was clicked: show its notes. */
  onPinClick(n: number): void;
  onActivity(): void;
}

/**
 * Image studied like a document (graph, diagram, map, whiteboard photo):
 * zoom and pan, numbered pins placed on the details, each pin linked to the
 * note lines that start with `[pin N]` — in both directions.
 */
export class ImageViewer {
  readonly el: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly pinLayer: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly pinBtn: HTMLButtonElement;
  private pins: Pin[];
  private counts = new Map<number, number>();
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private fitted = true;
  private placing = false;
  private active: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly opts: ImageViewerOptions) {
    this.pins = [...opts.pins];
    this.img = h('img', {
      class: 'iv-img',
      src: `boo://app/__media/${encodeURIComponent(opts.item.id)}`,
      alt: opts.item.title,
      draggable: 'false',
    });
    this.pinLayer = h('div', { class: 'iv-pins' });
    this.frame = h('div', { class: 'iv-frame' }, this.img, this.pinLayer);
    this.stage = h('div', { class: 'iv-stage', tabindex: '0', 'aria-label': 'Image' }, this.frame);
    this.zoomLabel = h('button', { type: 'button', class: 'zoom-label', title: 'Ajuster à la fenêtre' }, '100 %');
    this.zoomLabel.addEventListener('click', () => this.fit());
    this.pinBtn = h(
      'button',
      { type: 'button', class: 'btn plain small pin-toggle', 'aria-pressed': 'false', title: 'Placer un repère (Alt+Shift+T), ou double-clic sur l’image' },
      icon('target', 16),
      h('span', {}, 'Repère'),
    );
    this.pinBtn.addEventListener('click', () => this.setPlacing(!this.placing));
    const toolbar = h(
      'div',
      { class: 'pdf-toolbar iv-toolbar' },
      this.pinBtn,
      h('span', { class: 'toolbar-sep' }),
      iconButton('minus', 'Zoom arrière', () => this.zoomAt(1 / 1.2)),
      this.zoomLabel,
      iconButton('plus', 'Zoom avant', () => this.zoomAt(1.2)),
      iconButton('fit', 'Ajuster à la fenêtre', () => this.fit()),
    );
    this.el = h('section', { class: 'image-viewer', 'aria-label': 'Image annotée' }, toolbar, this.stage);

    this.img.addEventListener('load', () => {
      this.frame.style.width = `${this.img.naturalWidth}px`;
      this.frame.style.height = `${this.img.naturalHeight}px`;
      this.fit();
      this.renderPins();
    });
    this.stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
      },
      { passive: false },
    );
    this.stage.addEventListener('pointerdown', (e) => this.onStagePointer(e));
    this.stage.addEventListener('dblclick', (e) => {
      if ((e.target as Element).closest('.iv-pin')) return;
      this.placeAt(e.clientX, e.clientY);
    });
    this.stage.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.placing) {
        e.stopPropagation();
        this.setPlacing(false);
      }
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitted) this.fit();
    });
    this.resizeObserver.observe(this.stage);
  }

  /** Alt+Shift+T: next click on the image places a pin. */
  togglePlacing(): void {
    this.setPlacing(!this.placing);
  }

  /** Notes per pin (filled pins have notes). */
  setCounts(counts: Map<number, number>): void {
    this.counts = counts;
    this.renderPins();
  }

  /** From a `[pin N]` chip of the notes: bring the pin into view and pulse it. */
  showPin(n: number): void {
    const pin = this.pins.find((p) => p.n === n);
    if (!pin) return;
    this.active = n;
    const w = this.img.naturalWidth * this.scale;
    const hgt = this.img.naturalHeight * this.scale;
    const x = pin.x * w + this.tx;
    const y = pin.y * hgt + this.ty;
    const r = this.stage.getBoundingClientRect();
    if (x < 24 || y < 24 || x > r.width - 24 || y > r.height - 24) {
      this.tx += r.width / 2 - x;
      this.ty += r.height / 2 - y;
      this.fitted = false;
      this.apply();
    }
    this.renderPins();
    const el = this.pinLayer.querySelector(`[data-n="${n}"]`);
    el?.classList.remove('pulse');
    void (el as HTMLElement | null)?.offsetWidth;
    el?.classList.add('pulse');
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
  }

  // --- Zoom & pan -------------------------------------------------------------------------------

  private fit(): void {
    const r = this.stage.getBoundingClientRect();
    const w = this.img.naturalWidth || 1;
    const hgt = this.img.naturalHeight || 1;
    this.scale = Math.min(4, Math.max(0.05, Math.min((r.width - 48) / w, (r.height - 48) / hgt)));
    this.tx = (r.width - w * this.scale) / 2;
    this.ty = (r.height - hgt * this.scale) / 2;
    this.fitted = true;
    this.apply();
  }

  private zoomAt(factor: number, clientX?: number, clientY?: number): void {
    const r = this.stage.getBoundingClientRect();
    const cx = (clientX ?? r.left + r.width / 2) - r.left;
    const cy = (clientY ?? r.top + r.height / 2) - r.top;
    const next = Math.min(8, Math.max(0.05, this.scale * factor));
    const k = next / this.scale;
    this.tx = cx - (cx - this.tx) * k;
    this.ty = cy - (cy - this.ty) * k;
    this.scale = next;
    this.fitted = false;
    this.apply();
    this.opts.onActivity();
  }

  private apply(): void {
    this.frame.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.frame.style.setProperty('--inv-scale', String(1 / this.scale));
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)} %`;
  }

  private onStagePointer(e: PointerEvent): void {
    if (e.button !== 0 || (e.target as Element).closest('.iv-pin')) return;
    this.opts.onActivity();
    if (this.placing) {
      // Keep the focus where the new note line will be written.
      e.preventDefault();
      this.placeAt(e.clientX, e.clientY);
      this.setPlacing(false);
      return;
    }
    // Drag to pan.
    const start = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
    this.stage.setPointerCapture(e.pointerId);
    this.stage.classList.add('panning');
    const move = (ev: PointerEvent) => {
      this.tx = start.tx + ev.clientX - start.x;
      this.ty = start.ty + ev.clientY - start.y;
      this.fitted = false;
      this.apply();
    };
    const up = () => {
      this.stage.classList.remove('panning');
      this.stage.removeEventListener('pointermove', move);
      this.stage.removeEventListener('pointerup', up);
    };
    this.stage.addEventListener('pointermove', move);
    this.stage.addEventListener('pointerup', up);
  }

  // --- Pins ---------------------------------------------------------------------------------------

  private setPlacing(on: boolean): void {
    this.placing = on;
    this.stage.classList.toggle('placing', on);
    this.pinBtn.setAttribute('aria-pressed', String(on));
    if (on) this.stage.focus();
  }

  private toImage(clientX: number, clientY: number): { x: number; y: number } | null {
    const r = this.img.getBoundingClientRect();
    const x = (clientX - r.left) / r.width;
    const y = (clientY - r.top) / r.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  private placeAt(clientX: number, clientY: number): void {
    const at = this.toImage(clientX, clientY);
    if (!at) return;
    const n = this.pins.reduce((max, p) => Math.max(max, p.n), 0) + 1;
    this.pins = [...this.pins, { n, x: round4(at.x), y: round4(at.y), createdAt: Date.now() }];
    this.active = n;
    this.renderPins();
    this.opts.onPinsChange(this.pins);
    // After the mouse events of this click, so the note editor keeps the focus.
    setTimeout(() => this.opts.onPinCreated(n), 0);
  }

  private renderPins(): void {
    this.pinLayer.replaceChildren(
      ...this.pins.map((p) => {
        const count = this.counts.get(p.n) ?? 0;
        const pin = h(
          'button',
          {
            type: 'button',
            class: `iv-pin${count ? ' has-notes' : ''}${this.active === p.n ? ' active' : ''}`,
            'data-n': String(p.n),
            title: count ? `Repère ${p.n} — ${count} note${count > 1 ? 's' : ''}` : `Repère ${p.n} (sans note)`,
            'aria-label': `Repère ${p.n}`,
          },
          String(p.n),
        );
        pin.style.left = `${p.x * 100}%`;
        pin.style.top = `${p.y * 100}%`;
        pin.addEventListener('pointerdown', (e) => this.dragPin(e, p, pin));
        pin.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showMenu(pin, [
            { label: 'Voir les notes', icon: 'eye', run: () => this.opts.onPinClick(p.n) },
            {
              label: `Retirer le repère ${p.n}`,
              icon: 'trash',
              danger: true,
              run: () => {
                this.pins = this.pins.filter((x) => x.n !== p.n);
                this.renderPins();
                this.opts.onPinsChange(this.pins);
              },
            },
          ]);
        });
        return pin;
      }),
    );
  }

  /** Click = show the notes of the pin; drag = move it. */
  private dragPin(e: PointerEvent, p: Pin, el: HTMLElement): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      moved = true;
      const at = this.toImage(ev.clientX, ev.clientY);
      if (!at) return;
      el.style.left = `${at.x * 100}%`;
      el.style.top = `${at.y * 100}%`;
      p.x = round4(at.x);
      p.y = round4(at.y);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (moved) {
        this.pins = this.pins.map((x) => (x.n === p.n ? { ...p } : x));
        this.opts.onPinsChange(this.pins);
      } else {
        this.active = p.n;
        this.renderPins();
        this.opts.onPinClick(p.n);
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
