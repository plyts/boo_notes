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
