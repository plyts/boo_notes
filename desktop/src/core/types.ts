import type { MediaKind, Platform } from '../../../src/shared/platforms';

export type { MediaKind, Platform };

/** Where the note is written: in the browser extension, or in this app (local files). */
export type ItemOrigin = 'extension' | 'desktop';

/** Study status shown in the library and mirrored in Notion. */
export type StudyStatus = 'todo' | 'doing' | 'done';

export const STATUS_LABELS: Record<StudyStatus, string> = {
  todo: 'À commencer',
  doing: 'En cours',
  done: 'Terminé',
};

/**
 * Reading / listening position. Media: seconds. PDF: `position` is the page
 * being read and `duration` the page count.
 */
export interface Progress {
  position: number;
  duration: number;
  updatedAt: number;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

/** A passage highlighted in a PDF. Rects are fractions of the page size (0..1). */
export interface Highlight {
  id: string;
  page: number;
  rects: Array<[x: number, y: number, w: number, h: number]>;
  text: string;
  color: HighlightColor;
  createdAt: number;
}

export interface NotionBlockRef {
  id: string;
  hash: string;
}

/** Mirror of an item in the Notion course database. */
export interface NotionLink {
  pageId: string;
  url?: string;
  /** Top-level blocks written by Boo Notes, in order (incremental sync). */
  blocks: NotionBlockRef[];
  syncedAt: number;
  /** Library revision of the last successful content sync. */
  syncedRev: number;
  error?: string | null;
}

export interface LibraryItem {
  /** Note id: `youtube:…`, `notion:…`, `web:…` (extension) or `file:…` (local file). */
  id: string;
  origin: ItemOrigin;
  kind: MediaKind;
  platform: Platform;
  title: string;
  /** Page URL, or absolute path of the local file. */
  source: string;
  /** Markdown file, relative to the vault. */
  noteFile: string;
  /** Extension revision, or local save counter. */
  rev: number;
  createdAt: number;
  updatedAt: number;
  progress?: Progress;
  /** Furthest point reached (seconds, or page for a PDF): the course coverage. */
  furthest?: number;
  /** Time spent with the item open in the app (ms). */
  studyMs?: number;
  highlights?: Highlight[];
  /** Manual status; derived from the progress when absent. */
  status?: StudyStatus;
  /** Timestamps / page references in the note (library cards, Notion "Notes" column). */
  noteCount?: number;
  notion?: NotionLink;
}

/** Note as sent by the extension (`note.upsert`). */
export interface ExtensionNote {
  id: string;
  platform: Platform;
  kind?: MediaKind;
  url: string;
  title: string;
  markdown: string;
  createdAt: number;
  updatedAt: number;
  rev: number;
}

export interface ActivePlayer {
  noteId: string;
  title: string;
  url: string;
}
