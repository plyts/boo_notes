import { timestampToken } from './markdown';
import { formatTimecode } from './time';
import type { Cue, Transcript } from './transcript';

/**
 * The summary of a lesson, and of a whole course, from its transcripts:
 * its problem (« problématique »), its goals, its solution, and the course
 * laid out as a hierarchy (parts › points › details), each idea with the
 * moments of the video it comes from.
 *
 * The AI reads the whole transcript: in one request when it fits what the
 * model takes, else part by part (each part's outline and key sentences),
 * then those notes are merged. Every moment it cites is a line it was given
 * (`c12`): a moment that does not exist is dropped, never shown.
 *
 * Pure functions: the lines of a transcript, the parts, the requests and
 * the reading of the replies, the Markdown written into a note.
 */

// --- Model -------------------------------------------------------------------------------

/** A sentence and the moments (seconds) it comes from. */
export interface Cited {
  text: string;
  at: number[];
}

export interface PlanNode {
  title: string;
  /** Where it begins in the video (s), null when unknown. */
  at: number | null;
  children: PlanNode[];
}

/** What a summary was made from: told when the transcript has changed since. */
export interface Basis {
  cues: number;
  /** End of the last subtitle (s). */
  until: number;
  complete: boolean;
  /** Seconds of the media the subtitles cover. */
  covered: number;
  duration: number;
  lang: string;
  label: string;
}

export interface LessonSummary {
  noteId: string;
  title: string;
  problem: Cited;
  goals: Cited[];
  solution: Cited;
  plan: PlanNode[];
  basis: Basis;
  /** Who wrote it (`groq`, `chrome`…) and with which model. */
  provider: string;
  model: string;
  createdAt: number;
  /** Read in this many parts (1: in one go). */
  parts: number;
}

export interface CourseLessonRef {
  noteId: string;
  title: string;
  url: string;
  chapter: string;
  /** Length of the video (s), 0 when unknown. */
  duration: number;
  synthesis: string;
  /** `done`: summarised; `none`: no transcript; `partial`: summarised from part of the video. */
  state: 'done' | 'none' | 'partial';
}

export interface CourseSummary {
  course: string;
  problem: string;
  goals: Array<{ text: string; chapter: number | null }>;
  solution: string;
  chapters: Array<{ title: string; synthesis: string; lessons: CourseLessonRef[] }>;
  /** Each lesson's transcript as it was read (`basisKey`): a lesson changed since is « à mettre à jour ». */
  read: Record<string, string>;
  /** The course synthesis was written from the transcripts themselves (they fit), not only the lessons' summaries. */
  full: boolean;
  provider: string;
  model: string;
  createdAt: number;
}

export const summaryKey = (noteId: string) => `summary:${noteId}`;
export const courseSummaryKey = (normalizedCourse: string) => `course-summary:${normalizedCourse}`;

// --- What the summary is made from ----------------------------------------------------------

function coveredSeconds(t: Transcript): number {
  if (t.complete) return t.duration || (t.cues.at(-1)?.end ?? 0);
  return (t.covered ?? []).reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
}

export function basisOf(t: Transcript): Basis {
  return {
    cues: t.cues.length,
    until: Math.round(t.cues.at(-1)?.end ?? 0),
    complete: t.complete,
    covered: Math.round(coveredSeconds(t)),
    duration: Math.round(t.duration || (t.cues.at(-1)?.end ?? 0)),
    lang: t.lang,
    label: t.label,
  };
}

/** A short key for a transcript as read (the same transcript: the same key). */
export function basisKey(b: Basis): string {
  return `${b.cues}:${b.until}:${b.complete ? 1 : 0}`;
}

/** The transcript changed since the summary: more (or other) subtitles. */
export function isStale(summary: { basis: Basis }, t: Transcript | null): boolean {
  if (!t?.cues.length) return false;
  return basisKey(basisOf(t)) !== basisKey(summary.basis);
}

/**
 * How much of the video the transcript covers: `full` (a subtitles file, or
 * nearly all of it watched), `partial` (subtitles caught while watching),
 * `none`.
 */
export function coverage(t: Transcript | null): { state: 'full' | 'partial' | 'none'; covered: number; duration: number } {
  if (!t?.cues.length) return { state: 'none', covered: 0, duration: t?.duration ?? 0 };
  const covered = coveredSeconds(t);
  const duration = t.duration || (t.cues.at(-1)?.end ?? 0);
  if (t.complete || !duration || covered >= duration * 0.9) return { state: 'full', covered: duration || covered, duration };
  return { state: 'partial', covered, duration };
}

// --- Lines and parts -------------------------------------------------------------------------

/** A line the AI reads and cites (`c12`): a few subtitles together, its moment the first one's. */
export interface Line {
  id: string;
  at: number;
  text: string;
}

/**
 * The transcript as lines: subtitles joined until about a sentence (60
 * characters or 10 s, never more than 25 s): fewer ids, the same moments.
 */
export function linesOf(cues: readonly Cue[]): Line[] {
  const out: Line[] = [];
  let text = '';
  let start = 0;
  let last = 0;
  const flush = () => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) out.push({ id: `c${out.length}`, at: start, text: t });
    text = '';
  };
  for (const c of cues) {
    const t = c.text.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (text && (c.start - start >= 25 || ((text.length >= 60 || c.start - start >= 10) && /[.!?…]["»”)]?$/.test(text)) || text.length >= 220)) flush();
    if (!text) start = c.start;
    text = text ? `${text} ${t}` : t;
    last = c.end;
  }
  flush();
  void last;
  return out;
}

const lineText = (l: Line) => `[${l.id} ${formatTimecode(l.at)}] ${l.text}`;
const lineSize = (l: Line) => lineText(l).length + 1;

/** The lines in parts of at most `budget` characters, in order. */
export function partsOf(lines: readonly Line[], budget: number): Line[][] {
  const parts: Line[][] = [];
  let part: Line[] = [];
  let size = 0;
  for (const l of lines) {
    const s = lineSize(l);
    if (part.length && size + s > budget) {
      parts.push(part);
      part = [];
      size = 0;
    }
    part.push(l);
    size += s;
  }
  if (part.length) parts.push(part);
  return parts;
}

export function linesSize(lines: readonly Line[]): number {
  return lines.reduce((n, l) => n + lineSize(l), 0);
}

// --- Requests -------------------------------------------------------------------------------

export interface Prompt {
  system: string;
  user: string;
}

export interface LessonContext {
  title: string;
  course?: string | null;
  chapter?: string | null;
  /** Length of the video (s). */
  duration: number;
  /** Only part of the video has subtitles. */
  partial?: boolean;
}

const RULES = [
  'Uniquement ce que dit le cours : n’invente rien, n’ajoute aucune connaissance extérieure.',
  'Chaque idée cite les répliques où elle est dite, par leur identifiant (c12…) recopié tel quel.',
  'Problématique : 1 à 3 phrases, le problème que la leçon traite, terminées par la question centrale à laquelle elle répond.',
  'Objectifs : 2 à 5, ce que l’étudiant saura faire ou comprendre, chacun commençant par un verbe à l’infinitif.',
  'Solution : 2 à 4 phrases, la réponse ou la méthode que la leçon apporte au problème.',
  'Plan : le cours hiérarchisé dans l’ordre de la vidéo — 2 à 7 parties, chacune avec 1 à 4 points, un point pouvant avoir 1 à 3 détails ; titres courts (10 mots au plus), chacun avec la réplique où il commence.',
  'Écris en français même si la transcription est dans une autre langue ; garde les termes techniques d’origine.',
];

const LESSON_JSON =
  '{"problem":{"text":"…","refs":["c3"]},"goals":[{"text":"…","refs":["c10"]}],"solution":{"text":"…","refs":["c20","c31"]},"plan":[{"title":"…","ref":"c0","children":[{"title":"…","ref":"c4","children":[{"title":"…","ref":"c6"}]}]}]}';

function head(ctx: LessonContext): string[] {
  return [
    `Leçon : ${ctx.title || 'sans titre'}`,
    ctx.course ? `Cours : ${ctx.course}${ctx.chapter ? ` › ${ctx.chapter}` : ''}` : '',
    ctx.duration ? `Durée de la vidéo : ${formatTimecode(ctx.duration)}` : '',
    ctx.partial ? 'Attention : seule une partie de la vidéo a des sous-titres ; résume cette partie.' : '',
  ].filter(Boolean);
}

/** The whole transcript in one request: the lesson's summary. */
export function lessonPrompt(ctx: LessonContext, lines: readonly Line[]): Prompt {
  const system = [
    'Tu es l’assistant d’étude de Boo Notes. À partir de la transcription d’une leçon (une vidéo de cours), tu écris sa synthèse en français pour un étudiant.',
    'Règles :',
    ...RULES.map((r) => `- ${r}`),
    `Réponds par un seul objet JSON, sans texte autour : ${LESSON_JSON}`,
  ].join('\n');
  const user = [...head(ctx), '', 'Transcription (chaque réplique : [identifiant instant] texte) :', ...lines.map(lineText)].join('\n');
  return { system, user };
}

/** One part of a long transcript: its outline and its key sentences. */
export function partPrompt(ctx: LessonContext, part: readonly Line[], k: number, n: number): Prompt {
  const system = [
    'Tu aides à résumer une longue leçon, lue par parties. Uniquement d’après l’extrait donné, en français :',
    '- "sections" : les parties du cours dans cet extrait, dans l’ordre (titre court, réplique où elle commence), avec leurs points (1 à 4 : titre court, réplique) ;',
    '- "ideas" : les phrases clés où l’orateur pose le problème (kind "problem"), annonce un objectif ("goal") ou donne la solution ou la méthode ("solution") — une phrase chacune, en français, avec sa réplique.',
    'Cite les répliques par leur identifiant (c12…) recopié tel quel. N’invente rien.',
    'Réponds par un seul objet JSON, sans texte autour : {"sections":[{"title":"…","ref":"c0","points":[{"title":"…","ref":"c2"}]}],"ideas":[{"kind":"problem","text":"…","ref":"c1"}]}',
  ].join('\n');
  const from = formatTimecode(part[0]?.at ?? 0);
  const to = formatTimecode(part.at(-1)?.at ?? 0);
  const user = [...head(ctx), '', `Partie ${k} sur ${n} de la transcription (${from}–${to}) :`, ...part.map(lineText)].join('\n');
  return { system, user };
}

export interface PartDigest {
  sections: Array<{ title: string; ref: string; points: Array<{ title: string; ref: string }> }>;
  ideas: Array<{ kind: 'problem' | 'goal' | 'solution'; text: string; ref: string }>;
}

/** The notes of every part, merged into the lesson's summary. */
export function mergePrompt(ctx: LessonContext, digests: readonly PartDigest[], lines: readonly Line[]): Prompt {
  const at = new Map(lines.map((l) => [l.id, l.at]));
  const stamp = (ref: string) => `[${ref} ${formatTimecode(at.get(ref) ?? 0)}]`;
  const system = [
    'Tu es l’assistant d’étude de Boo Notes. Une leçon a été lue par parties : voici, pour chacune, son plan et ses phrases clés, avec les répliques d’où ils viennent.',
    'Écris la synthèse de la leçon entière, en français.',
    'Règles :',
    ...RULES.map((r) => `- ${r}`),
    '- Ne cite que des répliques présentes dans ces notes ; réunis les parties qui se suivent sur le même sujet.',
    `Réponds par un seul objet JSON, sans texte autour : ${LESSON_JSON}`,
  ].join('\n');
  const body: string[] = [];
  digests.forEach((d, i) => {
    body.push('', `Partie ${i + 1} :`);
    for (const s of d.sections) {
      body.push(`- ${stamp(s.ref)} ${s.title}`);
      for (const p of s.points) body.push(`  - ${stamp(p.ref)} ${p.title}`);
    }
    for (const idea of d.ideas) body.push(`- Phrase clé (${idea.kind === 'problem' ? 'problème' : idea.kind === 'goal' ? 'objectif' : 'solution'}) ${stamp(idea.ref)} : ${idea.text}`);
  });
  return { system, user: [...head(ctx), '', 'Notes de lecture :', ...body].join('\n') };
}

// --- Course ---------------------------------------------------------------------------------

export interface CourseLessonInput {
  /** `L3`: how the AI names it. */
  id: string;
  noteId: string;
  title: string;
  chapter: string;
  duration: number;
  summary: LessonSummary | null;
  /** Its transcript (lines), when the whole course fits in one request. */
  lines?: readonly Line[];
}

function lessonDigest(s: LessonSummary): string[] {
  const out = [`Problématique : ${s.problem.text}`, `Objectifs : ${s.goals.map((g) => g.text).join(' ; ')}`, `Solution : ${s.solution.text}`, 'Plan :'];
  const walk = (nodes: readonly PlanNode[], depth: number) => {
    for (const n of nodes) {
      out.push(`${'  '.repeat(depth)}- ${n.title}`);
      if (depth < 1) walk(n.children, depth + 1);
    }
  };
  walk(s.plan, 0);
  return out;
}

/**
 * The course's synthesis: its chapters and lessons, each lesson's summary
 * (made from its whole transcript) — and the transcripts themselves when
 * they fit what the model reads in one request (`withTranscripts`).
 */
export function coursePrompt(course: string, chapters: readonly string[], lessons: readonly CourseLessonInput[], withTranscripts: boolean): Prompt {
  const system = [
    `Tu es l’assistant d’étude de Boo Notes. Voici un cours entier : ses chapitres, ses leçons, et pour chaque leçon sa synthèse, faite d’après toute sa transcription${withTranscripts ? ', puis sa transcription complète' : ''}.`,
    'Écris la synthèse du cours entier, en français :',
    '- "problem" : 1 à 3 phrases, la problématique générale du cours, terminées par la question centrale à laquelle il répond ;',
    '- "goals" : 3 à 6 objectifs du cours (verbe à l’infinitif), chacun avec le numéro du chapitre qui le traite ("chapter": "2") ;',
    '- "solution" : 2 à 4 phrases, la démarche ou la solution que le cours construit, de chapitre en chapitre ;',
    '- "chapters" : pour chaque chapitre (son numéro), une phrase qui dit ce qu’il apporte ;',
    '- "lessons" : pour chaque leçon (son identifiant L1…), une phrase qui la résume.',
    'Uniquement ce que dit le cours : n’invente rien. Garde les termes techniques d’origine.',
    'Réponds par un seul objet JSON, sans texte autour : {"problem":"…","goals":[{"text":"…","chapter":"1"}],"solution":"…","chapters":[{"id":"1","synthesis":"…"}],"lessons":[{"id":"L1","synthesis":"…"}]}',
  ].join('\n');
  const body: string[] = [`Cours : ${course}`];
  chapters.forEach((chapter, i) => {
    body.push('', `## Chapitre ${i + 1} · ${chapter}`);
    for (const l of lessons.filter((x) => x.chapter === chapter)) {
      body.push('', `### ${l.id} · ${l.title}${l.duration ? ` (${formatTimecode(l.duration)})` : ''}`);
      if (l.summary) body.push(...lessonDigest(l.summary));
      else body.push('(pas de transcription)');
      if (withTranscripts && l.lines?.length) body.push('Transcription :', l.lines.map((x) => x.text).join(' '));
    }
  });
  return { system, user: body.join('\n') };
}

// --- Replies ---------------------------------------------------------------------------------

export class SummaryError extends Error {}

/** The JSON object of a reply (text around it, a fence, trailing commas forgiven). */
export function jsonOf(reply: string): Record<string, unknown> {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) throw new SummaryError('réponse de l’IA illisible (pas de JSON)');
  const raw = reply.slice(start, end + 1);
  for (const text of [raw, raw.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const v: unknown = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // The next way.
    }
  }
  throw new SummaryError('réponse de l’IA illisible (JSON invalide)');
}

const textOf = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** `c12`, `[c12]`, `c12 05:42`: the line's id. */
const refId = (v: unknown): string | null => (typeof v === 'string' ? (/\bc\d+\b/.exec(v)?.[0] ?? null) : null);

function citedOf(v: unknown, at: ReadonlyMap<string, number>): Cited {
  const o = (v && typeof v === 'object' ? v : { text: v }) as { text?: unknown; refs?: unknown; ref?: unknown };
  const refs = [...listOf(o.refs), o.ref].map(refId).filter((r): r is string => r !== null && at.has(r));
  const times = [...new Set(refs.map((r) => at.get(r)!))].sort((a, b) => a - b).slice(0, 3);
  return { text: textOf(o.text), at: times };
}

function planOf(v: unknown, at: ReadonlyMap<string, number>, depth = 0): PlanNode[] {
  if (depth > 2) return [];
  const out: PlanNode[] = [];
  for (const item of listOf(v)) {
    const o = (item && typeof item === 'object' ? item : { title: item }) as { title?: unknown; ref?: unknown; children?: unknown; points?: unknown };
    const title = textOf(o.title);
    if (!title) continue;
    const children = planOf(o.children ?? o.points, at, depth + 1);
    const ref = refId(o.ref);
    let when = ref && at.has(ref) ? at.get(ref)! : null;
    // Its first child's moment, when it has none of its own.
    if (when === null) when = children.find((c) => c.at !== null)?.at ?? null;
    out.push({ title, at: when, children });
  }
  // In the order of the video (the parts the model put out of order).
  if (depth === 0 && out.every((n) => n.at !== null)) out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return out;
}

export type LessonDraft = Pick<LessonSummary, 'problem' | 'goals' | 'solution' | 'plan'>;

/** The lesson's summary read from the reply; moments that are not lines of the transcript dropped. */
export function parseLesson(reply: string, lines: readonly Line[]): LessonDraft {
  const data = jsonOf(reply);
  const at = new Map(lines.map((l) => [l.id, l.at]));
  const problem = citedOf(data.problem, at);
  const goals = listOf(data.goals)
    .map((g) => citedOf(g, at))
    .filter((g) => g.text)
    .slice(0, 6);
  const solution = citedOf(data.solution, at);
  const plan = planOf(data.plan, at);
  if (!problem.text && !solution.text && !plan.length) throw new SummaryError('l’IA n’a rien résumé');
  return { problem, goals, solution, plan };
}

export function parsePart(reply: string, lines: readonly Line[]): PartDigest {
  const data = jsonOf(reply);
  const ids = new Set(lines.map((l) => l.id));
  const ok = (r: string | null): r is string => r !== null && ids.has(r);
  const sections: PartDigest['sections'] = [];
  for (const s of listOf(data.sections)) {
    const o = (s ?? {}) as { title?: unknown; ref?: unknown; points?: unknown };
    const title = textOf(o.title);
    const ref = refId(o.ref);
    const points = listOf(o.points)
      .map((p) => ({ title: textOf((p as { title?: unknown })?.title ?? p), ref: refId((p as { ref?: unknown })?.ref) }))
      .filter((p): p is { title: string; ref: string } => Boolean(p.title) && ok(p.ref));
    if (title && ok(ref)) sections.push({ title, ref, points });
    else if (points.length) sections.push({ title: title || points[0].title, ref: points[0].ref, points });
  }
  const ideas: PartDigest['ideas'] = [];
  for (const i of listOf(data.ideas)) {
    const o = (i ?? {}) as { kind?: unknown; text?: unknown; ref?: unknown };
    const kind = o.kind === 'problem' || o.kind === 'goal' || o.kind === 'solution' ? o.kind : null;
    const ref = refId(o.ref);
    const text = textOf(o.text);
    if (kind && text && ok(ref)) ideas.push({ kind, text, ref });
  }
  return { sections, ideas };
}

export interface CourseDraft {
  problem: string;
  goals: Array<{ text: string; chapter: number | null }>;
  solution: string;
  chapters: Map<number, string>;
  lessons: Map<string, string>;
}

export function parseCourse(reply: string, chapterCount: number): CourseDraft {
  const data = jsonOf(reply);
  const num = (v: unknown): number | null => {
    const n = Number(String(v ?? '').replace(/[^\d]/g, ''));
    return Number.isInteger(n) && n >= 1 && n <= chapterCount ? n : null;
  };
  const problem = textOf((data.problem as { text?: unknown })?.text ?? data.problem);
  const solution = textOf((data.solution as { text?: unknown })?.text ?? data.solution);
  const goals = listOf(data.goals)
    .map((g) => ({ text: textOf((g as { text?: unknown })?.text ?? g), chapter: num((g as { chapter?: unknown })?.chapter) }))
    .filter((g) => g.text)
    .slice(0, 8);
  const chapters = new Map<number, string>();
  for (const c of listOf(data.chapters)) {
    const n = num((c as { id?: unknown })?.id);
    const text = textOf((c as { synthesis?: unknown })?.synthesis);
    if (n !== null && text) chapters.set(n, text);
  }
  const lessons = new Map<string, string>();
  for (const l of listOf(data.lessons)) {
    const id = textOf((l as { id?: unknown })?.id).replace(/[[\]\s]/g, '');
    const text = textOf((l as { synthesis?: unknown })?.synthesis);
    if (/^L\d+$/.test(id) && text) lessons.set(id, text);
  }
  if (!problem && !solution && !goals.length) throw new SummaryError('l’IA n’a rien résumé du cours');
  return { problem, goals, solution, chapters, lessons };
}

// --- Shapes asked of Chrome's built-in AI (its replies are constrained to them) ----------------

const refsSchema = { type: 'array', items: { type: 'string' } };
const cited = { type: 'object', properties: { text: { type: 'string' }, refs: refsSchema }, required: ['text', 'refs'] };
const leaf = { type: 'object', properties: { title: { type: 'string' }, ref: { type: 'string' } }, required: ['title', 'ref'] };
const node = (children: object) => ({ type: 'object', properties: { title: { type: 'string' }, ref: { type: 'string' }, children: { type: 'array', items: children } }, required: ['title', 'ref'] });

export const LESSON_SCHEMA = {
  type: 'object',
  properties: { problem: cited, goals: { type: 'array', items: cited }, solution: cited, plan: { type: 'array', items: node(node(leaf)) } },
  required: ['problem', 'goals', 'solution', 'plan'],
};

export const PART_SCHEMA = {
  type: 'object',
  properties: {
    sections: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, ref: { type: 'string' }, points: { type: 'array', items: leaf } }, required: ['title', 'ref', 'points'] } },
    ideas: {
      type: 'array',
      items: { type: 'object', properties: { kind: { type: 'string', enum: ['problem', 'goal', 'solution'] }, text: { type: 'string' }, ref: { type: 'string' } }, required: ['kind', 'text', 'ref'] },
    },
  },
  required: ['sections', 'ideas'],
};

export const COURSE_SCHEMA = {
  type: 'object',
  properties: {
    problem: { type: 'string' },
    goals: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, chapter: { type: 'string' } }, required: ['text', 'chapter'] } },
    solution: { type: 'string' },
    chapters: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, synthesis: { type: 'string' } }, required: ['id', 'synthesis'] } },
    lessons: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, synthesis: { type: 'string' } }, required: ['id', 'synthesis'] } },
  },
  required: ['problem', 'goals', 'solution', 'chapters', 'lessons'],
};

// --- Written out -------------------------------------------------------------------------------

/** Where the lesson's summary block starts in a note (its header). */
export const SUMMARY_TYPE = 'summary';
export const SUMMARY_TITLE = 'Résumé de la leçon';

const stamps = (at: readonly number[]) => at.map((s) => ` ${timestampToken(s)}`).join('');

/**
 * The lesson's summary as a callout block (Obsidian's syntax: plain Markdown
 * quotes), put at the top of the note: its timestamps are clickable there,
 * and it goes with the note to Notion, the Desktop app, a copy, the PDF.
 */
export function lessonMarkdown(s: Pick<LessonSummary, 'problem' | 'goals' | 'solution' | 'plan'>): string {
  const out = [`> [!${SUMMARY_TYPE}] ${SUMMARY_TITLE} · IA d’après la transcription, à vérifier`];
  if (s.problem.text) out.push(`> **Problématique —** ${s.problem.text}${stamps(s.problem.at.slice(0, 1))}`, '>');
  if (s.goals.length) {
    out.push('> **Objectifs**');
    for (const g of s.goals) out.push(`> - ${g.text}${stamps(g.at.slice(0, 1))}`);
    out.push('>');
  }
  if (s.solution.text) out.push(`> **Solution —** ${s.solution.text}${stamps(s.solution.at.slice(0, 1))}`, '>');
  if (s.plan.length) {
    out.push('> **Plan**');
    const walk = (nodes: readonly PlanNode[], depth: number) => {
      nodes.forEach((n, i) => {
        const marker = depth === 2 ? '-' : `${i + 1}.`;
        out.push(`> ${'   '.repeat(depth)}${marker} ${n.title}${n.at !== null ? ` ${timestampToken(n.at)}` : ''}`);
        walk(n.children, depth + 1);
      });
    };
    walk(s.plan, 0);
  }
  while (out.at(-1) === '>') out.pop();
  return out.join('\n');
}

/** The note with the summary block at its top (an older one replaced). */
export function withSummary(markdown: string, block: string): string {
  const lines = markdown.split('\n');
  let from = -1;
  let to = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^>[ \\t]?\\[!${SUMMARY_TYPE}\\]`, 'i').test(lines[i])) {
      from = i;
      to = i;
      while (to + 1 < lines.length && lines[to + 1].startsWith('>')) to++;
      break;
    }
  }
  if (from !== -1) {
    // Its blank line after it goes too.
    if (lines[to + 1] === '') to++;
    lines.splice(from, to - from + 1);
  }
  const rest = lines.join('\n').replace(/^\n+/, '');
  return rest ? `${block}\n\n${rest}` : `${block}\n`;
}

/** The course's summary as Markdown (to copy elsewhere). */
export function courseMarkdown(s: CourseSummary, plans: ReadonlyMap<string, LessonSummary>): string {
  const out = [`# ${s.course} — résumé du cours`, '', '*Généré par IA d’après les transcriptions — à vérifier.*', ''];
  if (s.problem) out.push('## Problématique', '', s.problem, '');
  if (s.goals.length) {
    out.push('## Objectifs', '');
    for (const g of s.goals) out.push(`- ${g.text}${g.chapter ? ` (chapitre ${g.chapter})` : ''}`);
    out.push('');
  }
  if (s.solution) out.push('## Solution', '', s.solution, '');
  out.push('## Plan du cours', '');
  s.chapters.forEach((c, i) => {
    out.push(`### ${i + 1} · ${c.title}`, '');
    if (c.synthesis) out.push(c.synthesis, '');
    c.lessons.forEach((l, j) => {
      out.push(`${j + 1}. **${l.title}**${l.synthesis ? ` — ${l.synthesis}` : l.state === 'none' ? ' — *pas de transcription*' : ''}`);
      for (const p of plans.get(l.noteId)?.plan ?? []) out.push(`   - ${p.title}${p.at !== null ? ` ${timestampToken(p.at)}` : ''}`);
    });
    out.push('');
  });
  return out.join('\n').trimEnd() + '\n';
}
