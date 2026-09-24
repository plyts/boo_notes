import { findAssetRefs } from './markdown';
import { markdownToBlocks, transcriptBlocks, type InlineContext } from './notion/blocks';
import { blocksHtml, esc } from './notion/html';
import { formatTimecode } from './time';
import { languagesLabel, PASSAGE_LINE, rangeLabel, TRANSCRIPT_LINE, type Transcript } from './transcript';

/**
 * A note copied « tout compris », to paste into Obsidian, Notion, Google Docs,
 * Word, a mail…: the destination has none of Boo Notes' files, so everything
 * travels in the clipboard.
 *
 * - `markdown` (text/plain): Obsidian-flavoured Markdown — timestamps and
 *   ranges linked to the instant of the video, screenshots and passage cards
 *   embedded as images (data URLs), `[[liens]]` and `==surlignages==` kept;
 * - `html` (text/html): the same note, rendered, for rich editors (Notion,
 *   Docs, Word, and Obsidian when it converts pasted HTML);
 * - the transcript (subtitles, translations, comments) replaces its
 *   attachment line with a « Transcription » section.
 *
 * Recorded extracts (videos) are too heavy for a clipboard: a passage keeps
 * its card (first picture) and a link that replays it at the source.
 */
export interface RichCopyInput {
  title: string;
  /** Web page of the note's media or article (null: local file, revision sheet). */
  sourceUrl: string | null;
  /** « Cours › Chapitre ». */
  place?: string | null;
  /** The note, as written. */
  markdown: string;
  /** Portable Markdown: timestamps linked to the instant, anchors of other resources named. */
  linkify(markdown: string): string;
  /** Links of the anchors in the HTML (instant of the video, page of the PDF…). */
  context: InlineContext;
  /** Link to an instant of the main media, null when it has none (local file). */
  timeUrl(seconds: number): string | null;
  /** Data URL of an `assets/…` image; null when it cannot be found. */
  image(path: string): Promise<string | null>;
  transcript?: Transcript | null;
}

export interface RichCopy {
  markdown: string;
  html: string;
  /** Images embedded. */
  images: number;
  /** Images that could not be read. */
  missing: string[];
}

/** Recorded extract of a passage: a link replaying it at the source (Markdown), nothing in HTML (the card links there). */
function passageLinks(markdown: string, timeUrl: (s: number) => string | null, keepLink: boolean): string {
  return markdown
    .split('\n')
    .map((line) => {
      const m = PASSAGE_LINE.exec(line);
      if (!m) return line;
      const withoutMedia = line.replace(/\s+\[[^\]\n]*\]\(media\/[^)\s]+\)[ \t]*$/, '');
      if (!keepLink) return withoutMedia;
      const start = m[1].split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
      const end = m[2].split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
      const url = timeUrl(start);
      return url ? `${withoutMedia}\n[▶ Revoir le passage ${rangeLabel(start, end)}](${url})` : withoutMedia;
    })
    .join('\n');
}

function transcriptMarkdown(t: Transcript, timeUrl: (s: number) => string | null): string {
  const n = t.cues.length;
  const lines = ['## Transcription', '', `*${t.label} · ${languagesLabel(t)} · ${n} réplique${n > 1 ? 's' : ''}*`, ''];
  for (const c of t.cues) {
    const tc = formatTimecode(c.start);
    const url = timeUrl(c.start);
    const parts = [`${url ? `[${tc}](${url})` : `**${tc}**`} ${c.text}`];
    if (c.tr?.trim()) parts.push(`*${c.tr.trim()}*`);
    if (c.note?.trim()) parts.push(`💬 ${c.note.trim()}`);
    // Two trailing spaces: line breaks inside one paragraph.
    lines.push(parts.join('  \n'), '');
  }
  return lines.join('\n').trimEnd();
}

export async function buildRichCopy(input: RichCopyInput): Promise<RichCopy> {
  const hasTranscript = Boolean(input.transcript?.cues.length);
  const body = hasTranscript ? input.markdown.split('\n').filter((l) => !TRANSCRIPT_LINE.test(l)).join('\n') : input.markdown;

  // Every picture of the note, read once.
  const images = new Map<string, string>();
  const missing: string[] = [];
  for (const path of findAssetRefs(body)) {
    const data = await input.image(path).catch(() => null);
    if (data) images.set(path, data);
    else missing.push(path);
  }

  // --- Markdown -------------------------------------------------------------------------
  let md = input.linkify(passageLinks(body, input.timeUrl, true));
  md = md.replace(/!\[([^\]\n]*)\]\((assets\/[^)\s]+)\)/g, (_all, alt: string, path: string) => {
    const data = images.get(path);
    return data ? `![${alt}](${data})` : `*${alt || 'Image'} (image introuvable)*`;
  });
  const head = [`# ${input.title}`, ''];
  const meta = [input.sourceUrl ? `[${input.sourceUrl}](${input.sourceUrl})` : '', input.place ?? ''].filter(Boolean);
  if (meta.length) head.push(meta.join(' · '), '');
  const markdown = [
    ...head,
    md.trim(),
    ...(hasTranscript ? ['', transcriptMarkdown(input.transcript!, input.timeUrl)] : []),
  ]
    .join('\n')
    .concat('\n');

  // --- HTML -----------------------------------------------------------------------------
  const blocks = markdownToBlocks(passageLinks(body, input.timeUrl, false), input.context);
  if (hasTranscript) blocks.push(...transcriptBlocks(input.transcript!, input.timeUrl));
  const metaHtml = [
    input.sourceUrl ? `▶ <a href="${esc(input.sourceUrl)}">${esc(input.sourceUrl)}</a>` : '',
    input.place ? esc(input.place) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const html = `<meta charset="utf-8"><h1>${esc(input.title)}</h1>${metaHtml ? `<p>${metaHtml}</p>` : ''}${blocksHtml(blocks, (p) => images.get(p) ?? '')}`;

  return { markdown, html, images: images.size, missing };
}
