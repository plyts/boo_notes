import type { MediaKind, VideoContext } from './platforms';
import type { AssetRecord, CourseOption, Note, NoteMeta, NoteSummary } from './store';
import type { Cue, Transcript, TranscriptSource } from './transcript';
import type { CuePatch, TranscriptInfo } from './transcript-store';

/** Keyboard commands declared in manifest.json (configurable in chrome://extensions/shortcuts). */
export const COMMANDS = [
  'toggle-sidebar',
  'insert-timestamp',
  'capture-screenshot',
  'smart-pause',
  'replay',
  'passage-start',
  'passage-end',
] as const;
export type CommandId = (typeof COMMANDS)[number];

export function isCommand(value: unknown): value is CommandId {
  return COMMANDS.includes(value as CommandId);
}

export type SyncState = 'connected' | 'connecting' | 'offline';

export interface SyncStatus {
  state: SyncState;
  /** Notes saved locally but not yet acknowledged by the desktop app. */
  pending: number;
  error?: string;
  app?: { name: string; version: string };
  at: number;
}

export type ExportTarget = 'desktop' | 'notion' | 'download';

/** Notion as seen by the extension: through the desktop app, or directly (app closed). */
export interface NotionStatus {
  /** The extension can write to Notion itself. */
  configured: boolean;
  /** Where the connection comes from: shared by the desktop app, or set in the options. */
  origin: 'desktop' | 'extension' | null;
  workspace: string | null;
  databaseUrl: string | null;
  /** Notes waiting to be written to Notion by the extension. */
  pending: number;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the playback position comes from. */
export type MediaSource = 'element' | 'frame' | 'stopwatch';

/**
 * A media playing inside a sub-frame (embedded player: Vimeo, Kaltura,
 * Panopto, a YouTube embed…), as reported by the frame agent living there.
 */
export interface FrameMedia {
  kind: 'video' | 'audio';
  title: string;
  playback: PlaybackState;
  /** Player box and displayed picture, in the frame's viewport (CSS px). */
  box: CaptureRect | null;
  content: CaptureRect | null;
  viewport: { width: number; height: number };
  /** Random id, also posted to the parent window so it can find the <iframe> element. */
  token: string;
  href: string;
}

export type FrameCommand =
  | { op: 'play' }
  | { op: 'pause' }
  | { op: 'seek'; seconds: number }
  | { op: 'capture'; id: number; mime: string; quality: number }
  /** Switches the player's captions on. */
  | { op: 'captions' };

export interface FrameShot {
  dataUrl: string;
  width: number;
  height: number;
  mime: string;
}

/** Port between a frame agent and the background. */
export const FRAME_PORT = 'boo-notes-frame';

/**
 * Subtitles read in an embedded player: a whole file (its track, or a file its
 * player downloaded), and the lines it displays now (null: none displayed).
 */
export type FrameCaptions =
  | { kind: 'file'; cues: Cue[]; lang: string; label: string; source: 'platform' | 'track'; complete: boolean }
  | { kind: 'lines'; lines: string[] | null };

export type FrameToBackground =
  | { type: 'media'; media: FrameMedia }
  | { type: 'gone' }
  | { type: 'shot'; id: number; shot: FrameShot | null; error: string | null }
  | { type: 'captions'; captions: FrameCaptions };

export type BackgroundToFrame = { type: 'command'; command: FrameCommand };

/** Messages sent to the background service worker (chrome.runtime.sendMessage). */
export type BackgroundRequest =
  | { type: 'hello' }
  | { type: 'player:ready'; ctx: VideoContext; title: string; kind: MediaKind }
  | { type: 'player:gone' }
  | { type: 'player:interaction' }
  /** Playback position of the active media (course tracking). */
  | { type: 'player:progress'; noteId: string; position: number; duration: number; kind: MediaKind }
  | { type: 'note:get'; noteId: string; meta: NoteMeta }
  | { type: 'note:save'; noteId: string; meta: NoteMeta; markdown: string; writer: string }
  | { type: 'note:append'; noteId: string; meta: NoteMeta; text: string }
  /** Files the note in a course › chapter of the library (null: unfiled). */
  | { type: 'note:place'; noteId: string; meta: NoteMeta; place: { course: string; chapter: string } | null }
  /** Courses to file a note in: the desktop library's, and those already used here. */
  | { type: 'library:courses' }
  | {
      type: 'asset:save';
      noteId: string;
      dataUrl: string;
      mime: string;
      width: number;
      height: number;
      time: number;
    }
  | {
      type: 'capture:visible-tab';
      /** Video area in CSS pixels, relative to the viewport. */
      rect: CaptureRect;
      viewportWidth: number;
      mime: string;
      quality: number;
    }
  | { type: 'export'; noteId: string; target: ExportTarget }
  /** Drives the media of a sub-frame of the sender's tab. */
  | { type: 'frame:command'; frameId: number; command: FrameCommand }
  /** Injects the frame agent into every sub-frame of the sender's tab the extension may read. */
  | { type: 'frames:inject' }
  /** Embedded players the user allowed (origins): the agent is injected there from now on. */
  | { type: 'players:allow'; origins: string[]; tabId: number }
  /** A video or audio pasted into a note was stored (IndexedDB) by the panel: to send to the desktop app. */
  | { type: 'media:stored'; path: string }
  | { type: 'popout:open'; noteId: string }
  | { type: 'popout:close'; tabId: number }
  | { type: 'options:open' }
  | { type: 'shortcuts:list' }
  | { type: 'sync:status' }
  | { type: 'sync:retry' }
  | { type: 'notes:list' }
  | { type: 'notes:clear' }
  /** Sites where Boo Notes is always active (optional host permission already granted). */
  | { type: 'sites:list' }
  | { type: 'sites:enable'; origin: string }
  | { type: 'sites:disable'; origin: string }
  /** « Activer sur tous les sites »: `null` reads the state. */
  | { type: 'sites:all'; enabled: boolean | null }
  /** Titles of every known note (extension + desktop library), for `[[` completion. */
  | { type: 'wiki:titles' }
  /** Opens the note titled `title`: in the desktop app, else its page, else in Notion. */
  | { type: 'wiki:open'; title: string }
  | { type: 'notion:status' }
  | { type: 'notion:connect'; token: string; target: string }
  | { type: 'notion:disconnect' }
  | { type: 'notion:sync-all' }
  /**
   * Subtitles collected by the page. `replace`: the whole list (subtitles file), else new or
   * updated cues (live capture). Kept once the note exists, or while the user takes notes (`engaged`).
   */
  | { type: 'transcript:put'; noteId: string; meta: NoteMeta; info: TranscriptInfo; cues: Cue[]; replace: boolean; engaged: boolean }
  | { type: 'transcript:get'; noteId: string }
  /** Translations and comments of cues, and the transcript's languages. */
  | { type: 'transcript:annotate'; noteId: string; patches: CuePatch[]; lang?: string; target?: string }
  /** Pins (or updates) the transcript line at the end of the note, when the note exists. */
  | { type: 'transcript:pin'; noteId: string; delay?: number }
  /** Recorded media (passage extract, audio trace) sent in base64 chunks, then stored. */
  | { type: 'media:chunk'; upload: string; index: number; data: string }
  | { type: 'media:commit'; upload: string; record: MediaMeta; meta: NoteMeta };

/** A recorded extract (`passage`) or a stretch of the course's sound (`audio`), stored as `media/…`. */
export interface MediaMeta {
  path: string;
  noteId: string;
  /** `passage`: extract of a passage; `audio`: sound of the course kept; `file`: a video or audio pasted into the note. */
  kind: 'passage' | 'audio' | 'file';
  mime: string;
  /** Media time range (s); for a pasted file, the moment it was pasted at. */
  start: number;
  end: number;
  /** Name of a pasted file. */
  name?: string;
}

/** State of the subtitles collection, for the panel. */
export interface CaptionState {
  /**
   * `off`: disabled in the options; `searching`: no subtitles found yet; `captions-off`: the
   * player can show some (turn them on to capture them); `capturing`: captured as they are shown;
   * `complete`: the whole subtitles file is known; `none`: the platform says the media has none.
   */
  status: 'off' | 'searching' | 'captions-off' | 'capturing' | 'complete' | 'none';
  source: TranscriptSource | null;
  label: string;
}

export interface BackgroundResponses {
  hello: { tabId: number };
  'player:ready': void;
  'player:gone': void;
  'player:interaction': void;
  'player:progress': void;
  'note:get': Note;
  'note:save': Note;
  'note:append': Note;
  'note:place': Note;
  'library:courses': CourseOption[];
  'asset:save': Pick<AssetRecord, 'path'>;
  'capture:visible-tab': { dataUrl: string; width: number; height: number };
  export: { message: string };
  'frame:command': void;
  'frames:inject': void;
  'players:allow': void;
  'media:stored': void;
  'popout:open': { windowId: number };
  'popout:close': void;
  'options:open': void;
  'shortcuts:list': Array<{ name: string; shortcut: string; description: string }>;
  'sync:status': SyncStatus;
  'sync:retry': SyncStatus;
  'notes:list': Record<string, NoteSummary>;
  'notes:clear': void;
  'sites:list': string[];
  'sites:enable': string[];
  'sites:disable': string[];
  'sites:all': boolean;
  'wiki:titles': string[];
  'wiki:open': { message: string };
  'notion:status': NotionStatus;
  'notion:connect': NotionStatus;
  'notion:disconnect': NotionStatus;
  'notion:sync-all': { ok: number; failed: number };
  'transcript:put': { stored: boolean };
  'transcript:get': Transcript | null;
  'transcript:annotate': Transcript | null;
  'transcript:pin': { pinned: boolean };
  'media:chunk': void;
  'media:commit': { path: string };
}

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

/** Typed request to the background; rejects with the background's error message. */
export async function callBackground<R extends BackgroundRequest>(
  request: R,
): Promise<BackgroundResponses[R['type']]> {
  const reply = (await chrome.runtime.sendMessage(request)) as Reply<BackgroundResponses[R['type']]> | undefined;
  if (!reply) throw new Error('Pas de réponse du service worker');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

/** Messages pushed by the background to a tab's content script. */
export type TabMessage =
  /** Presence check before an on-demand injection. */
  | { type: 'ping' }
  | { type: 'command'; command: CommandId }
  | { type: 'popout:closed' }
  | { type: 'player:active'; active: boolean }
  /** State of the media of a sub-frame (null: gone). */
  | { type: 'frame:media'; frameId: number; media: FrameMedia | null }
  | { type: 'frame:shot'; id: number; shot: FrameShot | null; error: string | null }
  | { type: 'frame:captions'; frameId: number; captions: FrameCaptions };

// --- Panel (iframe / pop-out window) <-> content script port -------------

export const PANEL_PORT = 'boo-notes-panel';

export type PanelMode = 'embedded' | 'popout';

export interface PlaybackState {
  /** Video position when the state was sampled. */
  time: number;
  playing: boolean;
  rate: number;
  duration: number;
  /** Date.now() at sampling time, to extrapolate the current position. */
  at: number;
}

export type PageTheme = 'dark' | 'light';

export type ContentToPanel =
  | {
      type: 'init';
      ctx: VideoContext | null;
      title: string;
      pinned: boolean;
      hasVideo: boolean;
      kind: MediaKind;
      playback: PlaybackState;
      pageTheme: PageTheme;
      source: MediaSource | null;
    }
  | { type: 'context'; ctx: VideoContext | null; title: string }
  /** `hasVideo`: a media (video or audio) is attached; `kind` tells which. */
  | { type: 'playback'; playback: PlaybackState; hasVideo: boolean; kind: MediaKind; source: MediaSource | null }
  /** Embedded players (hosts) found in the page that Boo Notes may not read yet. */
  | { type: 'players'; hosts: string[] }
  | { type: 'insert-timestamp'; seconds: number; focus: boolean }
  /** Any anchor token prefixed to the line (`[↗ Section](URL#:~:text=…)` in reading mode). */
  | { type: 'insert-anchor'; token: string; focus: boolean }
  | { type: 'insert-block'; text: string; focus?: boolean }
  | { type: 'focus'; where: 'keep' | 'end' }
  | { type: 'pinned'; value: boolean }
  | { type: 'page-theme'; theme: PageTheme }
  | { type: 'typing-release' }
  /**
   * Reading mode (page without media): furthest point read (0..1) and the
   * quoted passage being read (`[↗](URL#:~:text=…)` of the note), if any.
   */
  | { type: 'reading'; ratio: number; passage: string | null }
  /** Subtitle being spoken (null: none), and the state of the collection. */
  | { type: 'caption'; cue: Cue | null; state: CaptionState }
  /**
   * Recordings: passage started with « Début du passage » or being recorded afterwards
   * (`end` known), null when none; `audio`: the sound of the course is being kept.
   */
  | { type: 'recording'; passage: { start: number; end?: number; recording: boolean } | null; audio: boolean }
  /** A passage was created: its card goes into the note (the panel adds its title). */
  | { type: 'insert-passage'; start: number; end: number; image: string; media: string | null }
  /** The extract of the passage starting at `start` was recorded. */
  | { type: 'passage-media'; start: number; media: string }
  /** The media reached its end: the transcript gets pinned to the note. */
  | { type: 'media-ended' };

export type PanelToContent =
  | { type: 'hello'; mode: PanelMode }
  | { type: 'seek'; seconds: number }
  | { type: 'mark'; seconds: number | null }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'capture' }
  | { type: 'replay' }
  | { type: 'timestamp' }
  | { type: 'escape' }
  | { type: 'close' }
  | { type: 'pin'; value: boolean }
  | { type: 'popout' }
  | { type: 'dock' }
  | { type: 'toast'; text: string }
  /** In-page fallback shortcut pressed inside the panel. */
  | { type: 'command'; command: CommandId }
  /** Reading mode: quote the page selection (or anchor the section being read). */
  | { type: 'quote' }
  /** Reading mode: scroll to a quoted passage and flash it. */
  | { type: 'reveal'; url: string }
  /** Manual clock, for streams no script can read (DRM, native players, lectures in the room). */
  | { type: 'stopwatch'; action: 'start' | 'pause' | 'reset' }
  /** The user allowed embedded players: look for their media again. */
  | { type: 'players:granted' }
  /** Plays a passage and stops at its end. */
  | { type: 'play-range'; start: number; end: number }
  /** A passage chosen afterwards (transcript selection): its card is added to the note; `record`: replay and record it. */
  | { type: 'passage:create'; start: number; end: number; record: boolean }
  /** Replays a passage of the note and records its extract. */
  | { type: 'passage:record'; start: number; end: number }
  /** « Afficher les sous-titres »: the player's captions are switched on (then collected). */
  | { type: 'captions:show' };
