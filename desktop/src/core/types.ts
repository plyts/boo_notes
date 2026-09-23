import type { MediaKind, Platform } from '../../../src/shared/platforms';

export type { MediaKind, Platform };

/** Where a note is written: in the browser extension, or in this app (local files). */
export type ItemOrigin = 'extension' | 'desktop';

export { STATUS_LABELS, type StudyStatus } from '../../../src/shared/study';
import type { StudyStatus } from '../../../src/shared/study';

/**
 * Reading / listening position. Media: seconds. PDF: `position` is the page
 * being read and `duration` the page count. Text: paragraph. Web page: % read.
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

/** Spaced repetition of a note: next review date and current interval. */
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

// --- The study model: courses › chapters › notes ↔ resources ---------------------------------

/** What is studied: everything but a revision sheet. */
export type ResourceKind = Exclude<MediaKind, 'note'>;

/** `file`: a local file; `url`: a stream or document opened by address; `extension`: a media noted in the browser. */
export type ResourceOrigin = 'file' | 'url' | 'extension';

/**
 * A study resource: a video or audio (file, stream, online course), a PDF, a
 * text, an image, a web page. Progress, highlights and pins belong to it; any
 * number of notes can refer to it.
 */
export interface Resource {
  /** `file:<hash>`, `url:<hash>`, or the extension's media id (`youtube:…`, `web:…`, `notion:…`). */
  id: string;
  kind: ResourceKind;
  platform: Platform;
  title: string;
  /** Absolute path of the file, or URL. */
  source: string;
  origin: ResourceOrigin;
  createdAt: number;
  updatedAt: number;
  progress?: Progress;
  /** Furthest point reached (same unit as `progress.position`). */
  furthest?: number;
  /** Time spent with the resource open in the app (ms). */
  studyMs?: number;
  highlights?: Highlight[];
  pins?: Pin[];
  /** Manual status; derived from the progress when absent. */
  status?: StudyStatus;
}

/**
 * A note: Markdown in the vault, linked to 0..n resources. Anchors without
 * target (`[04:15]`, `[p. 12]`) refer to the first resource, the others name
 * theirs (`[04:15](res:<id>)`). Without resource, it is a revision sheet.
 */
export interface Note {
  /** `note:…` (written in the app) or the extension's note id (`youtube:…`, `web:…`…). */
  id: string;
  origin: ItemOrigin;
  title: string;
  /** Markdown file, relative to the vault. */
  noteFile: string;
  /** Linked resources, in order: the first one is the note's main resource. */
  resources: string[];
  /** Save counter (extension revision for browser notes). */
  rev: number;
  createdAt: number;
  updatedAt: number;
  /** Titles linked with `[[Titre]]`. */
  links?: string[];
  /** Length of the Markdown (characters). */
  size?: number;
  /** Anchored lines (instants, pages, paragraphs, pins, quoted passages). */
  noteCount?: number;
  review?: Review;
  /** Manual status (else derived from the main resource, or the reviews of a sheet). */
  status?: StudyStatus;
  notion?: NotionLink;
  /** Last time the note was placed in a chapter (the latest placement wins: app or browser). */
  placedAt?: number;
}

/** A chapter holds notes, in order. A note is in at most one chapter. */
export interface Chapter {
  id: string;
  title: string;
  notes: string[];
}

/** A course: one or more chapters. */
export interface Course {
  id: string;
  title: string;
  emoji: string;
  /** Colour of the course (HSL hue, 0–359): sidebar, graph groups, badges. */
  hue: number;
  description?: string;
  createdAt: number;
  updatedAt: number;
  chapters: Chapter[];
}

/** Where a note is filed. */
export interface Placement {
  courseId: string;
  chapterId: string;
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
  /** Filing chosen in the browser panel: course and chapter titles (created if missing). */
  course?: string;
  chapter?: string;
  placedAt?: number;
}

export interface ActivePlayer {
  noteId: string;
  title: string;
  url: string;
}
