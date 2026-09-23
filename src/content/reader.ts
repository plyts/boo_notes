import { parseTextFragment, quoteLine, textFragmentUrl } from '../shared/markdown';

/**
 * Reading mode: a page without video or audio (article, course chapter,
 * documentation, Notion page) is studied like a document. Notes anchor to
 * passages through text fragments (`URL#:~:text=…`): a quoted selection, or
 * the section being read. Quoted passages are highlighted in the page and
 * followed while scrolling (page → note), a click on a passage link in the
 * note scrolls back to it (note → page).
 */

const SKIPPED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION']);
const QUOTE_HIGHLIGHT = 'boo-notes-quote';
const FLASH_HIGHLIGHT = 'boo-notes-flash';
const HIGHLIGHT_CSS = `
::highlight(${QUOTE_HIGHLIGHT}) { background-color: rgba(250, 204, 21, 0.28); }
::highlight(${FLASH_HIGHLIGHT}) { background-color: rgba(250, 204, 21, 0.8); color: #111; }
`;
/** A passage counts as "being read" in the upper part of the viewport. */
const READING_LINE = 0.45;
const MAX_LABEL = 60;

/** Characters of the page without whitespace, each mapped back to its text node. */
interface TextIndex {
  chars: string;
  nodes: Text[];
  /** Per char: index in `nodes`. */
  nodeOf: Int32Array;
  /** Per char: offset in its node. */
  offsetOf: Int32Array;
}

function lower(c: string): string {
  const l = c.toLowerCase();
  return l.length === 1 ? l : c;
}

function isSpace(code: number): boolean {
  return (
    code <= 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200b) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Whitespace is ignored on both sides: block boundaries and inline tags never break a match. */
export function squash(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) if (!isSpace(text.charCodeAt(i))) out += lower(text[i]);
  return out;
}

export function buildTextIndex(root: Node, skip: (el: Element) => boolean = () => false): TextIndex {
  const nodes: Text[] = [];
  const nodeOf: number[] = [];
  const offsetOf: number[] = [];
  let chars = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let el = node.parentElement; el; el = el.parentElement) {
        if (SKIPPED.has(el.tagName) || skip(el)) return NodeFilter.FILTER_REJECT;
        if (el === root) break;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const text = node.data;
    let used = false;
    for (let i = 0; i < text.length; i++) {
      if (isSpace(text.charCodeAt(i))) continue;
      if (!used) {
        nodes.push(node);
        used = true;
      }
      chars += lower(text[i]);
      nodeOf.push(nodes.length - 1);
      offsetOf.push(i);
    }
  }
  return { chars, nodes, nodeOf: Int32Array.from(nodeOf), offsetOf: Int32Array.from(offsetOf) };
}

function rangeOf(index: TextIndex, from: number, to: number): Range {
  const range = document.createRange();
  range.setStart(index.nodes[index.nodeOf[from]], index.offsetOf[from]);
  const last = index.nodes[index.nodeOf[to - 1]];
  range.setEnd(last, index.offsetOf[to - 1] + 1);
  return range;
}

/** Ranges of the page matching a text fragment (start … end), in document order. */
export function findPassages(index: TextIndex, start: string, end: string | null, limit = 10): Range[] {
  const a = squash(start);
  const b = end ? squash(end) : '';
  if (!a) return [];
  const out: Range[] = [];
  let from = index.chars.indexOf(a);
  while (from !== -1 && out.length < limit) {
    let to = from + a.length;
    if (b) {
      const e = index.chars.indexOf(b, to);
      if (e === -1) break;
      to = e + b.length;
    }
    out.push(rangeOf(index, from, to));
    from = index.chars.indexOf(a, from + 1);
  }
  return out;
}

function visible(range: Range): boolean {
  const r = range.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A link label: no brackets (they would end the Markdown link), a reasonable length. */
export function linkLabel(text: string): string {
  const t = clean(text).replace(/[[\]]/g, '');
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1).trimEnd()}…` : t;
}

export interface ReaderOptions {
  /** URL of the note (canonical URL of the page). */
  url(): string;
  /** Elements of Boo Notes itself (overlay, drawer): never quoted nor indexed. */
  isOwnUi(el: Element): boolean;
  /** Reading progress (0..1, furthest point of this visit). */
  onProgress(ratio: number): void;
  /** Quoted passage now being read (`null`: none), as the fragment URL written in the note. */
  onPassage(url: string | null): void;
}

export class PageReader {
  private readonly abort = new AbortController();
  private style: HTMLStyleElement | null = null;
  private passages: Array<{ url: string; ranges: Range[] }> = [];
  private wanted: string[] = [];
  private index: TextIndex | null = null;
  private indexedAt = 0;
  private scroller: Element | null = null;
  private furthest = 0;
  private current: string | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveAttempts = 0;
  private active = false;

  constructor(private readonly opts: ReaderOptions) {}

  /** Starts following the reading (scroll progress, passages in view). */
  start(): void {
    if (this.active) return;
    this.active = true;
    const signal = this.abort.signal;
    // Capture: scroll events of inner containers (Notion, docs sites) do not bubble.
    document.addEventListener('scroll', (e) => this.onScroll(e.target), { capture: true, passive: true, signal });
    window.addEventListener('resize', () => this.onScroll(null), { passive: true, signal });
    this.onScroll(null);
  }

  stop(): void {
    this.active = false;
    this.abort.abort();
    for (const t of [this.scrollTimer, this.flashTimer, this.resolveTimer]) if (t) clearTimeout(t);
    const highlights = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
    highlights?.delete(QUOTE_HIGHLIGHT);
    highlights?.delete(FLASH_HIGHLIGHT);
    this.style?.remove();
    this.style = null;
  }

  /** Forgets the page (SPA navigation to another page). */
  reset(): void {
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.passages = [];
    this.wanted = [];
    this.index = null;
    this.furthest = 0;
    this.current = null;
    this.scroller = null;
    this.paint();
  }

  get progress(): number {
    return this.furthest;
  }

  // --- Anchors written in the note ------------------------------------------------------------

  /** Text selected in the page (not in Boo Notes' own UI). */
  selection(): string {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const el = node instanceof Element ? node : node.parentElement;
    // Editable pages count too (a Notion page is contenteditable).
    if (el && this.opts.isOwnUi(el)) return '';
    return clean(sel.toString());
  }

  /** Bounding box of the selection, to place the "Citer" bubble. */
  selectionRect(): DOMRect | null {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const rects = sel.getRangeAt(0).getClientRects();
    return rects.length ? rects[rects.length - 1] : null;
  }

  /** `> passage [↗](URL#:~:text=…)` for the selection, null without selection. */
  quote(): string | null {
    const text = this.selection();
    if (text.length < 2) return null;
    return quoteLine(text, this.opts.url());
  }

  /**
   * Anchor of the place being read, prefixed to a new note line: the section
   * heading at the top of the viewport (`[↗ Titre](URL#:~:text=Titre)`), or
   * the first words of the first visible paragraph.
   */
  anchor(): string {
    const target = this.headingInView() ?? this.paragraphInView();
    if (!target) return `[↗ ${Math.round(this.ratio() * 100)} %](${this.opts.url()})`;
    const text = clean(target.textContent ?? '');
    const words = text.split(' ').slice(0, target.tagName.startsWith('H') ? 12 : 8).join(' ');
    return `[↗ ${linkLabel(words)}](${textFragmentUrl(this.opts.url(), words)})`;
  }

  /** Label of the section being read (captures). */
  sectionLabel(): string {
    const heading = this.headingInView();
    return heading ? linkLabel(heading.textContent ?? '') : '';
  }

  // --- Passages of the note, highlighted in the page ----------------------------------------------

  /** Fragment links written in the note: highlighted in the page, followed while reading. */
  setPassages(urls: string[]): void {
    const base = this.opts.url().split('#')[0];
    this.wanted = [...new Set(urls.filter((u) => sameDocument(u, base)))];
    this.resolveAttempts = 0;
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.resolveTimer = setTimeout(() => this.resolve(), 150);
  }

  /** Scrolls to a passage and flashes it. False when it cannot be found in this page. */
  reveal(url: string): boolean {
    const frag = parseTextFragment(url);
    if (!frag) return false;
    const range = findPassages(this.textIndex(true), frag.start, frag.end).find(visible);
    if (!range) return false;
    const el = range.startContainer.parentElement;
    el?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    this.setHighlight(FLASH_HIGHLIGHT, [range]);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.setHighlight(FLASH_HIGHLIGHT, []), 1800);
    return true;
  }

  // --- Internals ------------------------------------------------------------------------------

  private textIndex(fresh = false): TextIndex {
    // Pages change (lazy content, SPAs): the index is short-lived.
    if (!this.index || fresh || Date.now() - this.indexedAt > 2000) {
      this.index = buildTextIndex(document.body ?? document.documentElement, (el) => this.opts.isOwnUi(el));
      this.indexedAt = Date.now();
    }
    return this.index;
  }

  private resolve(): void {
    if (!this.wanted.length) {
      this.passages = [];
      this.paint();
      return;
    }
    const index = this.textIndex(true);
    this.passages = this.wanted.flatMap((url) => {
      const frag = parseTextFragment(url);
      if (!frag) return [];
      const ranges = findPassages(index, frag.start, frag.end, 3);
      return ranges.length ? [{ url, ranges }] : [];
    });
    this.paint();
    this.follow();
    // Apps (Notion…) render their content after the URL changes: try again a few times.
    if (this.passages.length < this.wanted.length && ++this.resolveAttempts < 4) {
      this.resolveTimer = setTimeout(() => this.resolve(), 1000 * this.resolveAttempts);
    }
  }

  private paint(): void {
    this.setHighlight(
      QUOTE_HIGHLIGHT,
      this.passages.flatMap((p) => p.ranges),
    );
  }

  private setHighlight(name: string, ranges: Range[]): void {
    const api = globalThis as unknown as {
      CSS?: { highlights?: Map<string, unknown> };
      Highlight?: new (...ranges: Range[]) => unknown;
    };
    const registry = api.CSS?.highlights;
    if (!registry || !api.Highlight) return;
    if (!ranges.length) {
      registry.delete(name);
      return;
    }
    this.ensureStyle();
    registry.set(name, new api.Highlight(...ranges));
  }

  private ensureStyle(): void {
    if (this.style?.isConnected) return;
    // `::highlight()` rules must live in the document's own style sheets.
    this.style = document.createElement('style');
    this.style.id = 'boo-notes-highlights';
    this.style.textContent = HIGHLIGHT_CSS;
    (document.head ?? document.documentElement).append(this.style);
  }

  private onScroll(target: EventTarget | null): void {
    if (target instanceof Element && target !== document.documentElement && target !== document.body) {
      // The page's main scroller: an inner container taller than half the window.
      if (target.clientHeight >= innerHeight * 0.5 && target.scrollHeight > target.clientHeight + 40 && !this.opts.isOwnUi(target)) {
        this.scroller = target;
      } else return;
    } else if (target === document || target === null) {
      if (target === document) this.scroller = null;
    }
    if (this.scrollTimer) return;
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      const ratio = this.ratio();
      if (ratio > this.furthest + 0.004) {
        this.furthest = ratio;
        this.opts.onProgress(ratio);
      }
      this.follow();
    }, 250);
  }

  /** 0..1: bottom of the viewport relative to the length of the page. */
  private ratio(): number {
    const doc = document.scrollingElement ?? document.documentElement;
    const el = this.scroller ?? (doc.scrollHeight > doc.clientHeight + 4 ? doc : (this.scroller = findScroller()) ?? doc);
    const total = el.scrollHeight;
    const seen = el.scrollTop + el.clientHeight;
    if (total <= el.clientHeight + 4) return 1;
    return Math.min(1, Math.max(0, seen / total));
  }

  /** Page → note: the quoted passage at the reading line. */
  private follow(): void {
    let best: { url: string; top: number } | null = null;
    const line = innerHeight * READING_LINE;
    for (const p of this.passages) {
      for (const r of p.ranges) {
        const rect = r.getBoundingClientRect();
        if (!rect.height && !rect.width) continue;
        // The last passage starting above the reading line, still on screen.
        if (rect.top <= line && rect.bottom >= 0 && (!best || rect.top > best.top)) best = { url: p.url, top: rect.top };
      }
    }
    const url = best?.url ?? null;
    if (url !== this.current) {
      this.current = url;
      this.opts.onPassage(url);
    }
  }

  private headingInView(): Element | null {
    let above: Element | null = null;
    let first: Element | null = null;
    for (const el of document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
      if (this.opts.isOwnUi(el) || !clean(el.textContent ?? '')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.top <= innerHeight * 0.3) above = el;
      else if (!first && r.top < innerHeight) first = el;
    }
    return above ?? first;
  }

  private paragraphInView(): Element | null {
    for (const el of document.querySelectorAll('p, li, blockquote, [data-block-id]')) {
      if (this.opts.isOwnUi(el)) continue;
      const text = clean(el.textContent ?? '');
      if (text.split(' ').length < 4) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.width > 0) return el;
    }
    return null;
  }
}

/** Largest inner scrolling container (apps like Notion do not scroll the document). */
function findScroller(): Element | null {
  let best: Element | null = null;
  let bestArea = 0;
  for (const el of document.body?.querySelectorAll('*') ?? []) {
    if (el.scrollHeight <= el.clientHeight + 40 || el.clientHeight < innerHeight * 0.5) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') continue;
    const area = el.clientWidth * el.clientHeight;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

/** Same page, ignoring the fragment and `(`/`)` encoding. */
function sameDocument(url: string, base: string): boolean {
  const strip = (u: string) => u.split('#')[0].replace(/%28/gi, '(').replace(/%29/gi, ')');
  return strip(url) === strip(base);
}
