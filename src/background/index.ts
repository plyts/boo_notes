import {
  isCommand,
  type BackgroundRequest,
  type BackgroundResponses,
  type CommandId,
  type Reply,
  type SyncStatus,
  type TabMessage,
} from '../shared/messages';
import { findAssetRefs, toPortableMarkdown } from '../shared/markdown';
import { noteSlug } from '../shared/platforms';
import { loadSettings, normalizeSettings } from '../shared/settings';
import { NoteStore } from '../shared/store';
import { asciiFileName, blobToDataUrl, safeFileName, textToDataUrl } from '../shared/encoding';
import { SessionState } from './session';
import { DesktopSync } from './sync';

/**
 * Background service worker: owns storage, keyboard commands, the single
 * active player (multi-tab routing) and the link to the desktop app.
 */
const store = new NoteStore(chrome.storage.local);
const session = new SessionState();
const SYNC_ALARM = 'boo-notes-sync-retry';

const sync = new DesktopSync({
  store,
  clientVersion: chrome.runtime.getManifest().version,
  getConfig: async () => {
    const s = await loadSettings();
    return { url: s.desktopUrl, token: s.desktopToken };
  },
  onStatus: (status) => void publishStatus(status),
});

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
  if (target === null && data.activeTab !== null && data.players[data.activeTab]) {
    target = (await tabExists(data.activeTab)) ? data.activeTab : null;
  }
  if (target === null) {
    // No known player: the current tab's content script (if any) explains why.
    if (tab?.id !== undefined) await sendToTab(tab.id, { type: 'command', command });
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
      d.players[tabId] = { noteId: msg.ctx.noteId, title: msg.title, url: msg.ctx.canonicalUrl, at: Date.now() };
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
    return note;
  },

  'note:append': async (msg) => {
    const note = await store.appendToNote(msg.noteId, msg.meta, msg.text, 'background');
    void sync.notifyChanged();
    return note;
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
    await sync.notifyChanged();
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
      throw new Error('ce site protège sa vidéo ; utilisez le raccourci clavier de capture pour l’autoriser');
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
  for (const path of findAssetRefs(note.markdown)) {
    const asset = await store.getAsset(path);
    if (!asset) continue;
    await chrome.downloads.download({
      url: asset.dataUrl,
      filename: `${folder}/${path}`,
      conflictAction: 'overwrite',
      saveAs: false,
    });
  }
  return `Téléchargé dans « ${folder} »`;
}

// --- Lifecycle ---------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  // Declared content scripts only run on page load: add them to video tabs already open.
  for (const cs of chrome.runtime.getManifest().content_scripts ?? []) {
    if (!cs.matches || !cs.js) continue;
    const tabs = await chrome.tabs.query({ url: cs.matches });
    for (const t of tabs) {
      if (t.id !== undefined && !t.discarded) {
        chrome.scripting.executeScript({ target: { tabId: t.id }, files: cs.js }).catch(noop);
      }
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
  },
});
