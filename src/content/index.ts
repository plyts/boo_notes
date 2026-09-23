import { captureLine, findFragmentLinks } from '../shared/markdown';
import {
  callBackground,
  isCommand,
  PANEL_PORT,
  type BackgroundRequest,
  type BackgroundResponses,
  type CommandId,
  type ContentToPanel,
  type FrameMedia,
  type PanelToContent,
  type TabMessage,
} from '../shared/messages';
import { detectVideoContext, readStartTime, timestampUrl, type MediaKind, type VideoContext } from '../shared/platforms';
import type { Note } from '../shared/store';
import { loadSettings, normalizeSettings, onSettingsChanged, saveSettings, type Settings } from '../shared/settings';
import { findBinding, inPageBindings, type InPageBinding } from '../shared/shortcuts';
import { formatTimecode } from '../shared/time';
import { adapterForHost, detectPageTheme, headerInset, queryVisible, type PlatformAdapter } from './adapters';
import { captureVideoFrame, nextFrame, probeFrame, type Shot } from './capture';
import { Drawer } from './drawer';
import { looksLikePlayer, playerFrames, scanMedia } from './media-scan';
import { Overlay } from './overlay';
import { MediaController } from './player';
import { PageReader } from './reader';

const PINNED_KEY = 'boo-notes:pinned';
const TEARDOWN_EVENT = 'boo-notes:teardown';
/** Iframes at least this large may hold a player. */
const PLAYER_FRAME_AREA = 240 * 135;

type Port = chrome.runtime.Port;

function isEditableTarget(e: Event): boolean {
  const t = e.composedPath()[0];
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image'].includes(t.type);
  }
  return t instanceof HTMLElement && t.isContentEditable;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Content script: attaches to the page's <video> (or <audio>), draws the HUD
 * / toasts, hosts the drawer and executes the keyboard commands routed by
 * the background service worker. A page without media (article, course
 * chapter, Notion page) is noted in reading mode: quotes and sections
 * linked with text fragments, reading progress.
 */
class ContentApp {
  private readonly abort = new AbortController();
  private readonly player: MediaController;
  private readonly overlay: Overlay;
  private readonly drawer: Drawer;
  private readonly reader: PageReader;
  private settings: Settings = normalizeSettings(undefined);
  private tabId = -1;
  private ctx: VideoContext | null = null;
  private title = '';
  private pinned = false;
  private embeddedPort: Port | null = null;
  private popoutPort: Port | null = null;
  private embeddedWaiters: Array<(port: Port) => void> = [];
  private intervals: Array<ReturnType<typeof setInterval>> = [];
  private titleWatch: ReturnType<typeof setInterval> | null = null;
  private lastHref = location.href;
  private lastInteraction = 0;
  private capturing = false;
  /** Set by Smart Pause until playback resumes, so the shortcut can toggle. */
  private smartPaused = false;
  /** Default shortcuts Chrome did not register globally, handled here instead. */
  private pageBindings: InPageBinding[] = inPageBindings([]).filter((b) => b.command === 'replay');
  private readonly seekedFromUrl = new Set<string>();
  /** Note id announced to the background as a player (Notion / other sites: once a media exists or notes are taken). */
  private registeredNoteId: string | null = null;
  private registeredKind: MediaKind | null = null;
  private lastProgressAt = 0;
  private stopSettingsWatch: (() => void) | null = null;
  private dead = false;
  /** Configured shortcut of `insert-timestamp` (shown in the "Citer" bubble). */
  private quoteShortcut = 'Alt+Shift+T';
  private bubbleFrame = 0;
  private lastPassage: string | null = null;
  /** Embedded players Boo Notes may not read yet (hosts), as last sent to the panels. */
  private blockedPlayers = '';
  private shotSeq = 0;
  private readonly shots = new Map<number, (r: { shot: Shot | null; error: string | null }) => void>();

  constructor(private readonly adapter: PlatformAdapter) {
    this.player = new MediaController(adapter, {
      onEvent: (type, media) => this.onMediaEvent(type, media),
      send: (frameId, command) => void this.bg({ type: 'frame:command', frameId, command }).catch(() => undefined),
    });
    this.overlay = new Overlay(
      {
        videoRect: () => this.player.rect(),
        contentRect: () => this.player.contentRect(),
        progressBarRect: () => this.player.progressBarRect(),
        currentTime: () => this.player.time(),
        duration: () => this.player.playback().duration,
        isOverUi: (x, y) => this.drawer.containsPoint(x, y),
      },
      {
        copyTimestamp: () => void this.copyTimestamp(),
        capture: () => void this.capture(),
        togglePin: () => this.setPinned(!this.pinned),
        openSettings: () => void this.bg({ type: 'options:open' }),
      },
    );
    this.drawer = new Drawer({
      panelUrl: () => chrome.runtime.getURL(`panel/panel.html?tab=${this.tabId}&mode=embedded`),
      width: this.settings.drawerWidth,
      layout: this.settings.layout,
      topInset: () => headerInset(this.adapter),
      onResized: (width) => void saveSettings({ drawerWidth: width }).catch(() => undefined),
    });
    this.reader = new PageReader({
      url: () => this.ctx?.canonicalUrl ?? location.href,
      isOwnUi: (el) => el === this.overlay.host || this.drawer.owns(el),
      onProgress: (ratio) => this.onReadingProgress(ratio),
      onPassage: (url) => {
        this.lastPassage = url;
        this.postPanels({ type: 'reading', ratio: this.reader.progress, passage: url });
      },
    });
  }

  /**
   * Reading mode: a generic page (Notion, other sites) without video or audio.
   * The course platforms are always about their video, even before it loads.
   */
  private get reading(): boolean {
    return Boolean(this.ctx?.requiresMedia) && !this.player.available;
  }

  private get kind(): MediaKind {
    return this.reading ? 'page' : this.player.kind;
  }

  get alive(): boolean {
    return !this.dead;
  }

  async start(): Promise<void> {
    document.addEventListener(TEARDOWN_EVENT, this.destroy, { once: true });
    // A teardown may arrive during any await below: never resurrect a destroyed instance.
    this.applySettings(await loadSettings());
    if (this.dead) return;
    this.tabId = (await this.bg({ type: 'hello' })).tabId;
    if (this.dead) return;
    try {
      this.pinned = sessionStorage.getItem(PINNED_KEY) === '1';
    } catch {
      this.pinned = false;
    }
    this.overlay.setPinned(this.pinned);
    this.overlay.mount();
    this.bindEvents();
    // Embedded players (sub-frames) the extension may read get their agent.
    void this.bg({ type: 'frames:inject' }).catch(() => undefined);
    await this.syncContext(true);
    if (this.dead) return;
    if (this.pinned && this.ctx) this.openDrawer(null);
  }

  readonly destroy = () => {
    if (this.dead) return;
    this.dead = true;
    this.abort.abort();
    for (const id of this.intervals) clearInterval(id);
    if (this.titleWatch) clearInterval(this.titleWatch);
    this.stopSettingsWatch?.();
    try {
      chrome.runtime.onMessage.removeListener(this.onTabMessage);
      chrome.runtime.onConnect.removeListener(this.onPanelConnect);
      chrome.storage.onChanged.removeListener(this.onStorageChanged);
    } catch {
      // Extension context already gone.
    }
    this.embeddedPort?.disconnect();
    this.popoutPort?.disconnect();
    this.overlay.destroy();
    this.drawer.destroy();
    this.reader.stop();
  };

  // --- Wiring -------------------------------------------------------------------

  private bindEvents(): void {
    const opts = { signal: this.abort.signal, capture: true } as const;
    document.addEventListener(
      'mousemove',
      (e) => this.overlay.onPointerMove(e.clientX, e.clientY, e.composedPath()),
      { ...opts, passive: true },
    );
    window.addEventListener('keydown', this.onKeyDown, opts);
    window.addEventListener('pointerdown', () => this.markInteraction(), { ...opts, passive: true });
    // Media of the page, its shadow trees and docked off-DOM players.
    this.player.listen(this.abort.signal);
    // Frame agents announce themselves to find their <iframe> element.
    window.addEventListener('message', this.onFrameHello, { signal: this.abort.signal });
    document.addEventListener('fullscreenchange', this.onFullscreenChange, opts);
    // Reading mode: "Citer" bubble next to the selected text while the notes are open.
    document.addEventListener('selectionchange', () => this.scheduleQuoteBubble(), { signal: this.abort.signal });
    document.addEventListener('scroll', () => this.scheduleQuoteBubble(), { ...opts, passive: true });
    chrome.storage.onChanged.addListener(this.onStorageChanged);
    window.addEventListener('popstate', () => this.checkUrl(), opts);
    // YouTube is a single-page app and announces its navigations.
    document.addEventListener('yt-navigate-finish', () => this.checkUrl(), opts);

    chrome.runtime.onMessage.addListener(this.onTabMessage);
    chrome.runtime.onConnect.addListener(this.onPanelConnect);
    this.stopSettingsWatch = onSettingsChanged((s) => this.applySettings(s));

    this.intervals.push(setInterval(() => this.checkUrl(), 750));
    // Embedded players the extension cannot read yet: offered in the panel.
    this.intervals.push(setInterval(() => this.checkPlayers(), 3000));
    this.intervals.push(
      setInterval(() => {
        if (this.player.playback().playing) this.reportProgress();
      }, 15_000),
    );
    window.addEventListener('pagehide', () => this.reportProgress(true), opts);
    // Periodic resync so the panels' extrapolated clock never drifts.
    this.intervals.push(
      setInterval(() => {
        if (this.embeddedPort || this.popoutPort) this.broadcastPlayback();
      }, 2000),
    );
    void this.loadShortcuts();
    // Shortcuts may be edited in chrome://extensions/shortcuts while the page is open.
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') void this.loadShortcuts();
      },
      opts,
    );
  }

  private async loadShortcuts(): Promise<void> {
    try {
      const list = await this.bg({ type: 'shortcuts:list' });
      this.pageBindings = inPageBindings(list);
      this.overlay.setCaptureShortcut(list.find((c) => c.name === 'capture-screenshot')?.shortcut ?? '');
      this.quoteShortcut =
        list.find((c) => c.name === 'insert-timestamp')?.shortcut ||
        (this.settings.pageShortcuts ? (this.pageBindings.find((b) => b.command === 'insert-timestamp')?.shortcut ?? '') : '');
    } catch {
      // Keep the previous bindings.
    }
  }

  private onMediaEvent(type: string, media: HTMLMediaElement): void {
    if (type === 'play') this.smartPaused = false;
    if (media !== this.player.current) return;
    this.broadcastPlayback();
    void this.ensureRegistered();
    // Course tracking: remember where the user stopped.
    if (type === 'pause' || type === 'ended') this.reportProgress(true);
    else if (type === 'seeked') this.reportProgress();
  }

  /** State of an embedded player's media, relayed by the background. */
  private onFrameMedia(frameId: number, media: FrameMedia | null): void {
    const was = this.player.remote?.media.playback.playing;
    this.player.setRemote(frameId, media);
    if (this.player.current) return; // A media of the page itself has priority.
    this.broadcastPlayback();
    void this.ensureRegistered();
    if (media) this.maybeSeekFromUrl();
    if (was && !this.player.remote?.media.playback.playing) this.reportProgress(true);
    else this.reportProgress();
    this.checkPlayers();
  }

  private readonly onFrameHello = (e: MessageEvent): void => {
    const token = (e.data as { booNotesFrame?: unknown } | null)?.booNotesFrame;
    if (typeof token !== 'string' || !e.source) return;
    const frames = [...document.querySelectorAll('iframe'), ...scanMedia(document, 8000).roots.flatMap((r) => [...r.querySelectorAll('iframe')])];
    const iframe = frames.find((f) => f.contentWindow === e.source);
    if (iframe) this.player.bindFrame(token, iframe);
  };

  /** Player-looking iframes without a reporting agent: the panel offers to allow their host. */
  private checkPlayers(): void {
    if (!this.ctx || this.dead) return;
    let hosts: string[] = [];
    if (!this.player.current && !this.player.remote) {
      const reporting = this.player.reportingFrames();
      hosts = [
        ...new Set(
          playerFrames(PLAYER_FRAME_AREA)
            .filter((f) => !reporting.has(f) && f.src && /^https?:/.test(f.src))
            .filter((f) => looksLikePlayer(f.src) || f.allowFullscreen || /autoplay|fullscreen|encrypted-media/.test(f.allow))
            .map((f) => new URL(f.src, location.href).host)
            .filter((h) => h !== location.host),
        ),
      ];
    }
    const key = hosts.join(' ');
    if (key === this.blockedPlayers) return;
    this.blockedPlayers = key;
    this.postPanels({ type: 'players', hosts });
  }

  private applySettings(s: Settings): void {
    this.settings = s;
    this.overlay.setEnabled(s.hudEnabled);
    this.drawer.setWidth(s.drawerWidth);
    this.drawer.setLayout(s.layout);
  }

  private bg<R extends BackgroundRequest>(request: R): Promise<BackgroundResponses[R['type']]> {
    if (!chrome.runtime?.id) {
      // The extension was reloaded / updated: this copy of the script is orphaned.
      this.destroy();
      return Promise.reject(new Error('Extension rechargée'));
    }
    return callBackground(request).catch((e: unknown) => {
      if (/context invalidated/i.test(errorMessage(e))) this.destroy();
      throw e;
    });
  }

  private readonly onTabMessage = (
    msg: TabMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg.type === 'ping') sendResponse(true);
    else if (msg.type === 'command') void this.onCommand(msg.command);
    else if (msg.type === 'popout:closed') this.popoutPort = null;
    else if (msg.type === 'frame:media') this.onFrameMedia(msg.frameId, msg.media);
    else if (msg.type === 'frame:shot') {
      this.shots.get(msg.id)?.({ shot: msg.shot, error: msg.error });
      this.shots.delete(msg.id);
    }
    return false;
  };

  private readonly onPanelConnect = (port: Port): void => {
    if (port.name !== PANEL_PORT || port.sender?.id !== chrome.runtime.id) return;
    port.onMessage.addListener((msg: PanelToContent) => this.onPanelMessage(port, msg));
    port.onDisconnect.addListener(() => {
      if (port === this.embeddedPort) this.embeddedPort = null;
      if (port === this.popoutPort) this.popoutPort = null;
      this.overlay.hideMarker();
    });
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.markInteraction();
    if (!this.ctx || isEditableTarget(e)) return;
    const plain = !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey;
    if (e.key === 'Escape' && plain && this.drawer.isOpen && !this.pinned && !document.fullscreenElement) {
      this.closeDrawer();
      return;
    }
    if (!this.settings.pageShortcuts) return;
    const binding = findBinding(this.pageBindings, e);
    if (!binding) return;
    e.preventDefault(); // Alt+← would otherwise navigate back.
    e.stopImmediatePropagation();
    void this.onCommand(binding.command);
  };

  private readonly onFullscreenChange = (): void => {
    const fs = document.fullscreenElement;
    // A bare <video> in fullscreen cannot host children: nothing can be drawn then.
    const target = fs && !(fs instanceof HTMLVideoElement) ? fs : null;
    this.overlay.reparent(target);
    if (target && this.drawer.isOpen && !this.pinned) this.drawer.close();
    this.drawer.setFullscreenTarget(target);
  };

  // --- Page / video context ---------------------------------------------------------

  private checkUrl(): void {
    if (location.href === this.lastHref) return;
    this.lastHref = location.href;
    void this.syncContext();
  }

  private async syncContext(force = false): Promise<void> {
    const ctx = detectVideoContext(location.href);
    const changed = force || ctx?.noteId !== this.ctx?.noteId;
    this.ctx = ctx;
    if (ctx) this.maybeSeekFromUrl();
    if (!changed) return;

    this.player.reset();
    this.overlay.hideMarker();
    this.overlay.hideQuoteButton();
    this.reader.reset();
    this.lastPassage = null;
    this.title = ctx ? this.adapter.title() : '';
    this.postPanels({ type: 'context', ctx, title: this.title });
    this.registeredNoteId = null;
    if (ctx) {
      this.watchTitle();
      await this.ensureRegistered();
      // A page already noted: its quoted passages are highlighted, its reading followed.
      if (this.reading) await this.loadPassages(ctx.noteId, true);
    } else {
      if (this.drawer.isOpen) this.closeDrawer();
      await this.bg({ type: 'player:gone' }).catch(() => undefined);
    }
  }

  /** SPAs update the title some time after the URL: follow it for a few seconds. */
  private watchTitle(): void {
    if (this.titleWatch) clearInterval(this.titleWatch);
    let ticks = 0;
    this.titleWatch = setInterval(() => {
      const title = this.adapter.title();
      if (this.ctx && title && title !== this.title) {
        this.title = title;
        this.postPanels({ type: 'context', ctx: this.ctx, title });
        this.registeredNoteId = null;
        void this.ensureRegistered();
      }
      if (++ticks >= 15 && this.titleWatch) {
        clearInterval(this.titleWatch);
        this.titleWatch = null;
      }
    }, 1000);
  }

  /**
   * Announces this tab as a player. Course platforms are identified by URL;
   * Notion pages and other sites once they contain a media, or once the user
   * takes notes on them (`engaged`: reading mode).
   */
  private async ensureRegistered(engaged = false): Promise<void> {
    const ctx = this.ctx;
    const kind = this.kind;
    if (!ctx || (this.registeredNoteId === ctx.noteId && this.registeredKind === kind) || (this.reading && !engaged)) return;
    this.registeredNoteId = ctx.noteId;
    this.registeredKind = kind;
    if (this.reading) this.reader.start();
    try {
      await this.bg({ type: 'player:ready', ctx, title: this.title, kind });
    } catch {
      this.registeredNoteId = null;
    }
  }

  // --- Reading mode ---------------------------------------------------------------------------

  /** Quoted passages of the saved note, highlighted in the page. */
  private async loadPassages(noteId: string, start = false): Promise<void> {
    let note: Note | undefined;
    try {
      note = (await chrome.storage.local.get(`note:${noteId}`))[`note:${noteId}`] as Note | undefined;
    } catch {
      return;
    }
    if (this.dead || this.ctx?.noteId !== noteId || !note) return;
    if (start) this.reader.start();
    this.reader.setPassages(findFragmentLinks(note.markdown).map((f) => f.url));
  }

  private readonly onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    const id = this.ctx?.noteId;
    if (area !== 'local' || !id || !changes[`note:${id}`] || !this.reading) return;
    const note = changes[`note:${id}`].newValue as Note | undefined;
    this.reader.setPassages(note ? findFragmentLinks(note.markdown).map((f) => f.url) : []);
  };

  private onReadingProgress(ratio: number): void {
    this.postPanels({ type: 'reading', ratio, passage: this.lastPassage });
    const ctx = this.ctx;
    if (!ctx || !this.reading || this.dead) return;
    // Percent read (the furthest point of the visit), kept only once the page has a note.
    void this.bg({ type: 'player:progress', noteId: ctx.noteId, position: Math.round(ratio * 1000) / 10, duration: 100, kind: 'page' }).catch(
      () => undefined,
    );
  }

  private scheduleQuoteBubble(): void {
    if (this.bubbleFrame) return;
    this.bubbleFrame = requestAnimationFrame(() => {
      this.bubbleFrame = 0;
      this.updateQuoteBubble();
    });
  }

  private updateQuoteBubble(): void {
    // Cheapest checks first: this runs on every scroll / selection change of the page.
    const open = this.drawer.isOpen || this.popoutPort !== null;
    const rect = open && this.ctx?.requiresMedia && this.reading && this.reader.selection().length >= 3 ? this.reader.selectionRect() : null;
    if (!rect || rect.bottom < 0 || rect.top > innerHeight) this.overlay.hideQuoteButton();
    else this.overlay.showQuoteButton(rect, this.quoteShortcut, () => void this.quote());
  }

  /** Alt+Shift+T in reading mode: quote the selection, or anchor a new line to the section being read. */
  private async quote(): Promise<void> {
    const line = this.reader.quote();
    const port = await this.inputEditor();
    if (line) {
      port.postMessage({ type: 'insert-block', text: line, focus: true } satisfies ContentToPanel);
      // Quoted: the selection has done its job (and the bubble goes away with it).
      document.getSelection()?.removeAllRanges();
      this.overlay.hideQuoteButton();
      this.overlay.toast('Passage cité dans la note', 'success', 1500, { icon: 'quote' });
    } else {
      port.postMessage({ type: 'insert-anchor', token: this.reader.anchor(), focus: true } satisfies ContentToPanel);
    }
  }

  /** Alt+Shift+S in reading mode: screenshot of the visible page (the notes drawer excluded). */
  private async capturePage(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.capturing) return;
    this.capturing = true;
    const { captureFormat: mime, captureQuality: quality } = this.settings;
    try {
      const drawer = this.drawer.rect();
      const width = drawer && drawer.left > innerWidth * 0.3 ? drawer.left : innerWidth;
      const area = new DOMRect(0, 0, width, innerHeight);
      const anchor = this.reader.anchor();
      const section = this.reader.sectionLabel();
      this.overlay.setHidden(true);
      let shot: Shot;
      try {
        await nextFrame();
        await nextFrame();
        if (document.visibilityState !== 'visible') throw new Error('l’onglet doit être visible');
        const res = await this.bg({
          type: 'capture:visible-tab',
          rect: { x: area.x, y: area.y, width: area.width, height: area.height },
          viewportWidth: innerWidth,
          mime,
          quality,
        });
        shot = { ...res, mime };
      } finally {
        this.overlay.setHidden(false);
      }
      this.overlay.flash(area);
      const { path } = await this.bg({
        type: 'asset:save',
        noteId: ctx.noteId,
        dataUrl: shot.dataUrl,
        mime: shot.mime,
        width: shot.width,
        height: shot.height,
        time: 0,
      });
      const line = `${anchor} ![Capture${section ? ` — ${section}` : ''}](${path})`;
      const port = this.popoutPort ?? this.embeddedPort;
      if (port && this.ctx?.noteId === ctx.noteId) {
        port.postMessage({ type: 'insert-block', text: line } satisfies ContentToPanel);
      } else {
        await this.bg({
          type: 'note:append',
          noteId: ctx.noteId,
          meta: { platform: ctx.platform, url: ctx.canonicalUrl, title: this.title, kind: 'page' },
          text: line,
        });
      }
      this.overlay.toast('Capture de la page sauvegardée', 'success', 2000, { thumb: shot.dataUrl });
    } catch (e) {
      this.overlay.toast(`Capture impossible : ${errorMessage(e)}`, 'error', 3500);
    } finally {
      this.capturing = false;
    }
  }

  /** Reading mode commands: no media to drive. */
  private async onReadingCommand(command: CommandId): Promise<void> {
    switch (command) {
      case 'toggle-sidebar':
        if (!this.popoutPort) {
          if (this.drawer.isOpen) this.closeDrawer();
          else this.openDrawer('keep');
        }
        break;
      case 'insert-timestamp':
        await this.quote();
        break;
      case 'capture-screenshot':
        await this.capturePage();
        break;
      case 'smart-pause': {
        // Nothing to pause: "write now".
        const port = await this.inputEditor();
        port.postMessage({ type: 'focus', where: 'end' } satisfies ContentToPanel);
        break;
      }
      case 'replay':
        this.overlay.toast('Aucun média à rembobiner sur cette page', 'error');
        break;
    }
  }

  /** Playback position for course tracking (kept only if the media has a note). */
  private reportProgress(force = false): void {
    const ctx = this.ctx;
    // A stopwatch is not a position in the media: nothing to resume.
    if (!ctx || !this.player.available || this.player.source === 'stopwatch' || this.dead) return;
    const now = Date.now();
    if (!force && now - this.lastProgressAt < 10_000) return;
    this.lastProgressAt = now;
    const { time, duration } = this.player.playback();
    if (time <= 0 && duration <= 0) return;
    void this.bg({ type: 'player:progress', noteId: ctx.noteId, position: time, duration, kind: this.player.kind }).catch(
      () => undefined,
    );
  }

  /** Opens `URL#t=255` links (the format of copied timestamps) at the right time on every platform. */
  private maybeSeekFromUrl(): void {
    const href = location.href;
    if (this.seekedFromUrl.has(href)) return;
    this.seekedFromUrl.add(href);
    const hashTime = new URLSearchParams(new URL(href).hash.slice(1)).get('t');
    // YouTube already honours its own `?t=` parameter.
    if (hashTime === null && this.adapter.platform === 'youtube') return;
    const target = readStartTime(href);
    if (target === null) return;
    let tries = 0;
    const attempt = () => {
      const v = this.player.current;
      if (v && v.readyState >= HTMLMediaElement.HAVE_METADATA) {
        if (Math.abs(v.currentTime - target) > 1.5) this.player.seek(target);
        return;
      }
      // Embedded player: its agent seeks inside the frame.
      if (!v && this.player.remote && this.player.remote.media.playback.duration > 0) {
        if (Math.abs(this.player.time() - target) > 1.5) this.player.seek(target);
        return;
      }
      if (++tries < 40 && !this.dead) setTimeout(attempt, 500);
    };
    attempt();
  }

  private markInteraction(): void {
    const now = Date.now();
    if (!this.ctx || now - this.lastInteraction < 3000) return;
    this.lastInteraction = now;
    void this.bg({ type: 'player:interaction' }).catch(() => undefined);
  }

  // --- Commands -------------------------------------------------------------------------

  private async onCommand(command: CommandId): Promise<void> {
    if (!this.ctx) {
      this.overlay.toast('Boo Notes : rien à noter sur cette page (ouvrez une vidéo, un cours ou un article)', 'error');
      return;
    }
    void this.ensureRegistered(true);
    this.markInteraction();
    if (this.reading) {
      await this.onReadingCommand(command);
      return;
    }
    switch (command) {
      case 'toggle-sidebar':
        // With a pop-out, the background switches window focus instead.
        if (!this.popoutPort) {
          if (this.drawer.isOpen) this.closeDrawer();
          else this.openDrawer('keep');
        }
        break;
      case 'insert-timestamp':
        await this.insertTimestamp();
        break;
      case 'capture-screenshot':
        await this.capture();
        break;
      case 'smart-pause':
        await this.smartPause();
        break;
      case 'replay':
        this.replay();
        break;
    }
  }

  private openDrawer(focus: 'keep' | 'end' | null): void {
    if (this.popoutPort) return;
    void this.ensureRegistered(true);
    this.drawer.open();
    this.postPanels({ type: 'page-theme', theme: detectPageTheme(this.adapter) });
    if (focus) {
      this.drawer.focus();
      void this.embedded().then((port) => port.postMessage({ type: 'focus', where: focus } satisfies ContentToPanel));
    }
  }

  private closeDrawer(): void {
    this.drawer.close();
    this.overlay.hideMarker();
    this.overlay.hideQuoteButton();
    queryVisible<HTMLElement>(this.adapter.playerFocusSelectors)?.focus({ preventScroll: true });
  }

  private embedded(): Promise<Port> {
    if (this.embeddedPort) return Promise.resolve(this.embeddedPort);
    return new Promise((resolve) => this.embeddedWaiters.push(resolve));
  }

  /** The editor that receives keyboard input: the pop-out if any, else the (opened) drawer. */
  private async inputEditor(): Promise<Port> {
    if (this.popoutPort) return this.popoutPort;
    if (!this.drawer.isOpen) this.openDrawer(null);
    this.drawer.focus();
    return this.embedded();
  }

  private async insertTimestamp(): Promise<void> {
    const seconds = this.player.time();
    const port = await this.inputEditor();
    port.postMessage({ type: 'insert-timestamp', seconds, focus: true } satisfies ContentToPanel);
  }

  /**
   * Smart Pause is a toggle: pause + write, then the same shortcut resumes
   * the video and gives the keyboard back to the player.
   */
  private async smartPause(): Promise<void> {
    if (this.smartPaused && this.player.available && this.player.paused) {
      this.smartPaused = false;
      this.player.play();
      this.drawer.blurToPage();
      queryVisible<HTMLElement>(this.adapter.playerFocusSelectors)?.focus({ preventScroll: true });
      return;
    }
    this.player.pause();
    this.smartPaused = true;
    this.postPanels({ type: 'typing-release' });
    const port = await this.inputEditor();
    port.postMessage({ type: 'focus', where: 'end' } satisfies ContentToPanel);
  }

  private replay(): void {
    if (!this.player.available) {
      this.overlay.toast('Aucun média à rembobiner', 'error');
      return;
    }
    const t = this.player.skip(-this.settings.replaySeconds);
    this.overlay.toast(`${formatTimecode(t)} - Retour de ${this.settings.replaySeconds} s`, 'info', 1500, { icon: 'replay' });
  }

  private async copyTimestamp(): Promise<void> {
    if (!this.ctx) return;
    const t = this.player.time();
    const tc = formatTimecode(t);
    try {
      await navigator.clipboard.writeText(`[${tc}](${timestampUrl(this.ctx.canonicalUrl, t)})`);
      this.overlay.confirmCopy();
    } catch {
      this.overlay.toast('Copie impossible (presse-papier refusé)', 'error');
    }
  }

  /** Flow 2: frame capture → flash → asset stored → thumbnail line in the note → toast. */
  private async capture(): Promise<void> {
    const video = this.player.video;
    const ctx = this.ctx;
    const remote = !video && this.player.source === 'frame' && this.player.kind === 'video' ? this.player.remote : null;
    if (!ctx || (!video && !remote)) {
      const audio = this.player.available && this.player.kind === 'audio';
      this.overlay.toast(
        audio ? 'Capture indisponible : ce média est audio' : this.player.source === 'stopwatch' ? 'Aucune image à capturer (chronomètre)' : 'Aucune vidéo à capturer',
        'error',
      );
      return;
    }
    if (this.capturing) return;
    this.capturing = true;
    const seconds = this.player.time();
    const { captureFormat: mime, captureQuality: quality } = this.settings;
    try {
      if (remote) {
        // Embedded player: its agent grabs the frame, else the visible area is captured.
        const res = await this.frameShot(mime, quality);
        const shot = res.shot ?? (await this.captureVisibleArea(mime, quality));
        this.overlay.flash();
        await this.saveShot(ctx, shot, seconds, '');
        return;
      }
      const probe = probeFrame(video!);
      if (probe === 'not-ready') throw new Error('la vidéo n’est pas encore chargée');
      let shot: Shot;
      let warning = '';
      if (probe === 'ok') {
        const pending = captureVideoFrame(video!, mime, quality); // frame drawn synchronously
        this.overlay.flash();
        shot = await pending;
      } else {
        // Cross-origin source (tainted canvas) or black frame (DRM): screenshot the visible area instead.
        try {
          shot = await this.captureVisibleArea(mime, quality);
        } catch (e) {
          if (probe !== 'blank') throw e;
          shot = await captureVideoFrame(video!, mime, quality);
          warning = ' (image noire : contenu protégé ?)';
        }
        this.overlay.flash();
      }
      await this.saveShot(ctx, shot, seconds, warning);
    } catch (e) {
      this.overlay.toast(`Capture impossible : ${errorMessage(e)}`, 'error', 3500);
    } finally {
      this.capturing = false;
    }
  }

  /** Manual clock for streams no script can read: timestamps follow it. */
  private onStopwatch(action: 'start' | 'pause' | 'reset'): void {
    const sw = this.player.stopwatch;
    if (action === 'start') {
      if (!sw.active) {
        // A large frame or video on screen: the notes are about a picture.
        const big = playerFrames(PLAYER_FRAME_AREA).length > 0 || [...document.querySelectorAll('video')].some((v) => v.getBoundingClientRect().width >= 320);
        this.player.stopwatchKind = big ? 'video' : 'audio';
      }
      sw.start();
      this.overlay.toast('Chronomètre lancé : vos horodatages le suivent', 'info', 2200, { icon: 'clock' });
    } else if (action === 'pause') sw.pause();
    else sw.reset();
    void this.ensureRegistered(true);
    this.broadcastPlayback();
  }

  /** Stores the picture, adds its line to the note, and confirms. */
  private async saveShot(ctx: VideoContext, shot: Shot, seconds: number, warning: string): Promise<void> {
    const { path } = await this.bg({
      type: 'asset:save',
      noteId: ctx.noteId,
      dataUrl: shot.dataUrl,
      mime: shot.mime,
      width: shot.width,
      height: shot.height,
      time: seconds,
    });
    const line = captureLine(seconds, path);
    const port = this.popoutPort ?? this.embeddedPort;
    if (port && this.ctx?.noteId === ctx.noteId) {
      port.postMessage({ type: 'insert-block', text: line } satisfies ContentToPanel);
    } else {
      await this.bg({
        type: 'note:append',
        noteId: ctx.noteId,
        meta: { platform: ctx.platform, url: ctx.canonicalUrl, title: this.title },
        text: line,
      });
    }
    this.overlay.toast(`${formatTimecode(seconds)} - Capture sauvegardée${warning}`, warning ? 'error' : 'success', 2000, {
      thumb: shot.dataUrl,
    });
  }

  /** Asks the embedded player's agent for the current frame (null: the page must screenshot it). */
  private frameShot(mime: string, quality: number): Promise<{ shot: Shot | null; error: string | null }> {
    const id = ++this.shotSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.shots.delete(id);
        resolve({ shot: null, error: 'timeout' });
      }, 4000);
      this.shots.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      if (!this.player.command({ op: 'capture', id, mime, quality })) {
        clearTimeout(timer);
        this.shots.delete(id);
        resolve({ shot: null, error: 'gone' });
      }
    });
  }

  private async captureVisibleArea(mime: string, quality: number): Promise<Shot> {
    if (document.visibilityState !== 'visible') throw new Error('l’onglet vidéo doit être visible');
    const rect = this.player.contentRect();
    if (!rect) throw new Error('vidéo introuvable');
    this.overlay.setHidden(true);
    try {
      await nextFrame();
      await nextFrame();
      const res = await this.bg({
        type: 'capture:visible-tab',
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        viewportWidth: innerWidth,
        mime,
        quality,
      });
      return { ...res, mime };
    } finally {
      this.overlay.setHidden(false);
    }
  }

  private setPinned(pinned: boolean): void {
    this.pinned = pinned;
    try {
      if (pinned) sessionStorage.setItem(PINNED_KEY, '1');
      else sessionStorage.removeItem(PINNED_KEY);
    } catch {
      // Storage unavailable: pinning only lasts for this page.
    }
    this.overlay.setPinned(pinned);
    this.postPanels({ type: 'pinned', value: pinned });
    if (pinned && this.ctx && !this.drawer.isOpen && !this.popoutPort) this.openDrawer(null);
  }

  // --- Panels (drawer iframe / pop-out window) ------------------------------------------

  private postPanels(msg: ContentToPanel): void {
    for (const port of [this.embeddedPort, this.popoutPort]) {
      try {
        port?.postMessage(msg);
      } catch {
        // Port closed in the meantime.
      }
    }
  }

  private broadcastPlayback(): void {
    this.postPanels({
      type: 'playback',
      playback: this.player.playback(),
      hasVideo: this.player.available,
      kind: this.kind,
      source: this.player.source,
    });
  }

  private onPanelMessage(port: Port, msg: PanelToContent): void {
    switch (msg.type) {
      case 'hello':
        if (msg.mode === 'popout') {
          this.popoutPort = port;
          this.drawer.destroyFrame();
          this.embeddedPort = null;
        } else {
          this.embeddedPort = port;
          for (const resolve of this.embeddedWaiters.splice(0)) resolve(port);
        }
        port.postMessage({
          type: 'init',
          ctx: this.ctx,
          title: this.title,
          pinned: this.pinned,
          hasVideo: this.player.available,
          kind: this.kind,
          playback: this.player.playback(),
          pageTheme: detectPageTheme(this.adapter),
          source: this.player.source,
        } satisfies ContentToPanel);
        if (this.reading) port.postMessage({ type: 'reading', ratio: this.reader.progress, passage: this.lastPassage } satisfies ContentToPanel);
        if (this.blockedPlayers) port.postMessage({ type: 'players', hosts: this.blockedPlayers.split(' ') } satisfies ContentToPanel);
        return;
      case 'seek':
        this.player.seek(msg.seconds);
        this.broadcastPlayback();
        break;
      case 'mark':
        if (msg.seconds === null) this.overlay.hideMarker();
        else this.overlay.showMarker(msg.seconds);
        return;
      case 'play':
        this.player.play();
        break;
      case 'pause':
        this.player.pause();
        break;
      case 'capture':
        void (this.reading ? this.capturePage() : this.capture());
        break;
      case 'replay':
        this.replay();
        break;
      case 'timestamp':
        if (this.reading) void this.quote();
        else port.postMessage({ type: 'insert-timestamp', seconds: this.player.time(), focus: true } satisfies ContentToPanel);
        break;
      case 'escape':
        if (port === this.popoutPort) return;
        if (this.pinned) {
          this.drawer.blurToPage();
          queryVisible<HTMLElement>(this.adapter.playerFocusSelectors)?.focus({ preventScroll: true });
        } else {
          this.closeDrawer();
        }
        return;
      case 'close':
        if (port !== this.popoutPort) this.closeDrawer();
        return;
      case 'pin':
        this.setPinned(msg.value);
        return;
      case 'popout':
        if (this.ctx) {
          void this.bg({ type: 'popout:open', noteId: this.ctx.noteId }).catch((e: unknown) =>
            this.overlay.toast(`Pop-out impossible : ${errorMessage(e)}`, 'error'),
          );
        }
        return;
      case 'dock':
        void this.bg({ type: 'popout:close', tabId: this.tabId }).catch(() => undefined);
        this.popoutPort = null;
        this.openDrawer('keep');
        return;
      case 'toast':
        this.overlay.toast(msg.text);
        return;
      case 'command':
        if (isCommand(msg.command)) void this.onCommand(msg.command);
        return;
      case 'quote':
        if (this.reading) void this.quote();
        return;
      case 'reveal':
        if (!this.reader.reveal(msg.url)) this.overlay.toast('Passage introuvable dans cette page (modifiée ?)', 'error', 3000);
        return;
      case 'stopwatch':
        this.onStopwatch(msg.action);
        return;
      case 'players:granted':
        // The agent was injected into the allowed frames: they report within a second.
        void this.bg({ type: 'frames:inject' }).catch(() => undefined);
        return;
    }
    this.markInteraction();
  }
}

const INSTANCE_KEY = '__booNotesContentApp';
type WindowWithApp = Window & { [INSTANCE_KEY]?: ContentApp };

const adapter = adapterForHost(location.hostname);
const existing = (window as WindowWithApp)[INSTANCE_KEY];
// Injected twice in the same world (declared script + re-injection on install): keep the live copy.
if (adapter && window.top === window && !existing?.alive) {
  // A copy from a previous extension version lives in another world: ask it to tear down.
  document.dispatchEvent(new CustomEvent(TEARDOWN_EVENT));
  const app = new ContentApp(adapter);
  (window as WindowWithApp)[INSTANCE_KEY] = app;
  app.start().catch((e: unknown) => console.warn('[Boo Notes]', errorMessage(e)));
}
