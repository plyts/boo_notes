/**
 * Rich text pasted into a note (a web page, Notion, Google Docs, Word, a
 * mail…) as Markdown: headings, lists (and to-dos), quotes, code, tables,
 * links, bold / italic / highlight / strike-through (inline styles of Google
 * Docs included), images, and videos, audios or embeds as links.
 *
 * Images are left as `![alt](boo-img:N)` placeholders, listed in `images`:
 * the caller stores them (a data URL, a picture it may download) and puts
 * their path in, or drops them.
 */
export interface HtmlImage {
  /** Placeholder in the Markdown: `boo-img:N`. */
  token: string;
  src: string;
  alt: string;
}

export interface HtmlMarkdown {
  markdown: string;
  images: HtmlImage[];
}

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'svg', 'button', 'input', 'select', 'textarea', 'object', 'embed', 'canvas', 'map']);
const BLOCKS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'address',
  'details', 'summary', 'dl', 'dt', 'dd', 'center', 'form', 'fieldset', 'body', 'html', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'table', 'hr',
]);

interface Ctx {
  images: HtmlImage[];
  base: string | undefined;
  bold: boolean;
  italic: boolean;
}

/** An absolute http(s) / mailto URL, resolved against the page's address; null otherwise. */
function absolute(href: string | null, base: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return /^(https?|mailto):$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** Markers around a text, its outer spaces left outside (`**gras** suite`). */
function wrap(text: string, marker: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : text;
}

function styleOf(el: Element): { bold: boolean | null; italic: boolean; strike: boolean } {
  const style = (el.getAttribute('style') ?? '').toLowerCase();
  const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(style)?.[1];
  return {
    bold: weight ? weight === 'bold' || weight === 'bolder' || Number(weight) >= 600 : null,
    italic: /font-style\s*:\s*italic/.test(style),
    strike: /text-decoration[^;]*line-through/.test(style),
  };
}

/** The address of a video embed as people open it: YouTube, Vimeo, Dailymotion, Loom… */
function embedUrl(src: string): { url: string; label: string } {
  try {
    const u = new URL(src);
    const yt = /(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{11})/.exec(u.href);
    if (yt) return { url: `https://www.youtube.com/watch?v=${yt[1]}`, label: '▶ Vidéo YouTube' };
    const vimeo = /player\.vimeo\.com\/video\/(\d+)/.exec(u.href);
    if (vimeo) return { url: `https://vimeo.com/${vimeo[1]}`, label: '▶ Vidéo Vimeo' };
    const loom = /loom\.com\/embed\/(\w+)/.exec(u.href);
    if (loom) return { url: `https://www.loom.com/share/${loom[1]}`, label: '▶ Vidéo Loom' };
    return { url: u.href, label: '▶ Contenu intégré' };
  } catch {
    return { url: src, label: '▶ Contenu intégré' };
  }
}

function inline(node: Node, ctx: Ctx): string {
  if (node.nodeType === 3) return (node.nodeValue ?? '').replace(/[\s ]+/g, ' ');
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.localName;
  if (SKIP.has(tag)) return '';
  const children = (c: Ctx = ctx) => [...el.childNodes].map((n) => inline(n, c)).join('');
  switch (tag) {
    case 'br':
      return '\n';
    case 'img': {
      const src = el.getAttribute('src') ?? '';
      const w = Number(el.getAttribute('width'));
      const hgt = Number(el.getAttribute('height'));
      // Tracking pixels and spacers.
      if ((w > 0 && w <= 2) || (hgt > 0 && hgt <= 2)) return '';
      const alt = (el.getAttribute('alt') ?? el.getAttribute('title') ?? '').replace(/[[\]\n]/g, ' ').trim();
      const usable = src.startsWith('data:image/') ? src : absolute(src, ctx.base);
      if (!usable) return alt ? `*${alt}*` : '';
      const token = `boo-img:${ctx.images.length}`;
      ctx.images.push({ token, src: usable, alt });
      return `![${alt}](${token})`;
    }
    case 'video':
    case 'audio': {
      const src = absolute(el.getAttribute('src') ?? el.querySelector('source')?.getAttribute('src') ?? null, ctx.base);
      if (!src) return '';
      // On a line of its own, like the player it was.
      return `\n[${tag === 'video' ? '▶ Vidéo' : '🔊 Audio'}](${src})\n`;
    }
    case 'iframe': {
      const src = absolute(el.getAttribute('src'), ctx.base);
      if (!src) return '';
      const e = embedUrl(src);
      return `\n[${e.label}](${e.url})\n`;
    }
    case 'a': {
      const href = absolute(el.getAttribute('href'), ctx.base);
      const text = children();
      if (!href || !text.trim()) return text;
      const label = text.trim();
      // A timecode linked to its moment (`<a><code>04:12</code></a>`, Boo Notes' own copy): a timestamp.
      const plain = el.textContent?.trim() ?? '';
      if (/^(?:\d+:)?\d{1,3}:\d{2}(?:\s?[–-]\s?(?:\d+:)?\d{1,3}:\d{2})?$/.test(plain)) return `[${plain}](${href})`;
      // A linked picture stays a picture.
      if (/^!\[[^\]]*\]\(boo-img:\d+\)$/.test(label)) return text;
      return text.replace(label, `[${label.replace(/\n/g, ' ')}](${href})`);
    }
    case 'strong':
    case 'b': {
      const s = styleOf(el);
      // Google Docs wraps whole pastes in <b style="font-weight:normal">.
      if (s.bold === false || ctx.bold) return children();
      return wrap(children({ ...ctx, bold: true }), '**');
    }
    case 'em':
    case 'i':
    case 'cite':
    case 'dfn':
      return ctx.italic ? children() : wrap(children({ ...ctx, italic: true }), '*');
    case 'mark':
      return wrap(children(), '==');
    case 's':
    case 'del':
    case 'strike':
      return wrap(children(), '~~');
    case 'code':
    case 'kbd':
    case 'samp': {
      const text = el.textContent ?? '';
      if (!text.trim()) return text;
      const ticks = text.includes('`') ? '``' : '`';
      return `${ticks}${text.replace(/\s+/g, ' ')}${ticks}`;
    }
    default: {
      if (BLOCKS.has(tag)) return `\n${blocks(el, ctx).join('\n')}\n`;
      // Styled spans (Google Docs, Word): bold, italic, strike-through.
      const s = styleOf(el);
      let text = children({ ...ctx, bold: ctx.bold || s.bold === true, italic: ctx.italic || s.italic });
      if (s.strike) text = wrap(text, '~~');
      if (s.italic && !ctx.italic) text = wrap(text, '*');
      if (s.bold === true && !ctx.bold) text = wrap(text, '**');
      return text;
    }
  }
}

/** Lines of the text of an inline run, trimmed; blank ones dropped. */
function runLines(run: string): string[] {
  return run
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

function list(el: Element, ctx: Ctx): string[] {
  const ordered = el.localName === 'ol';
  let n = Number(el.getAttribute('start')) || 1;
  const out: string[] = [];
  for (const li of el.children) {
    if (li.localName !== 'li') {
      if (li.localName === 'ul' || li.localName === 'ol') out.push(...list(li, ctx).map((l) => `  ${l}`));
      continue;
    }
    const box = li.querySelector(':scope > input[type="checkbox"], :scope > label > input[type="checkbox"]') as HTMLInputElement | null;
    const marker = ordered ? `${n++}. ` : box ? `- [${box.checked || box.hasAttribute('checked') ? 'x' : ' '}] ` : '- ';
    const lines = blocks(li, ctx);
    if (!lines.length) continue;
    const pad = ' '.repeat(ordered ? marker.length : 2);
    out.push(`${marker}${lines[0]}`, ...lines.slice(1).map((l) => (l ? `${pad}${l}` : l)));
  }
  return out;
}

function table(el: Element, ctx: Ctx): string[] {
  const rows = [...el.querySelectorAll('tr')].filter((tr) => tr.closest('table') === el);
  const cells = rows.map((tr) => [...tr.children].filter((c) => c.localName === 'td' || c.localName === 'th').map((c) => inline(c, ctx).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')));
  const width = Math.max(0, ...cells.map((r) => r.length));
  if (!width) return [];
  // A layout table of one cell: its content.
  if (width === 1 && cells.length === 1) return runLines(cells[0][0] ?? '');
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(cells[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...cells.slice(1).map(line)];
}

function blocks(el: Element, ctx: Ctx): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => {
    out.push(...runLines(run));
    run = '';
  };
  for (const node of el.childNodes) {
    if (node.nodeType !== 1) {
      run += inline(node, ctx);
      continue;
    }
    const child = node as Element;
    const tag = child.localName;
    if (SKIP.has(tag)) continue;
    if (!BLOCKS.has(tag)) {
      run += inline(child, ctx);
      continue;
    }
    flush();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      const text = runLines(inline(child, { ...ctx, bold: true })).join(' ');
      if (text) out.push(`${'#'.repeat(Number(heading[1]))} ${text}`);
    } else if (tag === 'ul' || tag === 'ol') out.push(...list(child, ctx));
    else if (tag === 'blockquote') out.push(...blocks(child, ctx).map((l) => (l ? `> ${l}` : '>')));
    else if (tag === 'pre') {
      const code = (child.textContent ?? '').replace(/\n$/, '');
      const lang = /language-([\w+-]+)/.exec(child.querySelector('code')?.className ?? child.className)?.[1] ?? '';
      out.push(`\`\`\`${lang}`, ...code.split('\n'), '```');
    } else if (tag === 'table') out.push(...table(child, ctx));
    else if (tag === 'hr') out.push('---');
    else if (tag === 'figcaption') out.push(...blocks(child, ctx).map((l) => wrap(l, '*')));
    else out.push(...blocks(child, ctx));
  }
  flush();
  return out;
}

export function htmlToMarkdown(html: string, base?: string): HtmlMarkdown {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const images: HtmlImage[] = [];
  const lines = blocks(doc.body, { images, base, bold: false, italic: false });
  return { markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), images };
}

/** The pasted HTML holds nothing more than its plain text (no formatting, links, pictures, lists). */
export function isPlainHtml(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return !doc.body.querySelector('img, video, audio, iframe, a[href], b, strong, i, em, h1, h2, h3, h4, h5, h6, ul, ol, table, pre, code, blockquote, mark, s, del, [style*="font-weight"], [style*="font-style"]');
}
