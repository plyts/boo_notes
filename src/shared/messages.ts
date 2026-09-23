import type { VideoContext } from './platforms';
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

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Messages sent to the background service worker (chrome.runtime.sendMessage). */
export type BackgroundRequest =
  | { type: 'hello' }
  | { type: 'player:ready'; ctx: VideoContext; title: string }
  | { type: 'player:gone' }
  | { type: 'player:interaction' }
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
  | { type: 'notes:clear' };

export interface BackgroundResponses {
  hello: { tabId: number };
  'player:ready': void;
  'player:gone': void;
  'player:interaction': void;
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
      playback: PlaybackState;
      pageTheme: PageTheme;
    }
  | { type: 'context'; ctx: VideoContext | null; title: string }
  | { type: 'playback'; playback: PlaybackState; hasVideo: boolean }
  | { type: 'insert-timestamp'; seconds: number; focus: boolean }
  | { type: 'insert-block'; text: string }
  | { type: 'focus'; where: 'keep' | 'end' }
  | { type: 'pinned'; value: boolean }
  | { type: 'page-theme'; theme: PageTheme }
  | { type: 'typing-release' };

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
  | { type: 'command'; command: CommandId };
