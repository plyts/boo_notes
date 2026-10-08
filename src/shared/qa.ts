import type { AnswerSource } from './callouts';
import { textFragmentUrl, timestampToken } from './markdown';
import { formatTimecode } from './time';
import type { Cue } from './transcript';

/**
 * Answers to the questions of a note, from the course: its transcript, the
 * text of its page (and of its frames: SCORM modules), and the notes already
 * taken. Pure functions: cutting the sources into passages, ranking them for
 * a question (BM25), the request made to the AI and reading its answer.
 */

export type PassageKind = AnswerSource['kind'];

export interface Passage {
  /** `T3` (transcript), `P2` (page), `N5` (notes): how the AI cites it. */
  id: string;
  kind: PassageKind;
  /** What is searched (a subtitle and its translation). */
  text: string;
  /** What is quoted. */
  display: string;
  /** Transcript: start / end of the passage (seconds); a note line: its timestamp. */
  start?: number;
  end?: number;
  /** Transcript: its subtitles (and their translation), to point at the one quoted. */
  cues?: Array<{ start: number; text: string; tr?: string }>;
  /** Where it is, written in the note: `[23:41]`, `[↗ Section](URL#:~:text=…)`, `[[Titre]]`… */
  ref: string;
  /** Section of the page, title of the note. */
  where?: string;
}

// --- Words --------------------------------------------------------------------------

const STOP = new Set(
  (
    'le la les l un une des du de d au aux a à et ou où en dans sur sous par pour avec sans ce cet cette ces c ça cela ceci qui que qu quoi dont ' +
    'est sont été être etre ai as avons avez ont avait fait faire il ils elle elles on nous vous je j tu te se s me m ne n pas plus moins très tres ' +
    'son sa ses leur leurs mon ma mes ton ta tes notre nos votre vos y si alors donc car mais comme quand comment pourquoi quel quelle quels quelles ' +
    'lequel laquelle est-ce-que ici là cas cette-ci tout tous toute toutes même aussi bien peut peuvent doit va vont entre après avant ' +
    'the a an and or of to in on at by for with without from is are was were be been being it its this that these those what which who whom why how ' +
    'when where do does did can could should would will shall may might must not no yes as if than then so such there here into about over under ' +
    'we you they he she i me my our your their his her them us let lets just also very more most some any each other only own same too'
  ).split(' '),
);

function stem(t: string): string {
  if (t.length > 4 && /(?:s|x)$/.test(t)) return t.slice(0, -1);
  return t;
}

/** Search words of a text: lower case, no accents, no small words, plurals folded. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

// --- Passages -----------------------------------------------------------------------

/** The transcript in passages of a few sentences (about 40 s or 90 words). */
export function transcriptPassages(cues: readonly Cue[], opts: { seconds?: number; words?: number } = {}): Passage[] {
  const maxSeconds = opts.seconds ?? 40;
  const maxWords = opts.words ?? 90;
  const out: Passage[] = [];
  let group: Cue[] = [];
  let count = 0;
  const flush = () => {
    if (!group.length) return;
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const display = group.map((c) => c.text).join(' ');
    const translated = group.map((c) => c.tr ?? '').join(' ');
    out.push({
      id: `T${out.length + 1}`,
      kind: 'transcript',
      text: `${display} ${translated}`.trim(),
      display,
      start,
      end,
      cues: group.map((c) => ({ start: c.start, text: c.text, ...(c.tr ? { tr: c.tr } : {}) })),
      ref: timestampToken(start),
    });
    group = [];
    count = 0;
  };
  for (const c of cues) {
    if (!c.text.trim()) continue;
    const n = c.text.split(/\s+/).length;
    if (group.length && (c.start - group[0].start > maxSeconds || count + n > maxWords)) flush();
    group.push(c);
    count += n;
  }
  flush();
  return out;
}

export interface PageSection {
  /** Heading of the section (may be empty). */
  heading: string;
  text: string;
}

/** The page's text in passages (about 120 words), each linked to its place in the page. */
export function pagePassages(sections: readonly PageSection[], url: string, first = 1): Passage[] {
  const out: Passage[] = [];
  for (const s of sections) {
    const sentences = s.text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…:;])\s+/);
    let chunk: string[] = [];
    let count = 0;
    const flush = () => {
      const display = chunk.join(' ').trim();
      if (display.length >= 20) {
        const lead = display.split(' ').slice(0, 8).join(' ');
        const label = clip((s.heading || lead).replace(/[[\]]/g, ''), 60);
        out.push({
          id: `P${first + out.length}`,
          kind: 'page',
          text: `${s.heading} ${display}`.trim(),
          display,
          ref: `[↗ ${label}](${textFragmentUrl(url, lead)})`,
          where: s.heading || undefined,
        });
      }
      chunk = [];
      count = 0;
    };
    for (const sentence of sentences) {
      const n = sentence.split(' ').length;
      if (chunk.length && count + n > 120) flush();
      chunk.push(sentence);
      count += n;
    }
    flush();
  }
  return out;
}

export interface NoteSource {
  /** Title of the note; null for the note being written. */
  title: string | null;
  lines: readonly string[];
}

const TS = /\[((?:\d+:)?\d{1,3}:\d{2})\](?:\([^()\s]*\))?/;
/** Lines that say nothing to search: pictures, attachments, callout headers, the answers. */
const SKIP_LINE = /^\s*(?:(?:\[[^\]]*\]\s*)?!\[|📄 \[|>\s?\[!|---\s*$)/;

/**
 * The notes already taken, in passages (a line, or a paragraph): those of
 * this note (questions and their answers left out) and of the other notes of
 * the course.
 */
export function notePassages(notes: readonly NoteSource[], skip: (note: number, line: number) => boolean, first = 1): Passage[] {
  const out: Passage[] = [];
  notes.forEach((note, ni) => {
    note.lines.forEach((raw, li) => {
      if (skip(ni, li) || SKIP_LINE.test(raw)) return;
      const line = raw.replace(/^(?:>\s?)+/, '').replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+)/, '');
      const stamp = TS.exec(line);
      const display = line
        .replace(/\[([^\]\n]*)\]\([^()\s]*\)/g, '$1')
        .replace(/\[((?:\d+:)?\d{1,3}:\d{2})\]/g, '')
        .replace(/[*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (display.length < 12) return;
      const seconds = stamp && note.title === null ? parseClock(stamp[1]) : null;
      out.push({
        id: `N${first + out.length}`,
        kind: 'note',
        text: display,
        display,
        ...(seconds !== null ? { start: seconds } : {}),
        ref: note.title !== null ? `[[${note.title.replace(/[[\]|]/g, '')}]]` : seconds !== null ? timestampToken(seconds) : 'cette note',
        where: note.title ?? undefined,
      });
    });
  });
  return out;
}

function parseClock(tc: string): number {
  return tc.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

// --- Ranking (BM25) ------------------------------------------------------------------

const KIND_WEIGHT: Record<PassageKind, number> = { transcript: 1, page: 0.92, note: 0.8 };

export interface Ranked {
  passage: Passage;
  score: number;
}

/**
 * Passages ranked for a question. `stamp`: the moment it was asked — what was
 * said just before counts a little more. `extra`: more words to look for
 * (the question translated into the language of the course).
 */
export function rank(question: string, passages: readonly Passage[], opts: { stamp?: number | null; extra?: string } = {}): Ranked[] {
  const query = [...new Set([...words(question), ...words(opts.extra ?? '')])];
  if (!query.length || !passages.length) return [];
  const docs = passages.map((p) => words(p.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const out: Ranked[] = [];
  passages.forEach((p, i) => {
    const d = docs[i];
    if (!d.length) return;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    let matched = 0;
    for (const q of query) {
      const f = tf.get(q);
      if (!f) continue;
      matched++;
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (passages.length - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }
    if (score <= 0) return;
    // More of the question's words: a better match than one word said often.
    score *= 1 + matched / query.length;
    score *= KIND_WEIGHT[p.kind];
    const stamp = opts.stamp;
    if (stamp != null && p.kind === 'transcript' && p.start !== undefined) {
      const before = stamp - p.start;
      if (before >= 0 && before <= 240) score *= 1 + 0.4 * (1 - before / 240);
      else if (before < 0) score *= 1 + 0.15 * Math.exp(before / 60);
    }
    out.push({ passage: p, score });
  });
  return out.sort((a, b) => b.score - a.score);
}

/** The closest passages, when no AI writes the answer: the best, and those nearly as good. */
export function extracts(ranked: readonly Ranked[], max = 3): Passage[] {
  if (!ranked.length) return [];
  const best = ranked[0].score;
  return ranked.filter((r) => r.score >= best * 0.4).slice(0, max).map((r) => r.passage);
}

/**
 * An answer source for a passage: its reference and the words quoted (a
 * subtitle pinned to its instant). Without a quote, the part of the passage
 * closest to `question`: its best subtitle or sentence.
 */
export function sourceOf(p: Passage, quote?: string | null, question?: string): AnswerSource {
  const q = quote && contains(p.text, quote) ? quote.trim() : question ? closestPart(p, question) : clip(p.display, 280);
  if (p.kind === 'transcript' && p.cues?.length) return { kind: p.kind, ref: timestampToken(quotedAt(p.cues, q) ?? p.start ?? 0), quote: q };
  return { kind: p.kind, ref: p.ref, quote: q };
}

/** The subtitle (or sentence) of a passage saying most of the question's words, and the next one when it is short. */
function closestPart(p: Passage, question: string): string {
  const query = new Set(words(question));
  const parts =
    p.kind === 'transcript' && p.cues?.length
      ? p.cues.map((c) => ({ text: c.text, search: `${c.text} ${c.tr ?? ''}` }))
      : p.display.split(/(?<=[.!?…])\s+/).map((s) => ({ text: s, search: s }));
  let best = 0;
  let bestScore = 0;
  parts.forEach((part, i) => {
    const score = new Set(words(part.search).filter((w) => query.has(w))).size;
    if (score > bestScore) [best, bestScore] = [i, score];
  });
  if (!bestScore) return clip(p.display, 280);
  let text = parts[best].text.trim();
  if (text.length < 80 && parts[best + 1]) text = `${text} ${parts[best + 1].text.trim()}`;
  return clip(text, 280);
}

/** Instant of the subtitle where the quoted words start (a quote may run over several subtitles). */
function quotedAt(cues: ReadonlyArray<{ start: number; text: string }>, quote: string): number | null {
  const lead = words(quote).slice(0, 3);
  if (!lead.length) return null;
  const all: Array<{ w: string; start: number }> = [];
  for (const c of cues) for (const w of words(c.text)) all.push({ w, start: c.start });
  for (let i = 0; i + lead.length <= all.length; i++) {
    if (lead.every((w, j) => all[i + j].w === w)) return all[i].start;
  }
  return null;
}

function contains(text: string, quote: string): boolean {
  const norm = (s: string) => words(s).join(' ');
  const q = norm(quote);
  return q.length > 0 && norm(text).includes(q);
}

// --- The AI ---------------------------------------------------------------------------

/**
 * Passages given to the AI: all of them while they fit, else the best ranked
 * (with the transcript around them), back in the order of the course.
 */
export function forPrompt(all: readonly Passage[], ranked: readonly Ranked[], budget = 120_000): Passage[] {
  const size = (p: Passage) => p.display.length + 40;
  const total = all.reduce((n, p) => n + size(p), 0);
  if (total <= budget) return [...all];
  const keep = new Set<Passage>();
  let used = 0;
  const take = (p: Passage | undefined) => {
    if (!p || keep.has(p) || used + size(p) > budget) return;
    keep.add(p);
    used += size(p);
  };
  const transcript = all.filter((p) => p.kind === 'transcript');
  for (const r of ranked) {
    if (used >= budget) break;
    const i = transcript.indexOf(r.passage);
    take(r.passage);
    if (i !== -1) {
      take(transcript[i - 1]);
      take(transcript[i + 1]);
    }
  }
  return all.filter((p) => keep.has(p));
}

export interface Prompt {
  system: string;
  user: string;
}

/**
 * The request to the AI. `lang`: the language it answers in — French (the
 * question's, as asked), or English for a model that writes only English
 * (the answer is translated afterwards).
 */
export function buildPrompt(question: string, passages: readonly Passage[], ctx: { title: string; stamp: number | null; lang?: 'fr' | 'en' }): Prompt {
  const en = ctx.lang === 'en';
  const system = (
    en
      ? [
          'You are the study assistant of Boo Notes. A student follows a course and asks a question in their notes.',
          'Answer only from the course excerpts given: the video transcript (T…), the text of the course page (P…), the student’s notes (N…). Prefer the transcript, then the course text, then the notes.',
          'Answer in English, clearly and briefly (2 to 4 sentences): only the answer, no preamble.',
          'If the excerpts do not answer the question, say so in one sentence and set "found" to false: never invent.',
          'Reply with one JSON object only: {"answer": "…", "found": true, "sources": [{"id": "T12", "quote": "sentence copied word for word from the excerpt"}]}.',
          'Cite 1 to 3 sources, the most useful, each with a short quote (under 40 words) copied exactly from the excerpt.',
        ]
      : [
          'Tu es l’assistant d’étude de Boo Notes. Un étudiant suit un cours et pose une question dans ses notes.',
          'Réponds uniquement à partir des extraits du cours fournis : la transcription de la vidéo (T…), le texte de la page du cours (P…), les notes de l’étudiant (N…). Privilégie la transcription, puis le texte du cours, puis les notes.',
          'Réponds dans la langue de la question, clairement et brièvement (2 à 4 phrases) : la réponse seule, sans préambule ni formule de politesse.',
          'Si les extraits ne permettent pas de répondre, dis-le en une phrase et mets "found" à false : n’invente rien.',
          'Réponds par un seul objet JSON, sans texte autour : {"answer": "…", "found": true, "sources": [{"id": "T12", "quote": "phrase recopiée mot pour mot de l’extrait"}]}.',
          'Cite 1 à 3 sources, les plus utiles, avec une citation courte (moins de 40 mots) recopiée exactement de l’extrait.',
        ]
  ).join('\n');
  const lines = passages.map((p) => {
    if (p.kind === 'transcript') return `[${p.id}] ${formatTimecode(p.start ?? 0)}–${formatTimecode(p.end ?? p.start ?? 0)} : ${p.display}`;
    if (p.kind === 'page') return `[${p.id}]${p.where ? (en ? ` (section “${p.where}”)` : ` (section « ${p.where} »)`) : ''} : ${p.display}`;
    return `[${p.id}]${p.where ? (en ? ` (note “${p.where}”)` : ` (note « ${p.where} »)`) : en ? ' (this note)' : ' (cette note)'} : ${p.display}`;
  });
  const user = [
    en ? `Course: ${ctx.title || 'untitled'}` : `Cours : ${ctx.title || 'sans titre'}`,
    ctx.stamp !== null ? (en ? `Question asked at ${formatTimecode(ctx.stamp)} of the video.` : `Question posée à ${formatTimecode(ctx.stamp)} de la vidéo.`) : '',
    en ? `Question: ${question}` : `Question : ${question}`,
    '',
    en ? 'Course excerpts:' : 'Extraits du cours :',
    lines.length ? lines.join('\n') : en ? '(no excerpt available)' : '(aucun extrait disponible)',
  ]
    .filter((l, i) => l !== '' || i === 3)
    .join('\n');
  return { system, user };
}

export interface ParsedAnswer {
  answer: string;
  found: boolean;
  sources: AnswerSource[];
}

/** The AI's reply read: its answer, and the passages it cites (those it was given only). */
export function parseAnswer(reply: string, passages: readonly Passage[]): ParsedAnswer {
  const byId = new Map(passages.map((p) => [p.id, p]));
  type Reply = { answer?: unknown; found?: unknown; sources?: unknown };
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  const data = ((): Reply | null => {
    if (start === -1 || end <= start) return null;
    try {
      const v: unknown = JSON.parse(reply.slice(start, end + 1));
      return v && typeof v === 'object' ? (v as Reply) : null;
    } catch {
      return null;
    }
  })();
  if (!data || typeof data.answer !== 'string') return { answer: reply.trim(), found: reply.trim().length > 0, sources: [] };
  const sources: AnswerSource[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(data.sources) ? data.sources : []) {
    const id = typeof s === 'string' ? s : typeof (s as { id?: unknown })?.id === 'string' ? (s as { id: string }).id : null;
    const p = id ? byId.get(id.replace(/[[\]\s]/g, '')) : undefined;
    if (!p || seen.has(p.id) || sources.length >= 4) continue;
    seen.add(p.id);
    const quote = typeof (s as { quote?: unknown })?.quote === 'string' ? (s as { quote: string }).quote : null;
    sources.push(sourceOf(p, quote));
  }
  return { answer: data.answer.trim(), found: data.found !== false, sources };
}
