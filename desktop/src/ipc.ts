/**
 * Contract between the renderer (UI) and the main process, exposed by the
 * preload script as `window.boo`. Everything crossing it is plain data.
 */
import type { Theme } from './core/config';
import type { ExportOptions, ExportResult } from './core/export';
import type {
  ActivePlayer,
  Chapter,
  Course,
  Highlight,
  MediaEntry,
  Pin,
  Placement,
  ResourceKind,
  ReviewAction,
  StudyStatus,
  TranscriptSummary,
} from './core/types';
import type { CuePatch, Transcript } from '../../src/shared/transcript';
import type { CourseView, LibrarySnapshot, NoteView, ResourceView } from './core/views';

export type {
  ActivePlayer,
  Chapter,
  Course,
  CourseView,
  ExportOptions,
  ExportResult,
  Highlight,
  CuePatch,
  LibrarySnapshot,
  MediaEntry,
  NoteView,
  Transcript,
  TranscriptSummary,
  Pin,
  Placement,
  ResourceKind,
  ResourceView,
  ReviewAction,
  StudyStatus,
  Theme,
};

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

export interface ImportResult {
  /** A note per imported file (its existing note when the file was already there). */
  notes: NoteView[];
  errors: string[];
}

export interface NoteInput {
  title: string;
  body?: string;
  resources?: string[];
  placement?: Placement & { index?: number };
}

export interface BooApi {
  platform: string;
  /** A system material (Mica, vibrancy) shows through the window: the canvas stays translucent. */
  material: boolean;
  library: {
    /** Courses, notes and resources, with their derived state. */
    snapshot(): Promise<LibrarySnapshot>;

    // Notes
    readNote(id: string): Promise<string>;
    saveNote(id: string, markdown: string): Promise<void>;
    createNote(input: NoteInput): Promise<NoteView>;
    /** The note a `[[Titre]]` points to, created as a revision sheet when missing. */
    ensureNote(title: string): Promise<NoteView>;
    updateNote(id: string, patch: { title?: string; status?: StudyStatus | null }): Promise<void>;
    removeNote(id: string, deleteFile: boolean): Promise<void>;
    linkResource(noteId: string, resourceId: string, index?: number): Promise<void>;
    unlinkResource(noteId: string, resourceId: string): Promise<void>;
    setPrimaryResource(noteId: string, resourceId: string): Promise<void>;
    review(noteId: string, action: ReviewAction): Promise<void>;
    /** Files a note in a chapter (at `index`), or unfiles it. */
    placeNote(noteId: string, dest: (Placement & { index?: number }) | null): Promise<void>;
    /** Shows the Markdown file in the file explorer. */
    revealNote(id: string): Promise<void>;

    // Resources
    /** File picker: each file becomes a resource with its note, filed in `placement`. */
    openFiles(placement?: Placement): Promise<ImportResult>;
    importFiles(paths: string[], placement?: Placement): Promise<ImportResult>;
    /** File picker: resources only (to link them to an existing note). */
    pickResources(): Promise<{ resources: ResourceView[]; errors: string[] }>;
    /** A stream (direct media, HLS), a remote PDF / image, or a web page. */
    addUrl(url: string, opts?: { title?: string; kind?: ResourceKind }): Promise<ResourceView>;
    updateResource(id: string, patch: { title?: string; status?: StudyStatus | null }): Promise<void>;
    removeResource(id: string): Promise<void>;
    /** Bytes of a PDF (local or remote). */
    readFile(resourceId: string): Promise<Uint8Array>;
    /** Content of a local text document. */
    readText(resourceId: string): Promise<string>;
    setProgress(resourceId: string, position: number, duration: number): Promise<void>;
    addStudyTime(resourceId: string, ms: number): Promise<void>;
    setHighlights(resourceId: string, highlights: Highlight[]): Promise<void>;
    setPins(resourceId: string, pins: Pin[]): Promise<void>;
    /** Screenshot of a video (JPEG data URL): returns the `assets/…` path. */
    saveCapture(resourceId: string, dataUrl: string, seconds: number): Promise<string>;
    /** Opens the resource where it lives: the page in the browser (at `seconds`), or the file in the explorer. */
    openSource(resourceId: string, seconds?: number): Promise<void>;

    // Transcript (subtitles) and recordings
    transcript(noteId: string): Promise<Transcript | null>;
    annotateTranscript(noteId: string, patches: CuePatch[], langs?: { lang?: string; target?: string }): Promise<Transcript>;
    /** Asks for a .vtt / .srt file: it becomes the note's transcript (null: cancelled). */
    importSubtitles(noteId: string): Promise<Transcript | null>;
    /** A passage extract recorded in the app (WebM bytes): returns its `media/…` path. */
    saveMedia(noteId: string, entry: { kind: 'passage' | 'audio'; mime: string; start: number; end: number }, bytes: Uint8Array): Promise<string>;

    // Courses and chapters
    createCourse(input: { title: string; emoji?: string; hue?: number; description?: string }): Promise<Course>;
    updateCourse(id: string, patch: { title?: string; emoji?: string; hue?: number; description?: string }): Promise<void>;
    removeCourse(id: string): Promise<void>;
    moveCourse(id: string, index: number): Promise<void>;
    addChapter(courseId: string, title?: string, index?: number): Promise<Chapter>;
    updateChapter(courseId: string, chapterId: string, patch: { title?: string }): Promise<void>;
    removeChapter(courseId: string, chapterId: string): Promise<void>;
    moveChapter(courseId: string, chapterId: string, index: number): Promise<void>;
  };
  export: {
    /** Asks for a folder, then writes the chosen formats there. */
    run(options: ExportOptions): Promise<ExportResult | null>;
  };
  notion: {
    connect(token: string, target: string): Promise<SettingsView>;
    disconnect(): Promise<SettingsView>;
    syncItem(id: string): Promise<{ url: string | null }>;
    syncAll(): Promise<{ ok: number; failed: number }>;
    /** Opens the note page (or the notes table) in Notion. */
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
  /** `library`: data changed; `status`: connections changed; `open-note`: a file was opened with the app. */
  on(event: 'library', cb: () => void): () => void;
  on(event: 'status', cb: (status: AppStatus) => void): () => void;
  on(event: 'open-note', cb: (id: string) => void): () => void;
  on(event: 'navigate', cb: (view: 'settings' | 'library') => void): () => void;
  /** The browser asked to open a note (`[[Titre]]` clicked in the extension). */
  on(event: 'open-title', cb: (title: string) => void): () => void;
  /** Absolute path of a dropped file. */
  pathForFile(file: File): string;
}

export const CHANNELS = {
  snapshot: 'library:snapshot',
  readNote: 'note:read',
  saveNote: 'note:save',
  createNote: 'note:create',
  ensureNote: 'note:ensure',
  updateNote: 'note:update',
  removeNote: 'note:remove',
  linkResource: 'note:link-resource',
  unlinkResource: 'note:unlink-resource',
  setPrimaryResource: 'note:set-primary',
  review: 'note:review',
  placeNote: 'note:place',
  revealNote: 'note:reveal',
  openFiles: 'resource:open-files',
  importFiles: 'resource:import-files',
  pickResources: 'resource:pick',
  addUrl: 'resource:add-url',
  updateResource: 'resource:update',
  removeResource: 'resource:remove',
  readFile: 'resource:read-file',
  readText: 'resource:read-text',
  setProgress: 'resource:set-progress',
  addStudyTime: 'resource:add-study-time',
  setHighlights: 'resource:set-highlights',
  setPins: 'resource:set-pins',
  saveCapture: 'resource:save-capture',
  openSource: 'resource:open-source',
  transcript: 'note:transcript',
  annotateTranscript: 'note:annotate-transcript',
  importSubtitles: 'note:import-subtitles',
  saveMedia: 'note:save-media',
  createCourse: 'course:create',
  updateCourse: 'course:update',
  removeCourse: 'course:remove',
  moveCourse: 'course:move',
  addChapter: 'chapter:add',
  updateChapter: 'chapter:update',
  removeChapter: 'chapter:remove',
  moveChapter: 'chapter:move',
  exportRun: 'export:run',
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
