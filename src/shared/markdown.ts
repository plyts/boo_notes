import { formatTimecode, parseTimecode } from './time';
import { timestampUrl } from './platforms';

export interface TimestampMatch {
  /** Start of the whole token (`[`). */
  from: number;
  /** End of the whole token, including an optional `(url)` part. */
  to: number;
  /** End of the `[MM:SS]` part. */
  labelTo: number;
  label: string;
  seconds: number;
  url: string | null;
}

/** `[04:15]` or `[04:15](https://…#t=255)`, but not the alt text of an image (`![04:15](…)`). */
const TIMESTAMP_RE = /(?<!!)\[((?:\d+:)?\d{1,3}:\d{2})\](?:\(([^()\s]*)\))?/g;
const ASSET_RE = /!\[[^\]\n]*\]\((assets\/[^)\s]+)\)/g;

export function findTimestamps(text: string, offset = 0): TimestampMatch[] {
  const out: TimestampMatch[] = [];
  for (const m of text.matchAll(TIMESTAMP_RE)) {
    const seconds = parseTimecode(m[1]);
    if (seconds === null) continue;
    const from = offset + (m.index ?? 0);
    out.push({
      from,
      to: from + m[0].length,
      labelTo: from + m[1].length + 2,
      label: m[1],
      seconds,
      url: m[2] ?? null,
    });
  }
  return out;
}

export interface PageRefMatch {
  from: number;
  to: number;
  page: number;
}

/** `[p. 12]`: a reference to a page of a PDF (the document equivalent of a timestamp). */
const PAGE_REF_RE = /(?<!!)\[p\.\s?(\d{1,5})\]/g;

export function findPageRefs(text: string, offset = 0): PageRefMatch[] {
  const out: PageRefMatch[] = [];
  for (const m of text.matchAll(PAGE_REF_RE)) {
    const from = offset + (m.index ?? 0);
    out.push({ from, to: from + m[0].length, page: Number(m[1]) });
  }
  return out;
}

export function pageRefToken(page: number): string {
  return `[p. ${Math.max(1, Math.floor(page))}]`;
}

// --- Other anchors: paragraphs of a text, pins on an image ---------------------------------

export interface AnchorMatch {
  from: number;
  to: number;
  kind: 'time' | 'page' | 'section' | 'pin';
  /** Seconds, page, paragraph or pin number. */
  value: number;
  /** Start of the number inside the token (what stays visible in the chip, besides a prefix). */
  labelFrom: number;
}

/** `[§ 12]`: paragraph 12 of a text document. */
const SECTION_RE = /(?<!!)\[§\s?(\d{1,5})\]/g;
/** `[pin 3]`: pin number 3 placed on an image. */
const PIN_RE = /(?<!!)\[pin\s?(\d{1,4})\]/gi;

function numbered(re: RegExp, kind: AnchorMatch['kind'], text: string, offset: number): AnchorMatch[] {
  const out: AnchorMatch[] = [];
  for (const m of text.matchAll(re)) {
    const from = offset + (m.index ?? 0);
    out.push({ from, to: from + m[0].length, kind, value: Number(m[1]), labelFrom: from + m[0].length - 1 - m[1].length });
  }
  return out;
}

export function findSectionRefs(text: string, offset = 0): AnchorMatch[] {
  return numbered(SECTION_RE, 'section', text, offset);
}

export function findPins(text: string, offset = 0): AnchorMatch[] {
  return numbered(PIN_RE, 'pin', text, offset);
}

export function sectionToken(n: number): string {
  return `[§ ${Math.max(1, Math.floor(n))}]`;
}

export function pinToken(n: number): string {
  return `[pin ${Math.max(1, Math.floor(n))}]`;
}

/** Every anchor of a text (time, page, paragraph, pin), in document order. */
export function findAnchors(text: string, offset = 0): AnchorMatch[] {
  const out: AnchorMatch[] = [
    ...findTimestamps(text, offset).map((m) => ({
      from: m.from,
      to: m.to,
      kind: 'time' as const,
      value: m.seconds,
      labelFrom: m.from + 1,
    })),
    ...findPageRefs(text, offset).map((m) => ({ from: m.from, to: m.to, kind: 'page' as const, value: m.page, labelFrom: m.from + 1 })),
    ...findSectionRefs(text, offset),
    ...findPins(text, offset),
  ];
  return out.sort((a, b) => a.from - b.from);
}

/** Notes of a text: lines anchored to an instant, a page, a paragraph or a pin, and quoted passages. */
export function countNotes(markdown: string): number {
  return findAnchors(markdown).length + findFragmentLinks(markdown).length;
}

// --- Links between notes: [[Titre]] ----------------------------------------------------------

export interface WikiLinkMatch {
  from: number;
  to: number;
  /** Note title the link points to. */
  title: string;
  /** Text shown (`[[Titre|texte]]`), the title otherwise. */
  label: string;
  /** Start of the visible label inside the token. */
  labelFrom: number;
  labelTo: number;
}

const WIKI_RE = /\[\[([^\[\]\n|]{1,200}?)(?:\|([^\[\]\n]{1,200}?))?\]\]/g;

/** `[[Titre]]` / `[[Titre|texte]]`: a link to another note (Obsidian-compatible). */
export function findWikiLinks(text: string, offset = 0): WikiLinkMatch[] {
  const out: WikiLinkMatch[] = [];
  for (const m of text.matchAll(WIKI_RE)) {
    const title = m[1].trim();
    if (!title) continue;
    const from = offset + (m.index ?? 0);
    const to = from + m[0].length;
    const alias = m[2]?.trim();
    const labelFrom = alias ? from + 2 + m[1].length + 1 : from + 2;
    out.push({ from, to, title, label: alias || title, labelFrom, labelTo: to - 2 });
  }
  return out;
}

export function wikiLinkToken(title: string): string {
  return `[[${title.replace(/[[\]|\n]+/g, ' ').replace(/\s+/g, ' ').trim()}]]`;
}

/** Titles linked from a note, without duplicates (case-insensitive), in order. */
export function linkedTitles(markdown: string): string[] {
  const seen = new Map<string, string>();
  for (const m of findWikiLinks(markdown)) {
    const key = normalizeTitle(m.title);
    if (!seen.has(key)) seen.set(key, m.title);
  }
  return [...seen.values()];
}

/** Title comparison key: case, accents and spacing insensitive. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Passages of a web page: text fragments (#:~:text=) ----------------------------------------

/** Percent-encodes a text fragment term (`-`, `,` and `&` are syntax; parentheses would end the Markdown link). */
function encodeTerm(term: string): string {
  return encodeURIComponent(term)
    .replace(/-/g, '%2D')
    .replace(/,/g, '%2C')
    .replace(/&/g, '%26')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * Link to a passage of a page: browsers scroll to and highlight it
 * (`URL#:~:text=début,fin`). Long quotes are shortened to their first and
 * last words, as recommended by the specification.
 */
export function textFragmentUrl(url: string, quote: string): string {
  const words = quote.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  // `(` `)` (Wikipedia…) would end the Markdown link: encoded, the URL stays the same.
  const base = url.split('#')[0].replace(/\(/g, '%28').replace(/\)/g, '%29');
  if (words.length === 0) return base;
  const text =
    words.length > 10
      ? `${encodeTerm(words.slice(0, 5).join(' '))},${encodeTerm(words.slice(-5).join(' '))}`
      : encodeTerm(words.join(' '));
  return `${base}#:~:text=${text}`;
}

/** The passage targeted by a `#:~:text=` link: start (and end) words. */
export function parseTextFragment(url: string): { start: string; end: string | null } | null {
  const i = url.indexOf('#:~:text=');
  if (i === -1) return null;
  const directive = url.slice(i + 9).split('&')[0];
  const parts = directive.split(',').filter((p) => !/-$/.test(p) && !/^-/.test(p));
  if (!parts.length) return null;
  try {
    const [start, end] = parts.map((p) => decodeURIComponent(p));
    return { start, end: end ?? null };
  } catch {
    return null;
  }
}

export interface FragmentLinkMatch {
  from: number;
  to: number;
  label: string;
  url: string;
  labelFrom: number;
  labelTo: number;
}

const FRAGMENT_LINK_RE = /(?<!!)\[([^\]\n]{0,80})\]\((https?:\/\/[^()\s]*#:~:text=[^()\s]+)\)/g;

/** Markdown links pointing to a passage of a page (quotes of web articles). */
export function findFragmentLinks(text: string, offset = 0): FragmentLinkMatch[] {
  const out: FragmentLinkMatch[] = [];
  for (const m of text.matchAll(FRAGMENT_LINK_RE)) {
    const from = offset + (m.index ?? 0);
    out.push({ from, to: from + m[0].length, label: m[1], url: m[2], labelFrom: from + 1, labelTo: from + 1 + m[1].length });
  }
  return out;
}

/** A quote of a web page, linked to the passage: `> texte [↗](URL#:~:text=…)`. */
export function quoteLine(quote: string, url: string): string {
  const clean = quote.replace(/\s+/g, ' ').trim();
  return `> ${clean} [↗](${textFragmentUrl(url, clean)})`;
}

export function timestampToken(seconds: number): string {
  return `[${formatTimecode(seconds)}]`;
}

/** The note line written for a screenshot: timestamp + thumbnail. */
export function captureLine(seconds: number, assetPath: string): string {
  const tc = formatTimecode(seconds);
  return `[${tc}] ![Capture ${tc}](${assetPath})`;
}

/** Paths (`assets/…`) of every screenshot referenced by the note. */
export function findAssetRefs(markdown: string): string[] {
  const refs = new Set<string>();
  for (const m of markdown.matchAll(ASSET_RE)) refs.add(m[1]);
  return [...refs];
}

/** Appends a block on its own line and leaves an empty line after it for the next note. */
export function appendBlock(markdown: string, block: string): string {
  if (markdown.trim() === '') return `${block}\n`;
  return `${markdown.endsWith('\n') ? markdown : `${markdown}\n`}${block}\n`;
}

export interface PortableNote {
  title: string;
  url: string;
  platform: string;
  markdown: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Markdown meant to leave the extension (download, clipboard, desktop app):
 * bare `[MM:SS]` become clickable `[MM:SS](URL#t=N)` links, and a YAML front
 * matter describes the source video. Code blocks / spans are left untouched.
 */
export function toPortableMarkdown(
  note: PortableNote,
  opts: { frontMatter?: boolean; linkTimestamps?: boolean } = {},
): string {
  const { frontMatter = true, linkTimestamps = true } = opts;
  let body = note.markdown;
  if (linkTimestamps && note.url) body = linkBareTimestamps(body, note.url);
  if (!frontMatter) return body;
  const header = [
    '---',
    `title: ${JSON.stringify(note.title)}`,
    `source: ${note.url}`,
    `platform: ${note.platform}`,
    `created: ${new Date(note.createdAt).toISOString()}`,
    `updated: ${new Date(note.updatedAt).toISOString()}`,
    '---',
    '',
  ].join('\n');
  return `${header}\n${body}`;
}

function linkBareTimestamps(markdown: string, url: string): string {
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (fence === null) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      // Odd segments are inline code spans.
      return line
        .split(/(`+[^`]*`+)/)
        .map((seg, i) =>
          i % 2 === 1
            ? seg
            : seg.replace(TIMESTAMP_RE, (all, label: string, link?: string) => {
                if (link !== undefined) return all;
                const seconds = parseTimecode(label);
                return seconds === null ? all : `[${label}](${timestampUrl(url, seconds)})`;
              }),
        )
        .join('');
    })
    .join('\n');
}
