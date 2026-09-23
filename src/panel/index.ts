import { TypingAutoPause } from '../shared/autopause';
import { h, icon, type IconName } from '../shared/icons';
import { findAssetRefs, findFragmentLinks, linkedTitles, normalizeTitle, toPortableMarkdown } from '../shared/markdown';
import {
  callBackground,
  PANEL_PORT,
  type ContentToPanel,
  type ExportTarget,
  type MediaSource,
  type NotionStatus,
  type PageTheme,
  type PanelMode,
  type PanelToContent,
  type PlaybackState,
  type SyncStatus,
} from '../shared/messages';
import { PLATFORM_LABELS, type MediaKind, type VideoContext } from '../shared/platforms';
import { loadSettings, normalizeSettings, type Settings } from '../shared/settings';
import type { AssetRecord, CourseOption, Note, NoteMeta } from '../shared/store';
import { IS_MAC } from '../shared/keycaps';
import { DEFAULT_SHORTCUTS, findBinding, formatShortcut, inPageBindings, type InPageBinding } from '../shared/shortcuts';
import { formatTimecode } from '../shared/time';
import { NotesEditor } from './editor';
import { EmptyState, ShortcutsSheet, type ShortcutMap } from './sheet';
import { Timeline } from './timeline';

/**
 * The notes panel. The same page runs embedded in the drawer iframe and in
 * the detached pop-out window; in both cases it talks to the video tab's
 * content script through a port.
 */
const params = new URLSearchParams(location.search);
const TAB_ID = Number(params.get('tab'));
const MODE: PanelMode = params.get('mode') === 'popout' ? 'popout' : 'embedded';
const CLIENT_ID = crypto.randomUUID();
const SAVE_DELAY_MS = 400;

type SaveState = 'saved' | 'pending' | 'saving' | 'error' | 'idle';

const assetCache = new Map<string, Promise<string>>();

/** Same page, ignoring the fragment and the encoding of `(` `)`. */
function samePage(a: string, b: string): boolean {
  const strip = (u: string) => u.split('#')[0].replace(/%28/gi, '(').replace(/%29/gi, ')');
  return strip(a) === strip(b);
}

function loadAsset(path: string): Promise<string> {
  let p = assetCache.get(path);
  if (!p) {
    p = chrome.storage.local.get(`asset:${path}`).then((res) => {
      const asset = res[`asset:${path}`] as AssetRecord | undefined;
      if (!asset || !asset.dataUrl.startsWith('data:image/')) throw new Error('missing asset');
      return asset.dataUrl;
    });
    p.catch(() => assetCache.delete(path));
    assetCache.set(path, p);
  }
  return p;
}

class PanelApp {
  private port: chrome.runtime.Port | null = null;
  private settings!: Settings;
  private ctx: VideoContext | null = null;
  private title = '';
  private note: Note | null = null;
  private knownRev = 0;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private playback: PlaybackState = { time: 0, playing: false, rate: 1, duration: 0, at: Date.now() };
  private hasVideo = false;
  private kind: MediaKind = 'video';
  /** Where the position comes from: the page's media, an embedded player, or the stopwatch. */
  private source: MediaSource | null = null;
  private playersHint!: HTMLDivElement;
  private pendingPlayers: string[] = [];
  private playersInjected = false;
  private stopwatchEl!: HTMLSpanElement;
  private chronoButton!: HTMLButtonElement;
  /** Filing of the note in a course › chapter of the library. */
  private placeButton!: HTMLButtonElement;
  private placeMenu!: HTMLDivElement;
  /** Reading mode: furthest point read and the quoted passage being read. */
  private reading: { ratio: number; passage: string | null } = { ratio: 0, passage: null };
  private wikiTitles: string[] = [];
  private notionStatus: NotionStatus | null = null;
  private siteHint!: HTMLDivElement;
  private pinned = false;
  private pageTheme: PageTheme | null = null;
  private shortcuts: Record<string, string> = {};
  private pageBindings: InPageBinding[] = [];
  private loadSeq = 0;
  /** Resolves once the current note is loaded: editor operations wait for it. */
  private loading: Promise<void> = Promise.resolve();
  private editor!: NotesEditor;
  private readonly autoPause = new TypingAutoPause({
    isPlaying: () => this.hasVideo && this.playback.playing,
    pause: () => {
      this.playback = { ...this.playback, time: this.now() ?? 0, playing: false, at: Date.now() };
      this.post({ type: 'pause' });
    },
    play: () => this.post({ type: 'play' }),
  });

  // UI
  private readonly root = document.getElementById('app') as HTMLElement;
  private statusButton!: HTMLButtonElement;
  private statusLabel!: HTMLSpanElement;
  private titleEl!: HTMLHeadingElement;
  private platformEl!: HTMLSpanElement;
  private statsEl!: HTMLSpanElement;
  private saveEl!: HTMLSpanElement;
  private noticeEl!: HTMLDivElement;
  private pinButton: HTMLButtonElement | null = null;
  private exportButton!: HTMLButtonElement;
  private menu!: HTMLDivElement;
  private banner!: HTMLDivElement;
  private clockEl!: HTMLSpanElement;
  private durationEl!: HTMLSpanElement;
  private readingBar!: HTMLSpanElement;
  private footerButtons: Record<'timestamp' | 'capture' | 'replay' | 'help' | 'link', HTMLButtonElement> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private contentTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timeline = new Timeline({
    seek: (seconds) => this.post({ type: 'seek', seconds }),
    preview: (seconds) => this.post({ type: 'mark', seconds }),
  });
  private readonly sheet = new ShortcutsSheet(IS_MAC, () => {
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  private readonly emptyState = new EmptyState(IS_MAC);

  async start(): Promise<void> {
    this.settings = await loadSettings();
    this.autoPause.enabled = this.settings.autoPause;
    document.documentElement.dataset.mode = MODE;
    this.buildUi();
    this.applyTheme();
    this.editor = new NotesEditor(this.root.querySelector('.editor') as HTMLElement, {
      now: () => (this.hasVideo ? this.now() : null),
      autoTimestamp: () => this.settings.autoTimestamp,
      onTimestampHover: (seconds) => this.post({ type: 'mark', seconds }),
      onTimestampClick: (seconds) => this.post({ type: 'seek', seconds }),
      onKeystroke: () => this.autoPause.keystroke(),
      onChange: () => this.scheduleSave(),
      onContentChanged: () => this.scheduleContentRefresh(),
      onSaveShortcut: () => void this.flush(),
      onHelp: () => this.sheet.open(),
      loadAsset,
      wikiTitles: () => {
        const own = normalizeTitle(this.title || this.note?.title || '');
        return this.wikiTitles.filter((t) => normalizeTitle(t) !== own);
      },
      onWikiLinkClick: (title) => void this.openWiki(title),
      onFragmentClick: (url) => this.openFragment(url),
      placeholderText: 'Écrivez ici… ([[ pour lier une fiche)',
    });
    this.editor.setEditable(false);
    this.bindGlobalEvents();
    this.connect();
    void this.loadShortcuts();
    const session = await chrome.storage.session.get(['sync:status', 'notion:status']);
    this.renderStatus(session['sync:status'] as SyncStatus | undefined);
    this.notionStatus = (session['notion:status'] as NotionStatus | undefined) ?? null;
    callBackground({ type: 'notion:status' }).then((n) => (this.notionStatus = n), () => undefined);
    void this.loadWikiTitles();
    callBackground({ type: 'sync:status' }).then((s) => this.renderStatus(s), () => undefined);
    setInterval(() => this.tick(), 250);
  }

  // --- Connection to the video tab ----------------------------------------------------

  private connect(): void {
    if (!Number.isInteger(TAB_ID) || TAB_ID < 0) {
      this.showBanner('Onglet vidéo inconnu.');
      return;
    }
    const port = chrome.tabs.connect(TAB_ID, { name: PANEL_PORT, frameId: 0 });
    this.port = port;
    port.onMessage.addListener((msg: ContentToPanel) => this.onMessage(msg));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // Expected when the tab is gone / reloading.
      if (this.port !== port) return;
      this.port = null;
      this.hasVideo = false;
      void this.flush();
      if (MODE === 'popout') this.showBanner('Onglet vidéo fermé ou rechargé — reconnexion…');
      setTimeout(() => this.connect(), 1500);
    });
    port.postMessage({ type: 'hello', mode: MODE } satisfies PanelToContent);
  }

  private post(msg: PanelToContent): void {
    try {
      this.port?.postMessage(msg);
    } catch {
      // Disconnected; the reconnect loop takes over.
    }
  }

  private onMessage(msg: ContentToPanel): void {
    switch (msg.type) {
      case 'init':
        this.hideBanner();
        this.pinned = msg.pinned;
        this.hasVideo = msg.hasVideo;
        this.kind = msg.kind;
        this.playback = msg.playback;
        this.pageTheme = msg.pageTheme;
        this.source = msg.source;
        this.renderKind();
        this.applyTheme();
        this.renderPin();
        void this.switchContext(msg.ctx, msg.title);
        break;
      case 'context':
        void this.switchContext(msg.ctx, msg.title);
        break;
      case 'playback':
        this.playback = msg.playback;
        this.hasVideo = msg.hasVideo;
        if (msg.kind !== this.kind || msg.source !== this.source) {
          this.kind = msg.kind;
          this.source = msg.source;
          this.renderKind();
        }
        this.renderSource();
        break;
      case 'players':
        void this.renderPlayers(msg.hosts);
        break;
      case 'insert-timestamp':
        void this.loading.then(() => this.note && this.editor.insertTimestamp(msg.seconds, msg.focus));
        break;
      case 'insert-anchor':
        void this.loading.then(() => this.note && this.editor.insertToken(msg.token, msg.focus));
        break;
      case 'insert-block':
        void this.loading.then(() => {
          if (!this.note) return;
          this.editor.insertBlock(msg.text);
          if (msg.focus) this.editor.focus();
        });
        break;
      case 'reading':
        this.reading = { ratio: msg.ratio, passage: msg.passage };
        void this.loading.then(() => this.editor.setCurrentFragment(msg.passage));
        break;
      case 'focus':
        void this.loading.then(() => this.editor.focus(msg.where));
        break;
      case 'pinned':
        this.pinned = msg.value;
        this.renderPin();
        break;
      case 'page-theme':
        this.pageTheme = msg.theme;
        this.applyTheme();
        break;
      case 'typing-release':
        this.autoPause.release();
        break;
    }
  }

  /** Current video time, extrapolated between playback updates. */
  private now(): number | null {
    const p = this.playback;
    let t = p.playing ? p.time + ((Date.now() - p.at) / 1000) * p.rate : p.time;
    if (p.duration > 0) t = Math.min(t, p.duration);
    return Math.max(0, t);
  }

  private tick(): void {
    if (this.kind === 'page') {
      const pct = Math.round(this.reading.ratio * 100);
      this.clockEl.textContent = `${pct} %`;
      this.clockEl.dataset.playing = 'false';
      this.durationEl.textContent = 'lu';
      (this.readingBar.firstElementChild as HTMLElement).style.width = `${pct}%`;
      this.readingBar.setAttribute('aria-valuenow', String(pct));
      return;
    }
    const t = this.hasVideo ? this.now() : null;
    const duration = this.playback.duration;
    this.clockEl.textContent = t === null ? '--:--' : formatTimecode(t);
    this.clockEl.dataset.playing = String(this.hasVideo && this.playback.playing);
    this.durationEl.textContent = t !== null && duration > 0 ? formatTimecode(duration) : '';
    this.timeline.update(t, duration);
    this.editor.setPlaybackTime(t);
  }

  /** Stats, timeline ticks and empty state follow the content (debounced). */
  private scheduleContentRefresh(): void {
    if (this.contentTimer) clearTimeout(this.contentTimer);
    this.contentTimer = setTimeout(() => this.refreshContent(), 120);
  }

  private refreshContent(): void {
    const markers = this.editor.markers();
    this.timeline.setMarkers(markers);
    const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
    let parts: string[];
    if (this.kind === 'page') {
      // Reading mode: passages linked to the page, and page captures.
      const content = this.editor.content;
      const passages = findFragmentLinks(content).length;
      const captures = findAssetRefs(content).length;
      parts = [passages ? plural(passages, 'passage') : '', captures ? plural(captures, 'capture') : ''];
    } else {
      const notes = markers.filter((m) => m.kind === 'note').length;
      const captures = markers.length - notes;
      parts = [notes ? plural(notes, 'note') : '', captures ? plural(captures, 'capture') : ''];
    }
    const links = linkedTitles(this.editor.content).length;
    if (links) parts.push(plural(links, 'lien'));
    this.statsEl.textContent = parts.filter(Boolean).join(' · ');
    this.emptyState.el.hidden = !this.note || !this.editor.isEmpty;
  }

  // --- Note lifecycle -------------------------------------------------------------------

  private meta(): NoteMeta | null {
    if (!this.ctx) return null;
    return {
      platform: this.ctx.platform,
      url: this.ctx.canonicalUrl,
      title: this.title,
      // Before the media is detected, the stored kind is kept (a video page is not a "page").
      ...(this.hasVideo || this.kind === 'page' ? { kind: this.kind } : {}),
    };
  }

  /** Serialised: a context switch waits for the previous one (and its save) to finish. */
  private switchContext(ctx: VideoContext | null, title: string): Promise<void> {
    const run = this.loading.then(() => this.loadContext(ctx, title));
    this.loading = run.catch(() => undefined);
    return run;
  }

  private async loadContext(ctx: VideoContext | null, title: string): Promise<void> {
    this.title = title || this.title;
    if (ctx?.noteId === this.ctx?.noteId && this.note) {
      this.title = title || this.note.title;
      this.renderHeader();
      return;
    }
    await this.flush();
    const seq = ++this.loadSeq;
    this.ctx = ctx;
    this.title = title;
    this.note = null;
    this.reading = { ratio: 0, passage: null };
    this.renderHeader();
    void this.loadWikiTitles();
    if (!ctx) {
      this.editor.load('');
      this.editor.setEditable(false);
      this.showBanner('Rien à noter ici. Ouvrez une vidéo, un cours Udemy / Coursera, une page Notion ou un article.');
      return;
    }
    const meta = this.meta() as NoteMeta;
    try {
      const note = await callBackground({ type: 'note:get', noteId: ctx.noteId, meta });
      if (seq !== this.loadSeq) return;
      this.note = note;
      this.knownRev = note.rev;
      this.title = title || note.title;
      this.editor.load(note.markdown);
      this.editor.setEditable(true);
      this.hideBanner();
      this.setSaveState(note.rev > 0 ? 'saved' : 'idle');
      this.renderHeader();
    } catch (e) {
      this.showBanner(`Impossible de charger la note : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private scheduleSave(): void {
    if (!this.note) return;
    this.dirty = true;
    this.setSaveState('pending');
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  private flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const meta = this.meta();
    if (!this.dirty || !this.note || !meta) return this.saving;
    this.dirty = false;
    const noteId = this.note.id;
    const markdown = this.editor.content;
    this.setSaveState('saving');
    this.saving = this.saving
      .then(() => callBackground({ type: 'note:save', noteId, meta, markdown, writer: CLIENT_ID }))
      .then((saved) => {
        if (this.note?.id === noteId) {
          this.note = saved;
          this.knownRev = Math.max(this.knownRev, saved.rev);
        }
        this.setSaveState(this.dirty ? 'pending' : 'saved');
      })
      .catch((e: unknown) => {
        this.dirty = true;
        this.setSaveState('error', e instanceof Error ? e.message : String(e));
      });
    return this.saving;
  }

  // --- UI -------------------------------------------------------------------------------

  private buildUi(): void {
    const iconButton = (name: IconName, label: string, onClick: () => void, extra: Record<string, string> = {}) => {
      const b = h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, ...extra }, icon(name));
      b.addEventListener('click', onClick);
      return b;
    };
    const actionButton = (name: IconName, label: string, onClick: () => void) => {
      const b = h(
        'button',
        { type: 'button', class: 'action', title: label, 'aria-label': label },
        icon(name),
        h('span', { class: 'action-label' }, label),
      );
      b.addEventListener('click', onClick);
      return b;
    };

    this.statusLabel = h('span', { class: 'status-label' }, 'Hors-ligne');
    this.statusButton = h(
      'button',
      { type: 'button', class: 'status', 'data-state': 'offline' },
      h('span', { class: 'status-dot', 'aria-hidden': 'true' }),
      this.statusLabel,
    );
    this.statusButton.addEventListener('click', () => {
      this.renderStatus({ state: 'connecting', pending: 0, at: Date.now() });
      callBackground({ type: 'sync:retry' }).then((s) => this.renderStatus(s), () => undefined);
    });

    const actions: HTMLElement[] = [];
    if (MODE === 'embedded') {
      actions.push(iconButton('popout', 'Détacher dans une fenêtre', () => void this.popout()));
    } else {
      actions.push(iconButton('dock', 'Rattacher au lecteur (panneau latéral)', () => void this.dock()));
    }
    this.exportButton = iconButton('share', 'Exporter la note', () => this.toggleMenu(), {
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    });
    actions.push(this.exportButton);
    if (MODE === 'embedded') {
      this.pinButton = iconButton('pin', 'Épingler le panneau', () => this.post({ type: 'pin', value: !this.pinned }), {
        'aria-pressed': 'false',
      });
      actions.push(this.pinButton);
    }
    actions.push(iconButton('close', MODE === 'embedded' ? 'Réduire le panneau (Échap)' : 'Fermer la fenêtre', () => void this.close()));

    this.titleEl = h('h1', { class: 'title' }, 'Boo Notes');
    this.platformEl = h('span', { class: 'platform' });
    this.placeButton = h('button', { type: 'button', class: 'place', 'aria-haspopup': 'menu', 'aria-expanded': 'false', hidden: true });
    this.placeButton.addEventListener('click', () => void this.togglePlaceMenu());
    this.placeMenu = h('div', { class: 'menu place-menu', role: 'menu', hidden: true, 'aria-label': 'Ranger dans un cours' });
    this.placeMenu.addEventListener('keydown', (e) => this.onPlaceMenuKey(e));
    this.statsEl = h('span', { class: 'stats' });
    this.saveEl = h('span', { class: 'save', 'data-state': 'idle' });
    this.noticeEl = h('div', { class: 'notice', role: 'status', 'aria-live': 'polite' });
    this.menu = this.buildMenu();
    this.banner = h('div', { class: 'banner', hidden: true, role: 'status' });
    this.siteHint = this.buildSiteHint();
    this.playersHint = this.buildPlayersHint();

    this.clockEl = h('span', { class: 'clock-now', title: 'Position de la vidéo' }, '--:--');
    this.durationEl = h('span', { class: 'clock-duration', title: 'Durée de la vidéo' });
    this.readingBar = h(
      'span',
      { class: 'reading-bar', role: 'progressbar', 'aria-label': 'Lecture de la page', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true },
      h('span', { class: 'reading-fill' }),
    );
    // In reading mode the same button quotes the selected passage (see renderKind).
    const timestamp = actionButton('clock', 'Horodater', () => this.post({ type: this.kind === 'page' ? 'quote' : 'timestamp' }));
    const capture = actionButton('camera', 'Capturer', () => this.post({ type: 'capture' }));
    const replay = iconButton('replay', 'Revoir 5 s', () => this.post({ type: 'replay' }));
    const help = iconButton('keyboard', 'Raccourcis clavier', () => this.sheet.open());
    // A stream no script can read (protected player, native app, live lecture): a manual clock.
    this.chronoButton = actionButton('clock', 'Chronomètre', () => this.post({ type: 'stopwatch', action: 'start' }));
    this.chronoButton.classList.add('chrono');
    this.chronoButton.title =
      'Aucun lecteur accessible ? Lancez un chronomètre au début du flux (direct, lecteur protégé, cours en salle) : vos horodatages le suivent.';
    const swToggle = iconButton('pause', 'Mettre le chronomètre en pause', () =>
      this.post({ type: 'stopwatch', action: this.playback.playing ? 'pause' : 'start' }),
    );
    swToggle.classList.add('sw-toggle');
    const swReset = iconButton('close', 'Arrêter le chronomètre', () => this.post({ type: 'stopwatch', action: 'reset' }));
    this.stopwatchEl = h('span', { class: 'stopwatch', hidden: true, role: 'group', 'aria-label': 'Chronomètre' }, swToggle, swReset);
    const link = iconButton('link', 'Lier une fiche ([[)', () => this.editor.insertWikiLink());
    this.footerButtons = { timestamp, capture, replay, help, link };

    const editorHost = h('main', { class: 'editor', 'aria-label': 'Éditeur de notes (Markdown)' });
    editorHost.append(this.emptyState.el);
    this.emptyState.el.hidden = true;

    this.root.append(
      h(
        'header',
        { class: 'header' },
        h('div', { class: 'toolbar' }, this.statusButton, h('span', { class: 'spacer' }), ...actions),
        this.titleEl,
        h('div', { class: 'meta' }, this.platformEl, this.placeButton, this.statsEl, h('span', { class: 'spacer' }), this.saveEl),
        this.siteHint,
        this.playersHint,
        this.menu,
        this.placeMenu,
      ),
      this.banner,
      editorHost,
      h(
        'footer',
        { class: 'footer' },
        // Media-player scrubber: current time · notes timeline · duration.
        h('div', { class: 'scrubber' }, this.clockEl, this.stopwatchEl, this.timeline.el, this.readingBar, this.durationEl),
        h('div', { class: 'controls' }, timestamp, capture, this.chronoButton, h('span', { class: 'spacer' }), link, replay, help),
      ),
      this.noticeEl,
      this.sheet.el,
    );
  }

  private buildMenu(): HTMLDivElement {
    const item = (target: ExportTarget | 'copy', iconName: IconName, label: string, hint: string) => {
      const b = h(
        'button',
        { type: 'button', role: 'menuitem', 'data-target': target, 'data-hint': hint },
        icon(iconName, 18),
        h('span', {}, label, h('small', {}, hint)),
      );
      b.addEventListener('click', () => {
        this.closeMenu(true);
        void (target === 'copy' ? this.copyMarkdown() : this.exportTo(target));
      });
      return b;
    };
    const menu = h(
      'div',
      { class: 'menu', role: 'menu', hidden: true, 'aria-label': 'Exporter' },
      h('div', { class: 'menu-label', 'aria-hidden': 'true' }, 'Application Desktop'),
      item('desktop', 'desktop', 'Envoyer vers l’app Desktop', 'Dossier de notes local'),
      item('notion', 'notion', 'Envoyer vers Notion', 'Tableau « Boo Notes — Mes notes »'),
      h('div', { class: 'menu-sep', role: 'separator' }),
      h('div', { class: 'menu-label', 'aria-hidden': 'true' }, 'Sur cet appareil'),
      item('download', 'download', 'Télécharger', 'Fichier .md + dossier assets/'),
      item('copy', 'copy', 'Copier le Markdown', 'Avec liens horodatés'),
    );
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeMenu(true);
      }
    });
    return menu;
  }

  private toggleMenu(): void {
    if (!this.menu.hidden) {
      this.closeMenu(false);
      return;
    }
    const online = this.statusButton.dataset.state === 'connected';
    const direct = Boolean(this.notionStatus?.configured);
    for (const b of this.menu.querySelectorAll<HTMLButtonElement>('button')) {
      const target = b.dataset.target;
      const small = b.querySelector('small');
      let hint = b.dataset.hint ?? '';
      let enabled = Boolean(this.note);
      if (target === 'desktop') {
        enabled &&= online;
        if (!online) hint = 'Application Desktop hors-ligne';
      } else if (target === 'notion') {
        // Through the app when it runs, else directly from the browser.
        enabled &&= online || direct;
        hint = online ? 'Via l’app Desktop' : direct ? 'Directement (app Desktop fermée)' : 'Connectez Notion : app Desktop ou options';
      }
      b.disabled = !enabled;
      if (small) small.textContent = hint;
    }
    this.menu.hidden = false;
    this.exportButton.setAttribute('aria-expanded', 'true');
    this.menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  private closeMenu(refocus: boolean): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.exportButton.setAttribute('aria-expanded', 'false');
    if (refocus) this.exportButton.focus();
  }

  private renderHeader(): void {
    const title = this.title || this.note?.title || 'Boo Notes';
    this.titleEl.textContent = title;
    this.titleEl.title = title;
    document.title = `${title} — Boo Notes`;
    this.platformEl.hidden = !this.ctx;
    this.renderPlace();
    this.renderKind();
    this.renderSaveState();
    void this.renderSiteHint();
  }

  /**
   * Platform chip (+ « Audio » / « Lecture »), and the footer: timestamp,
   * capture and replay for a media; quote, page capture and reading progress
   * for a page without media.
   */
  private renderKind(): void {
    const audio = this.hasVideo && this.kind === 'audio';
    const page = this.kind === 'page';
    const platform = this.ctx ? PLATFORM_LABELS[this.ctx.platform] : '';
    const via = this.source === 'stopwatch' ? ' · Chronomètre' : this.source === 'frame' ? ' · Lecteur intégré' : '';
    this.platformEl.textContent = (audio ? `${platform} · Audio` : page ? `${platform} · Lecture` : platform) + via;
    this.renderSource();
    document.documentElement.dataset.kind = page ? 'page' : audio ? 'audio' : 'video';
    document.documentElement.dataset.source = this.source ?? 'none';
    this.emptyState.setMode(page ? 'page' : 'media');
    if (this.editor) this.scheduleContentRefresh();
    this.timeline.el.hidden = page;
    this.readingBar.hidden = !page;
    this.clockEl.title = page ? 'Lu jusqu’ici' : 'Position de la vidéo';
    this.durationEl.title = page ? '' : 'Durée de la vidéo';
    const buttons = this.footerButtons;
    if (!buttons) return;
    const withKey = (label: string, key: string | undefined) => (key ? `${label} (${key})` : label);
    const set = (b: HTMLButtonElement, label: string, iconName?: IconName, text?: string) => {
      b.title = label;
      b.setAttribute('aria-label', label);
      if (iconName && text) b.replaceChildren(icon(iconName), h('span', { class: 'action-label' }, text));
    };
    const keys = this.shortcuts;
    if (page) set(buttons.timestamp, withKey('Citer le passage sélectionné dans la page', keys['insert-timestamp']), 'quote', 'Citer');
    else set(buttons.timestamp, withKey('Insérer l’horodatage', keys['insert-timestamp']), 'clock', 'Horodater');
    buttons.capture.disabled = audio;
    set(
      buttons.capture,
      audio
        ? 'Capture indisponible pour un média audio'
        : withKey(page ? 'Capturer la partie visible de la page' : 'Capturer l’image', keys['capture-screenshot']),
    );
    buttons.replay.hidden = page;
    set(buttons.replay, withKey(`Revoir les ${this.settings.replaySeconds} dernières secondes`, keys.replay));
    set(buttons.help, withKey('Raccourcis clavier', IS_MAC ? '⌘/' : 'Ctrl+/'));
  }

  // --- Course › chapter filing -------------------------------------------------------------

  private renderPlace(): void {
    if (!this.placeButton) return;
    const note = this.note;
    this.placeButton.hidden = !this.ctx || !note;
    const placed = Boolean(note?.course);
    this.placeButton.dataset.placed = String(placed);
    this.placeButton.replaceChildren(
      icon('course', 13),
      h('span', { class: 'place-label' }, placed ? `${note!.course} › ${note!.chapter ?? 'Chapitre 1'}` : 'Ranger dans un cours'),
    );
    const label = placed ? `Rangée dans ${note!.course} › ${note!.chapter} (changer)` : 'Ranger cette note dans un cours et un chapitre de la bibliothèque';
    this.placeButton.title = label;
    this.placeButton.setAttribute('aria-label', label);
  }

  private async togglePlaceMenu(): Promise<void> {
    if (!this.placeMenu.hidden) {
      this.closePlaceMenu(true);
      return;
    }
    this.closeMenu(false);
    const courses = await callBackground({ type: 'library:courses' }).catch(() => [] as CourseOption[]);
    this.renderPlaceMenu(courses);
    this.placeMenu.style.top = `${this.placeButton.offsetTop + this.placeButton.offsetHeight + 6}px`;
    this.placeMenu.hidden = false;
    this.placeButton.setAttribute('aria-expanded', 'true');
    (this.placeMenu.querySelector<HTMLElement>('[aria-checked="true"]') ?? this.placeMenu.querySelector<HTMLElement>('button, input'))?.focus();
  }

  private closePlaceMenu(refocus: boolean): void {
    if (this.placeMenu.hidden) return;
    this.placeMenu.hidden = true;
    this.placeButton.setAttribute('aria-expanded', 'false');
    if (refocus) this.placeButton.focus();
  }

  private renderPlaceMenu(courses: CourseOption[]): void {
    const current = this.note?.course ? { course: this.note.course, chapter: this.note.chapter ?? '' } : null;
    const same = (a: string, b: string) => normalizeTitle(a) === normalizeTitle(b);
    const item = (label: string, place: { course: string; chapter: string } | null, extra: Partial<Record<string, string>> = {}) => {
      const checked = Boolean(place && current && same(place.course, current.course) && same(place.chapter, current.chapter));
      const b = h(
        'button',
        { type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), ...extra },
        checked ? icon('check', 14) : h('span', { class: 'menu-check-space' }),
        h('span', {}, label),
      );
      b.addEventListener('click', () => void this.place(place));
      return b;
    };
    const children: HTMLElement[] = [h('div', { class: 'menu-label', 'aria-hidden': 'true' }, 'Ranger dans')];
    if (!courses.length) {
      children.push(h('p', { class: 'place-empty' }, 'Aucun cours pour l’instant : créez-en un ci-dessous (ou dans l’app Desktop).'));
    }
    for (const c of courses) {
      children.push(h('div', { class: 'place-course', 'aria-hidden': 'true' }, `${c.emoji ? `${c.emoji} ` : ''}${c.title}`));
      const chapters = c.chapters.length ? c.chapters : ['Chapitre 1'];
      for (const ch of chapters) children.push(item(ch, { course: c.title, chapter: ch }, { class: 'place-chapter' }));
    }
    children.push(h('div', { class: 'menu-sep', role: 'separator' }));
    // New course or chapter: free text, created in the library by the app.
    const courseInput = h('input', { type: 'text', placeholder: 'Cours', 'aria-label': 'Cours', list: 'boo-courses', value: current?.course ?? '' });
    const chapterInput = h('input', { type: 'text', placeholder: 'Chapitre', 'aria-label': 'Chapitre', list: 'boo-chapters' });
    const courseList = h('datalist', { id: 'boo-courses' }, ...courses.map((c) => h('option', { value: c.title })));
    const chapterList = h('datalist', { id: 'boo-chapters' });
    const fillChapters = () => {
      const c = courses.find((x) => same(x.title, courseInput.value));
      chapterList.replaceChildren(...(c?.chapters ?? []).map((t) => h('option', { value: t })));
    };
    courseInput.addEventListener('input', fillChapters);
    fillChapters();
    const submit = h('button', { type: 'submit', class: 'place-submit' }, 'Ranger');
    const form = h('form', { class: 'place-form' }, h('span', { class: 'menu-label' }, 'Nouveau cours ou chapitre'), courseInput, chapterInput, courseList, chapterList, submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!courseInput.value.trim()) {
        courseInput.focus();
        return;
      }
      void this.place({ course: courseInput.value, chapter: chapterInput.value });
    });
    children.push(form);
    if (current) {
      children.push(h('div', { class: 'menu-sep', role: 'separator' }), item('Retirer du cours', null, { class: 'danger', role: 'menuitem' }));
    }
    this.placeMenu.replaceChildren(...children);
  }

  private async place(place: { course: string; chapter: string } | null): Promise<void> {
    const ctx = this.ctx;
    const meta = this.meta();
    if (!ctx || !meta) return;
    this.closePlaceMenu(true);
    try {
      const note = await callBackground({ type: 'note:place', noteId: ctx.noteId, meta, place });
      if (this.ctx?.noteId !== ctx.noteId) return;
      this.knownRev = Math.max(this.knownRev, note.rev);
      this.note = { ...(this.note ?? note), course: note.course, chapter: note.chapter, placedAt: note.placedAt, rev: note.rev };
      if (!note.course) delete this.note.course;
      this.renderPlace();
      this.notify(note.course ? `Rangée dans ${note.course} › ${note.chapter}` : 'Note retirée du cours', 'success');
    } catch (e) {
      this.notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  private onPlaceMenuKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closePlaceMenu(true);
      return;
    }
    if (e.target instanceof HTMLInputElement || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const items = [...this.placeMenu.querySelectorAll<HTMLElement>('button[role^="menuitem"], input')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }

  /** Stopwatch controls, and the offer to start one when no media is readable. */
  private renderSource(): void {
    if (!this.stopwatchEl) return;
    const sw = this.source === 'stopwatch';
    this.stopwatchEl.hidden = !sw;
    this.chronoButton.hidden = this.hasVideo || !this.ctx;
    const toggle = this.stopwatchEl.querySelector<HTMLButtonElement>('.sw-toggle')!;
    const label = this.playback.playing ? 'Mettre le chronomètre en pause' : 'Reprendre le chronomètre';
    if (toggle.dataset.playing !== String(this.playback.playing)) {
      toggle.dataset.playing = String(this.playback.playing);
      toggle.replaceChildren(icon(this.playback.playing ? 'pause' : 'play'));
      toggle.title = label;
      toggle.setAttribute('aria-label', label);
    }
    this.clockEl.title = sw ? 'Chronomètre' : this.kind === 'page' ? 'Lu jusqu’ici' : 'Position de la vidéo';
  }

  /** Embedded players found in the page that Boo Notes may not read yet: one click allows them. */
  private buildPlayersHint(): HTMLDivElement {
    const button = h('button', { type: 'button', class: 'link-btn' }, 'Autoriser');
    button.addEventListener('click', () => void this.allowPlayers());
    return h('div', { class: 'players-hint', hidden: true, role: 'status' }, icon('video', 14), h('span', { class: 'site-text' }), button);
  }

  private async renderPlayers(hosts: string[]): Promise<void> {
    const missing: string[] = [];
    for (const host of hosts) {
      const has = await chrome.permissions.contains({ origins: [`https://${host}/*`] }).catch(() => false);
      if (!has) missing.push(host);
    }
    // Allowed earlier but loaded before: inject the agent now.
    if (hosts.length > missing.length && !this.playersInjected) {
      this.playersInjected = true;
      this.post({ type: 'players:granted' });
    }
    this.pendingPlayers = missing;
    this.playersHint.hidden = missing.length === 0;
    (this.playersHint.querySelector('.site-text') as HTMLElement).textContent =
      missing.length === 1
        ? `Lecteur intégré (${missing[0]}) : autorisez Boo Notes à le suivre pour horodater vos notes.`
        : `${missing.length} lecteurs intégrés (${missing.join(', ')}) : autorisez Boo Notes à les suivre.`;
  }

  private async allowPlayers(): Promise<void> {
    const origins = this.pendingPlayers.map((host) => `https://${host}`);
    if (!origins.length) return;
    // Needs the click's user gesture: requested here, recorded by the background.
    const granted = await chrome.permissions.request({ origins: origins.map((o) => `${o}/*`) }).catch(() => false);
    if (!granted) {
      this.notify('Autorisation refusée', 'error');
      return;
    }
    try {
      await callBackground({ type: 'players:allow', origins, tabId: TAB_ID });
      this.post({ type: 'players:granted' });
      this.playersHint.hidden = true;
      this.notify('Lecteur autorisé : Boo Notes suit sa lecture', 'success');
    } catch (e) {
      this.notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  /** On a site activated for this tab only: offer to keep Boo Notes active there. */
  private buildSiteHint(): HTMLDivElement {
    const button = h('button', { type: 'button', class: 'link-btn' }, 'Toujours activer ici');
    button.addEventListener('click', () => void this.enableSite());
    const hint = h('div', { class: 'site-hint', hidden: true }, h('span', { class: 'site-text' }), button);
    return hint;
  }

  private siteOrigin(): string | null {
    if (this.ctx?.platform !== 'web') return null;
    try {
      return new URL(this.ctx.canonicalUrl).origin;
    } catch {
      return null;
    }
  }

  private async renderSiteHint(): Promise<void> {
    const origin = this.siteOrigin();
    if (!origin) {
      this.siteHint.hidden = true;
      return;
    }
    const sites = await callBackground({ type: 'sites:list' }).catch(() => [] as string[]);
    (this.siteHint.querySelector('.site-text') as HTMLElement).textContent =
      `Actif sur ${new URL(origin).host} pour cet onglet.`;
    this.siteHint.hidden = sites.includes(origin);
  }

  private async enableSite(): Promise<void> {
    const origin = this.siteOrigin();
    if (!origin) return;
    // Needs the click's user gesture: requested here, recorded by the background.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
    if (!granted) {
      this.notify('Autorisation refusée', 'error');
      return;
    }
    try {
      await callBackground({ type: 'sites:enable', origin });
      this.siteHint.hidden = true;
      this.notify(`Boo Notes sera actif à chaque visite de ${new URL(origin).host}`, 'success');
    } catch (e) {
      this.notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  private saveState: SaveState = 'idle';
  private saveError = '';

  private setSaveState(state: SaveState, error = ''): void {
    this.saveState = state;
    this.saveError = error;
    this.renderSaveState();
  }

  private renderSaveState(): void {
    const labels: Record<SaveState, string> = {
      idle: '',
      pending: 'Modifié',
      saving: 'Enregistrement…',
      saved: 'Enregistré',
      error: 'Non enregistré',
    };
    const state = this.note ? this.saveState : 'idle';
    this.saveEl.dataset.state = state;
    this.saveEl.replaceChildren(
      ...(state === 'saved' ? [icon('check', 13)] : state === 'error' ? [icon('alert', 13)] : []),
      labels[state],
    );
    this.saveEl.title =
      state === 'error' ? this.saveError : state === 'saved' ? 'Enregistré sur cet appareil (chrome.storage)' : '';
  }

  private renderStatus(status: SyncStatus | undefined): void {
    const state = status?.state ?? 'offline';
    this.statusButton.dataset.state = state;
    this.statusLabel.textContent = state === 'connected' ? 'Connecté' : state === 'connecting' ? 'Connexion…' : 'Hors-ligne';
    const pending = status?.pending ? ` ${status.pending} note(s) en attente de synchronisation.` : '';
    this.statusButton.title =
      state === 'connected'
        ? `Synchronisé avec ${status?.app?.name ?? 'l’application Desktop'}.${pending}`
        : `Mode hors-ligne : notes enregistrées dans le navigateur.${pending}${status?.error ? `\n${status.error}` : ''}\nCliquer pour réessayer.`;
    this.statusButton.setAttribute('aria-label', `Synchronisation Desktop : ${this.statusLabel.textContent}`);
  }

  private renderPin(): void {
    if (!this.pinButton) return;
    this.pinButton.setAttribute('aria-pressed', String(this.pinned));
    const label = this.pinned ? 'Désépingler le panneau' : 'Épingler le panneau (reste ouvert)';
    this.pinButton.title = label;
    this.pinButton.setAttribute('aria-label', label);
  }

  private applyTheme(): void {
    const osDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const theme =
      this.settings.theme === 'auto' ? (this.pageTheme ?? (osDark ? 'dark' : 'light')) : this.settings.theme;
    document.documentElement.dataset.theme = theme;
  }

  /** Snackbar above the footer (Material pattern): transient, non-blocking. */
  private notify(text: string, kind: 'info' | 'success' | 'error' = 'info'): void {
    const glyph = kind === 'success' ? icon('check', 14) : kind === 'error' ? icon('alert', 14) : null;
    this.noticeEl.replaceChildren(...(glyph ? [glyph] : []), h('span', {}, text));
    this.noticeEl.dataset.kind = kind;
    this.noticeEl.classList.add('show');
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeEl.classList.remove('show');
      this.noticeTimer = setTimeout(() => this.noticeEl.replaceChildren(), 250);
    }, kind === 'error' ? 5000 : 3000);
  }

  private showBanner(text: string): void {
    this.banner.textContent = text;
    this.banner.hidden = false;
  }

  private hideBanner(): void {
    this.banner.hidden = true;
  }

  private async loadShortcuts(): Promise<void> {
    let list: Array<{ name: string; shortcut: string }>;
    try {
      list = await callBackground({ type: 'shortcuts:list' });
    } catch {
      return;
    }
    this.pageBindings = inPageBindings(list);
    const registered = new Map(list.map((c) => [c.name, c.shortcut]));
    const map = {} as ShortcutMap;
    for (const [id, fallback] of Object.entries(DEFAULT_SHORTCUTS) as Array<[keyof ShortcutMap, string]>) {
      const global = registered.get(id);
      if (global) map[id] = { keys: global, scope: 'global' };
      else if (this.settings.pageShortcuts) map[id] = { keys: fallback, scope: 'page' };
      else map[id] = { keys: '', scope: 'unset' };
    }
    this.shortcuts = Object.fromEntries(
      Object.entries(map).map(([id, info]) => [id, info.scope === 'page' ? formatShortcut(info.keys, IS_MAC) : info.keys]),
    );
    this.sheet.render(map);
    this.emptyState.render(map);
    this.renderKind();
  }

  // --- Actions -----------------------------------------------------------------------------

  private async popout(): Promise<void> {
    await this.flush();
    this.post({ type: 'popout' });
  }

  private async dock(): Promise<void> {
    await this.flush();
    this.post({ type: 'dock' });
  }

  private async close(): Promise<void> {
    await this.flush();
    if (MODE === 'popout') window.close();
    else this.post({ type: 'close' });
  }

  private async exportTo(target: ExportTarget): Promise<void> {
    if (!this.note) return;
    await this.flush();
    this.notify('Export en cours…');
    try {
      const { message } = await callBackground({ type: 'export', noteId: this.note.id, target });
      this.notify(message, 'success');
    } catch (e) {
      this.notify(`Export impossible : ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  /** `[[Titre]]` clicked: the desktop app, the note's page, or its Notion page. */
  private async openWiki(title: string): Promise<void> {
    await this.flush();
    try {
      const { message } = await callBackground({ type: 'wiki:open', title });
      this.notify(message, 'success');
    } catch (e) {
      this.notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  /** Passage link clicked: scrolled to in this page, or opened (the browser finds the passage). */
  private openFragment(url: string): void {
    if (this.ctx && this.port && samePage(url, this.ctx.canonicalUrl)) this.post({ type: 'reveal', url });
    else void chrome.tabs.create({ url });
  }

  private async loadWikiTitles(): Promise<void> {
    try {
      this.wikiTitles = await callBackground({ type: 'wiki:titles' });
    } catch {
      // Keep the previous list.
    }
  }

  private async copyMarkdown(): Promise<void> {
    if (!this.note) return;
    const text = toPortableMarkdown({ ...this.note, title: this.title || this.note.title, markdown: this.editor.content });
    try {
      await navigator.clipboard.writeText(text);
      this.notify('Markdown copié dans le presse-papier', 'success');
    } catch {
      this.notify('Copie refusée par le navigateur', 'error');
    }
  }

  private bindGlobalEvents(): void {
    document.addEventListener(
      'keydown',
      (e) => {
        if (this.sheet.isOpen) return; // The sheet handles its own keys (Esc, Tab).
        const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
        if (e.key === '?' && plain && !this.editor.hasFocus) {
          e.preventDefault();
          this.sheet.open();
          return;
        }
        const altLeft = e.key === 'ArrowLeft' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey;
        const binding = this.settings.pageShortcuts ? findBinding(this.pageBindings, e) : undefined;
        // On macOS, ⌥← moves by word inside the editor: keep that.
        if (binding && !(binding.command === 'replay' && IS_MAC && this.editor.hasFocus)) {
          e.preventDefault();
          e.stopPropagation();
          this.post({ type: 'command', command: binding.command });
          return;
        }
        // On Windows / Linux Alt+← would navigate the whole tab back.
        if (altLeft && !IS_MAC) {
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape' && !e.defaultPrevented && this.menu.hidden) {
          e.preventDefault();
          this.post({ type: 'escape' });
        }
      },
      true,
    );
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Node;
      if (!this.placeMenu.hidden && !this.placeMenu.contains(target) && !this.placeButton.contains(target)) this.closePlaceMenu(false);
      if (!this.menu.hidden && !this.menu.contains(e.target as Node) && e.target !== this.exportButton) {
        this.closeMenu(false);
      }
    });
    window.addEventListener('pagehide', () => void this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());

    window.addEventListener('focus', () => void this.loadWikiTitles());
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes['sync:status']) {
        this.renderStatus(changes['sync:status'].newValue as SyncStatus | undefined);
      }
      if (area === 'session' && changes['notion:status']) {
        this.notionStatus = (changes['notion:status'].newValue as NotionStatus | undefined) ?? null;
      }
      if (area === 'sync' && changes.settings) {
        this.settings = normalizeSettings(changes.settings.newValue);
        this.autoPause.enabled = this.settings.autoPause;
        this.applyTheme();
      }
      if (area === 'local' && this.note) {
        const change = changes[`note:${this.note.id}`];
        const next = change?.newValue as Note | undefined;
        // Another writer (background append, other window) saved a newer revision.
        if (next && next.lastWriter !== CLIENT_ID && next.rev > this.knownRev && !this.dirty) {
          this.knownRev = next.rev;
          this.note = next;
          this.editor.replaceContent(next.markdown);
          this.renderPlace();
        }
      }
    });
  }
}

void new PanelApp().start();
