import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Highlight, HighlightColor } from '../core/types';
import { h, icon, iconButton } from './dom';

pdfjs.GlobalWorkerOptions.workerSrc = 'boo://app/pdfjs/pdf.worker.mjs';

const COLORS: Array<{ color: HighlightColor; label: string }> = [
  { color: 'yellow', label: 'Jaune' },
  { color: 'green', label: 'Vert' },
  { color: 'blue', label: 'Bleu' },
  { color: 'pink', label: 'Rose' },
];

export interface PdfViewerOptions {
  data: Uint8Array;
  startPage: number;
  highlights: Highlight[];
  onPageChange(page: number, pages: number): void;
  onHighlightsChange(highlights: Highlight[]): void;
  onQuote(text: string, page: number): void;
  onActivity(): void;
  /** Note badge of a page clicked: show the notes of that page. */
  onMarkerClick?(page: number): void;
}

interface PageSlot {
  n: number;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  text: HTMLElement;
  marks: HTMLElement;
  /** Size at scale 1 (points). */
  width: number;
  height: number;
  renderedScale: number;
  rendering: Promise<void> | null;
  proxy: PDFPageProxy | null;
}

/**
 * Continuous-scroll PDF reader (pdf.js): lazy page rendering, selectable
 * text, highlights, and the page being read reported for progress tracking.
 */
export class PdfViewer {
  readonly el: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly pagesEl: HTMLElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageCount: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly popover: HTMLElement;
  private doc: PDFDocumentProxy | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private slots: PageSlot[] = [];
  private scale = 1;
  private fitWidth = true;
  private current = 1;
  private highlights: Highlight[];
  private observer: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollFrame = 0;
  /** Page requested by `goTo` while its smooth scroll runs: intermediate pages are not "read". */
  private navigating: number | null = null;
  private navigatingTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private selection: { text: string; page: number; rects: Highlight['rects'] } | null = null;
  private noteCounts = new Map<number, number>();
  private selectedHighlight: Highlight | null = null;

  constructor(private readonly opts: PdfViewerOptions) {
    this.highlights = [...opts.highlights];
    this.pageInput = h('input', {
      class: 'page-input',
      type: 'text',
      inputmode: 'numeric',
      'aria-label': 'Page',
      value: '1',
    });
    this.pageCount = h('span', { class: 'page-count' }, '/ …');
    this.zoomLabel = h('button', { type: 'button', class: 'zoom-label', title: 'Ajuster à la largeur (Ctrl+0)' }, '100 %');
    this.zoomLabel.addEventListener('click', () => this.setFitWidth());
    this.pagesEl = h('div', { class: 'pdf-pages' });
    this.scroller = h('div', { class: 'pdf-scroller', tabindex: '0', 'aria-label': 'Document PDF' }, this.pagesEl);
    this.popover = h('div', { class: 'pdf-popover', role: 'toolbar', hidden: true });

    const toolbar = h(
      'div',
      { class: 'pdf-toolbar' },
      iconButton('chevronLeft', 'Page précédente', () => this.goTo(this.current - 1)),
      h('label', { class: 'page-field' }, this.pageInput, this.pageCount),
      iconButton('chevronRight', 'Page suivante', () => this.goTo(this.current + 1)),
      h('span', { class: 'toolbar-sep' }),
      iconButton('minus', 'Zoom arrière (Ctrl+−)', () => this.zoom(1 / 1.15)),
      this.zoomLabel,
      iconButton('plus', 'Zoom avant (Ctrl++)', () => this.zoom(1.15)),
      iconButton('fit', 'Ajuster à la largeur (Ctrl+0)', () => this.setFitWidth()),
    );
    this.el = h('section', { class: 'pdf-viewer', 'aria-label': 'Lecteur PDF' }, toolbar, this.scroller, this.popover);

    this.pageInput.addEventListener('change', () => this.goTo(Number.parseInt(this.pageInput.value, 10) || this.current));
    this.pageInput.addEventListener('focus', () => this.pageInput.select());
    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.scroller.addEventListener('scrollend', () => this.endNavigation());
    this.scroller.addEventListener('mouseup', (e) => setTimeout(() => this.onPointerUp(e), 0));
    this.scroller.addEventListener('keyup', (e) => {
      if (e.shiftKey) this.onSelection();
    });
    this.scroller.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      },
      { passive: false },
    );
    document.addEventListener('selectionchange', this.onSelectionChange);
  }

  get page(): number {
    return this.current;
  }

  get pages(): number {
    return this.doc?.numPages ?? 0;
  }

  async open(): Promise<void> {
    const task = pdfjs.getDocument({
      data: this.opts.data,
      cMapUrl: 'boo://app/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'boo://app/pdfjs/standard_fonts/',
      wasmUrl: 'boo://app/pdfjs/wasm/',
    });
    this.task = task;
    this.doc = await task.promise;
    if (this.destroyed) return;
    const first = await this.doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.pageCount.textContent = `/ ${this.doc.numPages}`;
    this.slots = Array.from({ length: this.doc.numPages }, (_, i) => this.createSlot(i + 1, vp.width, vp.height));
    this.slots[0].proxy = first;
    this.pagesEl.replaceChildren(...this.slots.map((s) => s.el));
    for (const s of this.slots) this.renderBadge(s);
    this.observer = new IntersectionObserver((entries) => this.onVisible(entries), {
      root: this.scroller,
      rootMargin: '800px 0px',
    });
    for (const s of this.slots) this.observer.observe(s.el);
    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitWidth) this.applyScale(this.fitScale(), true);
    });
    this.resizeObserver.observe(this.scroller);
    this.applyScale(this.fitScale(), true);
    this.goTo(Math.min(Math.max(1, this.opts.startPage), this.doc.numPages), false);
    this.opts.onPageChange(this.current, this.doc.numPages);
  }

  goTo(page: number, smooth = true): void {
    if (!this.slots.length) return;
    const n = Math.min(Math.max(1, Math.round(page)), this.slots.length);
    const slot = this.slots[n - 1];
    const top = Math.max(0, slot.el.offsetTop - 12);
    if (smooth && Math.abs(this.scroller.scrollTop - top) > 1) {
      this.navigating = n;
      if (this.navigatingTimer) clearTimeout(this.navigatingTimer);
      this.navigatingTimer = setTimeout(() => this.endNavigation(), 1500);
    }
    this.scroller.scrollTo({ top, behavior: smooth ? 'smooth' : 'instant' });
    slot.el.classList.remove('flash');
    void slot.el.offsetWidth;
    if (smooth) slot.el.classList.add('flash');
    this.setCurrent(n);
  }

  private endNavigation(): void {
    if (this.navigatingTimer) clearTimeout(this.navigatingTimer);
    this.navigatingTimer = null;
    this.navigating = null;
  }

  zoom(factor: number): void {
    this.fitWidth = false;
    this.applyScale(Math.min(4, Math.max(0.4, this.scale * factor)));
  }

  setFitWidth(): void {
    this.fitWidth = true;
    this.applyScale(this.fitScale());
  }

  /** Notes per page: a badge in the margin of each annotated page (click = show its notes). */
  setNoteCounts(counts: Map<number, number>): void {
    this.noteCounts = counts;
    for (const s of this.slots) this.renderBadge(s);
  }

  private renderBadge(s: PageSlot): void {
    const count = this.noteCounts.get(s.n) ?? 0;
    let badge = s.el.querySelector('.pdf-note-badge') as HTMLButtonElement | null;
    if (!count) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = h('button', { type: 'button', class: 'pdf-note-badge' });
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this.opts.onMarkerClick?.(s.n);
      });
      s.el.append(badge);
    }
    badge.replaceChildren(icon('quote', 12), h('span', {}, String(count)));
    badge.title = `${count} note${count > 1 ? 's' : ''} sur la page ${s.n} — cliquer pour les voir`;
  }

  /** Selected text (for "quote" / "highlight" shortcuts). */
  currentSelection(): { text: string; page: number } | null {
    this.onSelection();
    return this.selection ? { text: this.selection.text, page: this.selection.page } : null;
  }

  highlightSelection(color: HighlightColor = 'yellow'): boolean {
    this.onSelection();
    const sel = this.selection;
    if (!sel) return false;
    const highlight: Highlight = {
      id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      page: sel.page,
      rects: sel.rects,
      text: sel.text,
      color,
      createdAt: Date.now(),
    };
    this.highlights = [...this.highlights, highlight];
    this.drawHighlights(sel.page);
    this.opts.onHighlightsChange(this.highlights);
    window.getSelection()?.removeAllRanges();
    this.hidePopover();
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    document.removeEventListener('selectionchange', this.onSelectionChange);
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.scrollFrame);
    this.endNavigation();
    void this.task?.destroy();
  }

  // --- Layout & rendering -----------------------------------------------------------------

  private createSlot(n: number, width: number, height: number): PageSlot {
    const canvas = h('canvas', { class: 'pdf-canvas', 'aria-hidden': 'true' });
    const marks = h('div', { class: 'pdf-marks' });
    const text = h('div', { class: 'textLayer' });
    const el = h(
      'div',
      { class: 'pdf-page', 'data-page': String(n), role: 'region', 'aria-label': `Page ${n}` },
      canvas,
      marks,
      text,
      h('span', { class: 'pdf-page-num', 'aria-hidden': 'true' }, String(n)),
    );
    return { n, el, canvas, text, marks, width, height, renderedScale: 0, rendering: null, proxy: null };
  }

  private fitScale(): number {
    const avail = this.scroller.clientWidth - 48;
    const width = this.slots[0]?.width ?? 612;
    return Math.min(2.5, Math.max(0.5, avail / width));
  }

  private applyScale(scale: number, keepPosition = true): void {
    if (!this.slots.length || Math.abs(scale - this.scale) < 0.001) {
      this.renderZoomLabel();
      return;
    }
    // Keep the same point of the current page under the top of the viewport.
    const slot = this.slots[this.current - 1];
    const offset = keepPosition && slot ? (this.scroller.scrollTop - slot.el.offsetTop) / this.scale : 0;
    this.scale = scale;
    for (const s of this.slots) this.sizeSlot(s);
    if (keepPosition && slot) this.scroller.scrollTop = slot.el.offsetTop + offset * scale;
    this.renderZoomLabel();
    for (const s of this.slots) if (s.renderedScale && this.isNear(s.n)) void this.render(s);
  }

  private renderZoomLabel(): void {
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)} %`;
  }

  private sizeSlot(s: PageSlot): void {
    const w = Math.floor(s.width * this.scale);
    const hgt = Math.floor(s.height * this.scale);
    s.el.style.width = `${w}px`;
    s.el.style.height = `${hgt}px`;
    s.el.style.setProperty('--scale-factor', String(this.scale));
  }

  private isNear(n: number): boolean {
    return Math.abs(n - this.current) <= 3;
  }

  private onVisible(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const n = Number((e.target as HTMLElement).dataset.page);
      const slot = this.slots[n - 1];
      if (!slot) continue;
      if (e.isIntersecting) void this.render(slot);
      else if (!this.isNear(n)) this.release(slot);
    }
  }

  private release(s: PageSlot): void {
    if (!s.renderedScale) return;
    s.canvas.width = 0;
    s.canvas.height = 0;
    s.text.replaceChildren();
    s.renderedScale = 0;
  }

  private async render(s: PageSlot): Promise<void> {
    if (!this.doc || this.destroyed) return;
    if (s.renderedScale === this.scale) return;
    if (s.rendering) {
      await s.rendering;
      if (s.renderedScale === this.scale) return;
    }
    const scale = this.scale;
    s.rendering = (async () => {
      const page = (s.proxy ??= await this.doc!.getPage(s.n));
      const base = page.getViewport({ scale: 1 });
      if (base.width !== s.width || base.height !== s.height) {
        s.width = base.width;
        s.height = base.height;
        this.sizeSlot(s);
      }
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      await page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      if (this.destroyed || scale !== this.scale) return;
      s.canvas.replaceWith(canvas);
      s.canvas = canvas;
      const text = h('div', { class: 'textLayer' });
      const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
      await layer.render();
      if (this.destroyed || scale !== this.scale) return;
      s.text.replaceWith(text);
      s.text = text;
      s.renderedScale = scale;
      s.el.classList.add('rendered');
      this.drawHighlights(s.n);
    })().finally(() => {
      s.rendering = null;
    });
    await s.rendering.catch(() => undefined);
  }

  private drawHighlights(page: number): void {
    const slot = this.slots[page - 1];
    if (!slot) return;
    slot.marks.replaceChildren(
      ...this.highlights
        .filter((hl) => hl.page === page)
        .flatMap((hl) =>
          hl.rects.map(([x, y, w, hh]) => {
            const mark = h('span', { class: `pdf-mark ${hl.color}`, 'data-id': hl.id });
            mark.style.left = `${x * 100}%`;
            mark.style.top = `${y * 100}%`;
            mark.style.width = `${w * 100}%`;
            mark.style.height = `${hh * 100}%`;
            return mark;
          }),
        ),
    );
  }

  // --- Reading position ------------------------------------------------------------------------

  private onScroll(): void {
    this.opts.onActivity();
    this.hidePopover();
    cancelAnimationFrame(this.scrollFrame);
    if (this.navigating !== null) return;
    this.scrollFrame = requestAnimationFrame(() => {
      const probe = this.scroller.scrollTop + this.scroller.clientHeight * 0.35;
      let n = this.current;
      for (const s of this.slots) {
        if (s.el.offsetTop <= probe) n = s.n;
        else break;
      }
      this.setCurrent(n);
    });
  }

  private setCurrent(n: number): void {
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(n);
    if (n === this.current) return;
    this.current = n;
    this.opts.onPageChange(n, this.slots.length);
  }

  // --- Selection: highlight / quote ------------------------------------------------------------

  private readonly onSelectionChange = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      this.selection = null;
      if (!this.selectedHighlight) this.hidePopover();
    }
  };

  private onPointerUp(e: MouseEvent): void {
    this.opts.onActivity();
    this.onSelection();
    if (this.selection) {
      this.showSelectionPopover();
      return;
    }
    // A click on a highlight: quote or remove it.
    const pageEl = (e.target as Element | null)?.closest?.('.pdf-page') as HTMLElement | null;
    if (!pageEl) return;
    const r = pageEl.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const page = Number(pageEl.dataset.page);
    const hit = this.highlights.find(
      (hl) => hl.page === page && hl.rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh),
    );
    if (hit) this.showHighlightPopover(hit, e.clientX, e.clientY);
    else this.hidePopover();
  }

  private onSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.selection = null;
      return;
    }
    const range = sel.getRangeAt(0);
    const startEl = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest(
      '.pdf-page',
    ) as HTMLElement | null;
    if (!startEl || !this.pagesEl.contains(startEl)) {
      this.selection = null;
      return;
    }
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) {
      this.selection = null;
      return;
    }
    const pr = startEl.getBoundingClientRect();
    const rects: Highlight['rects'] = [];
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const left = Math.max(r.left, pr.left);
      const right = Math.min(r.right, pr.right);
      const top = Math.max(r.top, pr.top);
      const bottom = Math.min(r.bottom, pr.bottom);
      if (right <= left || bottom <= top) continue;
      rects.push([
        round4((left - pr.left) / pr.width),
        round4((top - pr.top) / pr.height),
        round4((right - left) / pr.width),
        round4((bottom - top) / pr.height),
      ]);
    }
    this.selection = rects.length ? { text, page: Number(startEl.dataset.page), rects: mergeRects(rects) } : null;
  }

  private showSelectionPopover(): void {
    const sel = window.getSelection();
    if (!sel || !this.selection || sel.rangeCount === 0) return;
    this.selectedHighlight = null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const swatches = COLORS.map(({ color, label }) => {
      const b = h('button', { type: 'button', class: `swatch ${color}`, title: `Surligner en ${label.toLowerCase()}`, 'aria-label': `Surligner en ${label.toLowerCase()}` });
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.highlightSelection(color));
      return b;
    });
    const quote = h('button', { type: 'button', class: 'pop-btn', title: 'Citer dans les notes (Alt+Shift+Q)' }, icon('quote', 15), 'Citer');
    quote.addEventListener('mousedown', (e) => e.preventDefault());
    quote.addEventListener('click', () => {
      const s = this.selection;
      if (!s) return;
      this.opts.onQuote(s.text, s.page);
      window.getSelection()?.removeAllRanges();
      this.hidePopover();
    });
    const copy = h('button', { type: 'button', class: 'pop-btn', title: 'Copier' }, icon('copy', 15));
    copy.addEventListener('mousedown', (e) => e.preventDefault());
    copy.addEventListener('click', () => {
      if (this.selection) void navigator.clipboard.writeText(this.selection.text);
      this.hidePopover();
    });
    this.popover.replaceChildren(h('span', { class: 'swatches' }, ...swatches), h('span', { class: 'pop-sep' }), quote, copy);
    this.placePopover(rect.left + rect.width / 2, rect.top);
  }

  private showHighlightPopover(hl: Highlight, x: number, y: number): void {
    this.selectedHighlight = hl;
    const quote = h('button', { type: 'button', class: 'pop-btn' }, icon('quote', 15), 'Citer');
    quote.addEventListener('click', () => {
      this.opts.onQuote(hl.text, hl.page);
      this.hidePopover();
    });
    const remove = h('button', { type: 'button', class: 'pop-btn danger' }, icon('trash', 15), 'Retirer');
    remove.addEventListener('click', () => {
      this.highlights = this.highlights.filter((x2) => x2.id !== hl.id);
      this.drawHighlights(hl.page);
      this.opts.onHighlightsChange(this.highlights);
      this.hidePopover();
    });
    this.popover.replaceChildren(quote, remove);
    this.placePopover(x, y - 8);
  }

  private placePopover(x: number, top: number): void {
    this.popover.hidden = false;
    const host = this.el.getBoundingClientRect();
    const w = this.popover.offsetWidth;
    const hgt = this.popover.offsetHeight;
    const left = Math.min(Math.max(8, x - host.left - w / 2), host.width - w - 8);
    const y = top - host.top - hgt - 10;
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${Math.max(52, y)}px`;
  }

  private hidePopover(): void {
    this.popover.hidden = true;
    this.selectedHighlight = null;
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Merges the per-span rectangles of a selection into one rectangle per line. */
function mergeRects(rects: Highlight['rects']): Highlight['rects'] {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: Highlight['rects'] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && Math.abs(last[1] - r[1]) < 0.004 && Math.abs(last[3] - r[3]) < 0.006 && r[0] <= last[0] + last[2] + 0.02) {
      const right = Math.max(last[0] + last[2], r[0] + r[2]);
      last[2] = round4(right - last[0]);
    } else out.push([...r]);
  }
  return out;
}
