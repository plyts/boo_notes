/**
 * Contract between the renderer (UI) and the main process, exposed by the
 * preload script as `window.boo`. Everything crossing it is plain data.
 */
import type { Theme } from './core/config';
import type { ActivePlayer, Highlight, LibraryItem, Pin, ReviewAction, StudyStatus } from './core/types';

export type { ActivePlayer, Highlight, LibraryItem, Pin, ReviewAction, StudyStatus, Theme };

/** A library item as displayed: derived status, progress and position label included. */
export interface ItemView extends LibraryItem {
  studyStatus: StudyStatus;
  /** 0..1 */
  ratio: number;
  positionLabel: string;
  /** A review is due today. */
  due: boolean;
}

export interface NotionView {
  connected: boolean;
  /** The Notion connection is shared with the paired extensions (sync while the app is closed). */
  share: boolean;
  workspace: string | null;
  databaseUrl: string | null;
  autoSync: boolean;
  syncing: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface AppStatus {
  extension: { clients: number; port: number; error: string | null; active: ActivePlayer | null };
  notion: NotionView;
  vault: string;
}

export interface SettingsView {
  port: number;
  token: string;
  vault: string;
  openAtLogin: boolean;
  closeToTray: boolean;
  theme: Theme;
  onboarded: boolean;
  notion: NotionView;
  version: string;
  platform: string;
}

export type SettingsPatch = Partial<Pick<SettingsView, 'port' | 'openAtLogin' | 'closeToTray' | 'theme' | 'onboarded'>> & {
  notionAutoSync?: boolean;
  notionShare?: boolean;
};

export interface AddResult {
  added: ItemView[];
  errors: string[];
}

export interface BooApi {
  platform: string;
  library: {
    list(): Promise<ItemView[]>;
    get(id: string): Promise<ItemView | null>;
    /** File picker (PDF, audio, video). */
    openFiles(): Promise<AddResult>;
    addFiles(paths: string[]): Promise<AddResult>;
    readNote(id: string): Promise<string>;
    saveNote(id: string, markdown: string): Promise<ItemView>;
    setProgress(id: string, position: number, duration: number): Promise<void>;
    addStudyTime(id: string, ms: number): Promise<void>;
    setHighlights(id: string, highlights: Highlight[]): Promise<ItemView>;
    update(id: string, patch: { title?: string; status?: StudyStatus | null }): Promise<ItemView>;
    remove(id: string, deleteNote: boolean): Promise<void>;
    /** Bytes of a local PDF. */
    readFile(id: string): Promise<Uint8Array>;
    /** Screenshot of a local video (JPEG data URL): returns the `assets/…` path. */
    saveCapture(id: string, dataUrl: string, seconds: number): Promise<string>;
    /** Shows the Markdown file in the file explorer. */
    reveal(id: string): Promise<void>;
    /** Opens the course page in the browser, at `seconds` when given. */
    openSource(id: string, seconds?: number): Promise<void>;
    /** New revision sheet (or the existing note with this title). */
    createNote(title: string, body?: string): Promise<ItemView>;
    /** The note a `[[Titre]]` points to. */
    findByTitle(title: string): Promise<ItemView | null>;
    /** Notes linking to this one. */
    backlinks(id: string): Promise<ItemView[]>;
    /** Every note title (`[[` completion). */
    titles(): Promise<string[]>;
    review(id: string, action: ReviewAction): Promise<ItemView>;
    setPins(id: string, pins: Pin[]): Promise<ItemView>;
    /** Content of a local text document. */
    readText(id: string): Promise<string>;
  };
  notion: {
    connect(token: string, target: string): Promise<SettingsView>;
    disconnect(): Promise<SettingsView>;
    syncItem(id: string): Promise<{ url: string | null }>;
    syncAll(): Promise<{ ok: number; failed: number }>;
    /** Opens the item page (or the database) in Notion. */
    open(id?: string): Promise<void>;
  };
  settings: {
    get(): Promise<SettingsView>;
    set(patch: SettingsPatch): Promise<SettingsView>;
    regenerateToken(): Promise<SettingsView>;
    chooseVault(): Promise<SettingsView>;
    openVault(): Promise<void>;
    copy(text: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  status(): Promise<AppStatus>;
  /** `library`: items changed; `status`: connections changed; `open-item`: a file was opened with the app. */
  on(event: 'library', cb: () => void): () => void;
  on(event: 'status', cb: (status: AppStatus) => void): () => void;
  on(event: 'open-item', cb: (id: string) => void): () => void;
  on(event: 'navigate', cb: (view: 'settings' | 'library') => void): () => void;
  /** The browser asked to open a note (`[[Titre]]` clicked in the extension). */
  on(event: 'open-title', cb: (title: string) => void): () => void;
  /** Absolute path of a dropped file. */
  pathForFile(file: File): string;
}

export const CHANNELS = {
  libraryList: 'library:list',
  libraryGet: 'library:get',
  libraryOpenFiles: 'library:open-files',
  libraryAddFiles: 'library:add-files',
  libraryReadNote: 'library:read-note',
  librarySaveNote: 'library:save-note',
  librarySetProgress: 'library:set-progress',
  libraryAddStudyTime: 'library:add-study-time',
  librarySetHighlights: 'library:set-highlights',
  libraryUpdate: 'library:update',
  libraryRemove: 'library:remove',
  libraryReadFile: 'library:read-file',
  librarySaveCapture: 'library:save-capture',
  libraryReveal: 'library:reveal',
  libraryOpenSource: 'library:open-source',
  libraryCreateNote: 'library:create-note',
  libraryFindByTitle: 'library:find-by-title',
  libraryBacklinks: 'library:backlinks',
  libraryTitles: 'library:titles',
  libraryReview: 'library:review',
  librarySetPins: 'library:set-pins',
  libraryReadText: 'library:read-text',
  notionConnect: 'notion:connect',
  notionDisconnect: 'notion:disconnect',
  notionSyncItem: 'notion:sync-item',
  notionSyncAll: 'notion:sync-all',
  notionOpen: 'notion:open',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsRegenerateToken: 'settings:regenerate-token',
  settingsChooseVault: 'settings:choose-vault',
  settingsOpenVault: 'settings:open-vault',
  settingsCopy: 'settings:copy',
  settingsOpenExternal: 'settings:open-external',
  status: 'app:status',
} as const;

declare global {
  interface Window {
    boo: BooApi;
  }
}
