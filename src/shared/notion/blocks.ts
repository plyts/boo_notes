/**
 * Markdown (as written in Boo Notes) → Notion blocks.
 *
 * Every line of a note is one idea, usually stamped (`[04:15] …`): each line
 * becomes its own block. Timestamps become small code-styled links to the
 * exact moment of the video, page references stay as `p. 12` chips, and
 * screenshots are uploaded as image blocks captioned with their timestamp.
 */

export type Color =
  | 'default'
  | 'gray_background'
  | 'yellow_background'
  | 'green_background'
  | 'blue_background'
  | 'pink_background';

export interface Annotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

export type RichText =
  | { type: 'text'; text: { content: string; link?: { url: string } | null }; annotations?: Annotations }
  | { type: 'mention'; mention: { type: 'page'; page: { id: string } }; annotations?: Annotations };

/** Resolves `[[Titre]]` to the Notion page of that note (id), when it has one. */
export interface InlineContext {
  wiki?(title: string): string | null;
  /**
   * An anchor (`[04:15]`, `[p. 12]`, `[§ 4]`, `[pin 3]`) and the resource it
   * names (null: the note's main one): text shown before it (the resource of a
   * multi-resource note) and the link it opens.
   */
  anchor?(kind: 'time' | 'page' | 'section' | 'pin', value: number, resource: string | null): { prefix?: string; url?: string | null } | null;
}

/** Link to a Notion page from its id. */
export function notionPageUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, '')}`;
}

type TextBlockType =
  | 'paragraph'
  | 'heading_1'
  | 'heading_2'
  | 'heading_3'
  | 'quote'
  | 'bulleted_list_item'
  | 'numbered_list_item'
  | 'to_do'
  | 'callout';

export type BlockSpec =
  | { type: TextBlockType; rich: RichText[]; checked?: boolean; color?: Color; emoji?: string; children?: BlockSpec[] }
  | { type: 'code'; text: string; language: string }
  | { type: 'divider' }
  | { type: 'image'; asset: string; caption: RichText[]; missing?: boolean }
  | { type: 'external_image'; url: string; caption: RichText[] }
  | { type: 'video' | 'bookmark'; url: string };

const MAX_TEXT = 2000;
const MAX_RICH = 100;

// --- Inline Markdown ----------------------------------------------------------------------

const INLINE = new RegExp(
  [
    '\\[\\[(?<wiki>[^\\[\\]\\n|]{1,200}?)(?:\\|(?<wikiAlias>[^\\[\\]\\n]{1,200}?))?\\]\\]',
    '(?<code>`+)(?<codeText>.+?)\\k<code>',
    '(?<!!)\\[(?<ts>(?:\\d+:)?\\d{1,3}:\\d{2})(?:\\s?[–-]\\s?(?<tsEnd>(?:\\d+:)?\\d{1,3}:\\d{2}))?\\](?:\\((?<tsUrl>[^()\\s]*)\\))?',
    '(?<!!)\\[p\\.\\s?(?<page>\\d{1,5})\\](?:\\(res:(?<pageRes>[^()\\s]+)\\))?',
    '(?<!!)\\[§\\s?(?<section>\\d{1,5})\\](?:\\(res:(?<sectionRes>[^()\\s]+)\\))?',
    '(?<!!)\\[pin\\s?(?<pin>\\d{1,4})\\](?:\\(res:(?<pinRes>[^()\\s]+)\\))?',
    '(?<!!)\\[(?<linkText>[^\\]\\n]+)\\]\\((?<linkUrl>[^()\\s]+)\\)',
    '<(?<auto>https?:\\/\\/[^>\\s]+)>',
    '\\*\\*(?<bold>.+?)\\*\\*',
    '__(?<bold2>.+?)__',
    '~~(?<strike>.+?)~~',
    '\\*(?<em>[^*\\s](?:[^*]*?[^*\\s])?)\\*',
    '(?<![\\w])_(?<em2>[^_\\s](?:[^_]*?[^_\\s])?)_(?![\\w])',
  ].join('|'),
  'g',
);

export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function cleanAnnotations(annotations: Annotations): Annotations | undefined {
  const ann = Object.fromEntries(Object.entries(annotations).filter(([, v]) => v)) as Annotations;
  return Object.keys(ann).length ? ann : undefined;
}

function text(content: string, annotations: Annotations = {}, link: string | null = null): RichText[] {
  const out: RichText[] = [];
  for (let i = 0; i < content.length; i += MAX_TEXT) {
    const rt: Extract<RichText, { type: 'text' }> = { type: 'text', text: { content: content.slice(i, i + MAX_TEXT) } };
    if (link) rt.text.link = { url: link };
    const ann = cleanAnnotations(annotations);
    if (ann) rt.annotations = ann;
    out.push(rt);
  }
  return out;
}

/** Plain text of rich text items (mentions excluded). */
export function richPlainText(items: RichText[]): string {
  return items.map((i) => (i.type === 'text' ? i.text.content : '')).join('');
}

export function parseInline(
  input: string,
  annotations: Annotations = {},
  link: string | null = null,
  ctx: InlineContext = {},
): RichText[] {
  const out: RichText[] = [];
  let last = 0;
  const inner = (t: string, a: Annotations, l: string | null) => parseInline(t, a, l, ctx);
  for (const m of input.matchAll(INLINE)) {
    const g = m.groups ?? {};
    const at = m.index ?? 0;
    if (at > last) out.push(...text(input.slice(last, at), annotations, link));
    last = at + m[0].length;
    if (g.wiki !== undefined) {
      // [[Titre]]: a mention of the note's Notion page (Notion then lists the backlink), or plain text.
      const title = g.wiki.trim();
      const alias = g.wikiAlias?.trim();
      const pageId = ctx.wiki?.(title) ?? null;
      if (pageId && !alias && !link) out.push({ type: 'mention', mention: { type: 'page', page: { id: pageId } }, annotations: cleanAnnotations(annotations) });
      else out.push(...text(alias || title, { ...annotations, bold: true }, pageId ? notionPageUrl(pageId) : link));
    } else if (g.codeText !== undefined) out.push(...text(g.codeText.trim(), { ...annotations, code: true }, link));
    else if (g.ts !== undefined) {
      const res = g.tsUrl?.startsWith('res:') ? g.tsUrl.slice(4) : null;
      const a = ctx.anchor?.('time', timecodeSeconds(g.ts), res) ?? null;
      const url = res ? (a?.url ?? null) : (safeUrl(g.tsUrl) ?? a?.url ?? null);
      out.push(...text(`${a?.prefix ?? ''}${g.ts}${g.tsEnd ? `–${g.tsEnd}` : ''}`, { ...annotations, code: true }, safeUrl(url) ?? link));
    } else if (g.page !== undefined || g.section !== undefined || g.pin !== undefined) {
      const kind = g.page !== undefined ? 'page' : g.section !== undefined ? 'section' : 'pin';
      const value = Number(g.page ?? g.section ?? g.pin);
      const a = ctx.anchor?.(kind, value, g.pageRes ?? g.sectionRes ?? g.pinRes ?? null) ?? null;
      const label = kind === 'page' ? `p. ${value}` : kind === 'section' ? `§ ${value}` : `◉ ${value}`;
      out.push(...text(`${a?.prefix ?? ''}${label}`, { ...annotations, code: true }, safeUrl(a?.url) ?? link));
    }
    else if (g.linkText !== undefined) out.push(...inner(g.linkText, annotations, safeUrl(g.linkUrl) ?? link));
    else if (g.auto !== undefined) out.push(...text(g.auto, annotations, safeUrl(g.auto)));
    else if (g.bold !== undefined || g.bold2 !== undefined)
      out.push(...inner(g.bold ?? g.bold2, { ...annotations, bold: true }, link));
    else if (g.strike !== undefined) out.push(...inner(g.strike, { ...annotations, strikethrough: true }, link));
    else if (g.em !== undefined || g.em2 !== undefined)
      out.push(...inner(g.em ?? g.em2, { ...annotations, italic: true }, link));
  }
  if (last < input.length) out.push(...text(input.slice(last), annotations, link));
  return capRich(out);
}

/** Notion accepts at most 100 rich text items per block: the rest is merged as plain text. */
function capRich(items: RichText[]): RichText[] {
  if (items.length <= MAX_RICH) return items;
  const rest = richPlainText(items.slice(MAX_RICH - 1));
  return [...items.slice(0, MAX_RICH - 1), ...text(rest).slice(0, 1)];
}

// --- Blocks -------------------------------------------------------------------------------

const LANGUAGES = new Set([
  'bash', 'c', 'c#', 'c++', 'css', 'dart', 'diff', 'docker', 'go', 'graphql', 'haskell', 'html', 'java',
  'javascript', 'json', 'kotlin', 'latex', 'makefile', 'markdown', 'matlab', 'php', 'plain text', 'powershell',
  'python', 'r', 'ruby', 'rust', 'sass', 'scala', 'scss', 'shell', 'sql', 'swift', 'typescript', 'xml', 'yaml',
]);
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'shell',
  zsh: 'shell', console: 'shell', cs: 'c#', cpp: 'c++', yml: 'yaml', md: 'markdown', ps1: 'powershell',
  rb: 'ruby', rs: 'rust', kt: 'kotlin', tex: 'latex', text: 'plain text', txt: 'plain text', '': 'plain text',
};

export function notionLanguage(lang: string): string {
  const l = lang.trim().toLowerCase();
  const mapped = LANGUAGE_ALIASES[l] ?? l;
  return LANGUAGES.has(mapped) ? mapped : 'plain text';
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w#+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const DIVIDER = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const parseInlineCtx = (t: string, a: Annotations, l: string | null, ctx: InlineContext) => parseInline(t, a, l, ctx);

function timecodeSeconds(tc: string): number {
  return tc.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** `[04:15] ![…](assets/…)`, or a passage `[02:05–06:07] ![Passage …](assets/…) [Extrait](media/…)` (the extract stays local). */
const IMAGE_LINE =
  /^\s*(?:\[((?:\d+:)?\d{1,3}:\d{2}(?:\s?[–-]\s?(?:\d+:)?\d{1,3}:\d{2})?)\](?:\(([^()\s]*)\))?\s+)?!\[([^\]\n]*)\]\(([^()\s]+)\)(?:\s+\[[^\]\n]*\]\(media\/[^()\s]+\))?\s*$/;

export function markdownToBlocks(markdown: string, ctx: InlineContext = {}): BlockSpec[] {
  const parseInline = (t: string) => parseInlineCtx(t, {}, null, ctx);
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: BlockSpec[] = [];
  let lastTopList: Extract<BlockSpec, { children?: BlockSpec[] }> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length) break;
        body.push(lines[i]);
      }
      out.push({ type: 'code', text: body.join('\n'), language: notionLanguage(fence[2]) });
      lastTopList = null;
      continue;
    }
    if (line.trim() === '') {
      lastTopList = null;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      out.push({ type: `heading_${level}`, rich: parseInline(heading[2]) });
      lastTopList = null;
      continue;
    }
    if (DIVIDER.test(line)) {
      out.push({ type: 'divider' });
      lastTopList = null;
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      const parts = [quote[1]];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) parts.push(QUOTE.exec(lines[++i])![1]);
      out.push({ type: 'quote', rich: parseInline(parts.join('\n')) });
      lastTopList = null;
      continue;
    }
    const image = IMAGE_LINE.exec(line);
    if (image) {
      const [, range, tcUrl, alt, src] = image;
      const tc = range?.split(/\s?[–-]\s?/)[0];
      const passageTitle = /^Passage\b[^·]*·\s*(.+)$/.exec(alt)?.[1]?.trim();
      const res = tcUrl?.startsWith('res:') ? tcUrl.slice(4) : null;
      const a = tc ? (ctx.anchor?.('time', timecodeSeconds(tc), res) ?? null) : null;
      const url = res ? (a?.url ?? null) : (safeUrl(tcUrl) ?? a?.url ?? null);
      const label = range?.replace(/\s?[–-]\s?/, '–');
      const caption = label
        ? [
            ...text(`${range && label !== tc ? 'Passage ' : ''}${label}`, { code: true }, safeUrl(url)),
            ...(passageTitle ? text(` · ${passageTitle}`) : []),
          ]
        : alt
          ? text(alt)
          : [];
      if (src.startsWith('assets/')) out.push({ type: 'image', asset: src, caption });
      else if (safeUrl(src)) out.push({ type: 'external_image', url: safeUrl(src)!, caption });
      else out.push({ type: 'paragraph', rich: parseInline(line.trim()) });
      lastTopList = null;
      continue;
    }
    const list = LIST.exec(line);
    if (list) {
      const indent = list[1].replace(/\t/g, '  ').length;
      const checkbox = list[3];
      const block: Extract<BlockSpec, { rich: RichText[] }> =
        checkbox !== undefined
          ? { type: 'to_do', rich: parseInline(list[4]), checked: checkbox.toLowerCase() === 'x' }
          : { type: /\d/.test(list[2]) ? 'numbered_list_item' : 'bulleted_list_item', rich: parseInline(list[4]) };
      if (indent >= 2 && lastTopList) {
        // Notion accepts two levels of nesting per request: deeper items are flattened.
        (lastTopList.children ??= []).push(block);
      } else {
        out.push(block);
        lastTopList = block;
      }
      continue;
    }
    out.push({ type: 'paragraph', rich: parseInline(line.trim()) });
    lastTopList = null;
  }
  return out;
}

// --- Notion JSON --------------------------------------------------------------------------

export type Json = Record<string, unknown>;

/** Resolves an `assets/…` image to a Notion file upload id. */
export type Uploader = (asset: string) => Promise<string | null>;

export async function toNotion(spec: BlockSpec, upload: Uploader): Promise<Json> {
  switch (spec.type) {
    case 'divider':
      return { object: 'block', type: 'divider', divider: {} };
    case 'code':
      return {
        object: 'block',
        type: 'code',
        code: { rich_text: capRich(text(spec.text || ' ')), language: spec.language },
      };
    case 'video':
    case 'bookmark':
      return { object: 'block', type: spec.type, [spec.type]: { type: 'external', external: { url: spec.url } } };
    case 'external_image':
      return {
        object: 'block',
        type: 'image',
        image: { type: 'external', external: { url: spec.url }, caption: spec.caption },
      };
    case 'image': {
      const id = spec.missing ? null : await upload(spec.asset);
      if (!id) {
        return toNotion(
          { type: 'paragraph', rich: [...spec.caption, ...text(' Capture introuvable', { italic: true })] },
          upload,
        );
      }
      return {
        object: 'block',
        type: 'image',
        image: { type: 'file_upload', file_upload: { id }, caption: spec.caption },
      };
    }
    default: {
      const body: Json = { rich_text: spec.rich };
      if (spec.type === 'to_do') body.checked = Boolean(spec.checked);
      if (spec.color) body.color = spec.color;
      if (spec.type === 'callout') body.icon = { type: 'emoji', emoji: spec.emoji ?? '💡' };
      if (spec.children?.length) body.children = await Promise.all(spec.children.map((c) => toNotion(c, upload)));
      return { object: 'block', type: spec.type, [spec.type]: body };
    }
  }
}

/** Stable fingerprint of a block (incremental sync). Same value in Node and in the browser. */
export function hashBlock(spec: BlockSpec): string {
  const json = stableJson(spec);
  return `${cyrb53(json, 1).toString(16).padStart(14, '0')}${cyrb53(json, 2).toString(16).padStart(14, '0')}`;
}

/** cyrb53: fast 53-bit string hash (public domain). */
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Json)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export { text as plainRichText };
