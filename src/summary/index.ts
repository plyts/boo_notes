import { isRemote, PROVIDERS, providerLabel } from '../shared/ai-providers';
import { h, icon, type IconName } from '../shared/icons';
import { normalizeTitle } from '../shared/markdown';
import { callBackground } from '../shared/messages';
import { timestampUrl } from '../shared/platforms';
import { loadQa } from '../shared/qa-config';
import { basisKey, basisOf, courseSummaryKey, type CourseSummary, type PlanNode } from '../shared/summary';
import {
  courseContent,
  courseText,
  getCourseSummary,
  needsSummary,
  NoWriterError,
  staleLessons,
  summarizeCourse,
  writerFor,
  type CourseContent,
  type CourseLesson,
  type SummaryStep,
} from '../shared/summarizer';
import { formatTimecode } from '../shared/time';
import { courseCards } from '../panel/summary-render';

/**
 * The course's summary, large (a tab of its own): its lessons and their
 * state on the side; the course's problem, goals and solution; its plan,
 * chapters › lessons › their parts, each moment a link that opens the lesson
 * there. « Générer » / « Mettre à jour » reads every lesson's whole
 * transcript (those unchanged are kept), then the course.
 */

const course = new URLSearchParams(location.search).get('course') ?? '';
const side = document.getElementById('side') as HTMLElement;
const main = document.getElementById('main') as HTMLElement;
const actions = document.getElementById('actions') as HTMLElement;
const toast = document.getElementById('toast') as HTMLElement;

let content: CourseContent | null = null;
let summary: CourseSummary | null = null;
let running: { ctrl: AbortController; step: SummaryStep | null } | null = null;
let error: { text: string; setup: boolean } | null = null;
let provider = '';
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function say(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 3500);
}

const minutes = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}` : `${Math.round(s / 60)} min`);

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

function renderSide(): void {
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

function renderActions(): void {
  if (!content) return actions.replaceChildren();
  const pending = content.lessons.filter((l) => ['stale', 'todo'].includes(stateOf(l))).length;
  const list: HTMLElement[] = [];
  if (running) list.push(button('Arrêter', 'stop', () => running?.ctrl.abort()));
  else if (summary) {
    const update = button(pending ? `Mettre à jour (${pending})` : 'Régénérer', 'refresh', () => void generate(), pending ? 'sum-btn primary' : 'sum-btn');
    list.push(update);
  }
  list.push(
    button('PDF', 'file', () => {
      say(`PDF du cours « ${content!.course} » en préparation…`);
      callBackground({ type: 'course:pdf', course: content!.course }).then(
        (r) => say(r.message),
        (e: unknown) => say(`PDF impossible : ${e instanceof Error ? e.message : String(e)}`),
      );
    }),
  );
  if (summary) {
    const s = summary;
    list.push(
      button('Copier', 'copy', () => {
        navigator.clipboard.writeText(courseText(s, content!)).then(
          () => say('Résumé du cours copié'),
          (e: unknown) => say(`Copie impossible : ${e instanceof Error ? e.message : String(e)}`),
        );
      }),
    );
  }
  actions.replaceChildren(...list);
}

function partsList(nodes: readonly PlanNode[], url: string): HTMLElement {
  const list = (items: readonly PlanNode[], depth: number, parent = ''): HTMLElement =>
    h(
      'ul',
      { class: 'sum-tree' },
      ...items.map((n, i) =>
        h(
          'li',
          { class: `sum-lvl${depth + 1}` },
          h(
            'div',
            { class: 'sum-node' },
            h('span', { class: 'sum-fold' }),
            h('span', { class: 'sum-num' }, depth === 0 ? String(i + 1) : `${parent}.${i + 1}`),
            h('span', { class: 'sum-title' }, n.title),
            n.at !== null && url ? h('a', { class: 'sum-ts', href: timestampUrl(url, n.at), target: '_blank', rel: 'noopener', title: `Ouvrir la leçon à ${formatTimecode(n.at)}` }, formatTimecode(n.at)) : h('span', {}),
          ),
          depth < 1 && n.children.length ? list(n.children, depth + 1, String(i + 1)) : null,
        ),
      ),
    );
  return list(nodes, 0);
}

function progressCard(): HTMLElement {
  const step = running?.step;
  let label = 'Préparation…';
  if (step?.phase === 'lesson') label = `Leçon ${step.k} sur ${step.n} — « ${step.title} », lue en entier`;
  else if (step?.phase === 'read') label = step.n > 1 ? `« ${step.title ?? ''} » : partie ${step.k} sur ${step.n} de la transcription` : `« ${step.title ?? ''} » : toute la transcription`;
  else if (step?.phase === 'merge') label = `« ${step.title ?? ''} » : les parties réunies`;
  else if (step?.phase === 'course') label = 'Synthèse du cours entier…';
  else if (step?.phase === 'wait') label = `Limite du palier gratuit atteinte : reprise dans ${step.seconds} s`;
  return h('div', { class: 'sum-progress', role: 'status' }, h('b', {}, 'Résumé du cours en cours…'), h('p', { class: 'sum-step' }, label), h('p', { class: 'sum-hint' }, 'Chaque leçon est lue en entier — toute sa transcription —, puis le cours.'));
}

function renderMain(): void {
  if (!content) {
    main.replaceChildren(h('p', { class: 'sum-empty-text' }, 'Chargement…'));
    return;
  }
  const c = content;
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
        summary ? h('span', { class: 'sum-ai', title: `Écrit par ${summary.provider} (${summary.model})` }, icon('sparkles', 12), 'IA · à vérifier') : null,
      ),
    ),
  ];
  if (running) out.push(progressCard());
  if (error) {
    out.push(
      h(
        'div',
        { class: 'sum-error', role: 'alert' },
        icon('alert', 16),
        h('div', {}, h('p', {}, `Résumé impossible : ${error.text}.`), h('div', { class: 'sum-row' }, button('Réessayer', 'refresh', () => void generate()), error.setup ? button('Choisir une IA…', 'settings', () => void callBackground({ type: 'options:open', section: 'questions' })) : null)),
      ),
    );
  }
  if (!c.lessons.length) {
    out.push(h('div', { class: 'sum-note dashed' }, h('p', {}, 'Ce cours n’a pas encore de leçon dans ce navigateur : rangez-y des notes (« Ranger dans un cours », dans le panneau).')));
    main.replaceChildren(...out.filter((x): x is HTMLElement => x !== null));
    return;
  }
  if (!summary && !running) {
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
  if (summary) {
    const stale = staleLessons(summary, c);
    if (stale.length && !running) out.push(h('div', { class: 'sum-stale' }, h('p', {}, h('b', {}, `${stale.length} leçon${stale.length > 1 ? 's' : ''} à mettre à jour`), ` : ${stale.map((l) => `« ${l.title} »`).join(', ')}.`)));
    out.push(h('div', { class: 'three' }, ...courseCards(summary)));
    const chapters = summary.chapters.map((ch, ci) => {
      const lessons = h(
        'div',
        { class: 'lessons' },
        ...ch.lessons.flatMap((ref, li) => {
          const l = c.lessons.find((x) => x.noteId === ref.noteId);
          const parts = l?.summary?.plan ?? [];
          const row = h(
            'div',
            { class: `lesson${parts.length ? ' open' : ''}`, id: `lesson-${ref.noteId}` },
            h('span', { class: 'n' }, `${ci + 1}.${li + 1}`),
            h('span', { class: 't' }, ref.title, ref.state === 'none' ? h('small', { class: 'warn' }, 'Pas de transcription — ouvrez la leçon avec ses sous-titres pour la résumer.') : ref.synthesis ? h('small', {}, ref.synthesis) : null),
            h('span', { class: 'dur' }, ref.duration ? formatTimecode(ref.duration) : ''),
            ref.url ? h('a', { class: 'go', href: ref.url, target: '_blank', rel: 'noopener' }, icon('play', 12), 'Ouvrir') : h('span', {}),
          );
          return parts.length ? [row, h('div', { class: 'parts' }, partsList(parts, ref.url))] : [row];
        }),
      );
      const fold = h('button', { type: 'button', class: 'chev', 'aria-expanded': 'true', 'aria-label': `Replier le chapitre ${ci + 1}` }, icon('chevronDown', 15));
      fold.addEventListener('click', () => {
        const open = fold.getAttribute('aria-expanded') !== 'true';
        fold.setAttribute('aria-expanded', String(open));
        lessons.hidden = !open;
      });
      return h(
        'div',
        { class: 'chap' },
        h('div', { class: 'chap-row' }, fold, h('span', {}, h('b', {}, `${ci + 1} · ${ch.title}`), ch.synthesis ? h('span', { class: 'syn' }, ch.synthesis) : null), h('span', { class: 'dur' }, `${ch.lessons.length} leçon${ch.lessons.length > 1 ? 's' : ''}`)),
        lessons,
      );
    });
    out.push(
      h(
        'section',
        { class: 'sum-card sum-plan plan', 'aria-label': 'Plan du cours' },
        h('h3', { class: 'sum-head' }, h('span', { class: 'sum-ico' }, icon('outline', 15)), h('span', {}, 'Plan du cours'), h('span', { class: 'sum-count' }, 'chapitres › leçons › parties — un clic ouvre la leçon à l’instant')),
        ...chapters,
      ),
    );
    out.push(h('p', { class: 'sum-hint' }, `Généré le ${new Date(summary.createdAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })} · ${summary.full ? 'd’après toutes les transcriptions, lues ensemble' : 'd’après les résumés des leçons, chacune lue en entier'}`));
  }
  main.replaceChildren(...out.filter((x): x is HTMLElement => x !== null));
}

function render(): void {
  document.title = `Boo Notes — ${content?.course ?? course} : résumé du cours`;
  renderSide();
  renderActions();
  renderMain();
}

async function load(): Promise<void> {
  [content, summary] = await Promise.all([courseContent(course), getCourseSummary(course)]);
  render();
}

async function generate(): Promise<void> {
  if (running) return;
  running = { ctrl: new AbortController(), step: null };
  error = null;
  render();
  const run = running;
  try {
    const writer = await writerFor();
    summary = await summarizeCourse(course, writer, {
      signal: run.ctrl.signal,
      onStep: (step) => {
        run.step = step;
        renderMain();
      },
    });
    content = await courseContent(course);
    say('Résumé du cours prêt');
  } catch (e) {
    if (!run.ctrl.signal.aborted) error = { text: e instanceof Error ? e.message : String(e), setup: e instanceof NoWriterError };
    content = await courseContent(course).catch(() => content);
  } finally {
    running = null;
    render();
  }
}

async function loadProvider(): Promise<void> {
  const qa = await loadQa();
  provider = isRemote(qa.provider) ? `${PROVIDERS[qa.provider].label}${qa.model ? ` · ${qa.model}` : ''}` : providerLabel(qa.provider);
  if (!running) renderMain();
}

document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => (document.documentElement.dataset.theme = e.matches ? 'dark' : 'light'));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || running) return;
  if (changes['qa:config']) void loadProvider();
  // Made elsewhere (the panel), or a lesson's transcript grew.
  if (changes[courseSummaryKey(normalizeTitle(course))] || Object.keys(changes).some((k) => k.startsWith('summary:') || k.startsWith('transcript:'))) void load();
});
void loadProvider();
void load();
