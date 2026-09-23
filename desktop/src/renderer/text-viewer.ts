import { h, icon, iconButton } from './dom';

export interface TextViewerOptions {
  text: string;
  /** Markdown file: headings, lists, emphasis are rendered. */
  markdown: boolean;
  startParagraph: number;
  onParagraphChange(n: number, total: number): void;
  /** Gutter `§ N` clicked: new note about this paragraph. */
  onStamp(n: number): void;
  /** Note markers of a paragraph clicked: show its notes. */
  onMarkerClick(n: number): void;
  onQuote(text: string, n: number): void;
  onActivity(): void;
}

interface Block {
  kind: 'p' | 'h1' | 'h2' | 'h3' | 'li' | 'pre' | 'quote';
  text: string;
}

/** Splits a text into paragraphs (blank lines), keeping code fences whole. */
export function splitParagraphs(text: string, markdown: boolean): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const joined = buffer.join('\n').trim();
    buffer = [];
    if (!joined) return;
    if (!markdown) {
      blocks.push({ kind: 'p', text: joined });
      return;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(joined);
    if (heading && !joined.includes('\n')) {
      blocks.push({ kind: (`h${Math.min(3, heading[1].length)}` as Block['kind']), text: heading[2] });
      return;
    }
    if (/^>\s?/.test(joined)) {
      blocks.push({ kind: 'quote', text: joined.replace(/^>\s?/gm, '') });
      return;
    }
    if (/^(\s*[-*+]|\s*\d+[.)])\s+/.test(joined)) {
      for (const item of joined.split(/\n(?=\s*(?:[-*+]|\d+[.)])\s+)/)) {
        blocks.push({ kind: 'li', text: item.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '') });
      }
      return;
    }
    blocks.push({ kind: 'p', text: joined });
  };
  let fence: string[] | null = null;
  for (const line of lines) {
    if (markdown && /^\s{0,3}(```|~~~)/.test(line)) {
      if (fence) {
        blocks.push({ kind: 'pre', text: fence.join('\n') });
        fence = null;
      } else {
        flush();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    if (line.trim() === '') flush();
    else if (markdown && /^#{1,6}\s/.test(line)) {
      flush();
      buffer.push(line);
      flush();
    } else buffer.push(line);
  }
  if (fence) blocks.push({ kind: 'pre', text: fence.join('\n') });
  flush();
  return blocks;
}

/** Minimal inline Markdown (bold, italic, code, links) as DOM nodes — never innerHTML. */
function inline(text: string): Node[] {
  const out: Node[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(document.createTextNode(text.slice(last, at)));
    last = at + m[0].length;
    if (m[1]) out.push(h('code', {}, m[1].slice(1, -1)));
    else if (m[2]) out.push(h('strong', {}, m[2].slice(2, -2)));
    else if (m[3]) out.push(h('em', {}, m[3].slice(1, -1)));
    else if (m[4]) out.push(h('span', { class: 'tx-link' }, /^\[([^\]]+)\]/.exec(m[4])![1]));
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/**
 * Reader for text documents (.txt, .md): numbered paragraphs, notes anchored
 * with `[§ N]`, markers showing which paragraphs have notes, quotes and
 * reading progress.
 */
export class TextViewer {
  readonly el: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly article: HTMLElement;
  private readonly position: HTMLElement;
  private readonly popover: HTMLElement;
  private readonly blocks: HTMLElement[] = [];
  private current = 1;
  private frame = 0;
  private fontSize = 16;

  constructor(private readonly opts: TextViewerOptions) {
    const parts = splitParagraphs(opts.text, opts.markdown);
    this.article = h('article', { class: 'tx-article' });
    parts.forEach((b, i) => {
      const n = i + 1;
      const tag = b.kind === 'li' ? 'p' : b.kind === 'quote' ? 'blockquote' : b.kind;
      const content = b.kind === 'pre' ? h('pre', {}, b.text) : h(tag as 'p', { class: `tx-${b.kind}` }, ...inline(b.text));
      const gutter = h('button', { type: 'button', class: 'tx-gutter', title: `Nouvelle note sur le paragraphe ${n}` }, `§ ${n}`);
      gutter.addEventListener('click', () => this.opts.onStamp(n));
      const marker = h('button', { type: 'button', class: 'tx-marker', hidden: true, title: 'Voir les notes de ce paragraphe' });
      marker.addEventListener('click', () => this.opts.onMarkerClick(n));
      const block = h('div', { class: `tx-block${b.kind === 'li' ? ' tx-li' : ''}`, 'data-n': String(n) }, gutter, content, marker);
      this.blocks.push(block);
      this.article.append(block);
    });
    if (!parts.length) this.article.append(h('p', { class: 'tx-empty' }, 'Ce document est vide.'));
    this.scroller = h('div', { class: 'tx-scroller', tabindex: '0', 'aria-label': 'Texte' }, this.article);
    this.position = h('span', { class: 'page-count' }, '');
    this.popover = h('div', { class: 'pdf-popover', role: 'toolbar', hidden: true });
    const toolbar = h(
      'div',
      { class: 'pdf-toolbar' },
      h('span', { class: 'tx-position' }, icon('text', 15), this.position),
      h('span', { class: 'toolbar-sep' }),
      iconButton('minus', 'Texte plus petit', () => this.setFont(this.fontSize - 1)),
      iconButton('plus', 'Texte plus grand', () => this.setFont(this.fontSize + 1)),
    );
    this.el = h('section', { class: 'text-viewer', 'aria-label': 'Lecteur de texte' }, toolbar, this.scroller, this.popover);
    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.scroller.addEventListener('mouseup', () => setTimeout(() => this.onSelection(), 0));
    this.renderPosition();
  }

  get paragraph(): number {
    return this.current;
  }

  get total(): number {
    return this.blocks.length;
  }

  /** After insertion in the document: resume where the reading stopped. */
  start(): void {
    this.goTo(this.opts.startParagraph, false);
    this.opts.onParagraphChange(this.current, this.total);
  }

  goTo(n: number, smooth = true): void {
    const block = this.blocks[Math.min(Math.max(1, n), this.blocks.length) - 1];
    if (!block) return;
    this.scroller.scrollTo({ top: Math.max(0, block.offsetTop - 24), behavior: smooth ? 'smooth' : 'instant' });
    this.current = Number(block.dataset.n);
    this.renderPosition();
    if (smooth) {
      block.classList.remove('flash');
      void block.offsetWidth;
      block.classList.add('flash');
    }
  }

  /** Notes per paragraph (markers in the margin). */
  setCounts(counts: Map<number, number>): void {
    this.blocks.forEach((block, i) => {
      const count = counts.get(i + 1) ?? 0;
      const marker = block.querySelector('.tx-marker') as HTMLElement;
      marker.hidden = count === 0;
      marker.textContent = count ? String(count) : '';
      block.classList.toggle('has-notes', count > 0);
    });
  }

  currentSelection(): { text: string; n: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const node = sel.getRangeAt(0).startContainer;
    const block = (node instanceof Element ? node : node.parentElement)?.closest('.tx-block') as HTMLElement | null;
    if (!block || !this.article.contains(block)) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    return text ? { text, n: Number(block.dataset.n) } : null;
  }

  private setFont(size: number): void {
    this.fontSize = Math.min(24, Math.max(12, size));
    this.article.style.fontSize = `${this.fontSize}px`;
  }

  private onScroll(): void {
    this.opts.onActivity();
    this.popover.hidden = true;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      const probe = this.scroller.scrollTop + this.scroller.clientHeight * 0.3;
      let n = 1;
      for (const b of this.blocks) {
        if (b.offsetTop <= probe) n = Number(b.dataset.n);
        else break;
      }
      // The end of the document counts as read.
      if (this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 4) n = this.blocks.length;
      if (n !== this.current) {
        this.current = n;
        this.renderPosition();
        this.opts.onParagraphChange(n, this.total);
      }
    });
  }

  private renderPosition(): void {
    this.position.textContent = this.blocks.length ? `§ ${this.current} / ${this.blocks.length}` : '';
  }

  private onSelection(): void {
    const sel = this.currentSelection();
    if (!sel) {
      this.popover.hidden = true;
      return;
    }
    const range = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    const quote = h('button', { type: 'button', class: 'pop-btn', title: 'Citer dans les notes (Alt+Shift+Q)' }, icon('quote', 15), 'Citer');
    quote.addEventListener('mousedown', (e) => e.preventDefault());
    quote.addEventListener('click', () => {
      this.opts.onQuote(sel.text, sel.n);
      window.getSelection()?.removeAllRanges();
      this.popover.hidden = true;
    });
    this.popover.replaceChildren(quote);
    this.popover.hidden = false;
    const host = this.el.getBoundingClientRect();
    const left = Math.min(Math.max(8, range.left + range.width / 2 - host.left - this.popover.offsetWidth / 2), host.width - this.popover.offsetWidth - 8);
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${Math.max(52, range.top - host.top - this.popover.offsetHeight - 10)}px`;
  }
}
