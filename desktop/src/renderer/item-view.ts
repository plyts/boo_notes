import { captureLine, pageRefToken, timestampToken } from '../../../src/shared/markdown';
import { KIND_LABELS, PLATFORM_LABELS } from '../../../src/shared/platforms';
import { formatTimecode } from '../../../src/shared/time';
import type { AppStatus, ItemView, StudyStatus } from '../ipc';
import { MediaViewer } from './media-viewer';
import { NotesPane } from './notes-pane';
import { PdfViewer } from './pdf-viewer';
import {
  button,
  duration,
  errorMessage,
  h,
  icon,
  iconButton,
  KIND_ICON,
  percent,
  progressBar,
  relativeTime,
  showMenu,
  toast,
} from './ui';

const STATUS_OPTIONS: Array<{ value: StudyStatus | null; label: string }> = [
  { value: null, label: 'Automatique' },
  { value: 'todo', label: 'À commencer' },
  { value: 'doing', label: 'En cours' },
  { value: 'done', label: 'Terminé' },
];

export interface ItemViewHost {
  back(): void;
  openSettings(section?: string): void;
  status(): AppStatus | null;
}

/** A course open for study: viewer (PDF / media / web course) + notes, side by side. */
export class ItemScreen {
  readonly el: HTMLElement;
  private item: ItemView;
  private notes!: NotesPane;
  private pdf: PdfViewer | null = null;
  private media: MediaViewer | null = null;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private readonly notionBtn: HTMLButtonElement;
  private readonly statusBtn: HTMLButtonElement;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private studyTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = Date.now();
  private disposed = false;

  constructor(
    item: ItemView,
    private readonly host: ItemViewHost,
  ) {
    this.item = item;
    this.notionBtn = h('button', { type: 'button', class: 'btn plain notion-btn' });
    this.notionBtn.addEventListener('click', () => this.onNotion());
    this.statusBtn = h('button', { type: 'button', class: 'status-pill', 'aria-haspopup': 'menu' });
    this.statusBtn.addEventListener('click', () => this.statusMenu());
    this.header = h('header', { class: 'item-head' });
    this.body = h('div', { class: 'item-body' });
    this.el = h('div', { class: `item-screen kind-${item.kind}` }, this.header, this.body);
    this.renderHeader();
  }

  get id(): string {
    return this.item.id;
  }

  async mount(): Promise<void> {
    const { item } = this;
    const readOnly = item.origin !== 'desktop';
    this.notes = new NotesPane({
      item,
      readOnly,
      stamp: () => this.stamp(),
      now: () => (this.media ? this.media.time : null),
      onTimestampClick: (s) => this.onTimestamp(s),
      onPageRefClick: (p) => this.pdf?.goTo(p),
      onKeystroke: () => {
        this.activity();
        this.media?.autoPause.keystroke();
      },
      onContentChanged: (md) => {
        this.media?.setNote(md);
        // Re-highlight the note of the page being read (after the editor update).
        if (this.pdf) queueMicrotask(() => this.pdf && this.notes.editor.setCurrentPage(this.pdf.page));
      },
    });
    const viewer = await this.createViewer();
    const resizer = h('div', { class: 'resizer', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', title: 'Glisser pour redimensionner' });
    this.body.replaceChildren(viewer, resizer, this.notes.el);
    this.setupResizer(resizer);
    this.notes.load(await window.boo.library.readNote(item.id));
    this.notes.setActions(...this.actions());
    await this.pdf?.open().catch((e: unknown) => {
      viewer.replaceChildren(this.problem('Impossible d’ouvrir ce PDF', errorMessage(e)));
    });
    this.studyTimer = setInterval(() => {
      if (document.hasFocus() && Date.now() - this.lastActivity < 60_000) {
        void window.boo.library.addStudyTime(item.id, 15_000);
      }
    }, 15_000);
  }

  /** Library data changed (sync state, progress from the browser…). */
  update(item: ItemView): void {
    this.item = { ...item };
    this.renderHeader();
  }

  onStatus(): void {
    this.renderNotion();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
      if (this.pdf) await window.boo.library.setProgress(this.item.id, this.pdf.page, this.pdf.pages).catch(() => undefined);
    }
    if (this.studyTimer) clearInterval(this.studyTimer);
    await this.notes?.flush();
    this.media?.destroy();
    this.pdf?.destroy();
  }

  /** Keyboard shortcuts of the study screen (same as the extension). */
  handleKey(e: KeyboardEvent): boolean {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const altShift = e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
    const mod = e.ctrlKey || e.metaKey;
    if (altShift && (key === 't' || e.code === 'KeyT')) {
      const token = this.stamp();
      if (token) this.notes.stampLine(token);
      return true;
    }
    if (altShift && (key === 'n' || e.code === 'KeyN')) {
      this.notes.focus();
      return true;
    }
    if (altShift && (key === 's' || e.code === 'KeyS')) {
      void this.capture();
      return true;
    }
    if (altShift && e.code === 'Space') {
      this.media?.toggle();
      return true;
    }
    if (e.altKey && !e.shiftKey && !mod && key === 'ArrowLeft' && this.media) {
      this.media.skip(-5);
      return true;
    }
    if (altShift && (key === 'q' || e.code === 'KeyQ') && this.pdf) {
      const sel = this.pdf.currentSelection();
      if (sel) this.quote(sel.text, sel.page);
      else toast('Sélectionnez un passage du PDF à citer');
      return true;
    }
    if (altShift && (key === 'h' || e.code === 'KeyH') && this.pdf) {
      if (!this.pdf.highlightSelection('yellow')) toast('Sélectionnez un passage du PDF à surligner');
      return true;
    }
    if (mod && this.pdf && (key === '=' || key === '+')) {
      this.pdf.zoom(1.15);
      return true;
    }
    if (mod && this.pdf && key === '-') {
      this.pdf.zoom(1 / 1.15);
      return true;
    }
    if (mod && this.pdf && key === '0') {
      this.pdf.setFitWidth();
      return true;
    }
    return false;
  }

  // --- Viewer --------------------------------------------------------------------------------

  private async createViewer(): Promise<HTMLElement> {
    const { item } = this;
    if (item.origin !== 'desktop') return this.webCourse();
    if (item.kind === 'pdf') {
      let data: Uint8Array;
      try {
        data = await window.boo.library.readFile(item.id);
      } catch (e) {
        return this.problem('Fichier introuvable', `${errorMessage(e)} — ${item.source}`);
      }
      this.pdf = new PdfViewer({
        data,
        startPage: Math.max(1, Math.round(item.progress?.position ?? 1)),
        highlights: item.highlights ?? [],
        onPageChange: (page, pages) => this.onPage(page, pages),
        onHighlightsChange: (list) => {
          void window.boo.library.setHighlights(item.id, list).catch((e: unknown) => toast(errorMessage(e), 'error'));
        },
        onQuote: (text, page) => this.quote(text, page),
        onActivity: () => this.activity(),
      });
      return this.pdf.el;
    }
    this.media = new MediaViewer({
      item,
      onTime: (t) => this.notes.editor.setPlaybackTime(t),
      onProgress: (position, d) => void window.boo.library.setProgress(item.id, position, d),
      onActivity: () => this.activity(),
    });
    this.media.media.addEventListener('error', () => {
      this.media?.el.replaceChildren(this.problem('Lecture impossible', `Format non lu ou fichier déplacé : ${item.source}`));
    });
    return this.media.el;
  }

  /** A course noted in the browser: summary, resume link and read-only note. */
  private webCourse(): HTMLElement {
    const { item } = this;
    const yt = /[?&]v=([\w-]{6,20})/.exec(item.source)?.[1];
    const art = h('div', { class: 'course-art' }, icon(KIND_ICON[item.kind], 40));
    if (yt) {
      const img = h('img', { src: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, alt: '', loading: 'lazy' });
      img.addEventListener('error', () => img.remove());
      art.append(img);
    }
    const resumeAt = item.progress?.position;
    const resume = button(
      resumeAt ? `Reprendre à ${formatTimecode(resumeAt)}` : 'Ouvrir le cours',
      { variant: 'primary', icon: 'play' },
      () => void window.boo.library.openSource(item.id, resumeAt),
    );
    return h(
      'section',
      { class: 'web-course', 'aria-label': 'Cours dans le navigateur' },
      art,
      h(
        'div',
        { class: 'web-course-body' },
        h('p', { class: 'eyebrow' }, `${PLATFORM_LABELS[item.platform]} · ${KIND_LABELS[item.kind]}`),
        h('h2', {}, item.title),
        h(
          'div',
          { class: 'web-progress' },
          progressBar(item.ratio),
          h('span', {}, item.progress ? `${percent(item.ratio)} · ${item.positionLabel}` : 'Pas encore commencé'),
        ),
        h('div', { class: 'web-actions' }, resume),
        h(
          'p',
          { class: 'hint' },
          icon('globe', 14),
          h('span', {}, 'Cette note s’écrit dans l’extension Boo Notes du navigateur. Cliquez un horodatage pour rouvrir la vidéo à ce moment.'),
        ),
      ),
    );
  }

  private problem(title: string, text: string): HTMLElement {
    return h('div', { class: 'viewer-problem' }, icon('alert', 28), h('h3', {}, title), h('p', {}, text));
  }

  private actions(): Node[] {
    const { item } = this;
    if (item.origin !== 'desktop') return [];
    if (item.kind === 'pdf') {
      return [
        button('Page', { icon: 'file', small: true, title: 'Nouvelle note sur la page courante (Alt+Shift+T)' }, () => {
          const t = this.stamp();
          if (t) this.notes.stampLine(t);
        }),
        button('Citer', { icon: 'quote', small: true, title: 'Citer la sélection (Alt+Shift+Q)' }, () => {
          const sel = this.pdf?.currentSelection();
          if (sel) this.quote(sel.text, sel.page);
          else toast('Sélectionnez un passage du PDF à citer');
        }),
        button('Surligner', { icon: 'highlight', small: true, title: 'Surligner la sélection (Alt+Shift+H)' }, () => {
          if (!this.pdf?.highlightSelection('yellow')) toast('Sélectionnez un passage du PDF à surligner');
        }),
      ];
    }
    const nodes: Node[] = [
      button('Horodater', { icon: 'clock', small: true, title: 'Nouvelle note horodatée (Alt+Shift+T)' }, () => {
        const t = this.stamp();
        if (t) this.notes.stampLine(t);
      }),
    ];
    if (item.kind === 'video') {
      nodes.push(button('Capturer', { icon: 'camera', small: true, title: 'Capturer l’image (Alt+Shift+S)' }, () => void this.capture()));
    }
    nodes.push(button('5 s', { icon: 'replay', small: true, title: 'Revoir les 5 dernières secondes (Alt+←)' }, () => this.media?.skip(-5)));
    return nodes;
  }

  // --- Behaviour ----------------------------------------------------------------------------

  private stamp(): string | null {
    if (this.pdf) return pageRefToken(this.pdf.page);
    if (this.media) return timestampToken(this.media.time);
    return null;
  }

  private onTimestamp(seconds: number): void {
    if (this.media) {
      this.media.seek(seconds);
      void this.media.media.play().catch(() => undefined);
    } else if (this.item.origin !== 'desktop') {
      void window.boo.library.openSource(this.item.id, seconds);
    }
  }

  private onPage(page: number, pages: number): void {
    this.activity();
    this.notes?.editor.setCurrentPage(page);
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      void window.boo.library.setProgress(this.item.id, page, pages);
    }, 700);
  }

  private quote(text: string, page: number): void {
    const clean = text.replace(/\s+/g, ' ').trim();
    // Quotes follow the reading order: always at the end of the note.
    this.notes.insertBlock(`> ${clean} ${pageRefToken(page)}`, 'end');
    toast(`Citation de la page ${page} ajoutée`, 'success');
  }

  private async capture(): Promise<void> {
    if (!this.media) return;
    if (!this.media.isVideo) {
      toast('Capture indisponible : ce média est audio', 'error');
      return;
    }
    const t = this.media.time;
    const dataUrl = this.media.capture();
    if (!dataUrl) return;
    try {
      const path = await window.boo.library.saveCapture(this.item.id, dataUrl, t);
      this.notes.insertBlock(captureLine(t, path));
      toast(`${formatTimecode(t)} - Capture sauvegardée`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  private activity(): void {
    this.lastActivity = Date.now();
  }

  private setupResizer(resizer: HTMLElement): void {
    const KEY = 'boo.notesWidth';
    const apply = (w: number) => {
      const max = Math.max(360, this.body.clientWidth * 0.6);
      const width = Math.round(Math.min(max, Math.max(320, w)));
      this.body.style.setProperty('--notes-width', `${width}px`);
      return width;
    };
    try {
      const saved = Number(localStorage.getItem(KEY));
      if (saved) apply(saved);
    } catch {
      // Storage unavailable.
    }
    resizer.addEventListener('pointerdown', (e) => {
      resizer.setPointerCapture(e.pointerId);
      resizer.classList.add('dragging');
      const move = (ev: PointerEvent) => {
        const w = apply(this.body.getBoundingClientRect().right - ev.clientX);
        try {
          localStorage.setItem(KEY, String(w));
        } catch {
          // Ignore.
        }
      };
      const up = () => {
        resizer.classList.remove('dragging');
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', up);
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', up);
    });
    resizer.addEventListener('dblclick', () => apply(420));
    resizer.addEventListener('keydown', (e) => {
      const current = this.notes.el.getBoundingClientRect().width;
      if (e.key === 'ArrowLeft') apply(current + 24);
      if (e.key === 'ArrowRight') apply(current - 24);
    });
  }

  // --- Header ----------------------------------------------------------------------------------

  private renderHeader(): void {
    const { item } = this;
    const title = h('h1', { class: 'item-title', title: item.title }, item.title);
    if (item.origin === 'desktop') {
      title.title = `${item.title} — double-cliquer pour renommer`;
      title.addEventListener('dblclick', () => this.rename(title));
    }
    const meta = [
      PLATFORM_LABELS[item.platform],
      KIND_LABELS[item.kind],
      item.positionLabel,
      item.studyMs && item.studyMs >= 60_000 ? `${duration(item.studyMs)} d’étude` : '',
    ].filter(Boolean);
    const more = iconButton('more', 'Plus d’actions', (e) => this.moreMenu(e.currentTarget as HTMLElement));
    more.setAttribute('aria-haspopup', 'menu');
    this.header.replaceChildren(
      iconButton('chevronLeft', 'Bibliothèque (Échap)', () => this.host.back()),
      h('span', { class: `kind-badge ${item.kind}` }, icon(KIND_ICON[item.kind], 18)),
      h('div', { class: 'item-titles' }, title, h('p', { class: 'item-meta' }, meta.join(' · '))),
      h('span', { class: 'spacer' }),
      h('span', { class: 'item-progress', title: `Progression : ${percent(item.ratio)}` }, progressBar(item.ratio), h('span', {}, percent(item.ratio))),
      this.statusBtn,
      this.notionBtn,
      more,
    );
    this.statusBtn.textContent = STATUS_OPTIONS.find((o) => o.value === item.studyStatus)?.label ?? '';
    this.statusBtn.dataset.status = item.studyStatus;
    this.statusBtn.title = item.status ? 'Statut choisi manuellement' : 'Statut déduit de votre progression';
    this.renderNotion();
  }

  private renderNotion(): void {
    const status = this.host.status();
    const connected = status?.notion.connected ?? false;
    const link = this.item.notion;
    const syncing = (status?.notion.syncing ?? 0) > 0 && this.notionBtn.dataset.busy === '1';
    let label = 'Notion';
    let title = 'Connecter Notion dans les réglages';
    let state = 'off';
    if (connected) {
      if (syncing) {
        label = 'Synchronisation…';
        state = 'busy';
        title = 'Envoi vers Notion en cours';
      } else if (link?.error) {
        label = 'Notion';
        state = 'error';
        title = `${link.error} — cliquer pour réessayer`;
      } else if (link) {
        label = 'Notion';
        state = 'ok';
        title = `Synchronisé ${relativeTime(link.syncedAt)}`;
      } else {
        label = 'Envoyer vers Notion';
        state = 'ready';
        title = 'Créer la page de ce cours dans Notion';
      }
    }
    this.notionBtn.replaceChildren(
      icon(state === 'error' ? 'alert' : state === 'ok' ? 'check' : state === 'busy' ? 'refresh' : 'notion', 16),
      h('span', {}, label),
    );
    this.notionBtn.dataset.state = state;
    this.notionBtn.title = title;
  }

  private async onNotion(): Promise<void> {
    const status = this.host.status();
    if (!status?.notion.connected) {
      this.host.openSettings('notion');
      return;
    }
    if (this.item.notion && !this.item.notion.error) {
      showMenu(this.notionBtn, [
        { label: 'Ouvrir dans Notion', icon: 'popout', run: () => void window.boo.notion.open(this.item.id) },
        { label: 'Synchroniser maintenant', icon: 'refresh', run: () => void this.syncNow() },
      ]);
      return;
    }
    await this.syncNow();
  }

  private async syncNow(): Promise<void> {
    await this.notes?.flush();
    this.notionBtn.dataset.busy = '1';
    this.notionBtn.disabled = true;
    this.renderNotion();
    try {
      await window.boo.notion.syncItem(this.item.id);
      toast('Cours synchronisé avec Notion', 'success', {
        label: 'Ouvrir',
        run: () => void window.boo.notion.open(this.item.id),
      });
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      this.notionBtn.dataset.busy = '';
      this.notionBtn.disabled = false;
      this.renderNotion();
    }
  }

  private statusMenu(): void {
    showMenu(
      this.statusBtn,
      STATUS_OPTIONS.map((o) => ({
        label: o.label,
        checked: (this.item.status ?? null) === o.value,
        run: () => void window.boo.library.update(this.item.id, { status: o.value }).then((v) => this.update(v)),
      })),
    );
  }

  private moreMenu(anchor: HTMLElement): void {
    const { item } = this;
    showMenu(anchor, [
      {
        label: item.origin === 'desktop' ? 'Afficher le fichier du cours' : 'Ouvrir dans le navigateur',
        icon: item.origin === 'desktop' ? 'folder' : 'globe',
        run: () => void window.boo.library.openSource(item.id),
      },
      { label: 'Afficher la note (.md)', icon: 'file', run: () => void window.boo.library.reveal(item.id) },
      ...(item.notion?.url
        ? [{ label: 'Ouvrir dans Notion', icon: 'notion' as const, run: () => void window.boo.notion.open(item.id) }]
        : []),
    ]);
  }

  private rename(title: HTMLElement): void {
    const input = h('input', { class: 'title-input', value: this.item.title, 'aria-label': 'Titre' });
    title.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== this.item.title) {
        void window.boo.library.update(this.item.id, { title: value }).then((v) => this.update(v));
      } else this.renderHeader();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }
}
