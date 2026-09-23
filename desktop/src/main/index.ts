import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import { timestampUrl } from '../../../src/shared/platforms';
import { ConfigStore, plainBox, type SecretBox } from '../core/config';
import { isDue, kindForFile, Library, OPEN_FILE_FILTERS, positionLabel, progressRatio, studyStatus } from '../core/library';
import { NotionSync } from '../core/notion/sync';
import { ExtensionServer } from '../core/server';
import type { Highlight, LibraryItem, Pin, ReviewAction, StudyStatus } from '../core/types';
import { CHANNELS as C, type AddResult, type AppStatus, type ItemView, type SettingsPatch, type SettingsView } from '../ipc';
import { handleScheme, registerSchemePrivileges } from './protocol';

// --- Environment ----------------------------------------------------------------------------

const DIST = __dirname;
const ICON = join(DIST, 'icons', 'icon-256.png');
const TRAY_ICON = join(DIST, 'icons', process.platform === 'win32' ? 'tray-16.png' : 'tray-22.png');
const E2E = process.env.BOO_E2E === '1';

if (process.env.BOO_USER_DATA) app.setPath('userData', process.env.BOO_USER_DATA);
app.setAppUserModelId('app.boonotes.desktop');
registerSchemePrivileges();

if (!E2E && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let config: ConfigStore;
let library: Library;
let server: ExtensionServer;
let notion: NotionSync;
let serverError: string | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let trayHintShown = false;
const pendingOpen: string[] = [];

// --- Secrets --------------------------------------------------------------------------------

/** Notion secret sealed with the OS keychain (DPAPI on Windows, Keychain, libsecret). */
function secretBox(): SecretBox {
  if (!safeStorage.isEncryptionAvailable()) return plainBox;
  return {
    encrypt: (plain) => `os:${safeStorage.encryptString(plain).toString('base64')}`,
    decrypt: (sealed) => (sealed.startsWith('os:') ? safeStorage.decryptString(Buffer.from(sealed.slice(3), 'base64')) : ''),
  };
}

// --- Views ----------------------------------------------------------------------------------

function view(item: LibraryItem): ItemView {
  return {
    ...item,
    studyStatus: studyStatus(item),
    ratio: progressRatio(item),
    positionLabel: positionLabel(item),
    due: isDue(item),
  };
}

/** Notion connection sent to the paired extensions (they sync directly while the app is closed). */
function sharedNotionConfig(): Record<string, unknown> {
  const cfg = config.get().notion;
  const token = config.notionToken();
  const shared =
    cfg.share && token && cfg.databaseId
      ? {
          token,
          databaseId: cfg.databaseId,
          databaseUrl: cfg.databaseUrl,
          parentId: cfg.parentId,
          workspace: cfg.workspace,
          ...(process.env.NOTION_API_BASE ? { apiBase: process.env.NOTION_API_BASE } : {}),
        }
      : null;
  // `connected`: the app writes the extension's notes to Notion itself while it is running.
  return { type: 'notion.config', config: shared, connected: Boolean(token && cfg.databaseId) };
}

/** Titles of the library, offered by the extension after `[[`. */
function libraryTitles(): Record<string, unknown> {
  return { type: 'library.titles', titles: library.titles() };
}

let titlesSent = '';
function shareTitles(): void {
  const msg = libraryTitles();
  const key = JSON.stringify(msg.titles);
  if (key === titlesSent) return;
  titlesSent = key;
  server?.broadcast(msg);
}

function shareNotionConfig(): void {
  server?.broadcast(sharedNotionConfig());
}

function notionView(): SettingsView['notion'] {
  const cfg = config.get().notion;
  const state = notion.state;
  return {
    connected: Boolean(config.notionToken() && cfg.databaseId),
    share: cfg.share,
    workspace: cfg.workspace,
    databaseUrl: cfg.databaseUrl,
    autoSync: cfg.autoSync,
    syncing: state.syncing,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
  };
}

function settingsView(): SettingsView {
  const cfg = config.get();
  return {
    port: cfg.port,
    token: cfg.token,
    vault: library.path,
    openAtLogin: cfg.openAtLogin,
    closeToTray: cfg.closeToTray,
    theme: cfg.theme,
    onboarded: cfg.onboarded,
    notion: notionView(),
    version: app.getVersion(),
    platform: process.platform,
  };
}

function appStatus(): AppStatus {
  return {
    extension: { clients: server.clients, port: server.port, error: serverError, active: server.active },
    notion: notionView(),
    vault: library.path,
  };
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(`event:${channel}`, ...args);
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;
function pushStatus(): void {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    send('status', appStatus());
    updateTray();
  }, 50);
}

let libraryTimer: ReturnType<typeof setTimeout> | null = null;
function pushLibrary(): void {
  if (libraryTimer) return;
  libraryTimer = setTimeout(() => {
    libraryTimer = null;
    send('library');
    shareTitles();
  }, 80);
}

// --- Window & tray ----------------------------------------------------------------------------

function palette(): { bg: string; fg: string } {
  const theme = config.get().theme;
  const dark = theme === 'dark' || (theme === 'auto' && nativeTheme.shouldUseDarkColors);
  return dark ? { bg: '#141417', fg: '#ededf2' } : { bg: '#ffffff', fg: '#1d1d1f' };
}

function applyTheme(): void {
  const theme = config.get().theme;
  nativeTheme.themeSource = theme === 'auto' ? 'system' : theme;
  if (!win || win.isDestroyed()) return;
  const { bg, fg } = palette();
  win.setBackgroundColor(bg);
  if (process.platform !== 'darwin') {
    try {
      win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 44 });
    } catch {
      // No overlay on this platform.
    }
  }
}

function createWindow(show: boolean): void {
  const { bg, fg } = palette();
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 580,
    show: false,
    title: 'Boo Notes',
    icon: existsSync(ICON) ? ICON : undefined,
    backgroundColor: bg,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: bg, symbolColor: fg, height: 44 },
    webPreferences: {
      preload: join(DIST, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.setMenuBarVisibility(false);
  // Links open in the browser; the window never navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('boo://app/')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  win.once('ready-to-show', () => {
    if (show) win?.show();
  });
  win.on('close', (e) => {
    if (quitting || !config.get().closeToTray || E2E) return;
    e.preventDefault();
    win?.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({
        title: 'Boo Notes reste disponible',
        body: 'L’extension continue de synchroniser vos notes. Rouvrez Boo Notes depuis la zone de notification.',
        icon: existsSync(ICON) ? ICON : undefined,
      }).show();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  void win.loadURL('boo://app/index.html');
}

function showWindow(): void {
  if (!win) createWindow(true);
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function updateTray(): void {
  if (!tray) return;
  const clients = server.clients;
  const n = notionView();
  tray.setToolTip(`Boo Notes — ${clients ? 'extension connectée' : 'en attente de l’extension'}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir Boo Notes', click: showWindow },
      { type: 'separator' },
      {
        label: serverError ?? (clients ? `Extension connectée (${clients})` : 'Extension : en attente de connexion'),
        enabled: false,
      },
      { label: 'Copier le jeton d’appairage', click: () => clipboard.writeText(config.get().token) },
      {
        label: n.syncing ? 'Synchronisation Notion…' : 'Synchroniser avec Notion',
        enabled: n.connected && !n.syncing,
        click: () => void notion.syncAll().catch(() => undefined),
      },
      { type: 'separator' },
      {
        label: process.platform === 'darwin' ? 'Ouvrir à la connexion' : 'Lancer au démarrage de Windows',
        type: 'checkbox',
        checked: config.get().openAtLogin,
        click: (item) => void setSettings({ openAtLogin: item.checked }).then(() => send('status', appStatus())),
      },
      { label: 'Réglages…', click: () => (showWindow(), send('navigate', 'settings')) },
      { type: 'separator' },
      {
        label: 'Quitter Boo Notes',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  if (E2E || !existsSync(TRAY_ICON)) return;
  const image = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(image);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray();
}

function applyLoginItem(): void {
  if (E2E || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: config.get().openAtLogin, args: ['--hidden'] });
}

// --- Files opened with the app ("Ouvrir avec Boo Notes", drag onto the icon) -----------------

function filesFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-') && kindForFile(a) !== null && existsSync(a));
}

async function addFiles(paths: string[]): Promise<AddResult> {
  const added: ItemView[] = [];
  const errors: string[] = [];
  for (const p of paths) {
    try {
      added.push(view(await library.addLocalFile(p)));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { added, errors };
}

async function openFilesFromShell(paths: string[]): Promise<void> {
  if (!library) {
    pendingOpen.push(...paths);
    return;
  }
  const { added } = await addFiles(paths);
  showWindow();
  const last = added.at(-1);
  if (last) send('open-item', last.id);
}

app.on('second-instance', (_e, argv) => {
  const files = filesFromArgv(argv);
  if (files.length) void openFilesFromShell(files);
  else showWindow();
});

app.on('open-file', (e, path) => {
  e.preventDefault();
  void openFilesFromShell([path]);
});

// --- Settings -------------------------------------------------------------------------------

async function setSettings(patch: SettingsPatch): Promise<SettingsView> {
  const { notionAutoSync, notionShare, ...rest } = patch;
  const before = config.get();
  await config.update({
    ...rest,
    notion: {
      ...(notionAutoSync !== undefined ? { autoSync: notionAutoSync } : {}),
      ...(notionShare !== undefined ? { share: notionShare } : {}),
    },
  });
  if (notionShare !== undefined && notionShare !== before.notion.share) shareNotionConfig();
  if (rest.port !== undefined && rest.port !== before.port) {
    const port = Math.round(rest.port);
    if (!(port >= 1024 && port <= 65535)) throw new Error('Port invalide (1024 – 65535)');
    try {
      await server.restart(port);
      serverError = null;
    } catch (e) {
      serverError = e instanceof Error ? e.message : String(e);
    }
  }
  if (rest.openAtLogin !== undefined) applyLoginItem();
  if (rest.theme !== undefined) applyTheme();
  pushStatus();
  updateTray();
  return settingsView();
}

// --- IPC ------------------------------------------------------------------------------------

type Handler = (...args: never[]) => unknown;

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    // Only the app's own UI may call the main process.
    if (!event.senderFrame?.url.startsWith('boo://app/')) throw new Error('Origine refusée');
    return (fn as (...a: unknown[]) => unknown)(...args);
  });
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`${name} invalide`);
  return v;
};

function registerIpc(): void {
  handle(C.libraryList, () => library.list().map(view));
  handle(C.libraryGet, (id: string) => {
    const item = library.get(str(id, 'id'));
    return item ? view(item) : null;
  });
  handle(C.libraryOpenFiles, async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Ajouter des cours',
      buttonLabel: 'Ajouter',
      properties: ['openFile', 'multiSelections'],
      filters: OPEN_FILE_FILTERS,
    });
    return res.canceled ? { added: [], errors: [] } : addFiles(res.filePaths);
  });
  handle(C.libraryAddFiles, (paths: string[]) => addFiles((Array.isArray(paths) ? paths : []).map((p) => str(p, 'chemin'))));
  handle(C.libraryReadNote, (id: string) => library.readNote(str(id, 'id')));
  handle(C.librarySaveNote, async (id: string, markdown: string) => view(await library.saveNote(str(id, 'id'), str(markdown, 'note'))));
  handle(C.librarySetProgress, async (id: string, position: number, duration: number) => {
    await library.setProgress(str(id, 'id'), Number(position), Number(duration));
  });
  handle(C.libraryAddStudyTime, (id: string, ms: number) => library.addStudyTime(str(id, 'id'), Number(ms)));
  handle(C.librarySetHighlights, async (id: string, highlights: Highlight[]) =>
    view(await library.setHighlights(str(id, 'id'), Array.isArray(highlights) ? highlights : [])),
  );
  handle(C.libraryUpdate, async (id: string, patch: { title?: string; status?: StudyStatus | null }) =>
    view(await library.update(str(id, 'id'), patch ?? {})),
  );
  handle(C.libraryRemove, (id: string, deleteNote: boolean) => library.remove(str(id, 'id'), { deleteNote: Boolean(deleteNote) }));
  handle(C.libraryReadFile, async (id: string) => {
    const item = library.require(str(id, 'id'));
    if (item.origin !== 'desktop') throw new Error('Aucun fichier local');
    return new Uint8Array(await readFile(item.source));
  });
  handle(C.librarySaveCapture, async (id: string, dataUrl: string, seconds: number) => {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(str(dataUrl, 'image'));
    if (!m) throw new Error('Image invalide');
    const ext = m[1] === 'jpeg' ? 'jpg' : (m[1] as 'png' | 'webp');
    return library.saveCapture(str(id, 'id'), Buffer.from(m[2], 'base64'), Number(seconds) || 0, ext);
  });
  handle(C.libraryReveal, (id: string) => {
    shell.showItemInFolder(library.noteFilePath(library.require(str(id, 'id'))));
  });
  handle(C.libraryOpenSource, async (id: string, seconds?: number) => {
    const item = library.require(str(id, 'id'));
    if (item.origin === 'desktop') {
      shell.showItemInFolder(item.source);
      return;
    }
    const url = typeof seconds === 'number' ? timestampUrl(item.source, seconds) : item.source;
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
  });

  handle(C.libraryCreateNote, async (title: string, body?: string) =>
    view(await library.createNote(str(title, 'titre'), typeof body === 'string' ? body : '')),
  );
  handle(C.libraryFindByTitle, (title: string) => {
    const item = library.findByTitle(str(title, 'titre'));
    return item ? view(item) : null;
  });
  handle(C.libraryBacklinks, (id: string) => library.backlinks(str(id, 'id')).map(view));
  handle(C.libraryTitles, () => library.titles());
  handle(C.libraryReview, async (id: string, action: ReviewAction) => {
    if (!['start', 'stop', 'again', 'good', 'easy'].includes(action)) throw new Error('Action inconnue');
    return view(await library.review(str(id, 'id'), action));
  });
  handle(C.librarySetPins, async (id: string, pins: Pin[]) => {
    const clean = (Array.isArray(pins) ? pins : [])
      .filter((p) => Number.isFinite(p?.n) && Number.isFinite(p?.x) && Number.isFinite(p?.y))
      .map((p) => ({ n: Math.round(p.n), x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)), createdAt: Number(p.createdAt) || Date.now() }));
    return view(await library.setPins(str(id, 'id'), clean));
  });
  handle(C.libraryReadText, (id: string) => library.readText(str(id, 'id')));

  handle(C.notionConnect, async (token: string, target: string) => {
    const res = await notion.connect(str(token, 'jeton'), str(target, 'lien'));
    await config.setNotionToken(token.trim());
    await config.update({
      notion: {
        workspace: res.workspace,
        databaseId: res.databaseId,
        databaseUrl: res.url,
        // A page: the database is an inline table in it (re-created there if deleted).
        parentId: res.parentId,
      },
    });
    notion.reset();
    shareNotionConfig();
    pushStatus();
    if (config.get().notion.autoSync) void notion.syncAll().catch(() => undefined);
    return settingsView();
  });
  handle(C.notionDisconnect, async () => {
    await config.setNotionToken(null);
    await config.update({ notion: { databaseId: null, databaseUrl: null, parentId: null, workspace: null } });
    await library.clearNotion();
    notion.reset();
    shareNotionConfig();
    pushStatus();
    return settingsView();
  });
  handle(C.notionSyncItem, (id: string) => notion.syncItem(str(id, 'id')));
  handle(C.notionSyncAll, () => notion.syncAll());
  handle(C.notionOpen, async (id?: string) => {
    const url = id ? library.get(id)?.notion?.url : config.get().notion.databaseUrl;
    if (url && /^https:\/\//.test(url)) await shell.openExternal(url);
  });

  handle(C.settingsGet, () => settingsView());
  handle(C.settingsSet, (patch: SettingsPatch) => setSettings(patch ?? {}));
  handle(C.settingsRegenerateToken, async () => {
    await config.regenerateToken();
    server.disconnectAll();
    updateTray();
    return settingsView();
  });
  handle(C.settingsChooseVault, async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Dossier de notes',
      buttonLabel: 'Choisir ce dossier',
      defaultPath: library.path,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return settingsView();
    await config.update({ vault: res.filePaths[0] });
    await library.open(res.filePaths[0]);
    // The extension sends every note again, into the new folder.
    server.requestResync();
    pushStatus();
    return settingsView();
  });
  handle(C.settingsOpenVault, () => shell.openPath(library.path).then(() => undefined));
  handle(C.settingsCopy, (text: string) => clipboard.writeText(str(text, 'texte')));
  handle(C.settingsOpenExternal, async (url: string) => {
    if (/^https:\/\//.test(str(url, 'url'))) await shell.openExternal(url);
  });
  handle(C.status, () => appStatus());
}

// --- Boot -----------------------------------------------------------------------------------

async function boot(): Promise<void> {
  const box = secretBox();
  config = await ConfigStore.load(
    join(app.getPath('userData'), 'config.json'),
    process.env.BOO_VAULT ?? join(app.getPath('documents'), 'Boo Notes'),
    box,
  );
  // Tests / portable setups: fixed folder and port.
  if (process.env.BOO_VAULT && config.get().vault !== process.env.BOO_VAULT) await config.update({ vault: process.env.BOO_VAULT });
  if (process.env.BOO_PORT) await config.update({ port: Number(process.env.BOO_PORT) });
  library = new Library(config.get().vault);
  await library.open();

  notion = new NotionSync({
    library,
    getConfig: () => {
      const cfg = config.get().notion;
      return {
        token: config.notionToken(),
        parentId: cfg.parentId,
        databaseId: cfg.databaseId,
        autoSync: cfg.autoSync,
        apiBase: process.env.NOTION_API_BASE ?? cfg.apiBase,
      };
    },
    saveDatabase: async (databaseId, url) => {
      await config.update({ notion: { databaseId, databaseUrl: url } });
    },
    clientOptions: E2E ? { minIntervalMs: 0 } : undefined,
    debounceMs: E2E ? 300 : 6000,
    // The extension keeps the Notion mapping of its notes, to sync them itself while the app is closed.
    onSynced: (id) => {
      const link = library.get(id)?.notion;
      if (link) server?.broadcast({ type: 'notion.link', noteId: id, link });
    },
    log: (m) => console.log(`[boo] ${m}`),
  });
  notion.on('state', pushStatus);

  server = new ExtensionServer({
    library,
    port: config.get().port,
    getToken: () => config.get().token,
    app: { name: 'Boo Notes Desktop', version: app.getVersion() },
    onExport: async (noteId, target) => {
      if (target !== 'notion') return `Enregistré dans ${library.path}`;
      if (!notion.isConfigured()) {
        throw new Error('Notion n’est pas connecté : ouvrez Boo Notes › Réglages › Notion');
      }
      const job = notion.syncItem(noteId);
      const done = await Promise.race([job.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 20_000))]);
      return done ? 'Envoyé vers Notion' : 'Envoi vers Notion en cours…';
    },
    onOpen: (title) => {
      showWindow();
      send('open-title', title);
    },
    welcomeExtras: () => [sharedNotionConfig(), libraryTitles()],
    log: (m) => console.log(`[boo] ${m}`),
  });
  server.on('clients', pushStatus);
  server.on('active', pushStatus);
  try {
    await server.start(config.get().port);
  } catch (e) {
    serverError = e instanceof Error ? e.message : String(e);
  }
  library.on('changed', pushLibrary);

  handleScheme(join(DIST, 'renderer'), () => library);
  registerIpc();
  applyTheme();
  nativeTheme.on('updated', applyTheme);
  createWindow(!process.argv.includes('--hidden'));
  createTray();
  applyLoginItem();

  const files = [...filesFromArgv(process.argv), ...pendingOpen.splice(0)];
  if (files.length) {
    const { added } = await addFiles(files);
    win?.webContents.once('did-finish-load', () => {
      const last = added.at(-1);
      if (last) send('open-item', last.id);
    });
  }
}

app.whenReady().then(boot).catch((e: unknown) => {
  dialog.showErrorBox('Boo Notes', `Démarrage impossible : ${e instanceof Error ? e.message : String(e)}`);
  app.exit(1);
});

app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  // With the tray, the app keeps running (and syncing) in the background.
  if (!tray || E2E) app.quit();
});
app.on('will-quit', () => {
  notion?.dispose();
  void server?.stop();
});
