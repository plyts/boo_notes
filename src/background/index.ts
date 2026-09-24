import {
  FRAME_PORT,
  isCommand,
  type BackgroundRequest,
  type BackgroundToFrame,
  type FrameToBackground,
  type BackgroundResponses,
  type CommandId,
  type NotionStatus,
  type Reply,
  type SyncStatus,
  type TabMessage,
} from '../shared/messages';
import { findAssetRefs, normalizeTitle, toPortableMarkdown } from '../shared/markdown';
import { noteSlug } from '../shared/platforms';
import { loadSettings, normalizeSettings } from '../shared/settings';
import { NoteStore, type CourseOption } from '../shared/store';
import { clearMedia, getMedia, markAllMediaUnsynced, markMediaSynced, putMedia, unsyncedMedia } from '../shared/media-db';
import { findMediaRefs, pinTranscriptLine, transcriptLine, transcriptPath, transcriptToMarkdown, transcriptToVtt } from '../shared/transcript';
import { TranscriptStore } from '../shared/transcript-store';
import { asciiFileName, base64ToBytes, blobToDataUrl, safeFileName, textToDataUrl } from '../shared/encoding';
import { ExtensionNotion } from './notion';
import { downloadPdf } from './pdf';
import { SessionState } from './session';
import { DesktopSync } from './sync';

/**
 * Background service worker: owns storage, keyboard commands, the single
 * active player (multi-tab routing), the link to the desktop app, and the
 * direct Notion sync used while the app is closed.
 */
const store = new NoteStore(chrome.storage.local);
const transcripts = new TranscriptStore(chrome.storage.local);
const session = new SessionState();
/** Recorded media being received in chunks (upload id → base64 parts). */
const uploads = new Map<string, { parts: string[]; at: number }>();
const MAX_MEDIA_BYTES = 400 * 1024 * 1024;
const SYNC_ALARM = 'boo-notes-sync-retry';
const NOTION_ALARM = 'boo-notes-notion';
/** Titles of the desktop app's library (revision sheets…), for `[[` completion. */
const DESKTOP_TITLES = 'desktop:titles';
/** Courses of the desktop library (title, emoji, chapters), to file notes from the panel. */
const DESKTOP_COURSES = 'desktop:courses';

const sync: DesktopSync = new DesktopSync({
  store,
  transcripts,
  media: {
    unsynced: () => unsyncedMedia().catch(() => []),
    read: async (path) => (await getMedia(path))?.blob ?? null,
    markSynced: (path) => markMediaSynced(path),
    requeueAll: () => markAllMediaUnsynced(),
  },
  clientVersion: chrome.runtime.getManifest().version,
  getConfig: async () => {
    const s = await loadSettings();
    return { url: s.desktopUrl, token: s.desktopToken };
  },
  onStatus: (status) => void publishStatus(status),
  notionLink: (noteId) => notion.link(noteId),
  onNotionConfig: (config) => void notion.applyDesktopConfig(config),
  onNotionLink: (noteId, link) => void notion.applyDesktopLink(noteId, link),
  onTitles: (titles) => void chrome.storage.local.set({ [DESKTOP_TITLES]: titles }),
  onCourses: (courses) => void chrome.storage.local.set({ [DESKTOP_COURSES]: courses }),
});

const notion: ExtensionNotion = new ExtensionNotion({
  area: chrome.storage.local,
  store,
  desktopHandlesNotion: () => sync.appHandlesNotion,
  // The app learns the Notion page of the note with its next copy.
  onLinked: (noteId) => void store.requeue(noteId).then(() => sync.notifyChanged()),
  onStatus: (status) => void publishNotionStatus(status),
});

async function publishNotionStatus(status: NotionStatus): Promise<void> {
  await chrome.storage.session.set({ 'notion:status': status });
  // The service worker may stop before the delayed write: an alarm picks it up.
  if (status.pending > 0 && status.configured) {
    if (!(await chrome.alarms.get(NOTION_ALARM))) await chrome.alarms.create(NOTION_ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(NOTION_ALARM);
  }
}

async function publishStatus(status: SyncStatus): Promise<void> {
  // Panels / options read the status from session storage (and get onChanged events).
  await chrome.storage.session.set({ 'sync:status': status });
  // While notes wait for the desktop app, retry even if the worker was stopped meanwhile.
  if (status.pending > 0 && status.state === 'offline') {
    if (!(await chrome.alarms.get(SYNC_ALARM))) await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  } else if (status.pending === 0) {
    await chrome.alarms.clear(SYNC_ALARM);
  }
}

const noop = () => undefined;

function sendToTab(tabId: number, message: TabMessage): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(noop);
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function setActivePlayer(tabId: number | null): Promise<void> {
  const before = (await session.get()).activeTab;
  const data = await session.update((d) => {
    d.activeTab = tabId !== null && d.players[tabId] ? tabId : d.activeTab;
  });
  if (data.activeTab === before) return;
  const info = data.activeTab !== null ? data.players[data.activeTab] : undefined;
  if (before !== null) void sendToTab(before, { type: 'player:active', active: false });
  if (data.activeTab !== null) void sendToTab(data.activeTab, { type: 'player:active', active: true });
  sync.announceActivePlayer(info ? { noteId: info.noteId, title: info.title, url: info.url } : null);
}

// --- Content script presence / on-demand activation --------------------------------

async function hasContentScript(tabId: number): Promise<boolean> {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: 'ping' } satisfies TabMessage, { frameId: 0 })) === true;
  } catch {
    return false;
  }
}

/** Injects the content script if the tab has none yet, then waits until it answers. */
async function ensureContentScript(tabId: number): Promise<boolean> {
  if (await hasContentScript(tabId)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    return false; // chrome:// pages, the Web Store, PDF viewer… or no permission.
  }
  // Off-DOM players started from now on (`new Audio()`) become visible to it.
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['media-bridge.js'], world: 'MAIN' }).catch(noop);
  for (let i = 0; i < 40; i++) {
    if (await hasContentScript(tabId)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// --- Embedded players (sub-frames) ------------------------------------------------------

/** Frame agents connected, by `tabId:frameId`. */
const framePorts = new Map<string, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== FRAME_PORT || port.sender?.id !== chrome.runtime.id) return;
  const tabId = port.sender.tab?.id;
  const frameId = port.sender.frameId;
  if (tabId === undefined || frameId === undefined || frameId === 0) {
    port.disconnect();
    return;
  }
  const key = `${tabId}:${frameId}`;
  framePorts.set(key, port);
  port.onMessage.addListener((msg: FrameToBackground) => {
    if (msg.type === 'media') void sendToTab(tabId, { type: 'frame:media', frameId, media: msg.media });
    else if (msg.type === 'gone') void sendToTab(tabId, { type: 'frame:media', frameId, media: null });
    else if (msg.type === 'shot') void sendToTab(tabId, { type: 'frame:shot', id: msg.id, shot: msg.shot, error: msg.error });
    else if (msg.type === 'captions') void sendToTab(tabId, { type: 'frame:captions', frameId, captions: msg.captions });
    else if (msg.type === 'event') void sendToTab(tabId, { type: 'frame:event', frameId, event: msg.event });
  });
  port.onDisconnect.addListener(() => {
    if (framePorts.get(key) === port) framePorts.delete(key);
    void sendToTab(tabId, { type: 'frame:media', frameId, media: null });
  });
});

/** Frame agent + main-world bridge in every sub-frame of the tab the extension may read. */
async function injectFrames(tabId: number): Promise<void> {
  // Frames the extension has no access to are skipped by Chrome.
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['media-bridge.js'], world: 'MAIN' }).catch(noop);
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['frame.js'] }).catch(noop);
}

const PLAYERS_KEY = 'players:allowed';
const PLAYERS_SCRIPT_ID = 'boo-notes-players';
const PLAYERS_BRIDGE_ID = 'boo-notes-players-bridge';

async function allowedPlayers(): Promise<string[]> {
  return ((await chrome.storage.local.get(PLAYERS_KEY))[PLAYERS_KEY] as string[] | undefined) ?? [];
}

/** Embedded players the user allowed: their frames get the agent on every site. */
async function syncPlayerScripts(origins: string[]): Promise<void> {
  const ids = [PLAYERS_SCRIPT_ID, PLAYERS_BRIDGE_ID];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (!origins.length) return;
  const matches = origins.map((o) => `${o}/*`);
  await chrome.scripting.registerContentScripts([
    { id: PLAYERS_BRIDGE_ID, matches, js: ['media-bridge.js'], allFrames: true, runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
    { id: PLAYERS_SCRIPT_ID, matches, js: ['frame.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true },
  ]);
}

// --- Sites where Boo Notes is always active -----------------------------------------------

const SITES_KEY = 'sites:enabled';
const SITES_SCRIPT_ID = 'boo-notes-sites';
const SITES_BRIDGE_ID = 'boo-notes-sites-bridge';
const SITES_FRAMES_ID = 'boo-notes-sites-frames';

async function enabledSites(): Promise<string[]> {
  return ((await chrome.storage.local.get(SITES_KEY))[SITES_KEY] as string[] | undefined) ?? [];
}

/** Keeps a dynamic content script registered for every always-enabled origin. */
async function syncSiteScripts(origins: string[]): Promise<void> {
  const ids = [SITES_SCRIPT_ID, SITES_BRIDGE_ID, SITES_FRAMES_ID];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (origins.length === 0) return;
  const matches = origins.map((o) => `${o}/*`);
  await chrome.scripting.registerContentScripts([
    // Off-DOM players are docked from the first line of the page's own scripts.
    { id: SITES_BRIDGE_ID, matches, js: ['media-bridge.js'], allFrames: true, runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
    { id: SITES_SCRIPT_ID, matches, js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true },
    { id: SITES_FRAMES_ID, matches, js: ['frame.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true },
  ]);
}

// --- Every site (« Activer sur tous les sites ») ------------------------------------------------

const ALL_KEY = 'sites:all';
const ALL_ORIGINS = ['https://*/*', 'http://*/*'];
const ALL_IDS = { bridge: 'boo-notes-all-bridge', content: 'boo-notes-all', frames: 'boo-notes-all-frames' };

async function allSitesEnabled(): Promise<boolean> {
  const on = (await chrome.storage.local.get(ALL_KEY))[ALL_KEY] === true;
  return on && (await chrome.permissions.contains({ origins: ALL_ORIGINS }).catch(() => false));
}

/** Content scripts on every web page (the sites declared in the manifest keep theirs). */
async function syncAllSites(enabled: boolean): Promise<void> {
  const ids = Object.values(ALL_IDS);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (!enabled) return;
  const declared = [...new Set((chrome.runtime.getManifest().content_scripts ?? []).flatMap((cs) => cs.matches ?? []))];
  const common = { matches: ALL_ORIGINS, excludeMatches: declared, persistAcrossSessions: true };
  await chrome.scripting.registerContentScripts([
    { ...common, id: ALL_IDS.bridge, js: ['media-bridge.js'], allFrames: true, runAt: 'document_start', world: 'MAIN' },
    { ...common, id: ALL_IDS.content, js: ['content.js'], runAt: 'document_idle' },
    { ...common, id: ALL_IDS.frames, js: ['frame.js'], allFrames: true, runAt: 'document_idle' },
  ]);
}

/** `*://*.youtube.com/*`-style match pattern against a URL (scheme and host; any path). */
function matchesPattern(pattern: string, url: string): boolean {
  const m = /^(\*|https?):\/\/(\*|\*\.[^/]+|[^/*]+)\//.exec(pattern);
  if (!m) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (m[1] !== '*' && `${m[1]}:` !== u.protocol) return false;
  const host = m[2];
  if (host === '*') return true;
  if (host.startsWith('*.')) return u.hostname === host.slice(2) || u.hostname.endsWith(host.slice(1));
  return u.hostname === host;
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Site non pris en charge');
  return url.origin;
}

// --- Keyboard commands ------------------------------------------------------

/** Commands that bring the notes to the foreground. */
const FOCUS_COMMANDS = new Set<CommandId>(['toggle-sidebar', 'insert-timestamp', 'smart-pause']);

/**
 * Routes a command to a single player: the pop-out's video when the pop-out
 * has focus, else the current tab if it plays a supported video, else the
 * last player that received an interaction.
 */
async function runCommand(command: CommandId, tab?: chrome.tabs.Tab): Promise<void> {
  const data = await session.get();
  const fromPopout = tab?.windowId !== undefined ? SessionState.popoutOwner(data, tab.windowId) : null;
  let target: number | null = fromPopout;
  if (target === null && tab?.id !== undefined && data.players[tab.id]) target = tab.id;
  // Remote control of the last media played (a page read in another tab has nothing to drive).
  const active = data.activeTab !== null ? data.players[data.activeTab] : undefined;
  if (target === null && active && active.kind !== 'page') {
    target = (await tabExists(data.activeTab as number)) ? data.activeTab : null;
  }
  if (target === null) {
    // No known player. On any web page, pressing a shortcut (or the toolbar icon) activates
    // Boo Notes there: Chrome grants `activeTab`, which lets us inject the content script.
    if (tab?.id !== undefined && (await ensureContentScript(tab.id))) {
      await sendToTab(tab.id, { type: 'command', command });
    }
    return;
  }

  const popoutWindow = data.popouts[target];
  if (popoutWindow !== undefined && command === 'toggle-sidebar') {
    // With detached notes, the shortcut switches between the video and the notes window.
    if (fromPopout !== null) await focusTab(target).catch(noop);
    else await chrome.windows.update(popoutWindow, { focused: true }).catch(noop);
    return;
  }
  if (FOCUS_COMMANDS.has(command)) {
    if (popoutWindow !== undefined) await chrome.windows.update(popoutWindow, { focused: true }).catch(noop);
    else if (target !== tab?.id) await focusTab(target).catch(noop);
  }
  await sendToTab(target, { type: 'command', command });
  await setActivePlayer(target);
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (isCommand(command)) void runCommand(command, tab);
});

chrome.action.onClicked.addListener((tab) => void runCommand('toggle-sidebar', tab));

// --- Messages -----------------------------------------------------------------

type Handler<T extends BackgroundRequest['type']> = (
  msg: Extract<BackgroundRequest, { type: T }>,
  sender: chrome.runtime.MessageSender,
) => Promise<BackgroundResponses[T]>;

type Handlers = { [T in BackgroundRequest['type']]: Handler<T> };

function requireTab(sender: chrome.runtime.MessageSender): chrome.tabs.Tab & { id: number } {
  if (sender.tab?.id === undefined) throw new Error('Requête hors onglet');
  return sender.tab as chrome.tabs.Tab & { id: number };
}

const handlers: Handlers = {
  hello: async (_msg, sender) => {
    void sync.connect();
    return { tabId: requireTab(sender).id };
  },

  'player:ready': async (msg, sender) => {
    const tabId = requireTab(sender).id;
    await session.update((d) => {
      d.players[tabId] = { noteId: msg.ctx.noteId, title: msg.title, url: msg.ctx.canonicalUrl, at: Date.now(), kind: msg.kind };
    });
    // Opening a video counts as an interaction: it becomes the active player.
    await setActivePlayer(tabId);
  },

  'player:gone': async (_msg, sender) => {
    const tabId = requireTab(sender).id;
    await session.update((d) => {
      delete d.players[tabId];
      if (d.activeTab === tabId) d.activeTab = null;
    });
  },

  'player:interaction': async (_msg, sender) => {
    await setActivePlayer(requireTab(sender).id);
  },

  'note:get': (msg) => store.getOrDraft(msg.noteId, msg.meta),

  'note:save': async (msg) => {
    const note = await store.saveNote(msg.noteId, msg.meta, msg.markdown, msg.writer);
    void sync.notifyChanged();
    void notion.enqueue(msg.noteId);
    return note;
  },

  'note:append': async (msg) => {
    const note = await store.appendToNote(msg.noteId, msg.meta, msg.text, 'background');
    void sync.notifyChanged();
    void notion.enqueue(msg.noteId);
    return note;
  },

  'note:place': async (msg) => {
    const note = await store.placeNote(msg.noteId, msg.meta, msg.place);
    void sync.notifyChanged();
    void notion.enqueue(msg.noteId);
    return note;
  },

  'library:courses': async () => {
    const [index, stored] = await Promise.all([store.listNotes(), chrome.storage.local.get(DESKTOP_COURSES)]);
    const courses = new Map<string, CourseOption>();
    for (const c of (stored[DESKTOP_COURSES] as CourseOption[] | undefined) ?? []) courses.set(normalizeTitle(c.title), { ...c, chapters: [...c.chapters] });
    // Courses typed in the panel while the app was closed are offered too.
    for (const n of Object.values(index)) {
      if (!n.course) continue;
      const key = normalizeTitle(n.course);
      const c = courses.get(key) ?? { title: n.course, chapters: [] };
      if (n.chapter && !c.chapters.some((t) => normalizeTitle(t) === normalizeTitle(n.chapter!))) c.chapters.push(n.chapter);
      courses.set(key, c);
    }
    return [...courses.values()];
  },

  'asset:save': async (msg) => {
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(msg.dataUrl)) throw new Error('Image invalide');
    const asset = await store.saveAsset({
      noteId: msg.noteId,
      dataUrl: msg.dataUrl,
      mime: msg.mime,
      width: msg.width,
      height: msg.height,
      time: msg.time,
    });
    return { path: asset.path };
  },

  'capture:visible-tab': async (msg, sender) => {
    const tab = requireTab(sender);
    return captureVisibleArea(tab.windowId, msg);
  },

  export: async (msg) => {
    if (msg.target === 'download') return { message: await downloadNote(msg.noteId) };
    if (msg.target === 'pdf') return { message: await downloadPdf(store, [msg.noteId]) };
    if (msg.target === 'notion' && !sync.appHandlesNotion) {
      // App closed (or without Notion): the extension writes to Notion itself.
      if (await notion.isConfigured()) {
        await notion.syncNow(msg.noteId);
        return { message: 'Envoyé vers Notion' };
      }
      if (!sync.connected) throw new Error('Notion n’est pas connecté : ouvrez l’app Desktop ou les options de l’extension');
    }
    const message = await sync.exportNote(msg.noteId, msg.target === 'notion' ? 'notion' : 'local');
    return { message };
  },

  'popout:open': async (_msg, sender) => {
    const tab = requireTab(sender);
    const data = await session.get();
    const existing = data.popouts[tab.id];
    if (existing !== undefined) {
      try {
        await chrome.windows.update(existing, { focused: true });
        return { windowId: existing };
      } catch {
        // Stale entry: the window is gone, create a new one.
      }
    }
    const settings = await loadSettings();
    const parent = await chrome.windows.get(tab.windowId);
    const width = Math.max(380, settings.drawerWidth + 40);
    const height = Math.min(parent.height ?? 820, 820);
    const base: chrome.windows.CreateData = {
      url: chrome.runtime.getURL(`panel/panel.html?tab=${tab.id}&mode=popout`),
      type: 'popup',
      width,
      height,
      focused: true,
    };
    let win: chrome.windows.Window | undefined;
    try {
      // Next to the right edge of the video window.
      win = await chrome.windows.create({
        ...base,
        left: Math.max(0, (parent.left ?? 0) + (parent.width ?? width) - width - 24),
        top: (parent.top ?? 0) + 48,
      });
    } catch {
      // Bounds refused (must be ≥ 50 % on a visible screen): let Chrome place the window.
      win = await chrome.windows.create(base);
    }
    if (win?.id === undefined) throw new Error('Impossible d’ouvrir la fenêtre');
    const windowId = win.id;
    await session.update((d) => {
      d.popouts[tab.id] = windowId;
    });
    return { windowId };
  },

  'popout:close': async (msg) => {
    const data = await session.get();
    const windowId = data.popouts[msg.tabId];
    if (windowId !== undefined) await chrome.windows.remove(windowId).catch(noop);
  },

  'options:open': async () => {
    await chrome.runtime.openOptionsPage();
  },

  'shortcuts:list': async () => {
    const commands = await chrome.commands.getAll();
    return commands
      .filter((c) => c.name && c.name !== '_execute_action')
      .map((c) => ({ name: c.name ?? '', shortcut: c.shortcut ?? '', description: c.description ?? '' }));
  },

  'sync:status': async () => {
    void sync.connect();
    return sync.status();
  },

  'sync:retry': async () => {
    await sync.reconnect();
    return sync.status();
  },

  'notes:list': () => store.listNotes(),

  'notes:clear': async () => {
    await store.clearAll();
    await clearMedia().catch(noop);
    await sync.notifyChanged();
  },

  'transcript:put': async (msg) => {
    // Watching alone is never recorded: the note must exist, or the user be taking notes.
    if (!msg.engaged && !(await store.getNote(msg.noteId))) return { stored: false };
    await transcripts.put(msg.noteId, msg.info, msg.cues, msg.replace);
    void sync.notifyChanged();
    return { stored: true };
  },

  'transcript:get': (msg) => transcripts.get(msg.noteId),

  'transcript:annotate': async (msg) => {
    const t = await transcripts.annotate(msg.noteId, msg.patches, { lang: msg.lang, target: msg.target });
    void sync.notifyChanged();
    // Translations and comments reach the Notion page (debounced).
    if (msg.patches.length) void notion.enqueue(msg.noteId);
    return t;
  },

  'transcript:pin': async (msg) => {
    // Leaving the page: the panel saves the note first.
    if (msg.delay) await new Promise((r) => setTimeout(r, Math.min(msg.delay ?? 0, 5000)));
    const t = await transcripts.get(msg.noteId);
    if (!t?.cues.length) return { pinned: false };
    const line = transcriptLine(t);
    const note = await store.transformNote(msg.noteId, (md) => (md.trim() ? pinTranscriptLine(md, line) : md), 'background');
    if (note) {
      void sync.notifyChanged();
      void notion.enqueue(msg.noteId);
    }
    return { pinned: Boolean(note) || Boolean((await store.getNote(msg.noteId))?.markdown.includes(line)) };
  },

  'media:chunk': async (msg) => {
    const now = Date.now();
    for (const [id, u] of uploads) if (now - u.at > 10 * 60_000) uploads.delete(id);
    const u = uploads.get(msg.upload) ?? { parts: [], at: now };
    u.parts[msg.index] = msg.data;
    u.at = now;
    if (u.parts.reduce((n, p) => n + (p?.length ?? 0), 0) * 0.75 > MAX_MEDIA_BYTES) {
      uploads.delete(msg.upload);
      throw new Error('Enregistrement trop volumineux');
    }
    uploads.set(msg.upload, u);
  },

  'media:commit': async (msg) => {
    const u = uploads.get(msg.upload);
    uploads.delete(msg.upload);
    const r = msg.record;
    if (!u || u.parts.some((p) => p === undefined)) throw new Error('Enregistrement incomplet');
    if (!/^media\/[\w.-]+\.(webm|ogg|mp4|m4a)$/.test(r.path) || !/^(audio|video)\/[\w.+-]+(;.*)?$/.test(r.mime)) throw new Error('Enregistrement invalide');
    const blob = new Blob(u.parts.map((p) => base64ToBytes(p)), { type: r.mime });
    await putMedia({ ...r, blob, size: blob.size, createdAt: Date.now() });
    void sync.notifyChanged();
    return { path: r.path };
  },

  'media:stored': async (msg) => {
    if (!/^media\/[\w.-]+$/.test(msg.path) || !(await getMedia(msg.path))) throw new Error('Média introuvable');
    void sync.notifyChanged();
  },

  'player:progress': async (msg) => {
    let position = msg.position;
    if (msg.kind === 'page') {
      // Reading: the furthest point reached counts, not where the page was reopened.
      const before = await store.getProgress(msg.noteId);
      if (before && before.position >= position) return;
      position = Math.max(position, before?.position ?? 0);
    }
    // Only media that have a note are tracked (watching alone is never recorded).
    if (await store.saveProgress(msg.noteId, position, msg.duration)) {
      void sync.sendProgress(msg.noteId);
      void notion.enqueue(msg.noteId, 'progress');
    }
  },

  'frame:command': async (msg, sender) => {
    const tabId = requireTab(sender).id;
    framePorts.get(`${tabId}:${msg.frameId}`)?.postMessage({ type: 'command', command: msg.command } satisfies BackgroundToFrame);
  },

  'frames:inject': async (_msg, sender) => {
    await injectFrames(requireTab(sender).id);
  },

  'frames:notify': async (msg, sender) => {
    const prefix = `${requireTab(sender).id}:`;
    for (const [key, port] of framePorts) {
      if (!key.startsWith(prefix)) continue;
      try {
        port.postMessage({ type: 'notice', notice: msg.notice } satisfies BackgroundToFrame);
      } catch {
        framePorts.delete(key);
      }
    }
  },

  'players:allow': async (msg) => {
    const granted: string[] = [];
    for (const o of msg.origins) {
      const origin = normalizeOrigin(o);
      // The permission itself is requested by the panel (it needs a user gesture).
      if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) granted.push(origin);
    }
    if (!granted.length) throw new Error('Autorisation refusée pour ce lecteur');
    const players = [...new Set([...(await allowedPlayers()), ...granted])].sort();
    await chrome.storage.local.set({ [PLAYERS_KEY]: players });
    await syncPlayerScripts(players);
    await injectFrames(msg.tabId);
  },

  'sites:list': () => enabledSites(),

  'sites:enable': async (msg) => {
    const origin = normalizeOrigin(msg.origin);
    // The permission itself is requested by the UI (it needs a user gesture).
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
      throw new Error('Autorisation refusée pour ce site');
    }
    const sites = [...new Set([...(await enabledSites()), origin])].sort();
    await chrome.storage.local.set({ [SITES_KEY]: sites });
    await syncSiteScripts(sites);
    return sites;
  },

  'sites:all': async (msg) => {
    if (msg.enabled === null) return allSitesEnabled();
    if (msg.enabled) {
      // The permission itself is requested by the options page (it needs a user gesture).
      if (!(await chrome.permissions.contains({ origins: ALL_ORIGINS }))) throw new Error('Autorisation refusée pour tous les sites');
      await chrome.storage.local.set({ [ALL_KEY]: true });
      await syncAllSites(true);
      // Pages already open with a video or audio: active now, without reloading them.
      const tabs = await chrome.tabs.query({ url: ALL_ORIGINS }).catch(() => [] as chrome.tabs.Tab[]);
      for (const t of tabs) {
        if (t.id === undefined || t.discarded || !t.audible) continue;
        const tabId = t.id;
        void ensureContentScript(tabId).then(async (ok) => {
          if (ok) await injectFrames(tabId);
        });
      }
      return true;
    }
    await chrome.storage.local.set({ [ALL_KEY]: false });
    await syncAllSites(false);
    // The broad permission goes too, unless it also covers sites and players allowed one by one.
    if (!(await enabledSites()).length && !(await allowedPlayers()).length) {
      await chrome.permissions.remove({ origins: ALL_ORIGINS }).catch(noop);
    }
    return false;
  },

  'sites:disable': async (msg) => {
    const origin = normalizeOrigin(msg.origin);
    const sites = (await enabledSites()).filter((o) => o !== origin);
    await chrome.storage.local.set({ [SITES_KEY]: sites });
    await syncSiteScripts(sites);
    await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(noop);
    return sites;
  },

  'notes:pdf': async () => ({ message: await downloadPdf(store, null) }),

  'wiki:titles': async () => {
    const [index, stored] = await Promise.all([store.listNotes(), chrome.storage.local.get(DESKTOP_TITLES)]);
    const titles = [...Object.values(index).map((n) => n.title), ...((stored[DESKTOP_TITLES] as string[] | undefined) ?? [])];
    const seen = new Map<string, string>();
    for (const t of titles) {
      const key = normalizeTitle(t);
      if (key && !seen.has(key)) seen.set(key, t.trim());
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'fr'));
  },

  'wiki:open': async (msg) => {
    const title = msg.title.trim();
    // 1. The desktop app knows every note (revision sheets, PDF…) and creates missing sheets.
    if (sync.openInApp(title)) return { message: `« ${title} » ouvert dans Boo Notes Desktop` };
    // 2. A note of the extension: its video / page.
    const id = await notion.findByTitle(title);
    const note = id ? await store.getNote(id) : null;
    if (note && /^https?:\/\//.test(note.url)) {
      await chrome.tabs.create({ url: note.url });
      return { message: `« ${note.title} » ouvert dans un nouvel onglet` };
    }
    // 3. Its page in the Notion notes table.
    const url = await notion.pageUrlByTitle(title).catch(() => null);
    if (url) {
      await chrome.tabs.create({ url });
      return { message: `« ${title} » ouvert dans Notion` };
    }
    throw new Error(`« ${title} » n’existe pas encore : ouvrez l’app Desktop pour créer cette fiche`);
  },

  'notion:status': () => notion.status(),

  'notion:connect': (msg) => notion.connect(msg.token, msg.target),

  'notion:disconnect': () => notion.disconnect(),

  'notion:sync-all': () => {
    if (sync.appHandlesNotion) throw new Error('L’app Desktop synchronise déjà vos notes avec Notion');
    return notion.syncAll();
  },
};

chrome.runtime.onMessage.addListener((msg: BackgroundRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
  const handler = handlers[msg.type] as Handler<typeof msg.type> | undefined;
  if (!handler) return false;
  handler(msg as never, sender).then(
    (data) => sendResponse({ ok: true, data } satisfies Reply<unknown>),
    (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Reply<unknown>),
  );
  return true;
});

// --- Capture fallback & export --------------------------------------------------

/**
 * Used when the <video> frame cannot be read directly (cross-origin source
 * without CORS): screenshot the visible tab and crop the video area.
 */
async function captureVisibleArea(
  windowId: number,
  msg: Extract<BackgroundRequest, { type: 'capture:visible-tab' }>,
): Promise<{ dataUrl: string; width: number; height: number }> {
  let shot: string;
  try {
    shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (e) {
    // Needs the activeTab grant, which Chrome gives when an extension shortcut is pressed.
    if (/activeTab|all_urls/.test(String(e))) {
      throw new Error('Chrome ne l’autorise qu’après un clic sur l’icône Boo Notes ou le raccourci de capture (Alt+Maj+S)');
    }
    throw e;
  }
  const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
  const scale = bitmap.width / Math.max(1, msg.viewportWidth);
  const sx = Math.max(0, Math.round(msg.rect.x * scale));
  const sy = Math.max(0, Math.round(msg.rect.y * scale));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(msg.rect.width * scale)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(msg.rect.height * scale)));
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas indisponible');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: msg.mime, quality: msg.quality });
  return { dataUrl: await blobToDataUrl(blob), width: sw, height: sh };
}

/** Offline export: `Boo Notes/<titre>/<titre>.md` + `assets/…` next to it. */
async function downloadNote(noteId: string): Promise<string> {
  const note = await store.getNote(noteId);
  if (!note || note.markdown.trim() === '') throw new Error('La note est vide');
  let name = safeFileName(note.title, noteSlug(noteId));
  const markdownFile = (n: string) => ({
    url: textToDataUrl(toPortableMarkdown(note)),
    filename: `Boo Notes/${n}/${n}.md`,
    conflictAction: 'overwrite' as const,
    saveAs: false,
  });
  try {
    await chrome.downloads.download(markdownFile(name));
  } catch (e) {
    // Some platforms / locales refuse non-ASCII file names ("Invalid filename").
    if (!/invalid filename/i.test(String(e))) throw e;
    name = asciiFileName(note.title, noteSlug(noteId));
    await chrome.downloads.download(markdownFile(name));
  }
  const folder = `Boo Notes/${name}`;
  const save = (url: string, path: string) => chrome.downloads.download({ url, filename: `${folder}/${path}`, conflictAction: 'overwrite', saveAs: false });
  for (const path of findAssetRefs(note.markdown)) {
    const asset = await store.getAsset(path);
    if (asset) await save(asset.dataUrl, path);
  }
  // Recorded extracts (next to the note: its `[Extrait](media/…)` links open them, Obsidian plays them).
  for (const path of findMediaRefs(note.markdown)) {
    const media = await getMedia(path).catch(() => null);
    if (media) await save(await blobToDataUrl(media.blob), path);
  }
  // The transcript the note's `📄` line points to, readable and for players.
  const t = await transcripts.get(noteId);
  if (t?.cues.length) {
    await save(textToDataUrl(transcriptToMarkdown(t, { title: note.title, url: /^https?:/.test(note.url) ? note.url : undefined })), transcriptPath(noteId, 'md'));
    await save(textToDataUrl(transcriptToVtt(t), 'text/vtt'), transcriptPath(noteId, 'vtt'));
    if (t.cues.some((c) => c.tr)) await save(textToDataUrl(transcriptToVtt(t, true), 'text/vtt'), transcriptPath(noteId, 'vtt').replace(/\.vtt$/, `.${t.target || 'fr'}.vtt`));
  }
  return `Téléchargé dans « ${folder} »`;
}

// --- Lifecycle ---------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  // Declared content scripts only run on page load: add them to video tabs already open.
  for (const cs of chrome.runtime.getManifest().content_scripts ?? []) {
    if (!cs.matches || !cs.js) continue;
    const world = (cs as { world?: 'MAIN' | 'ISOLATED' }).world ?? 'ISOLATED';
    const tabs = await chrome.tabs.query({ url: cs.matches });
    for (const t of tabs) {
      if (t.id !== undefined && !t.discarded) {
        chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: Boolean(cs.all_frames) }, files: cs.js, world }).catch(noop);
      }
    }
  }
  const sites = await enabledSites();
  const everywhere = await allSitesEnabled();
  await syncSiteScripts(sites).catch(noop);
  await syncAllSites(everywhere).catch(noop);
  await syncPlayerScripts(await allowedPlayers()).catch(noop);
  // Sites always active (dynamic scripts): their open tabs get the new version too, as the declared ones.
  if (sites.length || everywhere) {
    const declared = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((cs) => cs.matches ?? []);
    const tabs = (await chrome.tabs.query({ url: everywhere ? ALL_ORIGINS : sites.map((o) => `${o}/*`) }).catch(() => [] as chrome.tabs.Tab[]))
      // Declared sites already got theirs above.
      .filter((t) => !(everywhere && t.url && declared.some((m) => matchesPattern(m, t.url!))));
    for (const t of tabs) {
      if (t.id === undefined || t.discarded) continue;
      const target = { tabId: t.id, allFrames: true };
      chrome.scripting.executeScript({ target, files: ['media-bridge.js'], world: 'MAIN' }).catch(noop);
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(noop);
      chrome.scripting.executeScript({ target, files: ['frame.js'] }).catch(noop);
    }
  }
  if (details.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#bienvenue') });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void session.update((d) => {
    delete d.players[tabId];
    if (d.activeTab === tabId) d.activeTab = null;
  });
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const owner = SessionState.popoutOwner(await session.get(), windowId);
  if (owner === null) return;
  await session.update((d) => {
    delete d.popouts[owner];
  });
  void sendToTab(owner, { type: 'popout:closed' });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) void sync.connect();
  if (alarm.name === NOTION_ALARM) void notion.flush();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.settings) return;
  const before = normalizeSettings(changes.settings.oldValue);
  const after = normalizeSettings(changes.settings.newValue);
  if (before.desktopUrl !== after.desktopUrl || before.desktopToken !== after.desktopToken) {
    void sync.reconnect();
  }
});

void sync.connect();
void notion.status().then(publishNotionStatus);

// Debug / end-to-end test hook (service worker console: `booNotes.runCommand('capture-screenshot')`).
Object.assign(globalThis, {
  booNotes: {
    runCommand: async (command: CommandId, tabId?: number) => {
      const tab =
        tabId !== undefined
          ? await chrome.tabs.get(tabId)
          : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      await runCommand(command, tab);
    },
    store,
    sync,
    session,
    notion,
  },
});
