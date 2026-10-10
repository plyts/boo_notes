import { providerLabel, PROVIDERS, isRemote } from '../shared/ai-providers';
import { h, icon } from '../shared/icons';
import { loadQa } from '../shared/qa-config';
import { coverage, courseSummaryKey, isStale, lessonMarkdown, summaryKey, type CourseSummary, type LessonSummary, type PartDigest, type PlanNode } from '../shared/summary';
import {
  courseContent,
  courseText,
  getCourseSummary,
  getLessonSummary,
  NoWriterError,
  putLessonSummary,
  staleLessons,
  summarizeCourse,
  summarizeLesson,
  writerFor,
  type CourseContent,
  type SummaryStep,
} from '../shared/summarizer';
import { normalizeTitle } from '../shared/markdown';
import { formatTimecode } from '../shared/time';
import type { Transcript } from '../shared/transcript';
import { courseCards, lessonCards, markCurrent, planCounts, planTree } from './summary-render';

/**
 * The panel's « Résumé » tab. « Cette leçon »: the summary of the video's
 * whole transcript — problem, goals, solution, the course as a hierarchy —
 * written by the AI chosen in the options, its moments clickable; inserted
 * at the top of the note in one click. « Tout le cours »: every lesson of
 * the course read in full, then the course; the large page opens from here.
 */

export interface SummaryHooks {
  seek(seconds: number): void;
  /** Writes the block at the top of the note (an older one replaced). */
  insert(markdown: string): void;
  notify(text: string, kind?: 'info' | 'success' | 'error'): void;
  /** The course's page (large). */
  openCourse(course: string): void;
  openOptions(): void;
}

export interface SummaryContext {
  noteId: string;
  title: string;
  course: string | null;
  chapter: string | null;
  /** The video plays here (moments clickable). */
  timed: boolean;
}

type Run = { scope: 'lesson' | 'course'; ctrl: AbortController; step: SummaryStep | null; outline: PartDigest[]; partsTotal: number };

const minutes = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)} s`);

export class SummaryView {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly foot: HTMLElement;
  private ctx: SummaryContext | null = null;
  private transcript: Transcript | null = null;
  private lesson: LessonSummary | null = null;
  private course: CourseSummary | null = null;
  private content: CourseContent | null = null;
  private scope: 'lesson' | 'course' = 'lesson';
  private run: Run | null = null;
  private error: { text: string; setup: boolean } | null = null;
  private provider = '';
  private now: number | null = null;
  private loadSeq = 0;

  constructor(private readonly hooks: SummaryHooks) {
    this.body = h('div', { class: 'sum-body' });
    this.foot = h('div', { class: 'sum-foot', hidden: true });
    this.el = h('section', { class: 'summary', hidden: true }, this.body, this.foot);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !this.ctx) return;
      // Written elsewhere (the course page, another window): shown here too.
      if (changes[summaryKey(this.ctx.noteId)] && !this.run) {
        this.lesson = (changes[summaryKey(this.ctx.noteId)].newValue as LessonSummary | undefined) ?? null;
        this.render();
      }
      if (this.ctx.course && changes[courseSummaryKey(normalizeTitle(this.ctx.course))] && !this.run) void this.loadCourse();
      if (changes['qa:config']) void this.loadProvider();
    });
    void this.loadProvider();
  }

  show(visible: boolean): void {
    this.el.hidden = !visible;
    if (visible && this.scope === 'course' && !this.content) void this.loadCourse();
  }

  /** The note shown changed (another video), or its course. */
  async set(ctx: SummaryContext | null): Promise<void> {
    const same = ctx?.noteId === this.ctx?.noteId;
    const courseChanged = ctx?.course !== this.ctx?.course;
    this.ctx = ctx;
    if (!same) {
      this.run?.ctrl.abort();
      this.run = null;
      this.error = null;
      this.lesson = null;
      this.transcript = null;
      this.scope = 'lesson';
    }
    if (courseChanged) {
      this.course = null;
      this.content = null;
    }
    const seq = ++this.loadSeq;
    if (ctx && !same) {
      const stored = await getLessonSummary(ctx.noteId).catch(() => null);
      if (seq !== this.loadSeq) return;
      this.lesson = stored;
    }
    this.render();
  }

  setTranscript(t: Transcript | null): void {
    this.transcript = t;
    if (!this.run) this.render();
  }

  /** The video's moment: the part being watched lit in the plan. */
  setTime(seconds: number | null): void {
    this.now = seconds;
    if (this.el.hidden || this.scope !== 'lesson') return;
    const tree = this.body.querySelector<HTMLElement>('.sum-plan-tree');
    if (tree) markCurrent(tree, seconds);
  }

  private async loadProvider(): Promise<void> {
    const qa = await loadQa().catch(() => null);
    if (!qa) return;
    this.provider = isRemote(qa.provider) ? `${PROVIDERS[qa.provider].label}${qa.model ? ` · ${qa.model}` : ''}` : providerLabel(qa.provider);
    if (!this.run) this.render();
  }

  private async loadCourse(): Promise<void> {
    const course = this.ctx?.course;
    if (!course) return;
    const [content, summary] = await Promise.all([courseContent(course), getCourseSummary(course)]).catch(() => [null, null] as const);
    if (this.ctx?.course !== course) return;
    this.content = content;
    this.course = summary;
    this.render();
  }

  // --- Actions ----------------------------------------------------------------------------------

  private async generateLesson(): Promise<void> {
    const ctx = this.ctx;
    const t = this.transcript;
    if (!ctx || !t?.cues.length || this.run) return;
    const run: Run = { scope: 'lesson', ctrl: new AbortController(), step: null, outline: [], partsTotal: 0 };
    this.run = run;
    this.error = null;
    this.render();
    try {
      const writer = await writerFor();
      const summary = await summarizeLesson({ noteId: ctx.noteId, title: ctx.title, course: ctx.course, chapter: ctx.chapter, transcript: t }, writer, {
        signal: run.ctrl.signal,
        onStep: (step) => this.progress(run, step),
        onPart: (digest, _k, n) => {
          run.outline.push(digest);
          run.partsTotal = n;
          this.render();
        },
      });
      if (this.run !== run || this.ctx?.noteId !== ctx.noteId) return;
      await putLessonSummary(summary);
      this.lesson = summary;
      this.hooks.notify('Résumé de la leçon prêt', 'success');
    } catch (e) {
      if (this.run === run && !run.ctrl.signal.aborted) this.error = { text: e instanceof Error ? e.message : String(e), setup: e instanceof NoWriterError };
    } finally {
      if (this.run === run) this.run = null;
      this.render();
    }
  }

  private async generateCourse(): Promise<void> {
    const course = this.ctx?.course;
    if (!course || this.run) return;
    const run: Run = { scope: 'course', ctrl: new AbortController(), step: null, outline: [], partsTotal: 0 };
    this.run = run;
    this.error = null;
    this.render();
    try {
      const writer = await writerFor();
      this.course = await summarizeCourse(course, writer, { signal: run.ctrl.signal, onStep: (step) => this.progress(run, step) });
      this.content = await courseContent(course);
      const mine = this.ctx ? this.content.lessons.find((l) => l.noteId === this.ctx?.noteId)?.summary : null;
      if (mine) this.lesson = mine;
      this.hooks.notify('Résumé du cours prêt', 'success');
    } catch (e) {
      if (this.run === run && !run.ctrl.signal.aborted) this.error = { text: e instanceof Error ? e.message : String(e), setup: e instanceof NoWriterError };
    } finally {
      if (this.run === run) this.run = null;
      this.render();
    }
  }

  private progress(run: Run, step: SummaryStep): void {
    if (this.run !== run) return;
    run.step = step;
    this.render();
  }

  private stop(): void {
    this.run?.ctrl.abort();
    this.run = null;
    this.render();
  }

  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.hooks.notify('Résumé copié', 'success');
    } catch (e) {
      this.hooks.notify(`Copie impossible : ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  // --- Drawing ----------------------------------------------------------------------------------

  private render(): void {
    const scopeBar = this.scopeBar();
    const content = this.scope === 'course' ? this.renderCourse() : this.renderLesson();
    this.body.replaceChildren(...[scopeBar, ...content].filter((x): x is HTMLElement => x !== null));
    this.renderFoot();
    if (this.scope === 'lesson') this.setTime(this.now);
  }

  private scopeBar(): HTMLElement | null {
    if (!this.ctx) return null;
    const seg = (scope: 'lesson' | 'course', label: string) => {
      const b = h('button', { type: 'button', role: 'tab', class: 'sum-seg-btn', 'aria-selected': String(this.scope === scope) }, label);
      b.addEventListener('click', () => {
        if (this.scope === scope) return;
        this.scope = scope;
        this.error = null;
        if (scope === 'course' && !this.content) void this.loadCourse();
        this.render();
      });
      return b;
    };
    const ai = this.scope === 'lesson' ? this.lesson : this.course;
    return h(
      'div',
      { class: 'sum-bar' },
      h('div', { class: 'sum-seg', role: 'tablist', 'aria-label': 'Résumé de' }, seg('lesson', 'Cette leçon'), seg('course', 'Tout le cours')),
      ai && !this.run ? h('span', { class: 'sum-ai', title: `Écrit par ${providerLabel(ai.provider as never) || ai.provider} (${ai.model}) — à vérifier` }, icon('sparkles', 12), 'IA · à vérifier') : null,
    );
  }

  private errorCard(retry: () => void): HTMLElement | null {
    if (!this.error) return null;
    const again = h('button', { type: 'button', class: 'sum-btn' }, icon('refresh', 14), 'Réessayer');
    again.addEventListener('click', retry);
    const options = h('button', { type: 'button', class: 'sum-btn' }, 'Choisir une IA…');
    options.addEventListener('click', () => this.hooks.openOptions());
    return h('div', { class: 'sum-error', role: 'alert' }, icon('alert', 16), h('div', {}, h('p', {}, `Résumé impossible : ${this.error.text}.`), h('div', { class: 'sum-row' }, again, this.error.setup ? options : null)));
  }

  private providerLine(): HTMLElement {
    const change = h('button', { type: 'button', class: 'sum-link' }, 'changer');
    change.addEventListener('click', () => this.hooks.openOptions());
    return h('p', { class: 'sum-provider' }, icon('sparkles', 13), h('span', {}, `IA : ${this.provider || '…'} · `), change);
  }

  private progressCard(run: Run): HTMLElement {
    const step = run.step;
    const stop = h('button', { type: 'button', class: 'sum-btn ghost' }, icon('stop', 13), 'Arrêter');
    stop.addEventListener('click', () => this.stop());
    let label = 'Préparation…';
    let ratio = 0.05;
    if (step?.phase === 'read') {
      label = step.n > 1 ? `Lecture de la transcription — partie ${step.k} sur ${step.n}` : 'Lecture de toute la transcription…';
      ratio = step.n > 1 ? (step.k - 0.5) / (step.n + 1) : 0.45;
    } else if (step?.phase === 'merge') {
      label = 'Les parties réunies : problématique, objectifs, solution, plan…';
      ratio = 0.9;
    } else if (step?.phase === 'lesson') {
      label = `Leçon ${step.k} sur ${step.n} — « ${step.title} », lue en entier`;
      ratio = (step.k - 0.5) / (step.n + 1);
    } else if (step?.phase === 'course') {
      label = 'Synthèse du cours entier…';
      ratio = 0.94;
    } else if (step?.phase === 'wait') {
      label = `Limite du palier gratuit atteinte : reprise dans ${step.seconds} s`;
    }
    return h(
      'div',
      { class: 'sum-progress', role: 'status' },
      h('div', { class: 'sum-row spread' }, h('b', {}, run.scope === 'course' ? 'Résumé du cours en cours…' : 'Résumé en cours…'), stop),
      h('div', { class: 'sum-bar-track' }, h('i', { style: `width:${Math.round(ratio * 100)}%` })),
      h('p', { class: 'sum-step' }, label),
      h('p', { class: 'sum-hint' }, 'Vous pouvez continuer vos notes : le résumé arrive ici.'),
    );
  }

  private renderLesson(): HTMLElement[] {
    const ctx = this.ctx;
    if (!ctx) return [h('p', { class: 'sum-empty-text' }, 'Ouvrez une vidéo : son résumé se fait à partir de sa transcription.')];
    const t = this.transcript;
    const cov = coverage(t);
    const out: HTMLElement[] = [];
    if (this.run?.scope === 'lesson') {
      out.push(this.progressCard(this.run));
      // The plan grows while the parts are read.
      if (this.run.outline.length) {
        const nodes: PlanNode[] = this.run.outline.flatMap((d) => d.sections.map((s) => ({ title: s.title, at: null, children: s.points.map((p) => ({ title: p.title, at: null, children: [] })) })));
        out.push(h('section', { class: 'sum-card sum-plan sum-growing' }, h('h3', { class: 'sum-head' }, h('span', { class: 'sum-ico' }, icon('outline', 15)), h('span', {}, `Plan — ${this.run.outline.length} partie${this.run.outline.length > 1 ? 's' : ''} lue${this.run.outline.length > 1 ? 's' : ''} sur ${this.run.partsTotal}`)), planTree(nodes, {})));
      }
      return out;
    }
    const err = this.errorCard(() => void this.generateLesson());
    if (err) out.push(err);
    if (this.lesson) {
      if (isStale(this.lesson, t)) {
        const update = h('button', { type: 'button', class: 'sum-btn primary' }, icon('refresh', 14), 'Mettre à jour');
        update.addEventListener('click', () => void this.generateLesson());
        const grew = t && t.cues.length > this.lesson.basis.cues ? ` (+ ${minutes(Math.max(0, coverage(t).covered - this.lesson.basis.covered))} de sous-titres)` : '';
        out.push(h('div', { class: 'sum-stale' }, h('p', {}, h('b', {}, 'La transcription a changé depuis ce résumé'), grew, '.'), h('div', { class: 'sum-row' }, update)));
      }
      out.push(...this.lessonResult(this.lesson));
      return out;
    }
    if (cov.state === 'none') {
      out.push(
        h(
          'div',
          { class: 'sum-note dashed' },
          h('p', {}, h('b', {}, 'Pas encore de transcription.'), ' Le résumé se fait à partir des sous-titres : activez ceux du lecteur (Boo Notes prend alors le fichier entier), ou importez un .vtt / .srt dans l’onglet Transcription.'),
        ),
      );
      return out;
    }
    const go = h('button', { type: 'button', class: 'sum-btn primary big' }, icon('sparkles', 16), cov.state === 'partial' ? `Résumer ces ${minutes(cov.covered)}` : 'Générer le résumé');
    go.addEventListener('click', () => void this.generateLesson());
    out.push(
      h(
        'div',
        { class: 'sum-empty' },
        h('span', { class: 'sum-halo' }, icon('sparkles', 26)),
        h('h4', {}, 'Résumer cette leçon'),
        h('p', {}, 'Boo Notes lit toute la transcription et en tire, avec les instants de la vidéo :'),
        h('div', { class: 'sum-chips' }, h('span', { class: 'c1' }, 'Problématique'), h('span', { class: 'c2' }, 'Objectifs'), h('span', { class: 'c3' }, 'Solution'), h('span', { class: 'c4' }, 'Plan hiérarchisé')),
      ),
    );
    if (cov.state === 'partial') {
      out.push(
        h(
          'div',
          { class: 'sum-warn', role: 'note' },
          icon('alert', 16),
          h('p', {}, h('b', {}, `La transcription ne couvre que ${minutes(cov.covered)} sur ${formatTimecode(cov.duration)}.`), ' Les sous-titres ont été captés pendant la lecture : le résumé ne porterait que sur ces passages. Pour tout couvrir, activez les sous-titres du lecteur ou importez un .vtt / .srt.'),
        ),
      );
    } else {
      out.push(h('p', { class: 'sum-ok' }, icon('check', 14), `Transcription complète · ${t?.cues.length ?? 0} répliques${cov.duration ? ` · ${formatTimecode(cov.duration)}` : ''}`));
    }
    out.push(go, this.providerLine());
    return out;
  }

  private lessonResult(s: LessonSummary): HTMLElement[] {
    const seek = this.ctx?.timed ? { seek: (sec: number) => this.hooks.seek(sec) } : {};
    const b = s.basis;
    const src = h(
      'p',
      { class: 'sum-srcline' },
      icon('subtitles', 13),
      `D’après la transcription${b.label ? ` · ${b.label}` : ''} · `,
      h('span', { class: b.complete || b.covered >= b.duration * 0.9 ? 'ok' : 'warn' }, b.complete || !b.duration || b.covered >= b.duration * 0.9 ? '100 % de la vidéo' : `${minutes(b.covered)} sur ${formatTimecode(b.duration)}`),
      s.parts > 1 ? ` · lue en ${s.parts} parties` : '',
    );
    const counts = planCounts(s.plan);
    const plan = s.plan.length
      ? h(
          'section',
          { class: 'sum-card sum-plan', 'aria-label': 'Plan du cours' },
          h('h3', { class: 'sum-head' }, h('span', { class: 'sum-ico' }, icon('outline', 15)), h('span', {}, 'Plan du cours'), h('span', { class: 'sum-count' }, `${counts.parts} parties · ${counts.points} points`)),
          (() => {
            const tree = planTree(s.plan, seek);
            tree.classList.add('sum-plan-tree');
            return tree;
          })(),
        )
      : null;
    return [src, ...lessonCards(s, seek), plan].filter((x): x is HTMLElement => x !== null);
  }

  private renderCourse(): HTMLElement[] {
    const course = this.ctx?.course;
    if (!course) {
      return [h('div', { class: 'sum-note dashed' }, h('p', {}, h('b', {}, 'Cette leçon n’est rangée dans aucun cours.'), ' Rangez-la (« Ranger dans un cours », en haut) avec les autres leçons : leur résumé commun se fait ici, d’après toutes leurs transcriptions.'))];
    }
    const out: HTMLElement[] = [];
    if (this.run?.scope === 'course') return [this.progressCard(this.run)];
    const err = this.errorCard(() => void this.generateCourse());
    if (err) out.push(err);
    const content = this.content;
    if (!content) return [...out, h('p', { class: 'sum-empty-text' }, 'Chargement du cours…')];
    const withText = content.lessons.filter((l) => l.transcript?.cues.length);
    const seconds = withText.reduce((n, l) => n + l.duration, 0);
    if (!this.course) {
      const go = h('button', { type: 'button', class: 'sum-btn primary big' }, icon('sparkles', 16), 'Générer le résumé du cours');
      go.disabled = !withText.length;
      go.addEventListener('click', () => void this.generateCourse());
      out.push(
        h(
          'div',
          { class: 'sum-empty' },
          h('span', { class: 'sum-halo' }, icon('course', 26)),
          h('h4', {}, course),
          h('p', {}, `${content.chapters.length} chapitre${content.chapters.length > 1 ? 's' : ''} · ${content.lessons.length} leçon${content.lessons.length > 1 ? 's' : ''} · ${withText.length} avec transcription${seconds ? ` (${minutes(seconds)})` : ''}`),
          h('p', {}, 'Chaque leçon est lue en entier — toute sa transcription —, puis le cours : sa problématique, ses objectifs, sa démarche et son plan, chapitre par chapitre.'),
        ),
        go,
        this.providerLine(),
      );
      return out;
    }
    const stale = staleLessons(this.course, content);
    if (stale.length) {
      const update = h('button', { type: 'button', class: 'sum-btn primary' }, icon('refresh', 14), 'Mettre à jour');
      update.addEventListener('click', () => void this.generateCourse());
      out.push(h('div', { class: 'sum-stale' }, h('p', {}, h('b', {}, `${stale.length} leçon${stale.length > 1 ? 's' : ''} à mettre à jour`), ` : ${stale.map((l) => `« ${l.title} »`).join(', ')}.`), h('div', { class: 'sum-row' }, update)));
    }
    out.push(h('p', { class: 'sum-srcline' }, icon('course', 13), `${content.lessons.length} leçons · d’après ${Object.keys(this.course.read).length} transcription${Object.keys(this.course.read).length > 1 ? 's' : ''}${this.course.full ? ' lues ensemble' : ''}`));
    out.push(...courseCards(this.course));
    const chapters = this.course.chapters.map((c, i) =>
      h(
        'li',
        { class: 'sum-chapter' },
        h('div', { class: 'sum-chapter-head' }, h('b', {}, `${i + 1} · ${c.title}`), c.synthesis ? h('span', {}, c.synthesis) : null),
        h(
          'ol',
          { class: 'sum-lessons' },
          ...c.lessons.map((l) => {
            const here = l.noteId === this.ctx?.noteId;
            return h('li', { class: here ? 'here' : '' }, h('span', { class: 'sum-title' }, l.title), l.state === 'none' ? h('small', { class: 'warn' }, 'pas de transcription') : l.synthesis ? h('small', {}, l.synthesis) : null);
          }),
        ),
      ),
    );
    out.push(h('section', { class: 'sum-card sum-plan', 'aria-label': 'Plan du cours' }, h('h3', { class: 'sum-head' }, h('span', { class: 'sum-ico' }, icon('outline', 15)), h('span', {}, 'Plan du cours')), h('ol', { class: 'sum-chapters' }, ...chapters)));
    return out;
  }

  private renderFoot(): void {
    const buttons: HTMLElement[] = [];
    if (!this.run && this.scope === 'lesson' && this.lesson) {
      const s = this.lesson;
      const insert = h('button', { type: 'button', class: 'sum-btn primary' }, icon('plus', 15), 'Insérer dans la note');
      insert.addEventListener('click', () => {
        this.hooks.insert(lessonMarkdown(s));
        this.hooks.notify('Résumé inséré en tête de la note', 'success');
      });
      const copy = h('button', { type: 'button', class: 'sum-btn' }, icon('copy', 15), 'Copier');
      copy.addEventListener('click', () => void this.copy(lessonMarkdown(s).replace(/^> ?/gm, '')));
      const again = h('button', { type: 'button', class: 'sum-btn ghost icon-only', title: 'Régénérer le résumé', 'aria-label': 'Régénérer' }, icon('refresh', 15));
      again.addEventListener('click', () => void this.generateLesson());
      buttons.push(insert, copy, h('span', { class: 'spacer' }), again);
    }
    if (!this.run && this.scope === 'course' && this.course && this.content && this.ctx?.course) {
      const course = this.ctx.course;
      const open = h('button', { type: 'button', class: 'sum-btn primary' }, icon('expand', 15), 'Ouvrir en grand');
      open.addEventListener('click', () => this.hooks.openCourse(course));
      const s = this.course;
      const content = this.content;
      const copy = h('button', { type: 'button', class: 'sum-btn' }, icon('copy', 15), 'Copier');
      copy.addEventListener('click', () => void this.copy(courseText(s, content)));
      const again = h('button', { type: 'button', class: 'sum-btn ghost icon-only', title: 'Régénérer le résumé du cours', 'aria-label': 'Régénérer' }, icon('refresh', 15));
      again.addEventListener('click', () => void this.generateCourse());
      buttons.push(open, copy, h('span', { class: 'spacer' }), again);
    }
    this.foot.replaceChildren(...buttons);
    this.foot.hidden = !buttons.length;
  }
}

