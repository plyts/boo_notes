import { TypingAutoPause } from '../shared/autopause';
import { plainText } from '../shared/cards';
import { getMedia, listMedia, putMedia } from '../shared/media-db';
import { htmlToMarkdown } from '../shared/html-markdown';
import { h, icon, type IconName } from '../shared/icons';
import { findAssetRefs, findFragmentLinks, linkedTitles, normalizeTitle, toPortableMarkdown } from '../shared/markdown';
import {
  callBackground,
  HIDDEN_SITE,
  type BackgroundRequest,
  PANEL_PORT,
  type CaptionState,
  type ContentToPanel,
  type ExportTarget,
  type MediaSource,
  type NotionStatus,
  type PageTheme,
  type PanelMode,
  type PanelToContent,
  type PlaybackState,
  type ScormState,
  type SyncStatus,
} from '../shared/messages';
import { detectVideoContext, PLATFORM_LABELS, timestampUrl, type MediaKind, type VideoContext } from '../shared/platforms';
import { buildRichCopy, renderRichCopy, type RichCopyInput } from '../shared/rich-copy';
import { scormLabel } from '../shared/scorm';
import { loadSettings, normalizeSettings, saveSettings, type Settings } from '../shared/settings';
import type { AssetRecord, CourseOption, Note, NoteMeta } from '../shared/store';
import { IS_MAC } from '../shared/keycaps';
import { DEFAULT_SHORTCUTS, findBinding, formatShortcut, inPageBindings, type InPageBinding } from '../shared/shortcuts';
import { formatTimecode } from '../shared/time';
import {
  annotateCues,
  cueQuote,
  cuesInRange,
  notesInRange,
  passageLine,
  pinTranscriptLine,
  rangeLabel,
  setPassageMedia,
  transcriptLine,
  type Cue,
  type Transcript,
} from '../shared/transcript';
import type { CuePatch } from '../shared/transcript-store';
import { NotesEditor } from './editor';
import {
  adaptClip,
  classifyPaste,
  fileKind,
  imageLine,
  MAX_MEDIA_BYTES,
  mediaFileLine,
  pastedMediaPath,
  pictureBlob,
  prepareImage,
  toPngBlob,
  writeBooClip,
} from './rich-clipboard';
import { EmptyState, ShortcutsSheet, type ShortcutMap } from './sheet';
import { Timeline } from './timeline';
import { TranscriptView } from './transcript-view';
import { CueTranslator, type TranslateStatus } from './translator';

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
/** Pictures already read (data URL by path): a copy fills the clipboard at once with them. */
const assetData = new Map<string, string>();

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
      assetData.set(path, asset.dataUrl);
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
  /** A course module (SCORM, xAPI) in the page: its completion, progress, score. */
  private scorm: ScormState | null = null;
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
  private footerButtons: Record<'timestamp' | 'capture' | 'replay' | 'help' | 'link' | 'fullscreen', HTMLButtonElement> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private contentTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timeline = new Timeline({
    seek: (seconds) => this.post({ type: 'seek', seconds }),
    preview: (seconds) => this.post({ type: 'mark', seconds }),
  });
  private readonly sheet = new ShortcutsSheet(
    IS_MAC,
    () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
    // The page's diagnostic (its tab: known in the drawer and in the pop-out).
    TAB_ID >= 0 ? () => void callBackground({ type: 'diagnostic:run', tabId: TAB_ID }).catch((e: unknown) => this.notify(e instanceof Error ? e.message : String(e), 'error')) : undefined,
  );
  private readonly emptyState = new EmptyState(IS_MAC);

  // Transcript (subtitles collected in the background), passages, recordings.
  private view: 'notes' | 'transcript' = 'notes';
  private transcript: Transcript | null = null;
  private caption: { cue: Cue | null; state: CaptionState } = { cue: null, state: { status: 'searching', source: null, label: '' } };
  private recording: { passage: { start: number; end?: number; recording: boolean } | null; audio: boolean } = { passage: null, audio: false };
  /** Kept sound of the course (IndexedDB): stretches that can be listened to. */
  private audioTrace: Array<{ path: string; start: number; end: number }> = [];
  private tabs!: HTMLDivElement;
  private notesTab!: HTMLButtonElement;
  private transcriptTab!: HTMLButtonElement;
  private editorHost!: HTMLElement;
  private liveEl!: HTMLDivElement;
  private recPill!: HTMLButtonElement;
  private passageButton!: HTMLButtonElement;
  private mediaPop!: HTMLDivElement;
  private mediaUrl: string | null = null;
  private translateStatus: TranslateStatus = { state: 'off' };
  private readonly transcriptView = new TranscriptView({
    seek: (seconds) => this.post({ type: 'seek', seconds }),
    pin: (cue) => this.pinCue(cue),
    annotate: (id, field, value) => this.annotate([{ id, [field]: value }]),
    passage: (start, end, record) => {
      this.post({ type: 'passage:create', start, end, record });
      this.notify(record ? `Passage ${rangeLabel(start, end)} : lecture et enregistrement de l’extrait…` : `Passage ${rangeLabel(start, end)} ajouté à la note`);
    },
    toggleTranslate: (on) => void this.setTranslate(on, true),
    pinTranscript: () => this.pinTranscript(true),
    listen: (seconds) => void this.listen(seconds),
    notesIn: (start, end) => notesInRange(this.editor.content, start, end).length,
    showCaptions: () => this.post({ type: 'captions:show' }),
    setTarget: (lang) => void this.setTarget(lang),
    playRange: (start, end) => this.post({ type: 'play-range', start, end }),
  });
  private readonly translator = new CueTranslator({
    patch: (patches, lang) => this.annotate(patches, lang),
    status: (s) => {
      this.translateStatus = s;
      this.transcriptView.setTranslate(this.settings.autoTranslate, s);
    },
  });

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
      onTimestampClick: (seconds, _res, end, url) => {
        // A moment of another media (pasted from another note): opened there.
        if (url && detectVideoContext(url)?.noteId !== this.ctx?.noteId) {
          window.open(url, '_blank', 'noopener');
          return;
        }
        this.post(end !== null && end !== undefined ? { type: 'play-range', start: seconds, end } : { type: 'seek', seconds });
      },
      onMediaClick: (path) => void this.openMedia(path),
      onTranscriptClick: () => this.setView('transcript'),
      onPassageTranscript: (start, end) => this.showPassageTranscript(start, end),
      onPaste: (data) => this.paste(data),
      onCopy: (markdown, data) => this.copySelection(markdown, data),
      onCopyImage: (path) => void this.copyImage(path),
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
    this.transcriptView.setTarget(this.settings.translateTo);
    this.transcriptView.setTranslate(this.settings.autoTranslate, this.translateStatus);
    if (this.settings.autoTranslate) void this.setTranslate(true, false);
    setInterval(() => this.tick(), 250);
    this.watchExtension();
  }

  // --- Extension reloaded under the panel ----------------------------------------------------

  private orphaned = false;

  /**
   * Boo Notes was reloaded or updated while this panel was open: every call
   * to the extension now fails (« Extension context invalidated »). The panel
   * says so, keeps the text reachable, and asks to reload the page.
   */
  private watchExtension(): void {
    const invalidated = (reason: unknown) => /context invalidated/i.test(reason instanceof Error ? reason.message : String(reason));
    window.addEventListener('unhandledrejection', (e) => {
      if (!invalidated(e.reason)) return;
      e.preventDefault();
      this.orphan();
    });
    window.addEventListener('error', (e) => {
      if (!invalidated(e.error ?? e.message)) return;
      e.preventDefault();
      this.orphan();
    });
    setInterval(() => !chrome.runtime?.id && this.orphan(), 2000);
  }

  private orphan(): void {
    if (this.orphaned) return;
    this.orphaned = true;
    this.editor.setEditable(false);
    const copy = h('button', { type: 'button', class: 'btn-quiet' }, icon('copy', 15), 'Copier le texte de la note');
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.editor.content).then(
        () => (copy.lastChild!.textContent = 'Texte copié'),
        () => (copy.lastChild!.textContent = 'Copie impossible'),
      );
    });
    const card = h(
      'div',
      { class: 'orphan', role: 'alertdialog', 'aria-labelledby': 'orphan-title' },
      h('div', { class: 'orphan-card' }, icon('refresh', 22), h('h2', { id: 'orphan-title' }, 'Boo Notes a été mis à jour'), h('p', {}, `Rechargez la page (${IS_MAC ? '⌘R' : 'F5'}) pour continuer : vos notes enregistrées sont conservées. Ce que vous venez de taper peut être copié avant.`), h('div', { class: 'orphan-actions' }, copy)),
    );
    this.root.append(card);
    copy.focus();
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
      case 'scorm':
        this.scorm = msg.state;
        this.renderKind();
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
      case 'caption':
        this.caption = { cue: msg.cue, state: msg.state };
        this.transcriptView.setState(msg.state);
        this.renderLive();
        break;
      case 'recording':
        this.recording = { passage: msg.passage, audio: msg.audio };
        this.renderRecording();
        void this.loadAudioTrace();
        break;
      case 'insert-passage':
        void this.loading.then(() => {
          if (!this.note) return;
          const title = this.passageTitle(msg.start, msg.end);
          this.editor.insertBlock(passageLine({ start: msg.start, end: msg.end, title, image: msg.image, media: msg.media }));
        });
        break;
      case 'passage-media':
        void this.loading.then(() => {
          if (this.note && this.editor.transform((md) => setPassageMedia(md, msg.start, msg.media))) this.notify('Extrait ajouté au passage', 'success');
        });
        break;
      case 'media-ended':
        void this.loading.then(() => this.pinTranscript(false));
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
    if (this.orphaned) return;
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
    this.transcriptView.setTime(t);
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
      const captures = markers.filter((m) => m.kind === 'capture').length;
      const passages = markers.filter((m) => m.kind === 'passage').length;
      parts = [notes ? plural(notes, 'note') : '', captures ? plural(captures, 'capture') : '', passages ? plural(passages, 'passage') : ''];
    }
    const links = linkedTitles(this.editor.content).length;
    if (links) parts.push(plural(links, 'lien'));
    this.statsEl.textContent = parts.filter(Boolean).join(' · ');
    this.emptyState.el.hidden = !this.note || !this.editor.isEmpty;
    // Every picture of the note read beforehand: a copy of any part of it carries them.
    for (const path of findAssetRefs(this.editor.content)) if (!assetData.has(path)) void loadAsset(path).catch(() => undefined);
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
    this.setTranscript(null);
    this.audioTrace = [];
    this.timeline.setCoverage([]);
    this.closeMedia();
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
      void this.loadTranscript(ctx.noteId);
      void this.loadAudioTrace();
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

  /**
   * The panel is going away (removed from the page — its frame left
   * fullscreen, the notes moved —, tab closed): the last edits leave at once,
   * a save queued behind another would never be sent.
   */
  private flushNow(): void {
    const meta = this.meta();
    if (!this.dirty || !this.note || !meta) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = false;
    try {
      void chrome.runtime.sendMessage({ type: 'note:save', noteId: this.note.id, meta, markdown: this.editor.content, writer: CLIENT_ID } satisfies BackgroundRequest).catch(() => undefined);
    } catch {
      // Extension reloaded: nothing to send to.
    }
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
    // The video fullscreen with the notes beside it (the page's own fullscreen may hide them).
    const fullscreen = iconButton('expand', 'Plein écran avec les notes', () => this.post({ type: 'fullscreen' }));
    this.footerButtons = { timestamp, capture, replay, help, link, fullscreen };
    capture.classList.add('compact');
    // Passage: first click = its start, second = its end (Alt+I / Alt+O).
    this.passageButton = actionButton('passage', 'Passage', () =>
      this.post({ type: 'command', command: this.recording.passage && this.recording.passage.end === undefined ? 'passage-end' : 'passage-start' }),
    );
    this.passageButton.classList.add('compact', 'passage-btn');

    // Recording in progress (sound of the course kept, passage being recorded).
    this.recPill = h('button', { type: 'button', class: 'rec-pill', hidden: true }, icon('rec', 10), h('span', {}, 'REC'));
    this.recPill.addEventListener('click', () => this.setView('transcript'));

    // Notes │ Transcription
    const tab = (id: 'notes' | 'transcript', label: string) => {
      const b = h('button', { type: 'button', role: 'tab', class: 'tab', id: `tab-${id}`, 'aria-selected': String(id === 'notes'), 'aria-controls': `view-${id}` }, h('span', {}, label));
      b.addEventListener('click', () => this.setView(id));
      return b;
    };
    this.notesTab = tab('notes', 'Notes');
    this.transcriptTab = tab('transcript', 'Transcription');
    this.transcriptTab.append(h('span', { class: 'tab-count', hidden: true }));
    this.tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Vue du panneau' }, this.notesTab, this.transcriptTab);
    this.tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      this.setView(this.view === 'notes' ? 'transcript' : 'notes');
      (this.view === 'notes' ? this.notesTab : this.transcriptTab).focus();
    });

    const editorHost = h('main', { class: 'editor', id: 'view-notes', role: 'tabpanel', 'aria-labelledby': 'tab-notes', 'aria-label': 'Éditeur de notes (Markdown)' });
    editorHost.append(this.emptyState.el);
    this.emptyState.el.hidden = true;
    this.editorHost = editorHost;
    this.transcriptView.el.id = 'view-transcript';
    this.transcriptView.el.setAttribute('role', 'tabpanel');
    this.transcriptView.el.setAttribute('aria-labelledby', 'tab-transcript');
    this.liveEl = this.buildLive();
    this.mediaPop = h('div', { class: 'media-pop', role: 'dialog', 'aria-label': 'Extrait', hidden: true });

    this.root.append(
      h(
        'header',
        { class: 'header' },
        h('div', { class: 'toolbar' }, this.statusButton, this.recPill, h('span', { class: 'spacer' }), ...actions),
        // Course › chapter of the library, as a breadcrumb above the title.
        this.placeButton,
        this.titleEl,
        h('div', { class: 'meta' }, this.platformEl, this.statsEl, h('span', { class: 'spacer' }), this.saveEl),
        this.tabs,
        this.siteHint,
        this.playersHint,
        this.menu,
        this.placeMenu,
      ),
      this.banner,
      editorHost,
      this.transcriptView.el,
      this.liveEl,
      this.mediaPop,
      h(
        'footer',
        { class: 'footer' },
        // Media-player scrubber: current time · notes timeline · duration.
        h('div', { class: 'scrubber' }, this.clockEl, this.stopwatchEl, this.timeline.el, this.readingBar, this.durationEl),
        h('div', { class: 'controls' }, timestamp, capture, this.passageButton, this.chronoButton, h('span', { class: 'spacer' }), link, replay, fullscreen, help),
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
        void (target === 'copy' ? this.copyNote() : this.exportTo(target));
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
      item('download', 'download', 'Télécharger', '.md + captures, extraits et transcription'),
      item('pdf', 'file', 'Télécharger en PDF', 'Images comprises, instants et passages cliquables'),
      item('copy', 'copy', 'Copier la note', 'Images comprises : Obsidian, Notion, Docs…'),
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
    // A course module (SCORM): what it reports to the LMS, next to the platform.
    const lesson = this.scorm ? ` · Module ${this.scorm.version === 'xapi' ? 'xAPI' : 'SCORM'}${scormLabel(this.scorm) ? ` · ${scormLabel(this.scorm)}` : ''}` : '';
    this.platformEl.textContent = (audio ? `${platform} · Audio` : page && !lesson ? `${platform} · Lecture` : platform) + via + lesson;
    this.platformEl.title = this.scorm?.location ? `Repère du module : ${this.scorm.location}` : '';
    this.renderSource();
    document.documentElement.dataset.kind = page ? 'page' : audio ? 'audio' : 'video';
    document.documentElement.dataset.source = this.source ?? 'none';
    this.emptyState.setMode(page ? 'page' : 'media');
    if (this.editor) this.scheduleContentRefresh();
    this.timeline.el.hidden = page;
    this.readingBar.hidden = !page;
    this.tabs.hidden = page || !this.ctx;
    this.passageButton.hidden = page || !this.hasVideo;
    if (page && this.view !== 'notes') this.setView('notes');
    this.renderLive();
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
    // A picture to watch: fullscreen with the notes (not for audio, pages, or a detached window).
    buttons.fullscreen.hidden = page || audio || !this.hasVideo || MODE === 'popout';
    buttons.replay.hidden = page;
    set(buttons.replay, withKey(`Revoir les ${this.settings.replaySeconds} dernières secondes`, keys.replay));
    set(buttons.help, withKey('Raccourcis clavier', IS_MAC ? '⌘/' : 'Ctrl+/'));
    this.renderRecording();
  }

  // --- Transcript, live subtitle, passages ---------------------------------------------------

  private setView(view: 'notes' | 'transcript'): void {
    if (view === 'transcript' && (this.kind === 'page' || !this.ctx)) return;
    const changed = view !== this.view;
    this.view = view;
    this.notesTab.setAttribute('aria-selected', String(view === 'notes'));
    this.transcriptTab.setAttribute('aria-selected', String(view === 'transcript'));
    this.notesTab.tabIndex = view === 'notes' ? 0 : -1;
    this.transcriptTab.tabIndex = view === 'transcript' ? 0 : -1;
    this.editorHost.hidden = view !== 'notes';
    this.transcriptView.show(view === 'transcript');
    document.documentElement.dataset.view = view;
    this.renderLive();
    if (!changed) return;
    if (view === 'transcript') this.transcriptView.focus();
    else this.editor.focus();
  }

  private setTranscript(t: Transcript | null): void {
    this.transcript = t;
    this.transcriptView.set(t);
    const count = this.transcriptTab.querySelector<HTMLElement>('.tab-count')!;
    count.textContent = t?.cues.length ? String(t.cues.length) : '';
    count.hidden = !t?.cues.length;
    this.translator.update(t, this.hasVideo ? this.now() : null);
    this.renderLive();
  }

  private async loadTranscript(noteId: string): Promise<void> {
    try {
      const t = await callBackground({ type: 'transcript:get', noteId });
      if (this.ctx?.noteId === noteId) this.setTranscript(t);
    } catch {
      // No transcript yet.
    }
  }

  /** Translations and comments: shown at once, stored by the background. */
  private annotate(patches: CuePatch[], lang?: string): void {
    const t = this.transcript;
    if (!t) return;
    if (patches.length) {
      this.transcript = { ...t, cues: annotateCues(t.cues, patches), ...(lang ? { lang } : {}) };
      this.transcriptView.set(this.transcript);
      this.renderLive();
    }
    void callBackground({ type: 'transcript:annotate', noteId: t.noteId, patches, lang, target: this.settings.translateTo }).catch((e: unknown) =>
      this.notify(`Transcription non enregistrée : ${e instanceof Error ? e.message : String(e)}`, 'error'),
    );
  }

  private async setTranslate(on: boolean, fromUser: boolean): Promise<void> {
    if (fromUser && on !== this.settings.autoTranslate) {
      this.settings = await saveSettings({ autoTranslate: on });
    }
    this.transcriptView.setTarget(this.settings.translateTo);
    if (on) {
      this.transcriptView.setTranslate(true, this.translateStatus);
      await this.translator.enable(this.settings.translateTo);
    } else this.translator.disable();
    this.transcriptView.setTranslate(on, this.translator.state);
  }

  /** Direction of the translation, chosen in the tab (anglais → français, français → anglais…): translated at once. */
  private async setTarget(lang: string): Promise<void> {
    if (lang === this.settings.translateTo && this.settings.autoTranslate) return;
    this.settings = await saveSettings({ translateTo: lang, autoTranslate: true });
    this.transcriptView.setTarget(lang);
    await this.setTranslate(true, false);
  }

  /** A passage's card (or extract): its lines, read in the transcript. */
  private showPassageTranscript(start: number, end: number): void {
    if (this.kind === 'page' || !this.ctx) return;
    this.closeMedia();
    this.setView('transcript');
    this.transcriptView.showPassage(start, end);
  }

  /** The line being spoken, quoted in the note (with its translation). */
  private pinCue(cue: Cue | null): void {
    if (!this.note) return;
    if (!cue) {
      this.notify('Aucune réplique en cours à épingler', 'error');
      return;
    }
    const full = this.transcript?.cues.find((c) => c.id === cue.id) ?? cue;
    this.editor.insertBlock(cueQuote(full));
    this.notify(`Réplique ${formatTimecode(full.start)} épinglée dans la note`, 'success');
  }

  /** The transcript line at the end of the note: added, or updated where it is. */
  private pinTranscript(fromUser: boolean): void {
    const t = this.transcript;
    if (!this.note || !t?.cues.length) {
      if (fromUser) this.notify('Pas encore de sous-titres à épingler', 'error');
      return;
    }
    const line = transcriptLine(t);
    const changed = this.editor.transform((md) => pinTranscriptLine(md, line));
    if (changed || fromUser) this.notify('Transcription épinglée à la note', 'success');
  }

  /** Title of a passage: the first note taken during it, else its first subtitle. */
  private passageTitle(start: number, end: number): string {
    const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 59).replace(/\s+\S*$/, '')}…` : s);
    // Pinned subtitles (quotes) are not the user's words: the first personal note, else the first line said.
    const line = notesInRange(this.editor.content, start, end).find((l) => !/^\s*>/.test(l));
    const fromNote = line ? plainText(line.replace(/^(?:\s*(?:[-*+]|\d+[.)]|>)\s+)?\[[^\]\n]*\](?:\([^)\s]*\))?\s*/, '')).trim() : '';
    if (fromNote) return clip(fromNote);
    const cue = cuesInRange(this.transcript?.cues ?? [], start, end)[0];
    return cue ? clip(cue.tr?.trim() || cue.text) : '';
  }

  private buildLive(): HTMLDivElement {
    const time = h('button', { type: 'button', class: 'lc-time', title: 'Aller à ce moment' });
    time.addEventListener('click', () => {
      const cue = this.caption.cue;
      if (cue) this.post({ type: 'seek', seconds: cue.start });
    });
    const body = h('button', { type: 'button', class: 'lc-body', title: 'Ouvrir la transcription (Alt+T)' }, h('span', { class: 'lc-text' }), h('span', { class: 'lc-tr' }));
    body.addEventListener('click', () => this.setView('transcript'));
    const pin = h(
      'button',
      { type: 'button', class: 'icon-btn lc-pin', title: `Épingler dans la note (${IS_MAC ? '⌘⇧K' : 'Ctrl+Maj+K'})`, 'aria-label': 'Épingler la réplique dans la note' },
      icon('plus', 16),
    );
    pin.addEventListener('click', () => this.pinCue(this.caption.cue));
    return h('div', { class: 'live-caption', hidden: true, 'aria-live': 'off', 'aria-label': 'Sous-titre en cours' }, time, body, pin);
  }

  private renderLive(): void {
    if (!this.liveEl) return;
    const cue = this.caption.cue;
    const show = Boolean(cue) && this.settings.transcribe && this.view === 'notes' && this.kind !== 'page' && Boolean(this.note);
    this.liveEl.hidden = !show;
    if (!show || !cue) return;
    const full = this.transcript?.cues.find((c) => c.id === cue.id);
    (this.liveEl.querySelector('.lc-time') as HTMLElement).textContent = formatTimecode(cue.start);
    (this.liveEl.querySelector('.lc-text') as HTMLElement).textContent = cue.text;
    const tr = this.liveEl.querySelector('.lc-tr') as HTMLElement;
    tr.textContent = full?.tr ?? '';
    tr.hidden = !full?.tr;
  }

  private renderRecording(): void {
    if (!this.passageButton) return;
    const p = this.recording.passage;
    const open = p !== null && p.end === undefined;
    const rec = this.recording.audio || Boolean(p?.recording);
    this.recPill.hidden = !rec;
    this.recPill.title = [
      this.recording.audio ? 'Son du cours conservé pendant la lecture' : '',
      p?.recording ? `Passage ${formatTimecode(p.start)} en cours d’enregistrement` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    this.recPill.setAttribute('aria-label', this.recPill.title || 'Enregistrement');
    const keys = this.shortcuts;
    const label = open ? `Fin ${formatTimecode(p.start)}` : 'Passage';
    const title = open
      ? `Terminer le passage commencé à ${formatTimecode(p.start)}${keys['passage-end'] ? ` (${keys['passage-end']})` : ''}`
      : p?.end !== undefined
        ? `Enregistrement du passage ${rangeLabel(p.start, p.end)}…`
        : `Début d’un passage (extrait avec ses sous-titres et vos notes)${keys['passage-start'] ? ` (${keys['passage-start']})` : ''}`;
    this.passageButton.dataset.state = open ? 'open' : p ? 'recording' : 'idle';
    this.passageButton.title = title;
    this.passageButton.setAttribute('aria-label', title);
    this.passageButton.setAttribute('aria-pressed', String(open));
    const text = this.passageButton.querySelector('.action-label');
    if (text) text.textContent = label;
    this.timeline.setPending(p ? { start: p.start, end: p.end } : null);
  }

  private async loadAudioTrace(): Promise<void> {
    const noteId = this.ctx?.noteId;
    if (!noteId) return;
    try {
      const media = (await listMedia(noteId)).filter((m) => m.kind === 'audio');
      if (this.ctx?.noteId !== noteId) return;
      this.audioTrace = media.map((m) => ({ path: m.path, start: m.start, end: m.end }));
      const ranges = this.audioTrace.map((m) => [m.start, m.end] as [number, number]);
      this.timeline.setCoverage(ranges);
      this.transcriptView.setCoverage(ranges);
    } catch {
      // IndexedDB unavailable: nothing to listen to.
    }
  }

  /** The kept sound of the course, from `seconds`. */
  private async listen(seconds: number): Promise<void> {
    const seg = this.audioTrace.find((m) => seconds >= m.start && seconds < m.end);
    if (seg) await this.openMedia(seg.path, seconds - seg.start, `Son du cours · ${formatTimecode(seconds)}`);
  }

  /** Recorded extract (or kept sound) played in the panel. */
  private async openMedia(path: string, offset = 0, title?: string): Promise<void> {
    const record = await getMedia(path).catch(() => null);
    if (!record) {
      this.notify('Extrait introuvable dans ce navigateur (il est peut-être dans l’app Desktop)', 'error');
      return;
    }
    this.closeMedia();
    this.mediaUrl = URL.createObjectURL(record.blob);
    const isVideo = record.mime.startsWith('video/');
    const player = h(isVideo ? 'video' : 'audio', { controls: true, playsinline: true, src: this.mediaUrl, preload: 'auto' }) as HTMLMediaElement;
    player.addEventListener('loadedmetadata', () => {
      if (offset > 0) player.currentTime = offset;
      void player.play().catch(() => undefined);
    });
    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fermer l’extrait', title: 'Fermer (Échap)' }, icon('close', 16));
    close.addEventListener('click', () => this.closeMedia());
    const label =
      title ?? (record.kind === 'file' ? (record.name ?? 'Média collé') : `${record.kind === 'passage' ? 'Extrait' : 'Son du cours'} ${rangeLabel(record.start, record.end)}`);
    const head: Node[] = [icon(isVideo ? 'video' : 'volume', 15), h('span', { class: 'mp-title' }, label)];
    if (record.kind === 'passage') {
      // Read what is said in the extract.
      const read = h(
        'button',
        { type: 'button', class: 'icon-btn mp-transcript', 'aria-label': 'Lire la transcription du passage', title: 'Lire la transcription du passage' },
        icon('subtitles', 16),
      );
      read.addEventListener('click', () => this.showPassageTranscript(record.start, record.end));
      head.push(read);
    }
    // The file itself (a video cannot go through the clipboard): saved where the user wants.
    const save = h(
      'a',
      { class: 'icon-btn mp-download', href: this.mediaUrl, download: record.name ?? path.split('/').pop() ?? 'extrait', 'aria-label': 'Télécharger le fichier', title: 'Télécharger le fichier' },
      icon('download', 16),
    );
    head.push(save);
    this.mediaPop.replaceChildren(h('div', { class: 'mp-head' }, ...head, close), player);
    this.mediaPop.dataset.kind = isVideo ? 'video' : 'audio';
    this.mediaPop.hidden = false;
    // The course itself pauses while the extract plays.
    this.post({ type: 'pause' });
    close.focus();
  }

  private closeMedia(): void {
    if (!this.mediaPop) return;
    this.mediaPop.querySelector('video, audio')?.remove();
    this.mediaPop.replaceChildren();
    this.mediaPop.hidden = true;
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.mediaUrl = null;
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
    // A frame whose site is hidden can only be read with Boo Notes allowed everywhere.
    button.addEventListener('click', () => void (this.pendingPlayers.includes(HIDDEN_SITE) ? this.enableEverywhere() : this.allowPlayers()));
    return h('div', { class: 'players-hint', hidden: true, role: 'status' }, icon('video', 14), h('span', { class: 'site-text' }), button);
  }

  private async renderPlayers(hosts: string[]): Promise<void> {
    const missing: string[] = [];
    for (const host of hosts) {
      const origins = host === HIDDEN_SITE ? ['https://*/*'] : [`https://${host}/*`];
      const has = await chrome.permissions.contains({ origins }).catch(() => false);
      if (!has) missing.push(host);
    }
    // Allowed earlier but loaded before: inject the agent now.
    if (hosts.length > missing.length && !this.playersInjected) {
      this.playersInjected = true;
      this.post({ type: 'players:granted' });
    }
    this.pendingPlayers = missing;
    this.playersHint.hidden = missing.length === 0;
    const named = missing.filter((host) => host !== HIDDEN_SITE);
    (this.playersHint.querySelector('.site-text') as HTMLElement).textContent = missing.includes(HIDDEN_SITE)
      ? 'Le cours s’affiche dans un cadre venu d’un autre site, dont l’adresse est masquée (module SCORM, lecteur) : autorisez Boo Notes sur tous les sites pour le lire (horodatage, citations, captures).'
      : named.length === 1
        ? `Contenu intégré (${named[0]}) — lecteur vidéo ou module de cours : autorisez Boo Notes à le lire (horodatage, citations, captures).`
        : `${named.length} contenus intégrés (${named.join(', ')}) — lecteurs ou modules de cours : autorisez Boo Notes à les lire.`;
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
    const everywhere = h('button', { type: 'button', class: 'link-btn', title: 'Toute vidéo ou tout audio détecté sur tous les sites, lecteurs intégrés compris' }, 'Partout');
    everywhere.addEventListener('click', () => void this.enableEverywhere());
    const hint = h('div', { class: 'site-hint', hidden: true }, h('span', { class: 'site-text' }), button, h('span', { class: 'site-sep', 'aria-hidden': 'true' }, '·'), everywhere);
    return hint;
  }

  /** « Partout »: Boo Notes on every site (every video and audio stream found by itself). */
  private async enableEverywhere(): Promise<void> {
    const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }).catch(() => false);
    if (!granted) {
      this.notify('Autorisation refusée', 'error');
      return;
    }
    try {
      await callBackground({ type: 'sites:all', enabled: true });
      this.siteHint.hidden = true;
      this.playersHint.hidden = true;
      this.post({ type: 'players:granted' });
      this.notify('Boo Notes est actif sur tous les sites', 'success');
    } catch (e) {
      this.notify(e instanceof Error ? e.message : String(e), 'error');
    }
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
    const [sites, all] = await Promise.all([
      callBackground({ type: 'sites:list' }).catch(() => [] as string[]),
      callBackground({ type: 'sites:all', enabled: null }).catch(() => false),
    ]);
    (this.siteHint.querySelector('.site-text') as HTMLElement).textContent =
      `Actif sur ${new URL(origin).host} pour cet onglet.`;
    this.siteHint.hidden = all || sites.includes(origin);
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

  /**
   * The whole note in the clipboard, to paste anywhere: Markdown (Obsidian) and HTML (Notion,
   * Docs, Word…), screenshots and passage cards embedded, timestamps linked to the instant,
   * transcript included.
   */
  /** What a copy of the note (or of a part of it) needs: links to the moments of its media. */
  private copyInput(markdown: string): Omit<RichCopyInput, 'image' | 'title'> & { title: string } {
    const note = { ...this.note!, title: this.title || this.note!.title, markdown };
    const web = /^https?:\/\//.test(note.url) ? note.url : null;
    const timed = (note.kind ?? this.kind) !== 'page';
    const timeUrl = (s: number) => (web && timed ? timestampUrl(web, s) : null);
    return {
      title: note.title,
      sourceUrl: web,
      place: note.course ? `${note.course} › ${note.chapter ?? 'Chapitre 1'}` : null,
      markdown,
      linkify: (md) => toPortableMarkdown({ ...note, markdown: md }, { frontMatter: false }),
      context: { anchor: (kind, value) => (kind === 'time' ? { url: timeUrl(value) } : null) },
      timeUrl,
    };
  }

  private async copyNote(): Promise<void> {
    if (!this.note) return;
    let copy: Awaited<ReturnType<typeof buildRichCopy>>;
    try {
      copy = await buildRichCopy({ ...this.copyInput(this.editor.content), image: (path) => loadAsset(path), transcript: this.transcript });
    } catch (e) {
      this.notify(`Copie impossible : ${e instanceof Error ? e.message : String(e)}`, 'error');
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([copy.markdown], { type: 'text/plain' }),
          'text/html': new Blob([copy.html], { type: 'text/html' }),
        }),
      ]);
    } catch {
      try {
        await navigator.clipboard.writeText(copy.markdown);
      } catch {
        this.notify('Copie refusée par le navigateur', 'error');
        return;
      }
    }
    const pics = copy.images ? ` avec ${copy.images} image${copy.images > 1 ? 's' : ''}` : '';
    const lost = copy.missing.length ? ` (${copy.missing.length} introuvable${copy.missing.length > 1 ? 's' : ''})` : '';
    this.notify(`Note copiée${pics}${lost} — collez-la dans Obsidian, Notion, Docs…`, copy.missing.length ? 'info' : 'success');
  }

  // --- Copy / paste « tout compris » -------------------------------------------------------

  /**
   * Copy (or cut) of a part of the note: Markdown and HTML with its pictures
   * inside and its moments linked (Obsidian, Notion, Docs, a mail…), and
   * Boo Notes' own format — pasted into a note, it keeps its captures,
   * passages, extracts and timestamps as they are.
   */
  private copySelection(markdown: string, data: DataTransfer): boolean {
    if (!this.note) return false;
    const copy = renderRichCopy({ ...this.copyInput(markdown), title: undefined }, assetData);
    data.setData('text/plain', copy.markdown.trimEnd());
    data.setData('text/html', copy.html);
    writeBooClip(data, { noteId: this.note.id, url: this.note.url, timed: (this.note.kind ?? this.kind) !== 'page', markdown });
    return true;
  }

  /** « Copier l’image » of a card: the picture itself, pasted as a picture anywhere. */
  private async copyImage(path: string): Promise<void> {
    try {
      const src = /^https?:\/\//.test(path) ? path : await loadAsset(path);
      // The promise keeps the click's permission to write while the picture is converted.
      const png = toPngBlob(src);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      this.notify('Image copiée : collez-la où vous voulez', 'success');
    } catch (e) {
      this.notify(`Copie de l’image impossible : ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  /** The line of a pasted item starts at the moment of the media, like a capture. */
  private pasteMoment(): { stamp: string | null; at: number } {
    const t = this.kind === 'page' || !this.hasVideo ? null : this.now();
    return t === null ? { stamp: null, at: 0 } : { stamp: `[${formatTimecode(t)}]`, at: t };
  }

  /**
   * Paste or drop into the note: pictures (screenshots, « Copier l’image »,
   * files), videos and audios, formatted text with its pictures, a part of
   * another note. Plain text is left to the editor.
   */
  private paste(data: DataTransfer): boolean {
    if (!this.note || this.orphaned) return false;
    const content = classifyPaste(data);
    switch (content.kind) {
      case 'clip': {
        const text = adaptClip(content.clip, this.note.id);
        const id = this.editor.reserve('');
        this.editor.fill(id, text, false);
        return true;
      }
      case 'files':
        if (content.skipped.length) this.notify(`Non collé${content.skipped.length > 1 ? 's' : ''} : ${content.skipped.join(', ')} (images, vidéos et audios seulement)`, 'error');
        if (!content.files.length) return true;
        void this.pasteFiles(content.files);
        return true;
      case 'html':
        void this.pasteHtml(content.html);
        return true;
      default:
        return false;
    }
  }

  private async pasteFiles(files: File[]): Promise<void> {
    const note = this.note;
    if (!note) return;
    const { stamp, at } = this.pasteMoment();
    // Every place kept at once (in order), then filled one by one.
    const slots = files.map((f) => ({ file: f, id: this.editor.reserve(`Import de ${f.name || 'l’image'}…`) }));
    let done = 0;
    for (const { file, id } of slots) {
      try {
        const kind = fileKind(file);
        if (kind === 'image') {
          const path = await this.storeImage(file, note.id, at);
          this.editor.fill(id, imageLine(path, file.name.replace(/\.[^.]*$/, '') === 'image' ? '' : file.name.replace(/\.[^.]*$/, ''), stamp));
        } else if (kind === 'video' || kind === 'audio') {
          if (file.size > MAX_MEDIA_BYTES) throw new Error(`${file.name} dépasse ${MAX_MEDIA_BYTES / 1024 / 1024} Mo`);
          const path = pastedMediaPath(note.id, file.name || kind, file.type, Math.random().toString(36).slice(2, 6));
          const mime = file.type || (kind === 'video' ? 'video/mp4' : 'audio/mpeg');
          await putMedia({ path, noteId: note.id, kind: 'file', name: file.name, mime, start: at, end: at, blob: file, size: file.size, createdAt: Date.now() });
          void callBackground({ type: 'media:stored', path }).catch(() => undefined);
          this.editor.fill(id, mediaFileLine(file.name, path, kind, stamp));
        } else this.editor.fill(id, null);
        done++;
      } catch (e) {
        this.editor.fill(id, null);
        this.notify(`${file.name || 'Fichier'} non collé : ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    }
    if (done) this.notify(done > 1 ? `${done} fichiers ajoutés à la note` : 'Ajouté à la note', 'success');
  }

  /** A picture (a pasted file, a data URL, a picture of the web) saved with the note's captures. */
  private async storeImage(blob: Blob, noteId: string, time: number): Promise<string> {
    const img = await prepareImage(blob);
    const { path } = await callBackground({ type: 'asset:save', noteId, dataUrl: img.dataUrl, mime: img.mime, width: img.width, height: img.height, time });
    assetData.set(path, img.dataUrl);
    return path;
  }

  /** Formatted text (a web page, Notion, Docs, Word…) as Markdown; its pictures kept in the note when their site allows it. */
  private async pasteHtml(html: string): Promise<void> {
    const note = this.note;
    if (!note) return;
    const { markdown, images } = htmlToMarkdown(html);
    const id = this.editor.reserve(images.length ? `Import de ${images.length} image${images.length > 1 ? 's' : ''}…` : '');
    let text = markdown;
    let kept = 0;
    for (const [i, img] of images.entries()) {
      let target: string | null = /^https?:\/\//.test(img.src) ? img.src : null;
      // A few dozen pictures at most are downloaded; the others stay online.
      if (i < 40) {
        try {
          const blob = await pictureBlob(img.src);
          if (blob.type.startsWith('image/')) {
            target = await this.storeImage(blob, note.id, 0);
            kept++;
          }
        } catch {
          // The site refused (CORS): the picture stays online.
        }
      }
      text = target ? text.split(`](${img.token})`).join(`](${target})`) : text.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${img.token}\\)`), (_a, alt: string) => (alt ? `*${alt}*` : ''));
    }
    const block = text.includes('\n') || /^(?:#|>|[-*+] |\d+\. |!\[|```|\|)/.test(text);
    this.editor.fill(id, text.trim() || null, block);
    if (images.length) {
      const online = images.length - kept;
      this.notify(`Collé avec ${images.length} image${images.length > 1 ? 's' : ''}${online ? ` (${online} restée${online > 1 ? 's' : ''} en ligne)` : ''}`, online ? 'info' : 'success');
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
        const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
        // Ctrl/⌘+Maj+K: the line being spoken, quoted in the note.
        if (mod && e.shiftKey && !e.altKey && e.code === 'KeyK') {
          e.preventDefault();
          e.stopPropagation();
          this.pinCue(this.caption.cue);
          return;
        }
        // Alt+T: Notes ⇄ Transcription.
        if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT' && this.kind !== 'page' && this.ctx) {
          e.preventDefault();
          e.stopPropagation();
          this.setView(this.view === 'notes' ? 'transcript' : 'notes');
          return;
        }
        if (e.key === 'Escape' && !this.mediaPop.hidden) {
          e.preventDefault();
          e.stopPropagation();
          this.closeMedia();
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
    window.addEventListener('pagehide', () => this.flushNow());
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
        const before = this.settings;
        this.settings = normalizeSettings(changes.settings.newValue);
        this.autoPause.enabled = this.settings.autoPause;
        this.applyTheme();
        this.renderLive();
        if (before.autoTranslate !== this.settings.autoTranslate || before.translateTo !== this.settings.translateTo) {
          void this.setTranslate(this.settings.autoTranslate, false);
        }
      }
      if (area === 'local' && this.ctx && changes[`transcript:${this.ctx.noteId}`]) {
        const t = changes[`transcript:${this.ctx.noteId}`].newValue as Transcript | undefined;
        this.setTranscript(t ?? null);
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
