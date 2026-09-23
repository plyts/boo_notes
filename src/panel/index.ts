import { TypingAutoPause } from '../shared/autopause';
import { h, icon, type IconName } from '../shared/icons';
import { toPortableMarkdown } from '../shared/markdown';
import {
  callBackground,
  PANEL_PORT,
  type ContentToPanel,
  type ExportTarget,
  type PageTheme,
  type PanelMode,
  type PanelToContent,
  type PlaybackState,
  type SyncStatus,
} from '../shared/messages';
import { PLATFORM_LABELS, type VideoContext } from '../shared/platforms';
import { loadSettings, normalizeSettings, type Settings } from '../shared/settings';
import type { AssetRecord, Note, NoteMeta } from '../shared/store';
import { findBinding, formatShortcut, inPageBindings, type InPageBinding } from '../shared/shortcuts';
import { formatTimecode } from '../shared/time';
import { NotesEditor } from './editor';

/**
 * The notes panel. The same page runs embedded in the drawer iframe and in
 * the detached pop-out window; in both cases it talks to the video tab's
 * content script through a port.
 */
const params = new URLSearchParams(location.search);
const TAB_ID = Number(params.get('tab'));
const MODE: PanelMode = params.get('mode') === 'popout' ? 'popout' : 'embedded';
const CLIENT_ID = crypto.randomUUID();
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const SAVE_DELAY_MS = 400;

type SaveState = 'saved' | 'pending' | 'saving' | 'error' | 'idle';

const assetCache = new Map<string, Promise<string>>();

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
  private metaEl!: HTMLSpanElement;
  private noticeEl!: HTMLSpanElement;
  private pinButton: HTMLButtonElement | null = null;
  private exportButton!: HTMLButtonElement;
  private menu!: HTMLDivElement;
  private banner!: HTMLDivElement;
  private clockEl!: HTMLSpanElement;
  private footerButtons: Record<'timestamp' | 'capture' | 'replay', HTMLButtonElement> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

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
      onSaveShortcut: () => void this.flush(),
      loadAsset,
    });
    this.editor.setEditable(false);
    this.bindGlobalEvents();
    this.connect();
    void this.loadShortcuts();
    const status = (await chrome.storage.session.get('sync:status'))['sync:status'] as SyncStatus | undefined;
    this.renderStatus(status);
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
        this.playback = msg.playback;
        this.pageTheme = msg.pageTheme;
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
        break;
      case 'insert-timestamp':
        void this.loading.then(() => this.note && this.editor.insertTimestamp(msg.seconds, msg.focus));
        break;
      case 'insert-block':
        void this.loading.then(() => this.note && this.editor.insertBlock(msg.text));
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
    const t = this.hasVideo ? this.now() : null;
    this.clockEl.textContent = t === null ? '--:--' : formatTimecode(t);
    this.clockEl.dataset.playing = String(this.hasVideo && this.playback.playing);
    this.editor.setPlaybackTime(t);
  }

  // --- Note lifecycle -------------------------------------------------------------------

  private meta(): NoteMeta | null {
    if (!this.ctx) return null;
    return { platform: this.ctx.platform, url: this.ctx.canonicalUrl, title: this.title };
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
    this.renderHeader();
    if (!ctx) {
      this.editor.load('');
      this.editor.setEditable(false);
      this.showBanner('Aucune vidéo détectée. Ouvrez une vidéo YouTube, un cours Udemy ou Coursera.');
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
    this.exportButton = iconButton('export', 'Exporter la note', () => this.toggleMenu(), {
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
    this.metaEl = h('span', { class: 'meta-text' });
    this.noticeEl = h('span', { class: 'notice', role: 'status', 'aria-live': 'polite' });
    this.menu = this.buildMenu();
    this.banner = h('div', { class: 'banner', hidden: true, role: 'status' });

    this.clockEl = h('span', { class: 'clock', title: 'Position de la vidéo' }, '--:--');
    const timestamp = iconButton('clock', 'Insérer l’horodatage', () => this.post({ type: 'timestamp' }));
    const capture = iconButton('camera', 'Capturer l’image', () => this.post({ type: 'capture' }));
    const replay = iconButton('replay', 'Reculer de 5 s', () => this.post({ type: 'replay' }));
    this.footerButtons = { timestamp, capture, replay };

    this.root.append(
      h(
        'header',
        { class: 'header' },
        h('div', { class: 'toolbar' }, this.statusButton, h('span', { class: 'spacer' }), ...actions),
        this.titleEl,
        h('div', { class: 'meta' }, this.metaEl, this.noticeEl),
        this.menu,
      ),
      this.banner,
      h('main', { class: 'editor', 'aria-label': 'Éditeur de notes (Markdown)' }),
      h('footer', { class: 'footer' }, this.clockEl, h('span', { class: 'spacer' }), timestamp, capture, replay),
    );
  }

  private buildMenu(): HTMLDivElement {
    const item = (target: ExportTarget | 'copy', iconName: IconName, label: string) => {
      const b = h('button', { type: 'button', role: 'menuitem', 'data-target': target }, icon(iconName), h('span', {}, label));
      b.addEventListener('click', () => {
        this.closeMenu(true);
        void (target === 'copy' ? this.copyMarkdown() : this.exportTo(target));
      });
      return b;
    };
    const menu = h(
      'div',
      { class: 'menu', role: 'menu', hidden: true, 'aria-label': 'Exporter' },
      item('desktop', 'desktop', 'Envoyer vers l’app Desktop'),
      item('notion', 'notion', 'Envoyer vers Notion (via Desktop)'),
      item('download', 'download', 'Télécharger (.md + captures)'),
      item('copy', 'copy', 'Copier le Markdown'),
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
    for (const b of this.menu.querySelectorAll<HTMLButtonElement>('button')) {
      const needsDesktop = b.dataset.target === 'desktop' || b.dataset.target === 'notion';
      b.disabled = !this.note || (needsDesktop && !online);
      b.title = needsDesktop && !online ? 'Application Desktop hors-ligne' : '';
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
    const platform = this.ctx ? PLATFORM_LABELS[this.ctx.platform] : '';
    this.metaEl.dataset.platform = platform;
    this.renderSaveState();
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
      idle: 'Nouvelle note',
      pending: 'Modifications…',
      saving: 'Enregistrement…',
      saved: 'Enregistré localement',
      error: 'Échec de l’enregistrement',
    };
    const platform = this.metaEl.dataset.platform;
    this.metaEl.textContent = [platform, labels[this.saveState]].filter(Boolean).join(' · ');
    this.metaEl.dataset.state = this.saveState;
    this.metaEl.title = this.saveError;
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

  private notify(text: string, kind: 'info' | 'error' = 'info'): void {
    this.noticeEl.textContent = text;
    this.noticeEl.dataset.kind = kind;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeEl.textContent = '';
    }, 3500);
  }

  private showBanner(text: string): void {
    this.banner.textContent = text;
    this.banner.hidden = false;
  }

  private hideBanner(): void {
    this.banner.hidden = true;
  }

  private async loadShortcuts(): Promise<void> {
    try {
      const list = await callBackground({ type: 'shortcuts:list' });
      this.pageBindings = inPageBindings(list);
      this.shortcuts = Object.fromEntries(list.map((c) => [c.name, c.shortcut]));
      if (this.settings.pageShortcuts) {
        for (const b of this.pageBindings) this.shortcuts[b.command] = formatShortcut(b.shortcut, IS_MAC);
      }
    } catch {
      return;
    }
    if (!this.footerButtons) return;
    const withKey = (label: string, key: string | undefined) => (key ? `${label} (${key})` : label);
    const replayKey = this.shortcuts.replay;
    const set = (b: HTMLButtonElement, label: string) => {
      b.title = label;
      b.setAttribute('aria-label', label);
    };
    set(this.footerButtons.timestamp, withKey('Insérer l’horodatage', this.shortcuts['insert-timestamp']));
    set(this.footerButtons.capture, withKey('Capturer l’image', this.shortcuts['capture-screenshot']));
    set(this.footerButtons.replay, withKey(`Reculer de ${this.settings.replaySeconds} s`, replayKey));
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
      this.notify(message);
    } catch (e) {
      this.notify(`Export impossible : ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  private async copyMarkdown(): Promise<void> {
    if (!this.note) return;
    const text = toPortableMarkdown({ ...this.note, title: this.title || this.note.title, markdown: this.editor.content });
    try {
      await navigator.clipboard.writeText(text);
      this.notify('Markdown copié dans le presse-papier');
    } catch {
      this.notify('Copie refusée par le navigateur', 'error');
    }
  }

  private bindGlobalEvents(): void {
    document.addEventListener(
      'keydown',
      (e) => {
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
      if (!this.menu.hidden && !this.menu.contains(e.target as Node) && e.target !== this.exportButton) {
        this.closeMenu(false);
      }
    });
    window.addEventListener('pagehide', () => void this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes['sync:status']) {
        this.renderStatus(changes['sync:status'].newValue as SyncStatus | undefined);
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
        }
      }
    });
  }
}

void new PanelApp().start();
