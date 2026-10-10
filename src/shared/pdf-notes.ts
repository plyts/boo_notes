import { PDFDocument, PDFName, PDFNull, PDFString, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type PDFRef } from 'pdf-lib';
import { calloutHeader, findCallouts, unquote, type Callout } from './callouts';
import { formatTimecode, parseTimecode } from './time';
import { PASSAGE_LINE, TRANSCRIPT_LINE } from './transcript';

/**
 * Notes as a PDF — one note, one course, or the whole library: a cover with
 * a clickable table of contents (course › chapter › note; a course's PDF:
 * chapter › lesson), then each note with its headings, lists, quotes, code,
 * highlights; its pictures embedded; every timestamp linked to the moment of
 * its video; each passage (clip) with its card, a link replaying it at the
 * source and a reference to its recorded extract; its transcript written out,
 * each line linked to its moment (when given); and, at the end of each note,
 * its references (source, passages, extracts). Pure layout: pictures and
 * links come from the caller.
 */
export interface PdfNote {
  id: string;
  title: string;
  /** Page of the media or article ('' when none). */
  url: string;
  /** « YouTube », « Web · Lecture »… */
  source: string;
  /** « Cours › Chapitre », null when not filed. */
  place: string | null;
  updatedAt: number;
  markdown: string;
  /** Its chapter alone (a course's PDF: its contents go by chapter). */
  chapter?: string | null;
  /** Its transcript, written out at its end (one note, one course). */
  transcript?: PdfTranscript | null;
}

/** What was said in the media, line by line. */
export interface PdfTranscript {
  /** « Sous-titres YouTube · anglais → français ». */
  label: string;
  cues: Array<{ start: number; text: string; tr?: string; note?: string }>;
}

export interface PdfPicture {
  bytes: Uint8Array;
  type: 'png' | 'jpg';
}

export interface PdfSources {
  /** An `assets/…` picture as PNG or JPEG bytes; null when missing. */
  picture(path: string): Promise<PdfPicture | null>;
  /** Link to an instant of the note's media; null when it has none (a page, a local file). */
  timeUrl(note: PdfNote, seconds: number): string | null;
}

export interface PdfOptions {
  /** Cover title: « Toutes les notes », the course's name, or the note's title. */
  title: string;
  date: Date;
  /** The PDF of one course: its lessons, contents by chapter. */
  course?: boolean;
  /** No cover nor contents (a summary: a page or two of its own). */
  cover?: false;
}

/** The course's summary, written first in its PDF (not one of its lessons). */
export const SUMMARY_NOTE_ID = 'boo:course-summary';

// --- Page geometry and style ----------------------------------------------------------------

const A4: [number, number] = [595.28, 841.89];
const MARGIN = { left: 56, right: 56, top: 60, bottom: 64 };
const WIDTH = A4[0] - MARGIN.left - MARGIN.right;
const INK = rgb(0.11, 0.11, 0.13);
const MUTED = rgb(0.43, 0.43, 0.46);
const ACCENT = rgb(0.36, 0.29, 0.86);
/** Free notes (« Note libre »). */
const FREE = rgb(0.12, 0.52, 0.3);
const LINK = rgb(0.2, 0.33, 0.8);
const RULE = rgb(0.85, 0.85, 0.88);
const HIGHLIGHT = rgb(1, 0.93, 0.55);
const CODE_BG = rgb(0.95, 0.95, 0.96);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

/** A piece of text with its style. */
interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  mark?: boolean;
  color?: ReturnType<typeof rgb>;
  link?: string;
}

// --- Characters the standard PDF fonts can draw --------------------------------------------------

const SUBSTITUTES: Record<string, string> = {
  '▶': '›',
  '►': '›',
  '↗': '»',
  '→': '->',
  '←': '<-',
  '⧗': '',
  '📄': '',
  '🎬': '',
  '🎵': '',
  '🔊': '',
  '💬': '»',
  '✦': '•',
  '✓': 'v',
  '✔': 'v',
  '•': '•',
  '−': '-',
  '≈': '~',
  '≤': '<=',
  '≥': '>=',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
};

function drawable(font: PDFFont): (text: string) => string {
  const allowed = new Set(font.getCharacterSet());
  return (text) => {
    let out = '';
    for (const ch of text) {
      const sub = SUBSTITUTES[ch];
      if (sub !== undefined) out += sub;
      else if (allowed.has(ch.codePointAt(0)!)) out += ch;
      else if (/\s/.test(ch)) out += ' ';
      else if (!/\p{Extended_Pictographic}|\p{M}/u.test(ch)) out += '?';
    }
    return out;
  };
}

// --- Inline Markdown ------------------------------------------------------------------------------

const TIMESTAMP = String.raw`\[((?:\d+:)?\d{1,3}:\d{2})(?:\s?[–-]\s?((?:\d+:)?\d{1,3}:\d{2}))?\](?:\(([^()\s]*)\))?`;
const INLINE = new RegExp(
  [
    String.raw`\[\[([^\]\n]+)\]\]`, // 1 wiki link
    TIMESTAMP, // 2 start, 3 end, 4 url
    String.raw`!\[([^\]\n]*)\]\(([^)\s]+)\)`, // 5 alt, 6 src (pictures are drawn apart)
    String.raw`\[([^\]\n]*)\]\(([^)\s]+)\)`, // 7 label, 8 url
    String.raw`\*\*([^*\n]+)\*\*`, // 9 bold
    String.raw`==([^=\n]+)==`, // 10 highlight
    String.raw`\x60([^\x60\n]+)\x60`, // 11 code
    String.raw`~~([^~\n]+)~~`, // 12 strike (kept as plain text)
    String.raw`(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<!\w)_([^_\n]+)_(?!\w)`, // 13 / 14 italic
  ].join('|'),
  'g',
);

function inlineRuns(text: string, note: PdfNote, src: PdfSources, base: Omit<Run, 'text'> = {}): Run[] {
  const out: Run[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ ...base, text: text.slice(last, at) });
    last = at + m[0].length;
    if (m[1] !== undefined) out.push({ ...base, text: m[1], color: ACCENT });
    else if (m[2] !== undefined) {
      const start = parseTimecode(m[2]) ?? 0;
      const url = m[4] && /^https?:\/\//.test(m[4]) ? m[4] : src.timeUrl(note, start);
      out.push({ ...base, text: m[3] ? `${m[2]}–${m[3]}` : m[2], bold: true, color: url ? LINK : ACCENT, link: url ?? undefined });
    } else if (m[5] !== undefined) {
      // A picture inside a line is drawn after it; online ones become links.
      if (/^https?:\/\//.test(m[6])) out.push({ ...base, text: `[image : ${m[5] || 'en ligne'}]`, color: LINK, link: m[6] });
    } else if (m[7] !== undefined) {
      const url = m[8];
      const label = m[7] || url;
      if (/^(https?:|mailto:)/.test(url)) out.push({ ...base, text: label, color: LINK, link: url });
      else if (url.startsWith('media/')) out.push({ ...base, text: `${label.replace(/^[🎬🎵]\s*/u, '')} (fichier ${url})`, italic: true });
      else out.push({ ...base, text: label });
    } else if (m[9] !== undefined) out.push(...inlineRuns(m[9], note, src, { ...base, bold: true }));
    else if (m[10] !== undefined) out.push(...inlineRuns(m[10], note, src, { ...base, mark: true }));
    else if (m[11] !== undefined) out.push({ ...base, text: m[11], mono: true });
    else if (m[12] !== undefined) out.push(...inlineRuns(m[12], note, src, { ...base, color: MUTED }));
    else out.push(...inlineRuns(m[13] ?? m[14] ?? '', note, src, { ...base, italic: true }));
  }
  if (last < text.length) out.push({ ...base, text: text.slice(last) });
  return out.filter((r) => r.text !== '');
}

// --- Layout -------------------------------------------------------------------------------------

interface LinkBox {
  page: PDFPage;
  rect: [number, number, number, number];
  uri?: string;
  /** Internal link: to this page, at this height. */
  dest?: { page: PDFPage; y: number };
}

class Layout {
  page!: PDFPage;
  y = 0;
  readonly links: LinkBox[] = [];
  /** Pages of each note (running footer). */
  readonly footers = new Map<PDFPage, string>();
  private readonly clean: Record<keyof Fonts, (t: string) => string>;
  footer = '';

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: Fonts,
  ) {
    this.clean = {
      regular: drawable(fonts.regular),
      bold: drawable(fonts.bold),
      italic: drawable(fonts.italic),
      boldItalic: drawable(fonts.boldItalic),
      mono: drawable(fonts.mono),
    };
  }

  newPage(): void {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN.top;
    if (this.footer) this.footers.set(this.page, this.footer);
  }

  /** Room for `h` points, else a new page. */
  need(h: number): void {
    if (this.y - h < MARGIN.bottom) this.newPage();
  }

  fontOf(r: Run): keyof Fonts {
    if (r.mono) return 'mono';
    if (r.bold && r.italic) return 'boldItalic';
    if (r.bold) return 'bold';
    if (r.italic) return 'italic';
    return 'regular';
  }

  text(r: Run): string {
    return this.clean[this.fontOf(r)](r.text);
  }

  /**
   * Runs wrapped to the width, from `indent`; links become clickable boxes.
   * `before(y, h)` draws behind each line (quote bar, code background).
   */
  paragraph(runs: Run[], opts: { size?: number; indent?: number; lead?: number; color?: ReturnType<typeof rgb>; first?: string; before?: (y: number, h: number) => void } = {}): void {
    const size = opts.size ?? 10.5;
    const lead = opts.lead ?? size * 1.45;
    const indent = opts.indent ?? 0;
    const width = WIDTH - indent;
    // Words with their style (spaces kept at the end of words).
    const words: Array<Run & { width: number }> = [];
    for (const r of runs) {
      const clean = this.text(r);
      for (const part of clean.split(/(?<=\s)/)) {
        if (!part) continue;
        const font = this.fonts[this.fontOf(r)];
        words.push({ ...r, text: part, width: font.widthOfTextAtSize(part, size) });
      }
    }
    if (!words.length) {
      this.y -= lead * 0.5;
      return;
    }
    const lines: Array<typeof words> = [[]];
    let used = 0;
    for (const w of words) {
      const line = lines[lines.length - 1];
      if (used + w.width > width && line.length) {
        lines.push([]);
        used = 0;
      }
      // A word wider than the line is cut.
      if (w.width > width) {
        const font = this.fonts[this.fontOf(w)];
        let piece = '';
        for (const ch of w.text) {
          if (font.widthOfTextAtSize(piece + ch, size) > width - used && piece) {
            lines[lines.length - 1].push({ ...w, text: piece, width: font.widthOfTextAtSize(piece, size) });
            lines.push([]);
            used = 0;
            piece = '';
          }
          piece += ch;
        }
        w.text = piece;
        w.width = font.widthOfTextAtSize(piece, size);
      }
      lines[lines.length - 1].push(w);
      used += w.width;
    }
    lines.forEach((line, i) => {
      this.need(lead);
      const base = this.y - size;
      opts.before?.(base, lead);
      let x = MARGIN.left + indent;
      if (i === 0 && opts.first) {
        const f = this.fonts.regular;
        this.page.drawText(this.clean.regular(opts.first), { x: x - f.widthOfTextAtSize(opts.first, size) - 4, y: base, size, font: f, color: MUTED });
      }
      // Words of the same style and link drawn at once: viewers space them with the font's own metrics.
      const groups: Array<typeof line> = [];
      for (const w of line) {
        const g = groups[groups.length - 1];
        const p = g?.[g.length - 1];
        if (p && this.fontOf(p) === this.fontOf(w) && p.color === w.color && p.mark === w.mark && p.link === w.link) g.push(w);
        else groups.push([w]);
      }
      for (const g of groups) {
        const w = g[0];
        const font = this.fonts[this.fontOf(w)];
        const text = g.map((x) => x.text).join('');
        const width = g.reduce((sum, x) => sum + x.width, 0);
        if (w.mark) this.page.drawRectangle({ x, y: base - size * 0.22, width, height: size * 1.18, color: HIGHLIGHT });
        if (w.mono) this.page.drawRectangle({ x, y: base - size * 0.22, width, height: size * 1.18, color: CODE_BG });
        this.page.drawText(text, { x, y: base, size, font, color: w.color ?? opts.color ?? INK });
        if (w.link) {
          // Trailing space out of the clickable box.
          const inner = width - (text.endsWith(' ') ? font.widthOfTextAtSize(' ', size) : 0);
          this.links.push({ page: this.page, rect: [x, base - size * 0.25, x + inner, base + size * 0.95], uri: w.link });
        }
        x += width;
      }
      this.y -= lead;
    });
  }

  gap(h: number): void {
    this.y -= h;
  }

  rule(): void {
    this.need(12);
    this.page.drawLine({ start: { x: MARGIN.left, y: this.y - 4 }, end: { x: A4[0] - MARGIN.right, y: this.y - 4 }, thickness: 0.6, color: RULE });
    this.y -= 12;
  }

  picture(img: PDFImage, maxHeight = 300): void {
    const scale = Math.min(WIDTH / img.width, maxHeight / img.height, 1.5);
    const w = img.width * scale;
    const hgt = img.height * scale;
    this.need(hgt + 6);
    this.page.drawImage(img, { x: MARGIN.left, y: this.y - hgt, width: w, height: hgt });
    this.page.drawRectangle({ x: MARGIN.left, y: this.y - hgt, width: w, height: hgt, borderColor: RULE, borderWidth: 0.5 });
    this.y -= hgt + 6;
  }
}

// --- Notes --------------------------------------------------------------------------------------

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;

/** A point of a summary's plan (« ★ **Essentiel — titre :** … »): its label in colour, then its text. */
const POINT = /^(?:★|📘|💡|⚠\uFE0F?)\s*\*\*(Essentiel|Définition|Exemple|Attention) — (.+?) :\*\*\s*(.*)$/u;
const POINT_COLORS: Record<string, ReturnType<typeof rgb>> = {
  Essentiel: rgb(0.6, 0.44, 0),
  Définition: rgb(0, 0.35, 0.72),
  Exemple: rgb(0.09, 0.44, 0.18),
  Attention: rgb(0.71, 0.33, 0.04),
};
/** Behind the essential point of each part. */
const KEY_BG = rgb(1, 0.965, 0.82);

function itemRuns(text: string, note: PdfNote, src: PdfSources): { runs: Run[]; key: boolean } {
  const m = POINT.exec(text);
  if (!m) return { runs: inlineRuns(text, note, src), key: false };
  return { runs: [{ text: `${m[1].toUpperCase()}  `, bold: true, color: POINT_COLORS[m[1]] }, ...inlineRuns(`**${m[2]}** — ${m[3]}`, note, src)], key: m[1] === 'Essentiel' };
}

async function writeNote(l: Layout, note: PdfNote, src: PdfSources, pictures: Map<string, PDFImage | null>): Promise<void> {
  const picture = async (path: string): Promise<PDFImage | null> => {
    if (!pictures.has(path)) {
      const p = await src.picture(path).catch(() => null);
      pictures.set(path, p ? await (p.type === 'png' ? l.doc.embedPng(p.bytes) : l.doc.embedJpg(p.bytes)).catch(() => null) : null);
    }
    return pictures.get(path) ?? null;
  };
  const refs: Run[][] = [];

  // Header: title, where it comes from, when it was written.
  l.paragraph([{ text: note.title, bold: true }], { size: 19, lead: 25 });
  const meta = [note.source, note.place ?? '', `modifiée le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(note.updatedAt)}`].filter(Boolean).join(' · ');
  l.paragraph([{ text: meta, color: MUTED }], { size: 9.5 });
  if (/^https?:\/\//.test(note.url)) {
    l.paragraph([{ text: '› Revoir la leçon : ', bold: true, color: LINK, link: note.url }, { text: note.url, color: LINK, link: note.url }], { size: 9 });
    refs.push([{ text: 'Source : ', bold: true }, { text: note.url, color: LINK, link: note.url }]);
  }
  l.rule();
  const spoken = note.transcript?.cues.length ? note.transcript : null;

  const lines = note.markdown.replace(/\r\n?/g, '\n').split('\n');
  // Questions and free notes: a titled block, a coloured bar along it.
  const blocks = new Map<number, { kind: Callout['kind']; header: boolean }>();
  for (const c of findCallouts(lines)) for (let i = c.from; i <= c.to; i++) blocks.set(i, { kind: c.kind, header: i === c.from });
  let fence: string | null = null;
  // The open list items (the column their text starts at): a line indented under one belongs to it.
  let items: number[] = [];
  let inBlock = false;
  /** A list item: its marker, nested under the items its indent falls in; `offset`: inside a block. */
  const listItem = (li: RegExpExecArray, offset: number, bar?: (y: number, h: number) => void) => {
    const spaces = li[1].replace(/\t/g, '  ').length;
    while (items.length && items[items.length - 1] > spaces) items.pop();
    const depth = items.length;
    items.push(spaces + li[2].length + 1);
    const box = li[3] !== undefined ? (li[3].trim() ? '[x] ' : '[ ] ') : '';
    const marker = /\d/.test(li[2]) ? li[2] : '•';
    const { runs, key } = box ? { runs: inlineRuns(`${box}${li[4]}`, note, src), key: false } : itemRuns(li[4], note, src);
    const indent = offset + 14 + depth * 14;
    const back = key ? (y: number, h: number) => l.page.drawRectangle({ x: MARGIN.left + indent - 12, y: y - 3.5, width: WIDTH - indent + 12, height: h, color: KEY_BG }) : null;
    l.paragraph(runs, { indent, first: marker, ...(back || bar ? { before: (y: number, h: number) => (back?.(y, h), bar?.(y, h)) } : {}) });
  };
  /** A line indented under a list item: its text, at the item's indent. */
  const continued = (text: string, offset: number, bar?: (y: number, h: number) => void): boolean => {
    const spaces = /^\s*/.exec(text)![0].replace(/\t/g, '  ').length;
    if (!items.length || !spaces) return false;
    while (items.length > 1 && items[items.length - 1] > spaces) items.pop();
    l.paragraph(inlineRuns(text.trim(), note, src), { indent: offset + 14 + (items.length - 1) * 14, ...(bar ? { before: bar } : {}) });
    return true;
  };
  for (const [i, raw] of lines.entries()) {
    let line = raw.replace(/\s+$/, '');
    // Code blocks: monospace, grey background.
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence;
      l.gap(2);
      continue;
    }
    if (fence !== null) {
      l.paragraph([{ text: line || ' ', mono: true }], { size: 9, lead: 12.5, indent: 8, before: (y, h) => l.page.drawRectangle({ x: MARGIN.left, y: y - 3.5, width: WIDTH, height: h, color: CODE_BG }) });
      continue;
    }
    if (!line.trim()) {
      l.gap(6);
      continue;
    }

    const block = blocks.get(i);
    if (Boolean(block) !== inBlock) items = [];
    inBlock = Boolean(block);
    if (block) {
      const color = block.kind === 'question' ? ACCENT : block.kind === 'free' ? FREE : MUTED;
      const bar = (y: number, h: number) => l.page.drawRectangle({ x: MARGIN.left + 2, y: y - 3.5, width: 2.2, height: h, color });
      if (block.header) {
        const title = calloutHeader(line)?.title || (block.kind === 'free' ? 'Note libre' : 'Question');
        l.gap(6);
        l.need(48);
        l.paragraph(inlineRuns(title, note, src, { bold: true }), { indent: 12, color, before: bar, size: 10.5 });
        continue;
      }
      const inner = unquote(line);
      if (!inner.trim()) {
        l.gap(4);
        continue;
      }
      if (!/!\[[^\]\n]*\]\(assets\//.test(inner)) {
        const nested = /^>\s?(.*)$/.exec(inner);
        const li = nested ? null : LIST.exec(inner);
        if (li) {
          listItem(li, 12, bar);
          continue;
        }
        if (!nested && continued(inner, 12, bar)) continue;
        items = [];
        l.paragraph(inlineRuns(nested ? nested[1] : inner, note, src, nested ? { italic: true } : {}), {
          indent: nested ? 22 : 12,
          before: bar,
          ...(nested ? { color: rgb(0.3, 0.3, 0.34) } : {}),
        });
        continue;
      }
      // A picture in the block: drawn as any picture.
      line = inner;
    }

    // A line at the margin (not an item) ends the lists above it.
    if (!block && !/^\s/.test(line) && !LIST.test(line)) items = [];

    // A passage (clip): its card, a link replaying it at the source, its extract.
    const passage = PASSAGE_LINE.exec(line);
    if (passage) {
      const start = parseTimecode(passage[1]) ?? 0;
      const end = parseTimecode(passage[2]) ?? start;
      const range = `${formatTimecode(start)}–${formatTimecode(end)}`;
      const img = await picture(passage[4]);
      l.gap(4);
      if (img) l.picture(img, 220);
      const url = src.timeUrl(note, start);
      const title = passage[3]?.trim();
      l.paragraph([{ text: `Passage ${range}`, bold: true, color: ACCENT }, ...(title ? [{ text: ` · ${title}` }] : [])], { size: 10 });
      const links: Run[] = [];
      if (url) links.push({ text: `› Revoir le passage ${range} à la source`, color: LINK, link: url });
      if (passage[5]) links.push({ text: `${links.length ? '   ·   ' : ''}Extrait vidéo : ${passage[5].split('/').pop()}`, italic: true, color: MUTED });
      if (links.length) l.paragraph(links, { size: 9.5 });
      refs.push([
        { text: `Passage ${range}${title ? ` · ${title}` : ''} : `, bold: true },
        ...(url ? [{ text: url, color: LINK, link: url }] : [{ text: 'sans lien (fichier local)', color: MUTED }]),
        ...(passage[5] ? [{ text: ` — extrait ${passage[5]}`, italic: true, color: MUTED }] : []),
      ]);
      l.gap(6);
      continue;
    }

    // The transcript pinned to the note: written out at the end, else a reference.
    if (TRANSCRIPT_LINE.test(line)) {
      const label = /\[([^\]]+)\]/.exec(line)?.[1] ?? 'Transcription';
      if (spoken) {
        l.paragraph([{ text: `${label} — en entier à la fin de la leçon`, italic: true, color: MUTED }], { size: 9.5 });
        continue;
      }
      l.paragraph([{ text: label, italic: true, color: MUTED }], { size: 9.5 });
      refs.push([{ text: `${label} : `, bold: true }, { text: line.replace(/^.*\]\(([^)]+)\).*$/, '$1'), italic: true, color: MUTED }]);
      continue;
    }

    // Headings.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const size = [16, 14, 12.5, 11.5, 11, 11][heading[1].length - 1];
      l.gap(size * 0.5);
      l.need(size * 3);
      l.paragraph(inlineRuns(heading[2], note, src, { bold: true }), { size, lead: size * 1.35 });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      l.rule();
      continue;
    }

    // Pictures of the line (captures, pasted pictures): drawn under its text.
    const images = [...line.matchAll(/!\[([^\]\n]*)\]\((assets\/[^)\s]+)\)/g)];
    const rest = line.replace(/!\[([^\]\n]*)\]\((assets\/[^)\s]+)\)/g, '').trim();
    const pics = await Promise.all(images.map(async (m) => ({ alt: m[1], img: await picture(m[2]), path: m[2] })));

    const quote = /^>\s?(.*)$/.exec(line);
    const list = LIST.exec(line);
    const table = /^\s*\|.*\|\s*$/.test(line);
    if (table) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      l.paragraph(inlineRuns(cells.join('   |   '), note, src), { size: 9.5 });
    } else if (quote) {
      l.paragraph(inlineRuns(quote[1], note, src, { italic: true }), {
        indent: 12,
        color: rgb(0.3, 0.3, 0.34),
        before: (y, h) => l.page.drawRectangle({ x: MARGIN.left + 2, y: y - 3.5, width: 2.2, height: h, color: ACCENT }),
      });
    } else if (list) {
      listItem(list, 0);
    } else if (!images.length && continued(line, 0)) {
      // Under the list item above.
    } else if (rest && !(images.length && /^\[[^\]]+\]$/.test(rest))) {
      l.paragraph(inlineRuns(images.length ? line.replace(/!\[([^\]\n]*)\]\((assets\/[^)\s]+)\)/g, '').trim() : line, note, src));
    }
    for (const p of pics) {
      const stamp = /^\[((?:\d+:)?\d{1,3}:\d{2})\]/.exec(line)?.[1];
      if (p.img) l.picture(p.img);
      else l.paragraph([{ text: `Image introuvable : ${p.path}`, italic: true, color: MUTED }], { size: 9 });
      const at = stamp ? parseTimecode(stamp) : null;
      const url = at !== null ? src.timeUrl(note, at) : null;
      const caption: Run[] = [{ text: p.alt || 'Image', italic: true, color: MUTED }];
      if (url && stamp) caption.push({ text: `   › Revoir à ${stamp}`, color: LINK, link: url });
      l.paragraph(caption, { size: 9 });
      l.gap(4);
    }
  }

  // The transcript: every line, its moment a click away.
  if (spoken) {
    l.gap(10);
    l.need(70);
    l.rule();
    l.paragraph([{ text: 'Transcription', bold: true }], { size: 12.5, lead: 18 });
    const n = spoken.cues.length;
    l.paragraph([{ text: `${spoken.label} · ${n} réplique${n > 1 ? 's' : ''}`, italic: true, color: MUTED }], { size: 9 });
    l.gap(4);
    for (const c of spoken.cues) {
      const url = src.timeUrl(note, c.start);
      const stamp = formatTimecode(c.start);
      l.paragraph([{ text: stamp, mono: true, color: url ? LINK : MUTED, ...(url ? { link: url } : {}) }, { text: `  ${c.text.replace(/\s+/g, ' ').trim()}` }], { size: 9.5, lead: 13.5 });
      if (c.tr?.trim()) l.paragraph([{ text: c.tr.replace(/\s+/g, ' ').trim(), italic: true, color: MUTED }], { size: 9, lead: 12.5, indent: 40 });
      if (c.note?.trim()) l.paragraph([{ text: `» ${c.note.replace(/\s+/g, ' ').trim()}`, color: ACCENT }], { size: 9, lead: 12.5, indent: 40 });
    }
  }

  // References: everything the note points to, clickable.
  if (refs.length) {
    l.gap(8);
    l.need(60);
    l.rule();
    l.paragraph([{ text: 'Références', bold: true }], { size: 11 });
    for (const r of refs) l.paragraph(r, { size: 9, indent: 14, first: '•' });
  }
}

/** The notes as a PDF document (bytes). */
export async function buildNotesPdf(notes: PdfNote[], src: PdfSources, opts: PdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Boo Notes — ${opts.title}`);
  doc.setAuthor('Boo Notes');
  doc.setCreator('Boo Notes');
  doc.setProducer('Boo Notes (pdf-lib)');
  doc.setCreationDate(opts.date);
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const l = new Layout(doc, fonts);
  const pictures = new Map<string, PDFImage | null>();

  // Notes first (their pages known), the cover and its contents inserted before them.
  const starts: Array<{ note: PdfNote; page: PDFPage }> = [];
  for (const note of notes) {
    l.footer = note.title;
    l.newPage();
    starts.push({ note, page: l.page });
    await writeNote(l, note, src, pictures);
  }
  const notePages = doc.getPages().length;

  // Cover: title, date, counts; then the table of contents, by course › chapter.
  const noteLinks = l.links.splice(0);
  if (opts.cover === false) return finish(doc, fonts, l, noteLinks, null);
  l.footer = '';
  l.newPage();
  const cover = l.page;
  l.gap(120);
  l.paragraph([{ text: 'Boo Notes', bold: true, color: ACCENT }], { size: 30, lead: 38 });
  l.paragraph([{ text: opts.title, bold: true }], { size: 18, lead: 26 });
  const lessons = notes.filter((x) => x.id !== SUMMARY_NOTE_ID);
  const count = lessons.length;
  const passages = notes.reduce((n, x) => n + x.markdown.split('\n').filter((line) => PASSAGE_LINE.test(line)).length, 0);
  const captures = notes.reduce((n, x) => n + (x.markdown.match(/!\[[^\]\n]*\]\(assets\//g)?.length ?? 0), 0);
  const spoken = notes.filter((x) => x.transcript?.cues.length).length;
  const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
  if (opts.course) l.paragraph([{ text: 'Cours — toutes les leçons', color: MUTED }], { size: 11 });
  l.paragraph(
    [
      {
        text: [
          new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(opts.date),
          plural(count, opts.course ? 'leçon' : 'note'),
          ...(opts.course ? [plural(new Set(lessons.map((x) => x.chapter ?? '')).size, 'chapitre')] : []),
          ...(lessons.length < notes.length ? ['résumé du cours'] : []),
          plural(captures, 'image'),
          plural(passages, 'passage'),
          ...(spoken ? [plural(spoken, 'transcription')] : []),
        ].join(' · '),
        color: MUTED,
      },
    ],
    { size: 11 },
  );
  l.gap(24);
  l.paragraph([{ text: 'Sommaire', bold: true }], { size: 13 });
  l.gap(4);
  const toc: Array<{ index: number; y: number; page: PDFPage; target: PDFPage; label: string }> = [];
  let place: string | null | undefined;
  for (const [i, s] of starts.entries()) {
    // A course: by chapter; the library: by course › chapter.
    const group = opts.course ? (s.note.chapter ?? 'Sans chapitre') : s.note.place;
    if (group !== place) {
      place = group;
      l.gap(6);
      l.paragraph([{ text: place ?? 'Sans cours', bold: true, color: ACCENT }], { size: 10.5 });
    }
    l.need(16);
    toc.push({ index: i, y: l.y, page: l.page, target: s.page, label: s.note.title });
    l.paragraph([{ text: s.note.title }], { size: 10.5, indent: 12 });
  }
  // Cover and contents move to the front.
  const front = doc.getPages().slice(notePages);
  for (const [i, page] of front.entries()) {
    doc.removePage(notePages + i);
    doc.insertPage(i, page);
  }
  const pages = doc.getPages();
  const numberOf = (p: PDFPage) => pages.indexOf(p) + 1;

  // Page numbers in the contents, clickable.
  for (const t of toc) {
    const label = `${numberOf(t.target)}`;
    const size = 10.5;
    const w = fonts.regular.widthOfTextAtSize(label, size);
    t.page.drawText(label, { x: A4[0] - MARGIN.right - w, y: t.y - size, size, font: fonts.regular, color: MUTED });
    noteLinks.push({ page: t.page, rect: [MARGIN.left + 12, t.y - size * 1.3, A4[0] - MARGIN.right, t.y + 1], dest: { page: t.target, y: A4[1] - MARGIN.top + 10 } });
  }
  noteLinks.push(...l.links);
  return finish(doc, fonts, l, noteLinks, cover);
}

/** Running footers, clickable links, and the bytes. */
async function finish(doc: PDFDocument, fonts: Fonts, l: Layout, noteLinks: LinkBox[], cover: PDFPage | null): Promise<Uint8Array> {
  const pages = doc.getPages();
  // Running footer: the note, the page.
  for (const [i, page] of pages.entries()) {
    if (page === cover) continue;
    const text = drawable(fonts.regular)(`Boo Notes${l.footers.get(page) ? ` — ${l.footers.get(page)}` : ''}`);
    const clipped = text.length > 80 ? `${text.slice(0, 79)}…` : text;
    page.drawText(clipped, { x: MARGIN.left, y: 32, size: 8, font: fonts.regular, color: MUTED });
    const num = `${i + 1} / ${pages.length}`;
    page.drawText(num, { x: A4[0] - MARGIN.right - fonts.regular.widthOfTextAtSize(num, 8), y: 32, size: 8, font: fonts.regular, color: MUTED });
  }

  // Clickable links: to the web (URI) or to a page of the document.
  for (const link of noteLinks) {
    const ctx = doc.context;
    const annot = ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: link.rect,
      Border: [0, 0, 0],
      ...(link.uri
        ? { A: { Type: 'Action', S: 'URI', URI: PDFString.of(link.uri) } }
        : { Dest: ctx.obj([link.dest!.page.ref, PDFName.of('XYZ'), PDFNull, link.dest!.y, PDFNull]) }),
    });
    const ref: PDFRef = ctx.register(annot);
    link.page.node.addAnnot(ref);
  }
  return doc.save();
}
