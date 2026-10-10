import { AiError, chat } from './ai-client';
import { isRemote, PROVIDERS, providerLabel } from './ai-providers';
import { chromeAiRoom, chromeAiState, promptChromeAi, toFrench, type AiLang } from './chrome-ai';
import { normalizeTitle } from './markdown';
import { accountOf, loadQa, type QaConfig } from './qa-config';
import type { Note, NoteSummary } from './store';
import {
  basisKey,
  basisOf,
  courseMarkdown,
  coursePrompt,
  courseSummaryKey,
  coverage,
  COURSE_SCHEMA,
  LESSON_SCHEMA,
  lessonPrompt,
  linesOf,
  linesSize,
  mergePrompt,
  PART_SCHEMA,
  parseCourse,
  parseLesson,
  parsePart,
  partPrompt,
  partsOf,
  summaryKey,
  SummaryError,
  type CourseLessonInput,
  type CourseSummary,
  type LessonContext,
  type LessonDraft,
  type LessonSummary,
  type Line,
  type PartDigest,
  type Prompt,
} from './summary';
import type { Transcript } from './transcript';
import { TranscriptStore } from './transcript-store';

/**
 * Makes the summaries: picks the AI chosen in the options, reads a lesson's
 * whole transcript (in one request when it fits, else part by part, then
 * merged), and a course's every lesson, then the course as a whole — with
 * the transcripts themselves when the model reads them all in one go.
 * Lessons already summarised from the same transcript are not read again.
 * Runs in an extension page (the panel, the course page).
 */

/** Where a summary stands, for the progress shown. */
export type SummaryStep =
  | { phase: 'read'; k: number; n: number; title?: string }
  | { phase: 'merge'; title?: string }
  | { phase: 'lesson'; k: number; n: number; title: string }
  | { phase: 'course' }
  | { phase: 'wait'; seconds: number };

export interface RunHooks {
  onStep?(step: SummaryStep): void;
  /** A part's outline as soon as it is read (the plan grows while the rest is read). */
  onPart?(digest: PartDigest, k: number, n: number): void;
  signal?: AbortSignal;
}

/** The AI that writes: how much it reads at once, and one request. */
export interface Writer {
  provider: string;
  model: string;
  label: string;
  /** Characters of transcript in one request, besides `system`. */
  budget(system: string): Promise<number>;
  write(prompt: Prompt, schema: object, maxTokens: number, hooks: RunHooks): Promise<string>;
  /** Chrome's model writes English only: its sentences are put in French afterwards. */
  english?: boolean;
}

export class NoWriterError extends Error {}

const TOO_LARGE = /quota|too large|too long|exceed/i;

/** The AI chosen in the options, ready to write — else why not. */
export async function writerFor(qa?: QaConfig): Promise<Writer> {
  const config = qa ?? (await loadQa());
  if (config.provider === 'none') throw new NoWriterError('les résumés demandent une IA : choisissez-en une dans options › IA (plusieurs sont gratuites)');
  if (isRemote(config.provider)) {
    const id = config.provider;
    const account = accountOf(config, id);
    if (!account) throw new NoWriterError(`${PROVIDERS[id].label} n’est pas prêt : ajoutez sa clé (options › IA)`);
    return {
      provider: id,
      model: account.model,
      label: PROVIDERS[id].label,
      budget: async (system) => Math.max(4_000, PROVIDERS[id].budget - system.length),
      write: (prompt, _schema, maxTokens, hooks) =>
        chat({ id, ...account }, { system: prompt.system, user: prompt.user, maxTokens, signal: hooks.signal, onWait: (seconds) => hooks.onStep?.({ phase: 'wait', seconds }) }),
    };
  }
  const ai = await chromeAiState();
  if (ai.state !== 'available' || !ai.lang) {
    throw new NoWriterError(
      ai.state === 'downloadable' || ai.state === 'downloading'
        ? 'l’IA de Chrome n’est pas encore téléchargée (options › IA › Télécharger le modèle), ou choisissez une IA gratuite avec une clé'
        : 'l’IA de Chrome n’est pas disponible sur cet ordinateur : choisissez une IA gratuite (Groq, Gemini, OpenRouter…) dans options › IA',
    );
  }
  const lang: AiLang = ai.lang;
  return {
    provider: 'chrome',
    model: 'Gemini Nano',
    label: providerLabel('chrome'),
    english: lang === 'en',
    budget: (system) => chromeAiRoom(lang, system).then((room) => Math.max(2_000, room - 600)),
    write: async (prompt, schema, _maxTokens, hooks) => {
      try {
        return await promptChromeAi(lang, { system: prompt.system, user: () => prompt.user }, schema, hooks.signal);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new AiError(`l’IA de Chrome n’a pas pu lire ce passage (${message})`, 0, TOO_LARGE.test(message) || (e as { name?: string })?.name === 'QuotaExceededError');
      }
    },
  };
}

/** One request, its reply read; an illegible reply asked again once. */
async function ask<T>(w: Writer, prompt: Prompt, schema: object, maxTokens: number, hooks: RunHooks, read: (reply: string) => T): Promise<T> {
  try {
    return read(await w.write(prompt, schema, maxTokens, hooks));
  } catch (e) {
    if (!(e instanceof SummaryError)) throw e;
    const again = { system: prompt.system, user: `${prompt.user}\n\nRéponds uniquement par l’objet JSON demandé, complet et valide.` };
    return read(await w.write(again, schema, maxTokens, hooks));
  }
}

/** Chrome's model wrote English: its sentences in French with Chrome's translator, when it is ready. */
async function inFrench(w: Writer, d: LessonDraft): Promise<LessonDraft> {
  if (!w.english) return d;
  const fr = async (t: string) => (t ? ((await toFrench(t)) ?? t) : t);
  const plan = async (nodes: LessonDraft['plan']): Promise<LessonDraft['plan']> => Promise.all(nodes.map(async (n) => ({ ...n, title: await fr(n.title), children: await plan(n.children) })));
  return {
    problem: { ...d.problem, text: await fr(d.problem.text) },
    goals: await Promise.all(d.goals.map(async (g) => ({ ...g, text: await fr(g.text) }))),
    solution: { ...d.solution, text: await fr(d.solution.text) },
    plan: await plan(d.plan),
  };
}

/** The lesson read part by part: each part's outline and key sentences, then merged. */
async function byParts(w: Writer, ctx: LessonContext, lines: readonly Line[], budget: number, hooks: RunHooks): Promise<{ draft: LessonDraft; parts: number }> {
  const parts = partsOf(lines, budget);
  const digests: PartDigest[] = [];
  for (const [i, part] of parts.entries()) {
    hooks.onStep?.({ phase: 'read', k: i + 1, n: parts.length, title: ctx.title });
    const digest = await ask(w, partPrompt(ctx, part, i + 1, parts.length), PART_SCHEMA, 1500, hooks, (r) => parsePart(r, part));
    digests.push(digest);
    hooks.onPart?.(digest, i + 1, parts.length);
  }
  hooks.onStep?.({ phase: 'merge', title: ctx.title });
  let merge = mergePrompt(ctx, digests, lines);
  // Very long: the points of each part left out, its sections and key sentences kept.
  if (merge.user.length > budget) merge = mergePrompt(ctx, digests.map((d) => ({ ...d, sections: d.sections.map((s) => ({ ...s, points: s.points.slice(0, 1) })) })), lines);
  const draft = await ask(w, merge, LESSON_SCHEMA, 2500, hooks, (r) => parseLesson(r, lines));
  return { draft, parts: parts.length };
}

export interface LessonInput {
  noteId: string;
  title: string;
  course?: string | null;
  chapter?: string | null;
  transcript: Transcript;
}

/** A lesson's summary, from its whole transcript. */
export async function summarizeLesson(input: LessonInput, w: Writer, hooks: RunHooks = {}): Promise<LessonSummary> {
  const t = input.transcript;
  if (!t.cues.length) throw new SummaryError('pas de transcription à résumer');
  const lines = linesOf(t.cues);
  const cov = coverage(t);
  const ctx: LessonContext = { title: input.title, course: input.course, chapter: input.chapter, duration: cov.duration, partial: cov.state === 'partial' };
  const whole = lessonPrompt(ctx, lines);
  let budget = await w.budget(whole.system);
  const size = linesSize(lines);
  let draft: LessonDraft | null = null;
  let parts = 1;
  if (size <= budget) {
    hooks.onStep?.({ phase: 'read', k: 1, n: 1, title: input.title });
    try {
      draft = await ask(w, whole, LESSON_SCHEMA, 2500, hooks, (r) => parseLesson(r, lines));
    } catch (e) {
      // Too large for this model or its free tier after all: by parts, smaller.
      if (!(e instanceof AiError && e.tooLarge)) throw e;
      budget = Math.floor(size * 0.5);
    }
  }
  for (let tries = 0; !draft; tries++) {
    try {
      ({ draft, parts } = await byParts(w, ctx, lines, budget, hooks));
    } catch (e) {
      if (!(e instanceof AiError && e.tooLarge) || tries >= 3 || budget < 2_000) throw e;
      budget = Math.floor(budget * 0.5);
    }
  }
  draft = await inFrench(w, draft);
  return { noteId: input.noteId, title: input.title, ...draft, basis: basisOf(t), provider: w.provider, model: w.model, createdAt: Date.now(), parts };
}

// --- Kept in this browser ---------------------------------------------------------------------

export async function getLessonSummary(noteId: string): Promise<LessonSummary | null> {
  return ((await chrome.storage.local.get(summaryKey(noteId)))[summaryKey(noteId)] as LessonSummary | undefined) ?? null;
}

export async function putLessonSummary(s: LessonSummary): Promise<void> {
  await chrome.storage.local.set({ [summaryKey(s.noteId)]: s });
}

export async function getCourseSummary(course: string): Promise<CourseSummary | null> {
  const key = courseSummaryKey(normalizeTitle(course));
  return ((await chrome.storage.local.get(key))[key] as CourseSummary | undefined) ?? null;
}

export async function putCourseSummary(s: CourseSummary): Promise<void> {
  await chrome.storage.local.set({ [courseSummaryKey(normalizeTitle(s.course))]: s });
}

// --- A course --------------------------------------------------------------------------------

export interface CourseLesson {
  noteId: string;
  title: string;
  url: string;
  chapter: string;
  duration: number;
  transcript: Transcript | null;
  summary: LessonSummary | null;
}

export interface CourseContent {
  course: string;
  chapters: string[];
  lessons: CourseLesson[];
}

/**
 * The lessons of a course, as the PDF orders them: its chapters in the order
 * they were begun, their lessons too — each with its transcript and its
 * summary (if any).
 */
export async function courseContent(course: string): Promise<CourseContent> {
  const want = normalizeTitle(course);
  const index = ((await chrome.storage.local.get('notes:index'))['notes:index'] ?? {}) as Record<string, NoteSummary>;
  const ids = Object.keys(index).filter((id) => normalizeTitle(index[id]?.course ?? '') === want);
  const notes = ids.length ? await chrome.storage.local.get(ids.map((id) => `note:${id}`)) : {};
  const transcripts = new TranscriptStore(chrome.storage.local);
  const lessons: Array<CourseLesson & { createdAt: number }> = [];
  for (const id of ids) {
    const note = notes[`note:${id}`] as Note | undefined;
    const meta = index[id];
    const transcript = await transcripts.get(id).catch(() => null);
    lessons.push({
      noteId: id,
      title: note?.title || meta?.title || id,
      url: note?.url || meta?.url || '',
      chapter: note?.chapter || meta?.chapter || 'Chapitre 1',
      duration: Math.round(transcript?.duration || meta?.progress?.duration || (transcript?.cues.at(-1)?.end ?? 0)),
      transcript,
      summary: await getLessonSummary(id),
      createdAt: note?.createdAt ?? meta?.updatedAt ?? 0,
    });
  }
  const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
  const firstOf = new Map<string, number>();
  for (const l of lessons) firstOf.set(normalizeTitle(l.chapter), Math.min(firstOf.get(normalizeTitle(l.chapter)) ?? Infinity, l.createdAt));
  lessons.sort((a, b) => firstOf.get(normalizeTitle(a.chapter))! - firstOf.get(normalizeTitle(b.chapter))! || a.createdAt - b.createdAt || collator.compare(a.title, b.title));
  const chapters: string[] = [];
  for (const l of lessons) if (!chapters.some((c) => normalizeTitle(c) === normalizeTitle(l.chapter))) chapters.push(l.chapter);
  const name = Object.values(index).find((n) => normalizeTitle(n.course ?? '') === want)?.course ?? course;
  return { course: name, chapters, lessons: lessons.map(({ createdAt: _at, ...l }) => l) };
}

/** The lesson's summary is missing, or its transcript has changed since. */
export function needsSummary(l: CourseLesson): boolean {
  if (!l.transcript?.cues.length) return false;
  return !l.summary || basisKey(l.summary.basis) !== basisKey(basisOf(l.transcript));
}

/**
 * The whole course: every lesson read in full (those already summarised from
 * the same transcript are kept), then the course's synthesis — written from
 * the transcripts themselves when they all fit in one request.
 */
export async function summarizeCourse(course: string, w: Writer, hooks: RunHooks = {}): Promise<CourseSummary> {
  const content = await courseContent(course);
  if (!content.lessons.length) throw new SummaryError(`le cours « ${course} » n’a pas encore de leçon`);
  const todo = content.lessons.filter(needsSummary);
  for (const [i, l] of todo.entries()) {
    hooks.onStep?.({ phase: 'lesson', k: i + 1, n: todo.length, title: l.title });
    l.summary = await summarizeLesson({ noteId: l.noteId, title: l.title, course: content.course, chapter: l.chapter, transcript: l.transcript! }, w, hooks);
    await putLessonSummary(l.summary);
  }
  if (!content.lessons.some((l) => l.summary)) throw new SummaryError('aucune leçon de ce cours n’a de transcription à résumer');
  hooks.onStep?.({ phase: 'course' });
  const inputs: CourseLessonInput[] = content.lessons.map((l, i) => ({
    id: `L${i + 1}`,
    noteId: l.noteId,
    title: l.title,
    chapter: l.chapter,
    duration: l.duration,
    summary: l.summary,
    lines: l.transcript?.cues.length ? linesOf(l.transcript.cues) : [],
  }));
  const system = coursePrompt(content.course, content.chapters, [], true).system;
  const budget = await w.budget(system);
  // The transcripts themselves when they all fit what the model reads at once; else the lessons' summaries.
  let full = coursePrompt(content.course, content.chapters, inputs, true).user.length <= budget;
  let draft;
  try {
    draft = await ask(w, coursePrompt(content.course, content.chapters, inputs, full), COURSE_SCHEMA, 3000, hooks, (r) => parseCourse(r, content.chapters.length));
  } catch (e) {
    if (!(full && e instanceof AiError && e.tooLarge)) throw e;
    full = false;
    draft = await ask(w, coursePrompt(content.course, content.chapters, inputs, false), COURSE_SCHEMA, 3000, hooks, (r) => parseCourse(r, content.chapters.length));
  }
  if (w.english) {
    const fr = async (t: string) => (t ? ((await toFrench(t)) ?? t) : t);
    draft.problem = await fr(draft.problem);
    draft.solution = await fr(draft.solution);
    draft.goals = await Promise.all(draft.goals.map(async (g) => ({ ...g, text: await fr(g.text) })));
    for (const [k, v] of draft.chapters) draft.chapters.set(k, await fr(v));
    for (const [k, v] of draft.lessons) draft.lessons.set(k, await fr(v));
  }
  const summary: CourseSummary = {
    course: content.course,
    problem: draft.problem,
    goals: draft.goals,
    solution: draft.solution,
    chapters: content.chapters.map((title, ci) => ({
      title,
      synthesis: draft.chapters.get(ci + 1) ?? '',
      lessons: inputs
        .filter((x) => x.chapter === title)
        .map((x) => {
          const l = content.lessons.find((y) => y.noteId === x.noteId)!;
          const state: 'done' | 'none' | 'partial' = !l.summary ? 'none' : coverage(l.transcript).state === 'partial' ? 'partial' : 'done';
          // A lesson without a transcript has nothing to sum up: whatever the AI wrote for it is left out.
          return { noteId: l.noteId, title: l.title, url: l.url, chapter: l.chapter, duration: l.duration, synthesis: state === 'none' ? '' : (draft.lessons.get(x.id) ?? ''), state };
        }),
    })),
    read: Object.fromEntries(content.lessons.filter((l) => l.transcript?.cues.length).map((l) => [l.noteId, basisKey(basisOf(l.transcript!))])),
    full,
    provider: w.provider,
    model: w.model,
    createdAt: Date.now(),
  };
  await putCourseSummary(summary);
  return summary;
}

/** Lessons of the course whose transcript appeared or changed since the course's summary. */
export function staleLessons(s: CourseSummary, content: CourseContent): CourseLesson[] {
  return content.lessons.filter((l) => l.transcript?.cues.length && s.read[l.noteId] !== basisKey(basisOf(l.transcript)));
}

/** The course's summary as Markdown, with each lesson's plan. */
export function courseText(s: CourseSummary, content: CourseContent): string {
  return courseMarkdown(s, new Map(content.lessons.filter((l) => l.summary).map((l) => [l.noteId, l.summary!])));
}
