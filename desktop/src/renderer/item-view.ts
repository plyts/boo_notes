import type { AnchorKind } from '../../../src/panel/editor';
import {
  captureLine,
  findWikiLinks,
  normalizeTitle,
  pageRefToken,
  pinToken,
  sectionToken,
  timestampToken,
} from '../../../src/shared/markdown';
import { isTimeKind, KIND_LABELS, PLATFORM_LABELS } from '../../../src/shared/platforms';
import { nextInterval, type ReviewGrade } from '../../../src/shared/study';
import { formatTimecode } from '../../../src/shared/time';
import type { AppStatus, ItemView, ReviewAction, StudyStatus } from '../ipc';
import { ImageViewer } from './image-viewer';
import { MediaViewer } from './media-viewer';
import { NotesPane } from './notes-pane';
import { PdfViewer } from './pdf-viewer';
import { TextViewer } from './text-viewer';
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
  type MenuItem,
} from './ui';
import type { WikiPreview } from './wiki';

const STATUS_OPTIONS: Array<{ value: StudyStatus | null; label: string }> = [
  { value: null, label: 'Automatique' },
  { value: 'todo', label: 'À commencer' },
  { value: 'doing', label: 'En cours' },
  { value: 'done', label: 'Terminé' },
];

const DAY = 86_400_000;

export interface ItemViewHost {
  back(): void;
  openSettings(section?: string): void;
  status(): AppStatus | null;
  /** `[[Titre]]` clicked: open (or create) that note. */
  openTitle(title: string): void;
  openItem(id: string): void;
  titles(): string[];
  preview: WikiPreview;
  /** Notes opened before this one by following links (breadcrumbs). */
  trail(): ItemView[];
  backTo(index: number): void;
}

function when(ts: number): string {
  const days = Math.round((new Date(ts).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);
  if (days <= 0) return 'aujourd’hui';
  if (days === 1) return 'demain';
  if (days < 7) return `dans ${days} jours`;
  return `le ${new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
}

function inDays(days: number): string {
  return days === 1 ? 'demain' : days < 30 ? `dans ${days} j` : `dans ${Math.round(days / 30)} mois`;
}

/**
 * A note open for study: its source (PDF, video / audio, image, text, web
 * course) next to the note, or — for a revision sheet — the note with its
 * links and review planning.
 */
export class ItemScreen {
  readonly el: HTMLElement;
  private item: ItemView;
  private notes!: NotesPane;
  private pdf: PdfViewer | null = null;
  private media: MediaViewer | null = null;
  private image: ImageViewer | null = null;
  private text: TextViewer | null = null;
  private side: HTMLElement | null = null;
  private activePin: number | null = null;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private readonly notionBtn: HTMLButtonElement;
  private readonly statusBtn: HTMLButtonElement;
  private readonly reviewBtn: HTMLButtonElement;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingProgress: [number, number] | null = null;
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
    this.reviewBtn = h('button', { type: 'button', class: 'review-pill', 'aria-haspopup': 'menu' });
    this.reviewBtn.addEventListener('click', () => this.reviewMenu(this.reviewBtn));
    this.header = h('header', { class: 'item-head' });
    this.body = h('div', { class: `item-body${item.kind === 'note' ? ' sheet' : ''}` });
    this.el = h('div', { class: `item-screen kind-${item.kind}` }, this.header, this.body);
    this.renderHeader();
  }

  get id(): string {
    return this.item.id;
  }

  async mount(): Promise<void> {
    const { item } = this;
    this.notes = new NotesPane({
      item,
      readOnly: item.origin !== 'desktop',
      stamp: () => this.stamp(),
      now: () => (this.media ? this.media.time : null),
      placeholder:
        item.kind === 'note'
          ? 'Écrivez votre fiche… Liez une autre fiche avec [[Titre]].'
          : 'Écrivez ici… Chaque ligne est rattachée à l’endroit étudié.',
      onTimestampClick: (s) => this.onTimestamp(s),
      onAnchorClick: (kind, n) => this.onAnchor(kind, n),
      onWikiLinkClick: (title) => {
        this.host.preview.hide();
        this.host.openTitle(title);
      },
      onWikiLinkHover: (title, el) => this.host.preview.hover(title, el),
      wikiTitles: () => this.host.titles().filter((t) => normalizeTitle(t) !== normalizeTitle(this.item.title)),
      onFragmentClick: (url) => void window.boo.settings.openExternal(url),
      onKeystroke: () => {
        this.activity();
        this.media?.autoPause.keystroke();
      },
      onContentChanged: (md) => {
        this.media?.setNote(md);
        // Markers of the viewer and highlighted line follow the note (after the editor update).
        queueMicrotask(() => this.syncMarkers(md));
      },
    });
    const viewer = await this.createViewer();
    if (item.kind === 'note') {
      this.side = h('aside', { class: 'sheet-side', 'aria-label': 'Liens et révision' });
      this.body.replaceChildren(this.notes.el, this.side);
    } else {
      const resizer = h('div', { class: 'resizer', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', title: 'Glisser pour redimensionner' });
      this.body.replaceChildren(viewer!, resizer, this.notes.el);
      this.setupResizer(resizer);
    }
    this.notes.load(await window.boo.library.readNote(item.id));
    this.notes.setActions(...this.actions());
    await this.renderLinks();
    await this.pdf?.open().catch((e: unknown) => {
      viewer?.replaceChildren(this.problem('Impossible d’ouvrir ce PDF', errorMessage(e)));
    });
    this.text?.start();
    this.syncMarkers(this.notes.editor.content);
    this.studyTimer = setInterval(() => {
      if (document.hasFocus() && Date.now() - this.lastActivity < 60_000) {
        void window.boo.library.addStudyTime(item.id, 15_000);
      }
    }, 15_000);
    if (item.kind === 'note' && !this.notes.editor.content.trim()) this.notes.focus();
  }

  /** Library data changed (sync state, progress from the browser, links…). */
  update(item: ItemView): void {
    this.item = { ...item };
    this.renderHeader();
    void this.renderLinks();
  }

  onStatus(): void {
    this.renderNotion();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.host.preview.hide();
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
      if (this.pendingProgress) {
        await window.boo.library.setProgress(this.item.id, ...this.pendingProgress).catch(() => undefined);
      }
    }
    if (this.studyTimer) clearInterval(this.studyTimer);
    await this.notes?.flush();
    this.media?.destroy();
    this.pdf?.destroy();
    this.image?.destroy();
  }

  /** Keyboard shortcuts of the study screen (same as the extension). */
  handleKey(e: KeyboardEvent): boolean {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const altShift = e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
    const mod = e.ctrlKey || e.metaKey;
    if (altShift && (key === 't' || e.code === 'KeyT')) {
      if (this.image) this.image.togglePlacing();
      else {
        const token = this.stamp();
        if (token) this.notes.stampLine(token);
      }
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
    if (altShift && (key === 'q' || e.code === 'KeyQ') && (this.pdf || this.text)) {
      this.quoteSelection();
      return true;
    }
    if (altShift && (key === 'h' || e.code === 'KeyH') && this.pdf) {
      if (!this.pdf.highlightSelection('yellow')) toast('Sélectionnez un passage du PDF à surligner');
      return true;
    }
    if (altShift && (key === 'r' || e.code === 'KeyR')) {
      this.reviewMenu(this.reviewBtn);
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

  private async createViewer(): Promise<HTMLElement | null> {
    const { item } = this;
    if (item.kind === 'note') return null;
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
        onPageChange: (page, pages) => this.onPosition('page', page, pages),
        onHighlightsChange: (list) => {
          void window.boo.library.setHighlights(item.id, list).catch((e: unknown) => toast(errorMessage(e), 'error'));
        },
        onQuote: (text, page) => this.quote(text, pageRefToken(page), `de la page ${page}`),
        onActivity: () => this.activity(),
        onMarkerClick: (page) => this.revealNotes('page', page),
      });
      return this.pdf.el;
    }
    if (item.kind === 'image') {
      this.image = new ImageViewer({
        item,
        pins: item.pins ?? [],
        onPinsChange: (pins) => void window.boo.library.setPins(item.id, pins).catch((e: unknown) => toast(errorMessage(e), 'error')),
        onPinCreated: (n) => {
          this.activePin = n;
          this.notes.stampLine(pinToken(n));
        },
        onPinClick: (n) => {
          this.activePin = n;
          this.revealNotes('pin', n);
        },
        onActivity: () => this.activity(),
      });
      this.image.el.querySelector('img')?.addEventListener('error', () => {
        this.image?.el.replaceChildren(this.problem('Image introuvable', `Format non lu ou fichier déplacé : ${item.source}`));
      });
      return this.image.el;
    }
    if (item.kind === 'text') {
      let text: string;
      try {
        text = await window.boo.library.readText(item.id);
      } catch (e) {
        return this.problem('Fichier introuvable', `${errorMessage(e)} — ${item.source}`);
      }
      this.text = new TextViewer({
        text,
        markdown: /\.(md|markdown)$/i.test(item.source),
        startParagraph: Math.max(1, Math.round(item.progress?.position ?? 1)),
        onParagraphChange: (n, total) => this.onPosition('section', n, total),
        onStamp: (n) => this.notes.stampLine(sectionToken(n)),
        onMarkerClick: (n) => this.revealNotes('section', n),
        onQuote: (quote, n) => this.quote(quote, sectionToken(n), `du paragraphe ${n}`),
        onActivity: () => this.activity(),
      });
      return this.text.el;
    }
    this.media = new MediaViewer({
      item,
      onTime: (t) => this.notes.editor.setPlaybackTime(t),
      onProgress: (position, d) => void window.boo.library.setProgress(item.id, position, d),
      onActivity: () => this.activity(),
      onMarkerClick: (s) => this.notes.editor.revealAnchor('time', s),
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
    const timed = isTimeKind(item.kind);
    const resumeAt = timed ? item.progress?.position : undefined;
    const resume = button(
      resumeAt ? `Reprendre à ${formatTimecode(resumeAt)}` : item.kind === 'page' ? 'Rouvrir la page' : 'Ouvrir le cours',
      { variant: 'primary', icon: timed ? 'play' : 'globe' },
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
          h(
            'span',
            {},
            timed
              ? 'Cette note s’écrit dans l’extension Boo Notes du navigateur. Cliquez un horodatage pour rouvrir la vidéo à ce moment.'
              : 'Cette note s’écrit dans l’extension Boo Notes du navigateur. Cliquez ↗ pour rouvrir la page sur le passage cité.',
          ),
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
    const linkBtn = button('Lier une fiche', { icon: 'link', small: true, title: 'Insérer [[…]] : lien vers une autre fiche' }, () =>
      this.notes.editor.insertWikiLink(),
    );
    switch (item.kind) {
      case 'note':
        return [linkBtn];
      case 'pdf':
        return [
          button('Page', { icon: 'file', small: true, title: 'Nouvelle note sur la page courante (Alt+Shift+T)' }, () => this.stampNow()),
          button('Citer', { icon: 'quote', small: true, title: 'Citer la sélection (Alt+Shift+Q)' }, () => this.quoteSelection()),
          button('Surligner', { icon: 'highlight', small: true, title: 'Surligner la sélection (Alt+Shift+H)' }, () => {
            if (!this.pdf?.highlightSelection('yellow')) toast('Sélectionnez un passage du PDF à surligner');
          }),
          linkBtn,
        ];
      case 'text':
        return [
          button('Paragraphe', { icon: 'text', small: true, title: 'Nouvelle note sur le paragraphe courant (Alt+Shift+T)' }, () => this.stampNow()),
          button('Citer', { icon: 'quote', small: true, title: 'Citer la sélection (Alt+Shift+Q)' }, () => this.quoteSelection()),
          linkBtn,
        ];
      case 'image':
        return [
          button('Repère', { icon: 'target', small: true, title: 'Placer un repère sur l’image (Alt+Shift+T)' }, () => this.image?.togglePlacing()),
          linkBtn,
        ];
      default: {
        const nodes: Node[] = [
          button('Horodater', { icon: 'clock', small: true, title: 'Nouvelle note horodatée (Alt+Shift+T)' }, () => this.stampNow()),
        ];
        if (item.kind === 'video') {
          nodes.push(button('Capturer', { icon: 'camera', small: true, title: 'Capturer l’image (Alt+Shift+S)' }, () => void this.capture()));
        }
        nodes.push(
          button('5 s', { icon: 'replay', small: true, title: 'Revoir les 5 dernières secondes (Alt+←)' }, () => this.media?.skip(-5)),
          linkBtn,
        );
        return nodes;
      }
    }
  }

  // --- Behaviour ----------------------------------------------------------------------------

  /** Token of the place being studied, prefixed to new note lines. */
  private stamp(): string | null {
    if (this.pdf) return pageRefToken(this.pdf.page);
    if (this.text) return sectionToken(this.text.paragraph);
    if (this.media) return timestampToken(this.media.time);
    if (this.image && this.activePin !== null) return pinToken(this.activePin);
    return null;
  }

  private stampNow(): void {
    const token = this.stamp();
    if (token) this.notes.stampLine(token);
  }

  private onTimestamp(seconds: number): void {
    if (this.media) {
      this.media.seek(seconds);
      void this.media.media.play().catch(() => undefined);
    } else if (this.item.origin !== 'desktop') {
      void window.boo.library.openSource(this.item.id, seconds);
    }
  }

  /** Note → source: a chip of the note shows its place in the document. */
  private onAnchor(kind: AnchorKind, n: number): void {
    if (kind === 'page') this.pdf?.goTo(n);
    else if (kind === 'section') this.text?.goTo(n);
    else if (kind === 'pin') {
      this.activePin = n;
      this.image?.showPin(n);
    }
  }

  /** Source → note: markers of the viewer show the matching note lines. */
  private revealNotes(kind: AnchorKind, n: number): void {
    if (!this.notes.editor.revealAnchor(kind, n)) toast('Aucune note à cet endroit : écrivez la première', 'info');
  }

  private syncMarkers(md: string): void {
    void md;
    if (this.pdf) {
      this.pdf.setNoteCounts(this.notes.editor.anchorCounts('page'));
      this.notes.editor.setCurrentPage(this.pdf.page);
    }
    if (this.text) {
      this.text.setCounts(this.notes.editor.anchorCounts('section'));
      this.notes.editor.setCurrentAnchor('section', this.text.paragraph);
    }
    if (this.image) this.image.setCounts(this.notes.editor.anchorCounts('pin'));
  }

  private onPosition(kind: 'page' | 'section', n: number, total: number): void {
    this.activity();
    this.notes?.editor.setCurrentAnchor(kind, n);
    this.pendingProgress = [n, total];
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.pendingProgress = null;
      void window.boo.library.setProgress(this.item.id, n, total);
    }, 700);
  }

  private quoteSelection(): void {
    if (this.pdf) {
      const sel = this.pdf.currentSelection();
      if (sel) this.quote(sel.text, pageRefToken(sel.page), `de la page ${sel.page}`);
      else toast('Sélectionnez un passage du PDF à citer');
    } else if (this.text) {
      const sel = this.text.currentSelection();
      if (sel) this.quote(sel.text, sectionToken(sel.n), `du paragraphe ${sel.n}`);
      else toast('Sélectionnez un passage du texte à citer');
    }
  }

  private quote(text: string, anchor: string, where: string): void {
    const clean = text.replace(/\s+/g, ' ').trim();
    // Quotes follow the reading order: always at the end of the note.
    this.notes.insertBlock(`> ${clean} ${anchor}`, 'end');
    toast(`Citation ${where} ajoutée`, 'success');
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

  // --- Links between notes ---------------------------------------------------------------------

  private async renderLinks(): Promise<void> {
    if (!this.notes) return;
    const backlinks = await window.boo.library.backlinks(this.item.id).catch(() => [] as ItemView[]);
    if (this.disposed) return;
    if (!this.side) {
      this.notes.setBacklinks(backlinks, (id) => this.host.openItem(id));
      return;
    }
    // Revision sheet: side panel with review, outgoing links and backlinks.
    const titles = [...new Map(findWikiLinks(this.notes.editor.content).map((l) => [normalizeTitle(l.title), l.title])).values()];
    const outgoing = await Promise.all(titles.map(async (t) => [t, await window.boo.library.findByTitle(t)] as const));
    if (this.disposed) return;
    const linkRow = (label: string, item: ItemView | null, onClick: () => void) => {
      const row = h(
        'button',
        { type: 'button', class: `side-link${item ? '' : ' missing'}`, title: item ? `Ouvrir « ${label} »` : `Créer la fiche « ${label} »` },
        icon(item ? KIND_ICON[item.kind] : 'plus', 15),
        h('span', { class: 'side-link-title' }, label),
        item?.due ? h('span', { class: 'due-dot', title: 'À réviser' }) : null,
      );
      row.addEventListener('click', onClick);
      return row;
    };
    const review = this.item.review;
    const reviewCard = h(
      'section',
      { class: `side-card review-card${this.item.due ? ' due' : ''}` },
      h('h3', {}, icon('cards', 15), 'Révision'),
      review
        ? h('p', {}, this.item.due ? 'À réviser aujourd’hui.' : `Prochaine révision ${when(review.next)}.`)
        : h('p', {}, 'Ajoutez cette fiche à vos révisions : elle reviendra au bon moment (1, 3, 7, 14 jours…).'),
      review && this.item.due
        ? h(
            'div',
            { class: 'grade-row' },
            ...(['again', 'good', 'easy'] as ReviewGrade[]).map((g) => this.gradeButton(g)),
          )
        : button(review ? 'Réviser maintenant' : 'Ajouter aux révisions', { small: true, icon: 'cards', variant: review ? 'plain' : 'primary' }, (e) => {
            if (review) this.reviewMenu(e.currentTarget as HTMLElement);
            else void this.review('start');
          }),
    );
    this.side.replaceChildren(
      reviewCard,
      h(
        'section',
        { class: 'side-card' },
        h('h3', {}, icon('link', 15), 'Liens'),
        outgoing.length
          ? h('div', { class: 'side-links' }, ...outgoing.map(([t, item]) => linkRow(t, item, () => this.host.openTitle(t))))
          : h('p', { class: 'side-empty' }, 'Tapez [[ pour lier une autre fiche ; elle s’ouvre d’un clic.'),
      ),
      h(
        'section',
        { class: 'side-card' },
        h('h3', {}, icon('link', 15), 'Liée depuis'),
        backlinks.length
          ? h('div', { class: 'side-links' }, ...backlinks.map((b) => linkRow(b.title, b, () => this.host.openItem(b.id))))
          : h('p', { class: 'side-empty' }, 'Aucune note ne mène encore ici.'),
      ),
    );
  }

  private gradeButton(grade: ReviewGrade): HTMLButtonElement {
    const days = nextInterval(this.item.review?.interval, grade);
    const labels: Record<ReviewGrade, string> = { again: 'À revoir', good: 'Je sais', easy: 'Facile' };
    const b = h(
      'button',
      { type: 'button', class: `grade ${grade}`, title: `Prochaine révision ${inDays(days)}` },
      h('strong', {}, labels[grade]),
      h('small', {}, inDays(days)),
    );
    b.addEventListener('click', () => void this.review(grade));
    return b;
  }

  private async review(action: ReviewAction): Promise<void> {
    try {
      const next = await window.boo.library.review(this.item.id, action);
      this.update(next);
      if (action === 'again' || action === 'good' || action === 'easy') {
        toast(`Fiche révisée : prochaine révision ${when(next.review!.next)}`, 'success');
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  private reviewMenu(anchor: HTMLElement): void {
    const review = this.item.review;
    if (!review) {
      void this.review('start');
      return;
    }
    const items: Array<MenuItem | 'separator'> = (['again', 'good', 'easy'] as ReviewGrade[]).map((g) => ({
      label: `${{ again: 'À revoir', good: 'Je sais', easy: 'Facile' }[g]} — ${inDays(nextInterval(review.interval, g))}`,
      icon: g === 'again' ? ('replay' as const) : ('check' as const),
      run: () => void this.review(g),
    }));
    items.push('separator', { label: 'Arrêter les révisions', icon: 'close', run: () => void this.review('stop') });
    showMenu(anchor, items);
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
      item.kind === 'note' ? '' : PLATFORM_LABELS[item.platform],
      KIND_LABELS[item.kind],
      item.positionLabel,
      item.studyMs && item.studyMs >= 60_000 ? `${duration(item.studyMs)} d’étude` : '',
    ].filter(Boolean);
    const trail = this.host.trail();
    const crumbs = trail.length
      ? h(
          'nav',
          { class: 'crumbs', 'aria-label': 'Notes précédentes' },
          ...trail.slice(-3).flatMap((t, i, arr) => {
            const index = trail.length - arr.length + i;
            const b = h('button', { type: 'button', class: 'crumb' }, t.title);
            b.addEventListener('click', () => this.host.backTo(index));
            return [b, h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›')];
          }),
        )
      : null;
    const more = iconButton('more', 'Plus d’actions', (e) => this.moreMenu(e.currentTarget as HTMLElement));
    more.setAttribute('aria-haspopup', 'menu');
    const progress =
      item.kind === 'note' || item.kind === 'image'
        ? null
        : h('span', { class: 'item-progress', title: `Progression : ${percent(item.ratio)}` }, progressBar(item.ratio), h('span', {}, percent(item.ratio)));
    this.header.replaceChildren(
      ...[
        iconButton('chevronLeft', trail.length ? `Revenir à « ${trail.at(-1)!.title} »` : 'Bibliothèque (Échap)', () => this.host.back()),
        h('span', { class: `kind-badge ${item.kind}` }, icon(KIND_ICON[item.kind], 18)),
        h('div', { class: 'item-titles' }, crumbs, title, h('p', { class: 'item-meta' }, meta.join(' · '))),
        h('span', { class: 'spacer' }),
        progress,
        this.reviewBtn,
        this.statusBtn,
        this.notionBtn,
        more,
      ].filter((n): n is HTMLElement => n !== null),
    );
    this.statusBtn.textContent = STATUS_OPTIONS.find((o) => o.value === item.studyStatus)?.label ?? '';
    this.statusBtn.dataset.status = item.studyStatus;
    this.statusBtn.title = item.status ? 'Statut choisi manuellement' : 'Statut déduit de votre progression';
    const review = item.review;
    this.reviewBtn.replaceChildren(icon('cards', 15), h('span', {}, review ? (item.due ? 'À réviser' : `Révision ${when(review.next)}`) : 'Réviser'));
    this.reviewBtn.dataset.state = review ? (item.due ? 'due' : 'planned') : 'off';
    this.reviewBtn.title = review ? 'Noter la révision (Alt+Shift+R)' : 'Ajouter aux révisions : cette note reviendra au bon moment';
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
      } else if (link && link.syncedRev >= 0) {
        label = 'Notion';
        state = 'ok';
        title = `Synchronisé ${relativeTime(link.syncedAt)}`;
      } else {
        label = 'Envoyer vers Notion';
        state = 'ready';
        title = 'Créer la page de cette note dans Notion';
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
    if (this.item.notion && this.item.notion.syncedRev >= 0 && !this.item.notion.error) {
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
      toast('Note synchronisée avec Notion', 'success', {
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
    const items: Array<MenuItem | 'separator'> = [];
    if (item.source) {
      items.push({
        label: item.origin === 'desktop' ? 'Afficher le fichier étudié' : 'Ouvrir dans le navigateur',
        icon: item.origin === 'desktop' ? 'folder' : 'globe',
        run: () => void window.boo.library.openSource(item.id),
      });
    }
    items.push({ label: 'Afficher la note (.md)', icon: 'file', run: () => void window.boo.library.reveal(item.id) });
    if (item.notion?.url) items.push({ label: 'Ouvrir dans Notion', icon: 'notion', run: () => void window.boo.notion.open(item.id) });
    showMenu(anchor, items);
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
