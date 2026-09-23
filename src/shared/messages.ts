import type { MediaKind, VideoContext } from './platforms';
import type { AssetRecord, Note, NoteMeta, NoteSummary } from './store';

/** Keyboard commands declared in manifest.json (configurable in chrome://extensions/shortcuts). */
export const COMMANDS = [
  'toggle-sidebar',
  'insert-timestamp',
  'capture-screenshot',
  'smart-pause',
  'replay',
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
  /** Titles of every known note (extension + desktop library), for `[[` completion. */
  | { type: 'wiki:titles' }
  /** Opens the note titled `title`: in the desktop app, else its page, else in Notion. */
  | { type: 'wiki:open'; title: string }
  | { type: 'notion:status' }
  | { type: 'notion:connect'; token: string; target: string }
  | { type: 'notion:disconnect' }
  | { type: 'notion:sync-all' };

export interface BackgroundResponses {
  hello: { tabId: number };
  'player:ready': void;
  'player:gone': void;
  'player:interaction': void;
  'player:progress': void;
  'note:get': Note;
  'note:save': Note;
  'note:append': Note;
  'asset:save': Pick<AssetRecord, 'path'>;
  'capture:visible-tab': { dataUrl: string; width: number; height: number };
  export: { message: string };
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
  'wiki:titles': string[];
  'wiki:open': { message: string };
  'notion:status': NotionStatus;
  'notion:connect': NotionStatus;
  'notion:disconnect': NotionStatus;
  'notion:sync-all': { ok: number; failed: number };
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
  | { type: 'player:active'; active: boolean };

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
    }
  | { type: 'context'; ctx: VideoContext | null; title: string }
  /** `hasVideo`: a media (video or audio) is attached; `kind` tells which. */
  | { type: 'playback'; playback: PlaybackState; hasVideo: boolean; kind: MediaKind }
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
  | { type: 'reading'; ratio: number; passage: string | null };

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
  | { type: 'reveal'; url: string };
