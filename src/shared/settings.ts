export type DrawerLayout = 'side-by-side' | 'overlay';
export type Theme = 'auto' | 'dark' | 'light';
export type CaptureFormat = 'image/jpeg' | 'image/png' | 'image/webp';

export interface Settings {
  /** Drawer width in px, 300–500. */
  drawerWidth: number;
  /** `side-by-side` shrinks the page so the drawer never covers the player. */
  layout: DrawerLayout;
  theme: Theme;
  /** Prefix new note lines with the current timecode. */
  autoTimestamp: boolean;
  /** Pause after 1.5 s of continuous typing, resume 1 s after the last key. */
  autoPause: boolean;
  /** Replay jump, in seconds. */
  replaySeconds: number;
  /**
   * Handle in the page (and notes panel) every default shortcut Chrome could
   * not register globally: Alt+← (Chrome allows only four defaults) and any
   * default clashing with a browser shortcut (Alt+Shift+T on Windows / Linux).
   */
  pageShortcuts: boolean;
  /** Floating HUD on top of the video. */
  hudEnabled: boolean;
  captureFormat: CaptureFormat;
  captureQuality: number;
  /** Local desktop app endpoint. */
  desktopUrl: string;
  /** Pairing token shown by the desktop app. */
  desktopToken: string;
}

export const DRAWER_MIN_WIDTH = 300;
export const DRAWER_MAX_WIDTH = 500;
export const DEFAULT_DESKTOP_URL = 'ws://localhost:43117';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  drawerWidth: 360,
  layout: 'side-by-side',
  theme: 'auto',
  autoTimestamp: true,
  autoPause: false,
  replaySeconds: 5,
  pageShortcuts: true,
  hudEnabled: true,
  captureFormat: 'image/jpeg',
  captureQuality: 0.92,
  desktopUrl: DEFAULT_DESKTOP_URL,
  desktopToken: '',
});

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Only loopback WebSocket endpoints are accepted: notes never leave the machine. */
export function isLoopbackWsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  const desktopUrl = typeof r.desktopUrl === 'string' ? r.desktopUrl.trim() : '';
  return {
    drawerWidth: Math.round(clamp(num(r.drawerWidth, d.drawerWidth), DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH)),
    layout: pick(r.layout, ['side-by-side', 'overlay'], d.layout),
    theme: pick(r.theme, ['auto', 'dark', 'light'], d.theme),
    autoTimestamp: bool(r.autoTimestamp, d.autoTimestamp),
    autoPause: bool(r.autoPause, d.autoPause),
    replaySeconds: Math.round(clamp(num(r.replaySeconds, d.replaySeconds), 1, 60)),
    // `replayInPage` is the pre-0.1 name of this option.
    pageShortcuts: bool(r.pageShortcuts ?? (r as Record<string, unknown>).replayInPage, d.pageShortcuts),
    hudEnabled: bool(r.hudEnabled, d.hudEnabled),
    captureFormat: pick(r.captureFormat, ['image/jpeg', 'image/png', 'image/webp'], d.captureFormat),
    captureQuality: clamp(num(r.captureQuality, d.captureQuality), 0.5, 1),
    desktopUrl: isLoopbackWsUrl(desktopUrl) ? desktopUrl : d.desktopUrl,
    desktopToken: typeof r.desktopToken === 'string' ? r.desktopToken.trim().slice(0, 256) : '',
  };
}

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.sync.get(KEY);
  return normalizeSettings(res[KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'sync' && changes[KEY]) cb(normalizeSettings(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
