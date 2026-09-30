import type { Answer } from '../shared/callouts';
import { ClaudeError, sendMessage } from '../shared/claude';
import { findCallouts } from '../shared/callouts';
import type { CourseText } from '../shared/course-text';
import { callBackground } from '../shared/messages';
import { askChromeAi, chromeAiState, toFrench } from '../shared/chrome-ai';
import { buildPrompt, extracts, forPrompt, notePassages, pagePassages, parseAnswer, rank, sourceOf, transcriptPassages, type NoteSource, type Passage, type Ranked } from '../shared/qa';
import { loadQa, type QaConfig } from '../shared/qa-config';
import type { Note, NoteSummary } from '../shared/store';
import type { Transcript } from '../shared/transcript';

/**
 * Answers a question of the note from the course: the transcript of the
 * video first, then the text of the course (its page, a module in its
 * frames), then the notes already taken (this one and the others of the
 * course). Chrome's built-in AI writes the answer on this computer (the
 * default), or Claude with a key set in the options; without either, the
 * closest passages are given. Nothing here touches the video: it plays on
 * while the answer is looked for.
 */

export interface AnswerContext {
  question: string;
  stamp: number | null;
  /** The tab of the course (its page text); -1: none. */
  tabId: number;
  noteId: string | null;
  title: string;
  /** Address of the course page: passages of the page are linked to it. */
  url: string | null;
  transcript: Transcript | null;
  /** The note being written. */
  lines: string[];
  course: string | null;
}

/** The text of the course in its tab, frames included. */
async function courseTexts(tabId: number): Promise<CourseText[]> {
  if (tabId < 0) return [];
  return callBackground({ type: 'course:text', tabId }).catch(() => []);
}

/** The other notes of the same course (the most recent first). */
async function courseNotes(course: string | null, noteId: string | null): Promise<NoteSource[]> {
  if (!course) return [];
  const index = ((await chrome.storage.local.get('notes:index'))['notes:index'] ?? {}) as Record<string, NoteSummary>;
  const ids = Object.entries(index)
    .filter(([id, n]) => id !== noteId && n.course === course)
    .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
    .slice(0, 12)
    .map(([id]) => `note:${id}`);
  if (!ids.length) return [];
  const notes = await chrome.storage.local.get(ids);
  return ids
    .map((k) => notes[k] as Note | undefined)
    .filter((n): n is Note => Boolean(n?.markdown))
    .map((n) => ({ title: n.title || 'Note sans titre', lines: n.markdown.split('\n') }));
}

/** Lines of the note that are questions (and their answers): not sources. */
function questionLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  for (const c of findCallouts(lines)) if (c.kind === 'question') for (let i = c.from; i <= c.to; i++) out.add(i);
  return out;
}

/** The question in the language of the course, with the browser's own translator when it is ready (never downloaded here). */
async function translated(text: string, to: string): Promise<string> {
  const api = (globalThis as { Translator?: { availability(o: object): Promise<string>; create(o: object): Promise<{ translate(t: string): Promise<string>; destroy?(): void }> } }).Translator;
  const target = to.split('-')[0].toLowerCase();
  if (!api || !target || target === 'fr') return '';
  try {
    if ((await api.availability({ sourceLanguage: 'fr', targetLanguage: target })) !== 'available') return '';
    const t = await api.create({ sourceLanguage: 'fr', targetLanguage: target });
    const out = await Promise.race([t.translate(text), new Promise<string>((r) => setTimeout(() => r(''), 4000))]);
    t.destroy?.();
    return out;
  } catch {
    return '';
  }
}

export async function gatherPassages(ctx: AnswerContext): Promise<Passage[]> {
  const [texts, others] = await Promise.all([courseTexts(ctx.tabId), courseNotes(ctx.course, ctx.noteId)]);
  const transcript = transcriptPassages(ctx.transcript?.cues ?? []);
  const page: Passage[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    // The same text twice (a frame shown twice, the page and its print view): once.
    const sections = t.sections.filter((s) => {
      const key = s.text.slice(0, 200);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    page.push(...pagePassages(sections, ctx.url ?? t.url, page.length + 1));
  }
  const skip = questionLines(ctx.lines);
  const notes = notePassages([{ title: null, lines: ctx.lines }, ...others], (n, l) => n === 0 && skip.has(l));
  return [...transcript, ...page, ...notes];
}

export async function answerQuestion(ctx: AnswerContext, config?: QaConfig): Promise<Answer> {
  const qa = config ?? (await loadQa());
  const passages = await gatherPassages(ctx);
  const extra = ctx.transcript?.lang ? await translated(ctx.question, ctx.transcript.lang) : '';
  const ranked = rank(ctx.question, passages, { stamp: ctx.stamp, extra });
  const query = `${ctx.question} ${extra}`;
  const closest = (note?: string): Answer => ({ method: 'extracts', text: '', sources: extracts(ranked).map((p) => sourceOf(p, null, query)), ...(note ? { note } : {}) });
  if (qa.provider === 'none') return closest();
  if (qa.provider === 'chrome') return answerOnDevice(ctx, passages, ranked, query, closest);
  if (!passages.length) return { method: 'ai', text: 'Aucune source du cours n’est encore disponible (transcription, texte de la page, notes) : impossible de chercher la réponse.', sources: [] };
  const { system, user } = buildPrompt(ctx.question, forPrompt(passages, ranked), { title: ctx.title, stamp: ctx.stamp });
  try {
    const reply = await sendMessage({ key: qa.key, model: qa.model, system, user, base: qa.base, maxTokens: 900 });
    const parsed = parseAnswer(reply, passages);
    // Nothing cited: the passages closest to the question stand for the sources.
    const sources = parsed.sources.length || !parsed.found ? parsed.sources : extracts(ranked, 2).map((p) => sourceOf(p, null, query));
    return { method: 'ai', text: parsed.answer, sources };
  } catch (e) {
    // No answer from Claude: the closest passages, and why.
    return closest(`Claude n’a pas pu répondre : ${e instanceof ClaudeError || e instanceof Error ? e.message : String(e)}.`);
  }
}

/**
 * Chrome's built-in AI (on this computer): the answer written from the
 * passages it can read. Not there (yet): the closest passages, and how to
 * get it when it can be had.
 */
async function answerOnDevice(ctx: AnswerContext, passages: Passage[], ranked: Ranked[], query: string, closest: (note?: string) => Answer): Promise<Answer> {
  const ai = await chromeAiState();
  if (ai.state !== 'available' || !ai.lang) {
    const why =
      ai.state === 'downloadable'
        ? 'Pour une réponse rédigée, activez l’IA intégrée de Chrome (options › Questions).'
        : ai.state === 'downloading'
          ? 'L’IA intégrée de Chrome se télécharge : les prochaines réponses seront rédigées.'
          : undefined;
    return closest(why);
  }
  if (!passages.length) return { method: 'ai', text: 'Aucune source du cours n’est encore disponible (transcription, texte de la page, notes) : impossible de chercher la réponse.', sources: [] };
  const lang = ai.lang;
  try {
    // A model writing English: asked in English (the question translated when Chrome can), answer translated back.
    const question = lang === 'en' ? ((await translated(ctx.question, 'en')) || ctx.question) : ctx.question;
    const base = { title: ctx.title, stamp: ctx.stamp, lang };
    const reply = await askChromeAi(lang, {
      system: buildPrompt(question, [], base).system,
      user: (budget) => buildPrompt(question, forPrompt(passages, ranked, budget), base).user,
    });
    const parsed = parseAnswer(reply, passages);
    let text = parsed.answer;
    let note: string | undefined;
    if (lang === 'en' && text) {
      const fr = await toFrench(text);
      if (fr) text = fr;
      else note = 'Réponse en anglais : l’IA intégrée de Chrome n’écrit pas encore le français, et son traducteur n’est pas prêt.';
    }
    const sources = parsed.sources.length || !parsed.found ? parsed.sources : extracts(ranked, 2).map((p) => sourceOf(p, null, query));
    return { method: 'ai', text, sources, ...(note ? { note } : {}) };
  } catch (e) {
    return closest(`L’IA intégrée de Chrome n’a pas pu répondre : ${e instanceof Error ? e.message : String(e)}.`);
  }
}
