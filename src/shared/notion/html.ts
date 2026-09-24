import type { BlockSpec, RichText } from './blocks';

/**
 * Blocks (see blocks.ts) → HTML: revision sheets of the desktop export, and
 * the rich copy of a note (pasted into Notion, Obsidian, Google Docs, Word…).
 */

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function richHtml(items: RichText[]): string {
  return items
    .map((item) => {
      if (item.type === 'mention') return '<span class="mention">↗</span>';
      // `==mot==` (a cloze card, an Obsidian highlight) stays highlighted.
      let html = esc(item.text.content)
        .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
        .replace(/\n/g, '<br>');
      const a = item.annotations ?? {};
      if (a.code) html = `<code>${html}</code>`;
      if (a.bold) html = `<strong>${html}</strong>`;
      if (a.italic) html = `<em>${html}</em>`;
      if (a.strikethrough) html = `<s>${html}</s>`;
      const url = item.text.link?.url;
      return url ? `<a href="${esc(url)}">${html}</a>` : html;
    })
    .join('');
}

/**
 * `asset(path)`: URL of an `assets/…` image (relative path, or data URL); empty: left out.
 * `headingShift`: `# Titre` becomes `<h{1 + shift}>` (the page has its own title above).
 */
export function blocksHtml(blocks: BlockSpec[], asset: (path: string) => string, headingShift = 1): string {
  let out = '';
  let list: 'ul' | 'ol' | null = null;
  const close = () => {
    if (list) out += `</${list}>`;
    list = null;
  };
  const figure = (src: string, caption: RichText[]) => {
    const cap = caption.length ? `<figcaption>${richHtml(caption)}</figcaption>` : '';
    return src ? `<figure><img src="${esc(src)}" alt="${esc(caption.map((c) => (c.type === 'text' ? c.text.content : '')).join(''))}">${cap}</figure>` : cap ? `<p>${richHtml(caption)}</p>` : '';
  };
  for (const b of blocks) {
    const kind = b.type === 'bulleted_list_item' || b.type === 'to_do' ? 'ul' : b.type === 'numbered_list_item' ? 'ol' : null;
    if (kind !== list) {
      close();
      if (kind) out += `<${kind}>`;
      list = kind;
    }
    switch (b.type) {
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        out += `<h${Number(b.type.slice(-1)) + headingShift}>${richHtml(b.rich)}</h${Number(b.type.slice(-1)) + headingShift}>`;
        break;
      case 'quote':
        out += `<blockquote>${richHtml(b.rich)}</blockquote>`;
        break;
      case 'bulleted_list_item':
      case 'numbered_list_item':
      case 'to_do': {
        const box = b.type === 'to_do' ? (b.checked ? '☑ ' : '☐ ') : '';
        const children = b.children?.length ? `<ul>${b.children.map((c) => ('rich' in c ? `<li>${richHtml(c.rich)}</li>` : '')).join('')}</ul>` : '';
        out += `<li>${box}${richHtml(b.rich)}${children}</li>`;
        break;
      }
      case 'code':
        out += `<pre><code>${esc(b.text)}</code></pre>`;
        break;
      case 'divider':
        out += '<hr>';
        break;
      case 'image':
        out += figure(asset(b.asset), b.caption);
        break;
      case 'external_image':
        out += figure(b.url, b.caption);
        break;
      case 'video':
      case 'bookmark':
        out += `<p><a href="${esc(b.url)}">${esc(b.url)}</a></p>`;
        break;
      case 'callout':
        out += `<aside>${richHtml(b.rich)}</aside>`;
        break;
      default:
        out += `<p>${richHtml(b.rich)}</p>`;
    }
  }
  close();
  return out;
}
