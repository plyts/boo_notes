import { isRemote, PROVIDERS, providerLabel } from '../shared/ai-providers';
import { h, icon, type IconName } from '../shared/icons';
import { normalizeTitle } from '../shared/markdown';
import { callBackground } from '../shared/messages';
import { timestampUrl } from '../shared/platforms';
import { loadQa } from '../shared/qa-config';
import { NoteStore, type Note } from '../shared/store';
import { basisKey, basisOf, courseSummaryKey, coverage, isStale, lessonMarkdown, summaryKey, type CourseSummary, type LessonSummary } from '../shared/summary';
import {
  courseContent,
  courseText,
  getCourseSummary,
  getLessonSummary,
  needsSummary,
  NoWriterError,
  putCourseSummary,
  putLessonSummary,
  staleLessons,
  summarizeCourse,
  summarizeLesson,
  writerFor,
  type CourseContent,
  type CourseLesson,
  type SummaryStep,
} from '../shared/summarizer';
import { formatTimecode } from '../shared/time';
import type { Transcript } from '../shared/transcript';
import { TranscriptStore } from '../shared/transcript-store';
import { card, courseCards, isDetailed, lessonCards, planTree, planView, viewSwitch, type PlanView } from '../panel/summary-render';
import { addButton, cleanPlan, editText, planEditor, smallButton } from './edit';

/**
 * A summary, large (a tab of its own): a course's (`?course=`) — its
 * lessons and their state on the side; its problem, goals and solution;
 * its plan, chapters › lessons › their parts and points, each moment a link
 * that opens the lesson there — or one lesson's (`?note=`).
 *
 * « Modifier »: every text edited in place, each point's kind chosen,
 * points and parts added, moved or removed, a moment typed; « Enregistrer »
 * keeps it (the summary block in the note follows, Notion is written again,
 * the PDF is the summary as saved).
 */

const params = new URLSearchParams(location.search);
const noteId = params.get('note') ?? '';
const MODE: 'course' | 'lesson' = noteId ? 'lesson' : 'course';
const course = params.get('course') ?? '';
const side = document.getElementById('side') as HTMLElement;
const main = document.getElementById('main') as HTMLElement;
const actions = document.getElementById('actions') as HTMLElement;
const crumb = document.getElementById('crumb') as HTMLElement | null;
const toast = document.getElementById('toast') as HTMLElement;
const notes = new NoteStore(chrome.storage.local);

let content: CourseContent | null = null;
let summary: CourseSummary | null = null;
/** The lesson (`?note=`): its note, its transcript, its summary. */
let lesson: { note: Note | null; transcript: Transcript | null; summary: LessonSummary | null } | null = null;
let running: { ctrl: AbortController; step: SummaryStep | null; lesson: { k: number; n: number; title: string } | null } | null = null;
let error: { text: string; setup: boolean } | null = null;
let provider = '';
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Each lesson's parts: their titles only, or their points explained. */
let view: PlanView = planView();
/** « Modifier »: the copy being edited (null: reading). */
let draft: { course: CourseSummary | null; lessons: Map<string, LessonSummary>; dirty: boolean } | null = null;
let saveButton: HTMLButtonElement | null = null;
let scrolledToHash = false;

function say(text: string, ms = 3500): void {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}

const minutes = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}` : `${Math.round(s / 60)} min`);
const dateTime = (at: number) => new Date(at).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

function button(label: string, iconName: IconName, onClick: () => void, cls = 'sum-btn'): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls }, icon(iconName, 15), label);
  b.addEventListener('click', onClick);
  return b;
}

type LessonState = 'done' | 'stale' | 'none' | 'todo';

function stateOf(l: CourseLesson): LessonState {
  if (!l.transcript?.cues.length) return 'none';
  if (!l.summary) return 'todo';
  if (needsSummary(l) || (summary && summary.read[l.noteId] !== basisKey(basisOf(l.transcript)))) return 'stale';
  return 'done';
}

const STATE_ICON: Record<LessonState, IconName> = { done: 'check', stale: 'refresh', none: 'alert', todo: 'clock' };
const STATE_LABEL: Record<LessonState, string> = { done: 'résumée', stale: 'à mettre à jour', none: 'sans transcription', todo: 'à résumer' };

/** The pastille of a summary: written by the AI (to check), or changed by hand since. */
function aiBadge(s: { provider: string; model: string; edited?: number }): HTMLElement {
  return s.edited
    ? h('span', { class: 'sum-ai edited', title: `Écrit par ${s.provider} (${s.model}), modifié par vous le ${dateTime(s.edited)}` }, icon('edit', 12), 'IA · modifié')
    : h('span', { class: 'sum-ai', title: `Écrit par ${s.provider} (${s.model})` }, icon('sparkles', 12), 'IA · à vérifier');
}

// --- « Modifier » -------------------------------------------------------------------------------

/** Stable JSON (keys sorted, the edit date left out): a summary changed or not, whatever the order its keys were written in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([k, x]) => x !== undefined && k !== 'edited')
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function startEditing(): void {
  const lessons = new Map<string, LessonSummary>();
  if (MODE === 'lesson' && lesson?.summary) lessons.set(noteId, structuredClone(lesson.summary));
  for (const l of content?.lessons ?? []) if (l.summary) lessons.set(l.noteId, structuredClone(l.summary));
  draft = { course: summary ? structuredClone(summary) : null, lessons, dirty: false };
  render();
}

function changed(): void {
  if (!draft) return;
  draft.dirty = true;
  saveButton?.classList.add('pulse');
}

function cancelEditing(): void {
  if (draft?.dirty && !confirm('Abandonner vos modifications ?')) return;
  draft = null;
  render();
}

const cleanLesson = (s: LessonSummary): LessonSummary => ({
  ...s,
  problem: { ...s.problem, text: s.problem.text.trim() },
  goals: s.goals.map((g) => ({ ...g, text: g.text.trim() })).filter((g) => g.text),
  solution: { ...s.solution, text: s.solution.text.trim() },
  plan: cleanPlan(s.plan),
});

const cleanCourse = (s: CourseSummary): CourseSummary => ({
  ...s,
  problem: s.problem.trim(),
  goals: s.goals.map((g) => ({ ...g, text: g.text.trim() })).filter((g) => g.text),
  solution: s.solution.trim(),
  chapters: s.chapters.map((c) => ({ ...c, synthesis: c.synthesis.trim(), lessons: c.lessons.map((l) => ({ ...l, synthesis: l.synthesis.trim() })) })),
});

/** Keeps the edited summary: the lessons changed, the course; the note's block follows; Notion is written again. */
async function save(): Promise<void> {
  if (!draft) return;
  const now = Date.now();
  const originals = new Map<string, LessonSummary>();
  if (lesson?.summary) originals.set(noteId, lesson.summary);
  for (const l of content?.lessons ?? []) if (l.summary) originals.set(l.noteId, l.summary);
  const lessonsChanged: string[] = [];
  try {
    for (const [id, d] of draft.lessons) {
      const next = cleanLesson(d);
      const before = originals.get(id);
      if (before && stable(next) === stable(before)) continue;
      await putLessonSummary({ ...next, edited: now });
      lessonsChanged.push(id);
    }
    let courseChanged = false;
    if (draft.course && summary) {
      const next = cleanCourse(draft.course);
      if (stable(next) !== stable(summary)) {
        await putCourseSummary({ ...next, edited: now });
        courseChanged = true;
      }
    }
    // The summary inserted in a note: written again as edited.
    let inNotes = 0;
    for (const id of lessonsChanged) if ((await callBackground({ type: 'summary:note', noteId: id }).catch(() => ({ updated: false }))).updated) inNotes++;
    const notion = await callBackground({ type: 'notion:status' }).catch(() => null);
    draft = null;
    await load();
    if (!lessonsChanged.length && !courseChanged) say('Rien n’a changé');
    else {
      const where = [inNotes ? (inNotes > 1 ? `${inNotes} notes` : 'la note') : '', notion?.configured ? 'Notion' : ''].filter(Boolean);
      say(`Résumé enregistré${where.length ? ` — mis à jour dans ${where.join(' et ')}` : ''}`, 5000);
    }
  } catch (e) {
    say(`Enregistrement impossible : ${failure(e)}`, 6000);
  }
}

/** Problem · Goals · Solution of a course, editable (a goal's chapter chosen; goals added, removed). */
function courseCardsEdit(s: CourseSummary): HTMLElement[] {
  const goals = h('ul', { class: 'sum-goals ed-goals' });
  const drawGoals = () => {
    goals.replaceChildren(
      ...s.goals.map((g, i) => {
        const chapter = h(
          'select',
          { class: 'ed-chap', 'aria-label': `Chapitre de l’objectif ${i + 1}` },
          h('option', { value: '' }, '—'),
          ...s.chapters.map((_, ci) => h('option', { value: String(ci + 1), ...(g.chapter === ci + 1 ? { selected: true } : {}) }, `ch. ${ci + 1}`)),
        );
        chapter.addEventListener('change', () => {
          g.chapter = chapter.value ? Number(chapter.value) : null;
          changed();
        });
        const remove = smallButton('trash', 'Supprimer l’objectif', () => {
          s.goals.splice(i, 1);
          drawGoals();
          changed();
        }, 'danger');
        const text = editText(g.text, (v) => {
          g.text = v;
          changed();
        }, { label: `Objectif ${i + 1}`, placeholder: 'Un objectif (verbe à l’infinitif)' });
        return h('li', {}, h('span', { class: 'sum-check' }, icon('check', 14)), text, h('span', { class: 'ed-row' }, chapter, remove));
      }),
    );
  };
  drawGoals();
  const addGoal = addButton('Ajouter un objectif', () => {
    s.goals.push({ text: '', chapter: null });
    drawGoals();
    changed();
    goals.querySelectorAll<HTMLElement>('.ed').item(s.goals.length - 1)?.focus();
  });
  const problem = editText(s.problem, (v) => {
    s.problem = v;
    changed();
  }, { label: 'Problématique du cours', placeholder: 'Le problème que le cours traite, et sa question', cls: 'sum-text', multiline: true });
  const solution = editText(s.solution, (v) => {
    s.solution = v;
    changed();
  }, { label: 'Solution du cours', placeholder: 'La démarche que le cours propose', cls: 'sum-text', multiline: true });
  return [
    card('problem', [problem], { label: 'Problématique du cours' }),
    card('goals', [goals, addGoal], { label: 'Objectifs du cours' }),
    card('solution', [solution], { label: 'Solution — la démarche' }),
  ];
}

/** Problem · Goals · Solution of a lesson, editable. */
function lessonCardsEdit(s: LessonSummary): HTMLElement[] {
  const goals = h('ul', { class: 'sum-goals ed-goals' });
  const drawGoals = () => {
    goals.replaceChildren(
      ...s.goals.map((g, i) => {
        const text = editText(g.text, (v) => {
          g.text = v;
          changed();
        }, { label: `Objectif ${i + 1}`, placeholder: 'Un objectif (verbe à l’infinitif)' });
        const remove = smallButton('trash', 'Supprimer l’objectif', () => {
          s.goals.splice(i, 1);
          drawGoals();
          changed();
        }, 'danger');
        return h('li', {}, h('span', { class: 'sum-check' }, icon('check', 14)), text, remove);
      }),
    );
  };
  drawGoals();
  const addGoal = addButton('Ajouter un objectif', () => {
    s.goals.push({ text: '', at: [] });
    drawGoals();
    changed();
    goals.querySelectorAll<HTMLElement>('.ed').item(s.goals.length - 1)?.focus();
  });
  const problem = editText(s.problem.text, (v) => {
    s.problem.text = v;
    changed();
  }, { label: 'Problématique', placeholder: 'Le problème que la leçon traite, et sa question', cls: 'sum-text', multiline: true });
  const solution = editText(s.solution.text, (v) => {
    s.solution.text = v;
    changed();
  }, { label: 'Solution', placeholder: 'La réponse ou la méthode de la leçon', cls: 'sum-text', multiline: true });
  return [card('problem', [problem]), card('goals', [goals, addGoal]), card('solution', [solution])];
}

function editBanner(): HTMLElement {
  return h(
    'div',
    { class: 'ed-banner', role: 'note' },
    icon('edit', 16),
    h(
      'p',
      {},
      h('b', {}, 'Vous modifiez le résumé.'),
      ' Cliquez un texte pour le changer ; choisissez la sorte de chaque point ; ajoutez, déplacez ou supprimez points et parties ; tapez un instant (02:40). « Enregistrer » le garde — ici, dans le PDF, dans la note où il est inséré et dans Notion.',
    ),
  );
}

// --- Drawing ------------------------------------------------------------------------------------

function renderSide(): void {
  if (MODE === 'lesson') {
    const note = lesson?.note;
    const s = lesson?.summary;
    const cov = coverage(lesson?.transcript ?? null);
    const items: HTMLElement[] = [h('h2', {}, note?.title || s?.title || 'Leçon')];
    if (note?.course) {
      items.push(h('p', { class: 'progress' }, `${note.course} › ${note.chapter || 'Chapitre 1'}`));
      items.push(h('a', { class: 'side-link', href: `summary.html?course=${encodeURIComponent(note.course)}#lesson-${noteId}` }, icon('course', 14), 'Tout le cours'));
    }
    if (note?.url && /^https?:/.test(note.url)) items.push(h('a', { class: 'side-link', href: note.url, target: '_blank', rel: 'noopener' }, icon('play', 14), 'Ouvrir la leçon'));
    const transcript =
      cov.state === 'none' ? 'Pas de transcription.' : cov.state === 'full' ? `Transcription complète${cov.duration ? ` · ${formatTimecode(cov.duration)}` : ''}` : `Transcription partielle : ${minutes(cov.covered)} sur ${minutes(cov.duration)}`;
    items.push(h('p', { class: 'legend' }, transcript, s ? h('br', {}) : null, s ? `Résumé du ${dateTime(s.createdAt)}${s.edited ? `, modifié le ${dateTime(s.edited)}` : ''}` : null));
    side.replaceChildren(...items);
    return;
  }
  if (!content) return;
  const done = content.lessons.filter((l) => stateOf(l) === 'done').length;
  const items: HTMLElement[] = [
    h('h2', {}, content.course),
    h('p', { class: 'progress' }, `${done} leçon${done > 1 ? 's' : ''} résumée${done > 1 ? 's' : ''} sur ${content.lessons.length}`),
    h('div', { class: 'pbar' }, h('i', { style: `width:${content.lessons.length ? Math.round((done / content.lessons.length) * 100) : 0}%` })),
  ];
  content.chapters.forEach((chapter, ci) => {
    items.push(h('div', { class: 'ch' }, `${ci + 1} · ${chapter}`));
    for (const l of content!.lessons.filter((x) => x.chapter === chapter)) {
      const st = stateOf(l);
      const b = h('button', { type: 'button', class: 'ls', 'data-state': st, title: `${l.title} — ${STATE_LABEL[st]}` }, h('span', { class: 'st' }, icon(STATE_ICON[st], 15)), h('span', {}, l.title), h('span', { class: 'd' }, l.duration ? formatTimecode(l.duration) : ''));
      b.addEventListener('click', () => document.getElementById(`lesson-${l.noteId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      items.push(b);
    }
  });
  items.push(h('p', { class: 'legend' }, '✓ résumée · ↻ à mettre à jour · ⚠ sans transcription · ◷ à résumer'));
  side.replaceChildren(...items);
}

function pdfAction(request: { type: 'course:pdf' | 'course:summary-pdf'; course: string } | { type: 'summary:pdf'; noteId: string }, label: string): void {
  say(`${label} en préparation…`);
  callBackground(request).then(
    (r) => say(r.message),
    (e: unknown) => say(`PDF impossible : ${failure(e)}`),
  );
}

function copy(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => say(`${what} copié`),
    (e: unknown) => say(`Copie impossible : ${failure(e)}`),
  );
}

function renderActions(): void {
  saveButton = null;
  const list: HTMLElement[] = [];
  if (draft) {
    saveButton = button('Enregistrer', 'check', () => void save(), 'sum-btn primary');
    list.push(h('span', { class: 'ed-state' }, icon('edit', 14), 'Modification en cours'), button('Annuler', 'close', cancelEditing), saveButton);
    actions.replaceChildren(...list);
    return;
  }
  if (MODE === 'lesson') {
    const s = lesson?.summary;
    if (running) list.push(button('Arrêter', 'stop', () => running?.ctrl.abort()));
    else if (s) list.push(button('Modifier', 'edit', startEditing));
    if (!running && lesson?.transcript?.cues.length) list.push(button(s ? 'Régénérer' : 'Générer le résumé', s ? 'refresh' : 'sparkles', () => void generateLesson(), s ? 'sum-btn' : 'sum-btn primary'));
    if (s) {
      list.push(button('PDF du résumé', 'download', () => pdfAction({ type: 'summary:pdf', noteId }, 'PDF du résumé')));
      list.push(button('Copier', 'copy', () => copy(lessonMarkdown(s).replace(/^> ?/gm, ''), 'Résumé')));
    }
    actions.replaceChildren(...list);
    return;
  }
  if (!content) return actions.replaceChildren();
  const pending = content.lessons.filter((l) => ['stale', 'todo'].includes(stateOf(l))).length;
  if (running) list.push(button('Arrêter', 'stop', () => running?.ctrl.abort()));
  else if (summary) {
    list.push(button('Modifier', 'edit', startEditing));
    list.push(button(pending ? `Mettre à jour (${pending})` : 'Régénérer', 'refresh', () => void generate(), pending ? 'sum-btn primary' : 'sum-btn'));
  }
  // The summary alone (a few pages), or the whole course: its summary, then every lesson with its notes and transcript.
  if (summary) list.push(button('PDF du résumé', 'download', () => pdfAction({ type: 'course:summary-pdf', course: content!.course }, `PDF du résumé du cours « ${content!.course} »`)));
  list.push(button('PDF du cours', 'file', () => pdfAction({ type: 'course:pdf', course: content!.course }, `PDF du cours « ${content!.course} »`)));
  if (summary) {
    const s = summary;
    list.push(button('Copier', 'copy', () => copy(courseText(s, content!), 'Résumé du cours')));
  }
  actions.replaceChildren(...list);
}

function progressCard(): HTMLElement {
  const step = running?.step;
  const current = running?.lesson;
  let label = 'Préparation…';
  let detail: string | null = null;
  if (step?.phase === 'course') label = 'Synthèse du cours entier…';
  else if (step?.phase === 'read' && MODE === 'lesson') label = step.n > 1 ? `Lecture de la transcription — partie ${step.k} sur ${step.n}` : 'Lecture de toute la transcription…';
  else if (step?.phase === 'merge' && MODE === 'lesson') label = 'Les parties réunies : problématique, objectifs, solution, plan…';
  else if (current) {
    label = `Leçon ${current.k} sur ${current.n} — « ${current.title} », lue en entier`;
    detail =
      step?.phase === 'read' && step.n > 1
        ? `partie ${step.k} sur ${step.n} de sa transcription`
        : step?.phase === 'merge'
          ? 'ses parties réunies'
          : step?.phase === 'wait'
            ? `limite du palier gratuit atteinte : reprise dans ${step.seconds} s`
            : 'toute sa transcription';
  } else if (step?.phase === 'wait') label = `Limite du palier gratuit atteinte : reprise dans ${step.seconds} s`;
  const ratio =
    step?.phase === 'course' ? 0.94 : current ? (current.k - 0.5) / (current.n + 1) : step?.phase === 'merge' ? 0.9 : step?.phase === 'read' ? (step.k - 0.5) / (step.n + 1) : 0.05;
  return h(
    'div',
    { class: 'sum-progress', role: 'status' },
    h('b', {}, MODE === 'lesson' ? 'Résumé en cours…' : 'Résumé du cours en cours…'),
    h('div', { class: 'sum-bar-track' }, h('i', { style: `width:${Math.round(ratio * 100)}%` })),
    h('p', { class: 'sum-step' }, label),
    detail ? h('p', { class: 'sum-hint' }, `En ce moment : ${detail}`) : null,
    h('p', { class: 'sum-hint' }, MODE === 'lesson' ? 'Toute la transcription est lue.' : 'Chaque leçon est lue en entier — toute sa transcription —, puis le cours.'),
  );
}

function errorCard(retry: () => void): HTMLElement | null {
  if (!error) return null;
  const setup = error.setup ? button('Choisir une IA…', 'settings', () => void callBackground({ type: 'options:open', section: 'questions' })) : null;
  return h('div', { class: 'sum-error', role: 'alert' }, icon('alert', 16), h('div', {}, h('p', {}, `Résumé impossible : ${error.text}.`), h('div', { class: 'sum-row' }, button('Réessayer', 'refresh', retry), setup)));
}

/** The plan section: its head (« Titres | Détaillé »), then what it holds. */
function planSection(detailed: boolean, hint: string, ...body: HTMLElement[]): HTMLElement {
  const switcher =
    detailed && !draft
      ? viewSwitch(view, (v) => {
          const y = scrollY;
          view = v;
          renderMain();
          scrollTo(0, y);
        })
      : null;
  return h(
    'section',
    { class: 'sum-card sum-plan plan', 'aria-label': 'Plan du cours' },
    h('h3', { class: 'sum-head' }, h('span', { class: 'sum-ico' }, icon('outline', 15)), h('span', {}, 'Plan du cours'), h('span', { class: 'sum-count' }, hint), switcher),
    ...body,
  );
}

function renderLessonMain(): void {
  const s = draft?.lessons.get(noteId) ?? lesson?.summary ?? null;
  const note = lesson?.note;
  const title = note?.title || s?.title || 'Leçon';
  const href = note?.url && /^https?:/.test(note.url) ? (at: number) => timestampUrl(note.url, at) : null;
  const out: Array<HTMLElement | null> = [
    h('div', {}, h('h1', {}, title), h('div', { class: 'meta' }, note?.course ? h('span', {}, `${note.course} › ${note.chapter || 'Chapitre 1'}`) : null, s ? aiBadge(s) : null)),
  ];
  if (running) out.push(progressCard());
  out.push(errorCard(() => void generateLesson()));
  if (!lesson) out.push(h('p', { class: 'sum-empty-text' }, 'Chargement…'));
  else if (!s && !running) {
    const spoken = Boolean(lesson.transcript?.cues.length);
    out.push(
      h(
        'div',
        { class: 'sum-note dashed' },
        h(
          'p',
          {},
          h('b', {}, spoken ? 'Pas encore de résumé.' : 'Pas encore de transcription.'),
          spoken ? ' « Générer le résumé », en haut : toute la transcription est lue.' : ' Ouvrez la leçon avec ses sous-titres (ou importez un .vtt / .srt dans l’onglet Transcription du panneau) pour la résumer.',
        ),
      ),
    );
  } else if (s && draft) {
    out.push(editBanner(), h('div', { class: 'three' }, ...lessonCardsEdit(s)), planSection(true, 'parties › points — chaque texte se modifie', planEditor(s.plan, changed)));
  } else if (s) {
    if (isStale(s, lesson.transcript)) out.push(h('div', { class: 'sum-stale' }, h('p', {}, h('b', {}, 'La transcription a changé depuis ce résumé'), ' : « Régénérer » le refait.')));
    const detailed = isDetailed(s.plan);
    out.push(
      h('div', { class: 'three' }, ...lessonCards(s, { href })),
      planSection(detailed, view === 'detailed' && detailed ? 'parties › points importants — un clic ouvre la leçon à l’instant' : 'parties — un clic ouvre la leçon à l’instant', planTree(s.plan, { href }, view)),
      h('p', { class: 'sum-hint' }, `Généré le ${dateTime(s.createdAt)}${s.edited ? ` · modifié par vous le ${dateTime(s.edited)}` : ''} · d’après la transcription${s.parts > 1 ? `, lue en ${s.parts} parties` : ''}`),
    );
  }
  main.replaceChildren(...out.filter((x): x is HTMLElement => x !== null));
}

function renderCourseMain(): void {
  if (!content) {
    main.replaceChildren(h('p', { class: 'sum-empty-text' }, 'Chargement…'));
    return;
  }
  const c = content;
  const s = draft?.course ?? summary;
  const withText = c.lessons.filter((l) => l.transcript?.cues.length);
  const seconds = c.lessons.reduce((n, l) => n + l.duration, 0);
  const out: Array<HTMLElement | null> = [
    h(
      'div',
      {},
      h('h1', {}, c.course),
      h(
        'div',
        { class: 'meta' },
        h('span', {}, `${c.chapters.length} chapitre${c.chapters.length > 1 ? 's' : ''} · ${c.lessons.length} leçon${c.lessons.length > 1 ? 's' : ''}${seconds ? ` · ${minutes(seconds)} de vidéo` : ''}`),
        h('span', {}, `· ${withText.length} transcription${withText.length > 1 ? 's' : ''}`),
        s ? aiBadge(s) : null,
      ),
    ),
  ];
  if (running) out.push(progressCard());
  out.push(errorCard(() => void generate()));
  if (!c.lessons.length) {
    out.push(h('div', { class: 'sum-note dashed' }, h('p', {}, 'Ce cours n’a pas encore de leçon dans ce navigateur : rangez-y des notes (« Ranger dans un cours », dans le panneau).')));
    main.replaceChildren(...out.filter((x): x is HTMLElement => x !== null));
    return;
  }
  if (!s && !running) {
    const go = button('Générer le résumé du cours', 'sparkles', () => void generate(), 'sum-btn primary big');
    go.disabled = !withText.length;
    out.push(
      h(
        'div',
        { class: 'sum-card' },
        h('div', { class: 'sum-empty' }, h('span', { class: 'sum-halo' }, icon('course', 26)), h('h4', {}, 'Résumer tout le cours'), h('p', {}, 'Chaque leçon est lue en entier — toute sa transcription —, puis le cours : sa problématique, ses objectifs, sa démarche et son plan, chapitre par chapitre.')),
        go,
        h('p', { class: 'sum-provider' }, icon('sparkles', 13), `IA : ${provider || '…'}`),
      ),
    );
  }
  if (s) {
    if (draft) out.push(editBanner());
    else {
      const stale = staleLessons(s, c);
      if (stale.length && !running) out.push(h('div', { class: 'sum-stale' }, h('p', {}, h('b', {}, `${stale.length} leçon${stale.length > 1 ? 's' : ''} à mettre à jour`), ` : ${stale.map((l) => `« ${l.title} »`).join(', ')}.`)));
    }
    out.push(h('div', { class: 'three' }, ...(draft ? courseCardsEdit(s) : courseCards(s))));
    const chapters = s.chapters.map((ch, ci) => {
      const lessons = h(
        'div',
        { class: 'lessons' },
        ...ch.lessons.flatMap((ref, li) => {
          const l = c.lessons.find((x) => x.noteId === ref.noteId);
          const own = draft?.lessons.get(ref.noteId) ?? l?.summary ?? null;
          const parts = own?.plan ?? [];
          const synthesis = draft
            ? editText(ref.synthesis, (v) => {
                ref.synthesis = v;
                changed();
              }, { label: `Phrase de la leçon « ${ref.title} »`, placeholder: 'Ce que dit la leçon, en une phrase', cls: 'ed-small' })
            : ref.state === 'none'
              ? h('small', { class: 'warn' }, 'Pas de transcription — ouvrez la leçon avec ses sous-titres pour la résumer.')
              : ref.synthesis
                ? h('small', {}, ref.synthesis)
                : null;
          const large = own && !draft ? h('a', { class: 'go', href: `summary.html?note=${encodeURIComponent(ref.noteId)}`, title: `« ${ref.title} » en grand` }, icon('expand', 12), 'En grand') : null;
          const video = ref.url ? h('a', { class: 'go', href: ref.url, target: '_blank', rel: 'noopener' }, icon('play', 12), 'Ouvrir') : null;
          const row = h(
            'div',
            { class: `lesson${parts.length || (draft && own) ? ' open' : ''}`, id: `lesson-${ref.noteId}` },
            h('span', { class: 'n' }, `${ci + 1}.${li + 1}`),
            h('span', { class: 't' }, ref.title, synthesis),
            h('span', { class: 'dur' }, ref.duration ? formatTimecode(ref.duration) : ''),
            h('span', { class: 'go-row' }, large, video),
          );
          if (draft && own) return [row, h('div', { class: 'parts' }, planEditor(own.plan, changed))];
          return parts.length ? [row, h('div', { class: 'parts' }, planTree(parts, { href: ref.url ? (at) => timestampUrl(ref.url, at) : null }, view))] : [row];
        }),
      );
      const fold = h('button', { type: 'button', class: 'chev', 'aria-expanded': 'true', 'aria-label': `Replier le chapitre ${ci + 1}` }, icon('chevronDown', 15));
      fold.addEventListener('click', () => {
        const isOpen = fold.getAttribute('aria-expanded') !== 'true';
        fold.setAttribute('aria-expanded', String(isOpen));
        lessons.hidden = !isOpen;
      });
      const syn = draft
        ? editText(ch.synthesis, (v) => {
            ch.synthesis = v;
            changed();
          }, { label: `Phrase du chapitre ${ci + 1}`, placeholder: 'Ce que le chapitre apporte, en une phrase', cls: 'syn' })
        : ch.synthesis
          ? h('span', { class: 'syn' }, ch.synthesis)
          : null;
      return h(
        'div',
        { class: 'chap' },
        h('div', { class: 'chap-row' }, fold, h('span', {}, h('b', {}, `${ci + 1} · ${ch.title}`), syn), h('span', { class: 'dur' }, `${ch.lessons.length} leçon${ch.lessons.length > 1 ? 's' : ''}`)),
        lessons,
      );
    });
    const detailed = c.lessons.some((l) => isDetailed(l.summary?.plan ?? []));
    const hint = draft
      ? 'chapitres › leçons › parties › points — chaque texte se modifie'
      : view === 'detailed' && detailed
        ? 'chapitres › leçons › parties › points importants — un clic ouvre la leçon à l’instant'
        : 'chapitres › leçons › parties — un clic ouvre la leçon à l’instant';
    out.push(planSection(detailed, hint, ...chapters));
    out.push(h('p', { class: 'sum-hint' }, `Généré le ${dateTime(s.createdAt)}${s.edited ? ` · modifié par vous le ${dateTime(s.edited)}` : ''} · ${s.full ? 'd’après toutes les transcriptions, lues ensemble' : 'd’après les résumés des leçons, chacune lue en entier'}`));
  }
  main.replaceChildren(...out.filter((x): x is HTMLElement => x !== null));
}

function renderMain(): void {
  if (MODE === 'lesson') renderLessonMain();
  else renderCourseMain();
  main.classList.toggle('editing', Boolean(draft));
}

function render(): void {
  const name = MODE === 'lesson' ? (lesson?.note?.title ?? lesson?.summary?.title ?? 'leçon') : (content?.course ?? course);
  document.title = `Boo Notes — ${name} : résumé${MODE === 'lesson' ? '' : ' du cours'}`;
  if (crumb) crumb.textContent = MODE === 'lesson' ? '› Résumé de la leçon' : '› Résumé du cours';
  renderSide();
  renderActions();
  renderMain();
  // Opened at a lesson (`#lesson-…`): there.
  if (!scrolledToHash && location.hash && (content || lesson)) {
    scrolledToHash = true;
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'center' });
  }
}

async function load(): Promise<void> {
  if (MODE === 'lesson') {
    const [note, transcript, s] = await Promise.all([notes.getNote(noteId), new TranscriptStore(chrome.storage.local).get(noteId).catch(() => null), getLessonSummary(noteId)]);
    lesson = { note, transcript, summary: s };
  } else [content, summary] = await Promise.all([courseContent(course), getCourseSummary(course)]);
  render();
}

/** Made again by the AI: a summary changed by hand is replaced (asked first). */
function replaceEdits(edited: boolean, what: string): boolean {
  return !edited || confirm(`${what} a été modifié à la main : le refaire remplace vos modifications. Continuer ?`);
}

async function generate(): Promise<void> {
  if (running) return;
  const editedLessons = content?.lessons.some((l) => l.summary?.edited && stateOf(l) === 'stale') ?? false;
  if (!replaceEdits(Boolean(summary?.edited) || editedLessons, 'Le résumé du cours')) return;
  running = { ctrl: new AbortController(), step: null, lesson: null };
  error = null;
  render();
  const run = running;
  try {
    const writer = await writerFor();
    summary = await summarizeCourse(course, writer, {
      signal: run.ctrl.signal,
      onStep: (step) => {
        run.step = step;
        if (step.phase === 'lesson') run.lesson = { k: step.k, n: step.n, title: step.title };
        if (step.phase === 'course') run.lesson = null;
        renderMain();
      },
    });
    content = await courseContent(course);
    say('Résumé du cours prêt');
  } catch (e) {
    if (!run.ctrl.signal.aborted) error = { text: failure(e), setup: e instanceof NoWriterError };
    content = await courseContent(course).catch(() => content);
  } finally {
    running = null;
    render();
  }
}

async function generateLesson(): Promise<void> {
  const t = lesson?.transcript;
  if (running || !lesson || !t?.cues.length) return;
  if (!replaceEdits(Boolean(lesson.summary?.edited), 'Ce résumé')) return;
  running = { ctrl: new AbortController(), step: null, lesson: null };
  error = null;
  render();
  const run = running;
  try {
    const writer = await writerFor();
    const note = lesson.note;
    const input = { noteId, title: note?.title || lesson.summary?.title || 'Leçon', course: note?.course ?? null, chapter: note?.chapter ?? null, transcript: t };
    const s = await summarizeLesson(input, writer, {
      signal: run.ctrl.signal,
      onStep: (step) => {
        run.step = step;
        renderMain();
      },
    });
    await putLessonSummary(s);
    lesson = { ...lesson, summary: s };
    say('Résumé de la leçon prêt');
  } catch (e) {
    if (!run.ctrl.signal.aborted) error = { text: failure(e), setup: e instanceof NoWriterError };
  } finally {
    running = null;
    render();
  }
}

async function loadProvider(): Promise<void> {
  const qa = await loadQa();
  provider = isRemote(qa.provider) ? `${PROVIDERS[qa.provider].label}${qa.model ? ` · ${qa.model}` : ''}` : providerLabel(qa.provider);
  if (!running && !draft) renderMain();
}

document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => (document.documentElement.dataset.theme = e.matches ? 'dark' : 'light'));
// Unsaved changes: said before leaving.
addEventListener('beforeunload', (e) => {
  if (draft?.dirty) e.preventDefault();
});
chrome.storage.onChanged.addListener((changes, area) => {
  // While editing, nothing is drawn again under the cursor (saved: read again).
  if (area !== 'local' || running || draft) return;
  if (changes['qa:config']) void loadProvider();
  if (MODE === 'lesson') {
    if (changes[summaryKey(noteId)] || changes[`note:${noteId}`] || changes[`transcript:${noteId}`]) void load();
    return;
  }
  // Made elsewhere (the panel), or a lesson's transcript grew.
  if (changes[courseSummaryKey(normalizeTitle(course))] || Object.keys(changes).some((k) => k.startsWith('summary:') || k.startsWith('transcript:'))) void load();
});
void loadProvider();
void load();
