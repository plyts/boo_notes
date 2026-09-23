import type { MediaKind, Platform } from '../../../src/shared/platforms';

export type { MediaKind, Platform };

/** Where the note is written: in the browser extension, or in this app (local files). */
export type ItemOrigin = 'extension' | 'desktop';

export { STATUS_LABELS, type StudyStatus } from '../../../src/shared/study';
import type { StudyStatus } from '../../../src/shared/study';

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

/** A numbered pin placed on an image (graph, diagram…). Coordinates are fractions of the image (0..1). */
export interface Pin {
  n: number;
  x: number;
  y: number;
  createdAt: number;
}

/** Spaced repetition of a revision sheet: next review date and current interval. */
export interface Review {
  /** Due date (ms). */
  next: number;
  /** Current interval (days). */
  interval: number;
  /** Successful reviews in a row. */
  count: number;
  last?: number;
}

export type ReviewAction = 'start' | 'stop' | 'again' | 'good' | 'easy';

export type { NotionBlockRef, NotionLink } from '../../../src/shared/notion/engine';
import type { NotionLink } from '../../../src/shared/notion/engine';

export interface LibraryItem {
  /** Note id: `youtube:…`, `notion:…`, `web:…` (extension), `file:…` (local file) or `note:…` (revision sheet). */
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
  pins?: Pin[];
  /** Titles linked from the note with `[[Titre]]`. */
  links?: string[];
  /** Length of the note (characters), for revision sheets without anchors. */
  size?: number;
  review?: Review;
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
  /** Notion page written by the extension itself (while the app was closed). */
  notion?: NotionLink;
}

export interface ActivePlayer {
  noteId: string;
  title: string;
  url: string;
}
