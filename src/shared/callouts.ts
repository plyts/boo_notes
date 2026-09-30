import { parseTimecode } from './time';

/**
 * Question and « Note libre » blocks of a note, written as callouts (the
 * Obsidian syntax: plain Markdown quotes, readable anywhere):
 *
 *   > [!question] Question 1 · [15:32]
 *   > Pourquoi cette méthode fonctionne-t-elle dans ce cas ?
 *   >
 *   > **Réponse :** La méthode fonctionne parce que…
 *   >
 *   > **Source du cours — [23:41]**
 *   > « Passage du transcript… »
 *
 *   > [!note] Note libre
 *   > Cette partie me fait penser à un concept vu précédemment.
 *   > > « Extrait du cours… » [↗](URL#:~:text=…)
 *   > ![Capture](assets/…)
 *
 * A question is numbered in the order of the note (Question 1, 2, 3…) and
 * answered from the course; its header keeps the moment it was asked. A free
 * note is personal: no answer, no automatic timestamp in it.
 */

export type BlockKind = 'question' | 'free';

export interface Callout {
  /** `question`, `free` (`[!note]`), or another callout type (`[!tip]`…). */
  kind: BlockKind | 'other';
  /** Callout type as written (`question`, `note`, `tip`…), lower case. */
  type: string;
  title: string;
  /** First line (the header), 0-based. */
  from: number;
  /** Last line of the block (inclusive). */
  to: number;
}

export const QUESTION_TYPE = 'question';
export const FREE_TYPE = 'note';
export const FREE_TITLE = 'Note libre';

const HEADER = /^>[ \t]?\[!([A-Za-z][\w-]*)\][+-]?(?:[ \t]+(.*))?$/;
/** « Question 3 », then anything the header carries (` · [15:32]`). */
const QUESTION_TITLE = /^Question(?:[ \t]+(\d+))?(?=$|[ \t·—-])/;
const STAMP = /\[((?:\d+:)?\d{1,3}:\d{2})\](?:\([^()\s]*\))?/;
const LEADING_STAMP = /^\[((?:\d+:)?\d{1,3}:\d{2})\](?:\([^()\s]*\))?[ \t]*/;
const LEADING_MARKUP = /^[ \t]*(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+|#{1,6}[ \t]+)?/;
/** First line of the answer part of a question block. */
const ANSWER_START = /^>[ \t]?\*\*Réponse\b/;

export function calloutHeader(line: string): { type: string; title: string } | null {
  const m = HEADER.exec(line);
  return m ? { type: m[1].toLowerCase(), title: (m[2] ?? '').trim() } : null;
}

function kindOf(type: string): Callout['kind'] {
  return type === QUESTION_TYPE ? 'question' : type === FREE_TYPE ? 'free' : 'other';
}

/** The callouts of a note: a header line, then every following line starting with `>`. */
export function findCallouts(lines: readonly string[]): Callout[] {
  const out: Callout[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Nothing inside a code block is a callout.
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const header = calloutHeader(line);
    if (!header) continue;
    let to = i;
    while (to + 1 < lines.length && lines[to + 1].startsWith('>') && !calloutHeader(lines[to + 1])) to++;
    out.push({ kind: kindOf(header.type), type: header.type, title: header.title, from: i, to });
    i = to;
  }
  return out;
}

/** The callout holding line `n`, if any. */
export function calloutAt(lines: readonly string[], n: number): Callout | null {
  return findCallouts(lines).find((c) => n >= c.from && n <= c.to) ?? null;
}

/** Text of a line inside a callout, its `>` taken off. */
export function unquote(line: string): string {
  return line.replace(/^>[ \t]?/, '');
}

const quoted = (text: string) => (text ? `> ${text}` : '>');

function questionHeader(n: number, stamp: string | null): string {
  return `> [!${QUESTION_TYPE}] Question ${n}${stamp ? ` · ${stamp}` : ''}`;
}

const FREE_HEADER = `> [!${FREE_TYPE}] ${FREE_TITLE}`;

/** Number the next question gets when made from line `n` (its rank among the questions). */
export function questionNumberAt(lines: readonly string[], n: number): number {
  return findCallouts(lines).filter((c) => c.kind === 'question' && c.from < n).length + 1;
}

/**
 * Numbers of the questions, in the order of the note: the edits bringing
 * each `Question N` title in line (`line`, and the range of its number).
 */
export function renumberQuestions(lines: readonly string[]): Array<{ line: number; from: number; to: number; text: string }> {
  const edits: Array<{ line: number; from: number; to: number; text: string }> = [];
  let n = 0;
  for (const c of findCallouts(lines)) {
    if (c.kind !== 'question') continue;
    n++;
    const line = lines[c.from];
    const titleAt = line.indexOf(']', line.indexOf('[!')) + 1;
    const rest = line.slice(titleAt);
    const lead = /^[+-]?[ \t]*/.exec(rest)![0].length;
    const m = QUESTION_TITLE.exec(rest.slice(lead));
    if (!m) continue;
    const start = titleAt + lead;
    const want = `Question ${n}`;
    if (m[0] !== want) edits.push({ line: c.from, from: start, to: start + m[0].length, text: want });
  }
  return edits;
}

/** A line as the first line of a block: list / heading markers and its leading timestamp taken off. */
function splitLine(line: string): { stamp: string | null; text: string } {
  let text = line.replace(LEADING_MARKUP, '');
  const stamp = LEADING_STAMP.exec(text);
  if (stamp) text = text.slice(stamp[0].length);
  return { stamp: stamp ? stamp[0].trim() : null, text: text.trimEnd() };
}

/**
 * A normal line made a block. A question keeps the moment it was asked (in
 * its header); a free note is not tied to the video: its timestamp goes.
 */
export function lineToBlock(line: string, kind: BlockKind, number: number): string[] {
  // A quoted line stays quoted in a free note; a question is its text.
  if (kind === 'free' && line.startsWith('>')) return [FREE_HEADER, `> ${line}`];
  const { stamp, text } = splitLine(line.replace(/^(?:>[ \t]?)+/, ''));
  if (kind === 'question') return [questionHeader(number, stamp), quoted(text)];
  return [FREE_HEADER, quoted(text)];
}

/**
 * A block turned into another kind, or back into normal lines (`normal`):
 * its content stays, only the header changes (or goes, with the `>`).
 */
export function convertBlock(block: readonly string[], to: BlockKind | 'normal', number: number): string[] {
  const header = calloutHeader(block[0]);
  const body = block.slice(1);
  const stamp = header ? STAMP.exec(header.title)?.[0] ?? null : null;
  if (to === 'normal') {
    const lines = body.map(unquote);
    // The moment a question was asked goes back in front of it.
    if (stamp && header?.type === QUESTION_TYPE && lines.length) lines[0] = lines[0] ? `${stamp} ${lines[0]}` : stamp;
    // An empty last line would read as the end of a paragraph: keep the text only.
    while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.length ? lines : [''];
  }
  if (to === 'question') return [questionHeader(number, header?.type === QUESTION_TYPE ? stamp : null), ...(body.length ? body : ['>'])];
  return [FREE_HEADER, ...(body.length ? body : ['>'])];
}

export interface QuestionInfo {
  /** The question, on one line. */
  text: string;
  /** When it was asked (seconds of the video), from its header. */
  stamp: number | null;
  /** Last line of the question itself (before the answer), 0-based in the note. */
  lastLine: number;
  answered: boolean;
}

/** What a question block asks. */
export function questionOf(lines: readonly string[], c: Callout): QuestionInfo {
  const header = calloutHeader(lines[c.from]);
  const tc = header ? STAMP.exec(header.title)?.[1] : undefined;
  const parts: string[] = [];
  let last = c.from;
  for (let i = c.from + 1; i <= c.to; i++) {
    const text = unquote(lines[i]).trim();
    if (!text || ANSWER_START.test(lines[i])) break;
    parts.push(text);
    last = i;
  }
  const answered = lines.slice(c.from + 1, c.to + 1).some((l) => ANSWER_START.test(l));
  return { text: parts.join(' ').trim(), stamp: tc ? parseTimecode(tc) : null, lastLine: last, answered };
}

export interface AnswerSource {
  kind: 'transcript' | 'page' | 'note';
  /** Where it comes from, as written in the note: `[23:41]`, `[↗ Section](URL#:~:text=…)`, `[[Titre]]`. */
  ref: string;
  quote: string;
}

export interface Answer {
  /** The answer (may span several paragraphs), empty when nothing was found. */
  text: string;
  /** `ai`: written from the sources; `extracts`: the closest passages, no AI. */
  method: 'ai' | 'extracts';
  sources: AnswerSource[];
  /** A line said after the answer (why no AI answered, for instance). */
  note?: string;
}

const SOURCE_LABELS: Record<AnswerSource['kind'], string> = {
  transcript: 'Source du cours',
  page: 'Source du cours',
  note: 'Vos notes',
};

/** One line of text that cannot break the block (no header, no line breaks). */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\[!/g, '[ !').trim();
}

/** The lines of an answer, inside the question block (each starting with `>`). */
export function answerLines(a: Answer): string[] {
  const out: string[] = ['>'];
  const label = a.method === 'ai' ? '**Réponse :**' : '**Réponse — passages du cours les plus proches (sans IA) :**';
  const paragraphs = a.text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.split('\n').map((l) => l.replace(/\[!/g, '[ !').trimEnd()).filter((l) => l.trim()))
    .filter((p) => p.length);
  if (!paragraphs.length && a.method === 'ai') out.push(`> ${label} je n’ai pas trouvé la réponse dans le cours.`);
  else if (!paragraphs.length) out.push(`> ${label}`);
  paragraphs.forEach((p, i) => {
    if (i > 0) out.push('>');
    p.forEach((l, j) => out.push(`> ${i === 0 && j === 0 ? `${label} ${l.trim()}` : l}`));
  });
  if (a.method === 'extracts' && !a.sources.length) out[out.length - 1] += ' aucun passage du cours ne s’en approche.';
  for (const s of a.sources) {
    out.push('>', `> **${SOURCE_LABELS[s.kind]} — ${s.ref}**`);
    if (s.quote.trim()) out.push(`> « ${flat(s.quote)} »`);
  }
  if (a.note) out.push('>', `> *${flat(a.note)}*`);
  return out;
}

/** The block with this answer, in place of the one it had (from its « Réponse » line on). */
export function withAnswer(block: readonly string[], answer: readonly string[]): string[] {
  let end = block.findIndex((l, i) => i > 0 && ANSWER_START.test(l));
  if (end === -1) end = block.length;
  // The empty line before the old answer goes with it.
  while (end > 1 && unquote(block[end - 1]).trim() === '') end--;
  return [...block.slice(0, end), ...answer];
}

/** A free note or a question: no timestamp added to what is typed in it. */
export function inBlock(lines: readonly string[], n: number): boolean {
  const c = calloutAt(lines, n);
  return c !== null && c.kind !== 'other';
}
