import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { release } from 'node:os';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  safeStorage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import { noteSlug, timestampUrl } from '../../../src/shared/platforms';
import { formatTimecode } from '../../../src/shared/time';
import type { CuePatch } from '../../../src/shared/transcript';
import { ConfigStore, plainBox, type SecretBox } from '../core/config';
import { writeExport, type ExportFormat, type ExportOptions } from '../core/export';
import { kindForFile, Library, OPEN_FILE_FILTERS } from '../core/library';
import { NotionSync } from '../core/notion/sync';
import { ExtensionServer } from '../core/server';
import type { Highlight, Pin, Placement, ResourceKind, ReviewAction, StudyStatus } from '../core/types';
import { noteView, resourceView, snapshot } from '../core/views';
import { CHANNELS as C, type AppStatus, type ImportResult, type NoteInput, type SettingsPatch, type SettingsView } from '../ipc';
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

/** Courses and chapters, offered by the extension to file a note. */
function libraryCourses(): Record<string, unknown> {
  return {
    type: 'library.courses',
    courses: library.listCourses().map((c) => ({ title: c.title, emoji: c.emoji, chapters: c.chapters.map((ch) => ch.title) })),
  };
}

const sent = new Map<string, string>();
/** Sends a library message to the extensions when it changed. */
function share(msg: Record<string, unknown>): void {
  const key = JSON.stringify(msg);
  if (sent.get(String(msg.type)) === key) return;
  sent.set(String(msg.type), key);
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
    share(libraryTitles());
    share(libraryCourses());
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
  const material = hasMica() || process.platform === 'darwin';
  win.setBackgroundColor(material ? '#00000000' : bg);
  if (process.platform !== 'darwin') {
    try {
      win.setTitleBarOverlay({ color: material ? '#00000000' : bg, symbolColor: fg, height: 44 });
    } catch {
      // No overlay on this platform.
    }
  }
}

/** Windows 11 (build 22621+): the Mica material shows the desktop through the window, like macOS vibrancy. */
function hasMica(): boolean {
  return process.platform === 'win32' && Number(release().split('.')[2] ?? 0) >= 22621;
}

function createWindow(show: boolean): void {
  const { bg, fg } = palette();
  // A translucent system material under the UI: Liquid Glass surfaces refract it.
  const material = hasMica() || process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 580,
    show: false,
    title: 'Boo Notes',
    icon: existsSync(ICON) ? ICON : undefined,
    backgroundColor: material ? '#00000000' : bg,
    ...(hasMica() ? { backgroundMaterial: 'mica' as const } : {}),
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: material ? '#00000000' : bg, symbolColor: fg, height: 44 },
    webPreferences: {
      preload: join(DIST, 'preload.cjs'),
      additionalArguments: material ? ['--boo-material'] : [],
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

async function importFiles(paths: string[], placement?: Placement): Promise<ImportResult> {
  const { notes, errors } = await library.importFiles(paths, placement);
  return { notes: notes.map((n) => noteView(library, n)), errors };
}

async function openFilesFromShell(paths: string[]): Promise<void> {
  if (!library) {
    pendingOpen.push(...paths);
    return;
  }
  const { notes } = await importFiles(paths);
  showWindow();
  const last = notes.at(-1);
  if (last) send('open-note', last.id);
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
  const placement = (v: unknown): (Placement & { index?: number }) | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const p = v as Record<string, unknown>;
    return {
      courseId: str(p.courseId, 'cours'),
      chapterId: str(p.chapterId, 'chapitre'),
      ...(typeof p.index === 'number' ? { index: p.index } : {}),
    };
  };
  const status = (v: unknown): StudyStatus | null | undefined =>
    v === null ? null : v === 'todo' || v === 'doing' || v === 'done' ? v : undefined;

  handle(C.snapshot, () => snapshot(library));

  // Notes
  handle(C.readNote, (id: string) => library.readNote(str(id, 'id')));
  handle(C.saveNote, async (id: string, markdown: string) => {
    await library.saveNote(str(id, 'id'), str(markdown, 'note'));
  });
  handle(C.createNote, async (input: NoteInput) => {
    const note = await library.createNote({
      title: str(input?.title ?? '', 'titre'),
      body: typeof input?.body === 'string' ? input.body : '',
      resources: Array.isArray(input?.resources) ? input.resources.map((r) => str(r, 'support')) : [],
      placement: placement(input?.placement),
    });
    return noteView(library, note);
  });
  handle(C.ensureNote, async (title: string) => noteView(library, await library.ensureNote(str(title, 'titre'))));
  handle(C.updateNote, async (id: string, patch: { title?: string; status?: StudyStatus | null }) => {
    await library.updateNote(str(id, 'id'), { title: typeof patch?.title === 'string' ? patch.title : undefined, status: status(patch?.status) });
  });
  handle(C.removeNote, (id: string, deleteFile: boolean) => library.removeNote(str(id, 'id'), { deleteFile: Boolean(deleteFile) }));
  handle(C.linkResource, async (noteId: string, resourceId: string, index?: number) => {
    await library.linkResource(str(noteId, 'note'), str(resourceId, 'support'), typeof index === 'number' ? index : undefined);
  });
  handle(C.unlinkResource, async (noteId: string, resourceId: string) => {
    await library.unlinkResource(str(noteId, 'note'), str(resourceId, 'support'));
  });
  handle(C.setPrimaryResource, async (noteId: string, resourceId: string) => {
    await library.setPrimaryResource(str(noteId, 'note'), str(resourceId, 'support'));
  });
  handle(C.review, async (id: string, action: ReviewAction) => {
    if (!['start', 'stop', 'again', 'good', 'easy'].includes(action)) throw new Error('Action inconnue');
    await library.review(str(id, 'id'), action);
  });
  handle(C.placeNote, (id: string, dest: unknown) => library.placeNote(str(id, 'id'), dest === null ? null : (placement(dest) ?? null)));
  handle(C.revealNote, (id: string) => {
    shell.showItemInFolder(library.noteFilePath(library.requireNote(str(id, 'id'))));
  });

  // Resources
  handle(C.openFiles, async (where?: Placement) => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Ajouter des supports de cours',
      buttonLabel: 'Ajouter',
      properties: ['openFile', 'multiSelections'],
      filters: OPEN_FILE_FILTERS,
    });
    return res.canceled ? { notes: [], errors: [] } : importFiles(res.filePaths, placement(where));
  });
  handle(C.importFiles, (paths: string[], where?: Placement) =>
    importFiles((Array.isArray(paths) ? paths : []).map((p) => str(p, 'chemin')), placement(where)),
  );
  handle(C.pickResources, async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Lier des supports à la note',
      buttonLabel: 'Lier',
      properties: ['openFile', 'multiSelections'],
      filters: OPEN_FILE_FILTERS,
    });
    const resources = [];
    const errors: string[] = [];
    if (!res.canceled) {
      for (const p of res.filePaths) {
        try {
          resources.push(resourceView(library, await library.addFile(p)));
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
    }
    return { resources, errors };
  });
  handle(C.addUrl, async (url: string, opts?: { title?: string; kind?: ResourceKind }) => {
    const kinds: ResourceKind[] = ['video', 'audio', 'pdf', 'text', 'image', 'page'];
    const kind = opts?.kind && kinds.includes(opts.kind) ? opts.kind : undefined;
    return resourceView(library, await library.addUrl(str(url, 'adresse'), { title: typeof opts?.title === 'string' ? opts.title : undefined, kind }));
  });
  handle(C.updateResource, async (id: string, patch: { title?: string; status?: StudyStatus | null }) => {
    await library.updateResource(str(id, 'id'), { title: typeof patch?.title === 'string' ? patch.title : undefined, status: status(patch?.status) });
  });
  handle(C.removeResource, (id: string) => library.removeResource(str(id, 'id')));
  handle(C.readFile, async (id: string) => {
    const res = library.requireResource(str(id, 'id'));
    if (res.origin === 'file') return new Uint8Array(await readFile(res.source));
    if (res.origin === 'url') {
      const r = await net.fetch(res.source);
      if (!r.ok) throw new Error(`Téléchargement impossible (${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    }
    throw new Error('Ce support s’ouvre dans le navigateur');
  });
  handle(C.readText, (id: string) => library.readText(str(id, 'id')));
  handle(C.setProgress, async (id: string, position: number, duration: number) => {
    await library.setProgress(str(id, 'id'), Number(position), Number(duration));
  });
  handle(C.addStudyTime, (id: string, ms: number) => library.addStudyTime(str(id, 'id'), Number(ms)));
  handle(C.setHighlights, async (id: string, highlights: Highlight[]) => {
    await library.setHighlights(str(id, 'id'), Array.isArray(highlights) ? highlights : []);
  });
  handle(C.setPins, async (id: string, pins: Pin[]) => {
    const clean = (Array.isArray(pins) ? pins : [])
      .filter((p) => Number.isFinite(p?.n) && Number.isFinite(p?.x) && Number.isFinite(p?.y))
      .map((p) => ({ n: Math.round(p.n), x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)), createdAt: Number(p.createdAt) || Date.now() }));
    await library.setPins(str(id, 'id'), clean);
  });
  handle(C.saveCapture, async (id: string, dataUrl: string, seconds: number) => {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(str(dataUrl, 'image'));
    if (!m) throw new Error('Image invalide');
    const ext = m[1] === 'jpeg' ? 'jpg' : (m[1] as 'png' | 'webp');
    return library.saveCapture(str(id, 'id'), Buffer.from(m[2], 'base64'), Number(seconds) || 0, ext);
  });
  handle(C.transcript, (noteId: string) => library.getTranscript(str(noteId, 'id')));
  handle(C.annotateTranscript, (noteId: string, patches: CuePatch[], langs?: { lang?: string; target?: string }) =>
    library.annotateTranscript(
      str(noteId, 'id'),
      (Array.isArray(patches) ? patches : [])
        .filter((p) => p && typeof p.id === 'string')
        .map((p) => ({
          id: p.id,
          ...(typeof p.tr === 'string' || p.tr === null ? { tr: p.tr } : {}),
          ...(typeof p.note === 'string' || p.note === null ? { note: p.note } : {}),
        })),
      { lang: typeof langs?.lang === 'string' ? langs.lang : undefined, target: typeof langs?.target === 'string' ? langs.target : undefined },
    ),
  );
  handle(C.importSubtitles, async (noteId: string) => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Ajouter des sous-titres à la note',
      buttonLabel: 'Ajouter',
      properties: ['openFile'],
      filters: [{ name: 'Sous-titres', extensions: ['vtt', 'srt'] }],
    });
    return res.canceled || !res.filePaths[0] ? null : library.importSubtitles(str(noteId, 'id'), res.filePaths[0]);
  });
  handle(C.saveMedia, async (noteId: string, entry: { kind: string; mime: string; start: number; end: number }, bytes: Uint8Array) => {
    const id = str(noteId, 'id');
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Enregistrement vide');
    const mime = str(entry?.mime, 'type').split(';')[0];
    const nonce = randomBytes(3).toString('hex');
    const ext = mime.includes('ogg') ? 'ogg' : 'webm';
    const start = Number(entry.start) || 0;
    const path = `media/${noteSlug(id)}-${entry.kind === 'audio' ? 'audio' : 'passage'}-${formatTimecode(start).replace(/:/g, '-')}-${nonce}.${ext}`;
    await library.putMedia(id, { path, kind: entry.kind === 'audio' ? 'audio' : 'passage', mime, start, end: Number(entry.end) || 0 }, Buffer.from(bytes));
    return path;
  });
  handle(C.openSource, async (id: string, seconds?: number) => {
    const res = library.requireResource(str(id, 'id'));
    if (res.origin === 'file') {
      shell.showItemInFolder(res.source);
      return;
    }
    const url = typeof seconds === 'number' && res.origin === 'extension' ? timestampUrl(res.source, seconds) : res.source;
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
  });

  // Courses and chapters
  handle(C.createCourse, (input: { title: string; emoji?: string; hue?: number; description?: string }) =>
    library.createCourse({
      title: str(input?.title ?? '', 'titre'),
      emoji: typeof input?.emoji === 'string' ? input.emoji : undefined,
      hue: typeof input?.hue === 'number' ? input.hue : undefined,
      description: typeof input?.description === 'string' ? input.description : undefined,
    }),
  );
  handle(C.updateCourse, async (id: string, patch: { title?: string; emoji?: string; hue?: number; description?: string }) => {
    await library.updateCourse(str(id, 'id'), {
      title: typeof patch?.title === 'string' ? patch.title : undefined,
      emoji: typeof patch?.emoji === 'string' ? patch.emoji : undefined,
      hue: typeof patch?.hue === 'number' ? patch.hue : undefined,
      description: typeof patch?.description === 'string' ? patch.description : undefined,
    });
  });
  handle(C.removeCourse, (id: string) => library.removeCourse(str(id, 'id')));
  handle(C.moveCourse, (id: string, index: number) => library.moveCourse(str(id, 'id'), Number(index) || 0));
  handle(C.addChapter, (courseId: string, title?: string, index?: number) =>
    library.addChapter(str(courseId, 'cours'), typeof title === 'string' ? title : undefined, typeof index === 'number' ? index : undefined),
  );
  handle(C.updateChapter, async (courseId: string, chapterId: string, patch: { title?: string }) => {
    await library.updateChapter(str(courseId, 'cours'), str(chapterId, 'chapitre'), { title: typeof patch?.title === 'string' ? patch.title : undefined });
  });
  handle(C.removeChapter, (courseId: string, chapterId: string) => library.removeChapter(str(courseId, 'cours'), str(chapterId, 'chapitre')));
  handle(C.moveChapter, (courseId: string, chapterId: string, index: number) =>
    library.moveChapter(str(courseId, 'cours'), str(chapterId, 'chapitre'), Number(index) || 0),
  );

  // Export
  handle(C.exportRun, async (opts: ExportOptions) => {
    const formats = (Array.isArray(opts?.formats) ? opts.formats : []).filter((f): f is ExportFormat =>
      ['markdown', 'sheets', 'cards', 'json'].includes(f),
    );
    if (!formats.length) throw new Error('Choisissez au moins un format');
    const target = process.env.BOO_EXPORT_DIR
      ? process.env.BOO_EXPORT_DIR
      : (
          await dialog.showOpenDialog(win!, {
            title: 'Exporter mes cours',
            buttonLabel: 'Exporter ici',
            properties: ['openDirectory', 'createDirectory'],
          })
        ).filePaths[0];
    if (!target) return null;
    const folder = join(target, `Boo Notes — export ${new Date().toISOString().slice(0, 10)}`);
    const result = await writeExport(library, folder, {
      formats,
      courses: Array.isArray(opts?.courses) ? opts.courses.map((c) => str(c, 'cours')) : undefined,
      includeUnfiled: opts?.includeUnfiled,
    });
    if (result.sheetsHtml) {
      try {
        result.files.push(await printToPdf(result.sheetsHtml, join(folder, 'Fiches de révision.pdf')));
      } catch (e) {
        result.warnings.push(`PDF des fiches impossible : ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!process.env.BOO_EXPORT_DIR) void shell.openPath(folder);
    const { sheetsHtml: _sheets, ...rest } = result;
    return rest;
  });

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
    const url = id ? library.getNote(id)?.notion?.url : config.get().notion.databaseUrl;
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

/** Revision sheets as a PDF (A4), rendered by an offscreen window. */
async function printToPdf(htmlPath: string, pdfPath: string): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await pdfWin.loadURL(pathToFileURL(htmlPath).href);
    const data = await pdfWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.5, right: 0.5 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font:9px -apple-system,Segoe UI,sans-serif;color:#888;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    await writeFile(pdfPath, data);
    return 'Fiches de révision.pdf';
  } finally {
    pdfWin.destroy();
  }
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
      const link = library.getNote(id)?.notion;
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
    welcomeExtras: () => [sharedNotionConfig(), libraryTitles(), libraryCourses()],
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
    const { notes } = await importFiles(files);
    win?.webContents.once('did-finish-load', () => {
      const last = notes.at(-1);
      if (last) send('open-note', last.id);
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
