import type { PageTheme } from '../shared/messages';
import type { Platform } from '../shared/platforms';

/**
 * Per-platform knowledge of the page. Selectors are only *read*: the
 * extension never modifies the native player or its controls.
 */
export interface PlatformAdapter {
  platform: Platform;
  /** Main player <video>, most specific first. */
  videoSelectors: string[];
  /** Audio players (<audio>), used when the page has no main video. */
  audioSelectors: string[];
  /** Native progress bar, used to place the timestamp preview marker. */
  progressBarSelectors: string[];
  /** Fixed site header the drawer should sit below (keeps native navigation visible). */
  headerSelectors: string[];
  /** Element that receives the platform's keyboard shortcuts. */
  playerFocusSelectors: string[];
  /** Video / course title. */
  title(): string;
  /** Explicit site theme, when the site exposes one. */
  theme(): PageTheme | null;
}

function firstText(selectors: string[]): string {
  for (const sel of selectors) {
    const text = document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function cleanDocumentTitle(patterns: RegExp[]): string {
  let t = document.title;
  for (const p of patterns) t = t.replace(p, '');
  return t.trim();
}

function metaContent(selector: string): string {
  return document.querySelector(selector)?.getAttribute('content')?.trim() ?? '';
}

type PagePlatform = Exclude<Platform, 'local'>;

const ADAPTERS: Record<PagePlatform, PlatformAdapter> = {
  youtube: {
    platform: 'youtube',
    videoSelectors: ['#movie_player video.html5-main-video', 'video.html5-main-video'],
    audioSelectors: [],
    progressBarSelectors: ['#movie_player .ytp-progress-bar', '.ytp-progress-bar'],
    headerSelectors: ['#masthead-container'],
    playerFocusSelectors: ['#movie_player'],
    title: () =>
      firstText(['ytd-watch-metadata h1 yt-formatted-string', 'ytd-watch-metadata h1', 'h1.ytd-watch-metadata']) ||
      cleanDocumentTitle([/^\(\d+\)\s*/, /\s*-\s*YouTube$/]),
    theme: () => (document.documentElement.hasAttribute('dark') ? 'dark' : null),
  },
  udemy: {
    platform: 'udemy',
    videoSelectors: ['[data-purpose="video-player"] video', 'video.vjs-tech', 'video'],
    audioSelectors: ['audio'],
    progressBarSelectors: [
      '[data-purpose="video-progress-bar"]',
      '[class*="progress-bar--slider"]',
      '.vjs-progress-holder',
    ],
    headerSelectors: ['[data-purpose="header"]'],
    playerFocusSelectors: ['[data-purpose="video-player"]'],
    title: () => {
      const course = firstText(['[data-purpose="course-header-title"]', 'header h1']);
      const lecture = firstText([
        '[class*="curriculum-item-link--is-current"] [data-purpose="item-title"]',
        '[aria-current="true"] [data-purpose="item-title"]',
      ]);
      const joined = [course, lecture].filter(Boolean).join(' — ');
      return joined || cleanDocumentTitle([/\s*\|\s*Udemy.*$/i]);
    },
    theme: () => null,
  },
  coursera: {
    platform: 'coursera',
    videoSelectors: ['video.vjs-tech', '.c-video-player video', 'video'],
    audioSelectors: ['audio'],
    progressBarSelectors: ['.vjs-progress-holder', '.vjs-progress-control'],
    headerSelectors: [],
    playerFocusSelectors: ['.video-js'],
    title: () =>
      firstText(['h1.video-name', 'main h1', 'h1']) || cleanDocumentTitle([/\s*\|\s*Coursera$/i]),
    theme: () => null,
  },
  notion: {
    // Videos and audio files uploaded in a Notion page (embeds of other sites are cross-origin iframes).
    platform: 'notion',
    videoSelectors: ['.notion-video-block video', 'video'],
    audioSelectors: ['.notion-audio-block audio', 'audio'],
    progressBarSelectors: [],
    headerSelectors: [],
    playerFocusSelectors: [],
    title: () => cleanDocumentTitle([/\s*\|\s*Notion$/i]) || 'Page Notion',
    theme: () => (document.body?.classList.contains('notion-dark-theme') ? 'dark' : null),
  },
  web: {
    // Any site the user activated Boo Notes on (podcasts, radio, course platforms…).
    platform: 'web',
    videoSelectors: ['video'],
    audioSelectors: ['audio'],
    progressBarSelectors: [],
    headerSelectors: [],
    playerFocusSelectors: [],
    title: () => metaContent('meta[property="og:title"]') || document.title.trim() || location.hostname,
    theme: () => null,
  },
};

const isHost = (hostname: string, domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);

/** Adapter for the page. Hosts without a dedicated adapter get the generic one (on-demand activation). */
export function adapterForHost(hostname: string): PlatformAdapter {
  if (isHost(hostname, 'youtube.com')) return ADAPTERS.youtube;
  if (isHost(hostname, 'udemy.com')) return ADAPTERS.udemy;
  if (isHost(hostname, 'coursera.org')) return ADAPTERS.coursera;
  if (isHost(hostname, 'notion.so') || isHost(hostname, 'notion.site')) return ADAPTERS.notion;
  return ADAPTERS.web;
}

export function queryVisible<T extends Element>(selectors: string[], minWidth = 1): T | null {
  for (const sel of selectors) {
    for (const el of document.querySelectorAll<T>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width >= minWidth && r.height > 0) return el;
    }
  }
  return null;
}

/** Bottom edge of a fixed header at the top of the viewport, 0 if none. */
export function headerInset(adapter: PlatformAdapter): number {
  for (const sel of adapter.headerSelectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const pos = getComputedStyle(el).position;
    if ((pos === 'fixed' || pos === 'sticky') && r.top <= 1 && r.height > 0 && r.height < 160) {
      return Math.round(r.bottom);
    }
  }
  return 0;
}

function parseRgb(color: string): { r: number; g: number; b: number; a: number } | null {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(color);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}

/** Dark / light look of the page behind the drawer, so the panel matches it. */
export function detectPageTheme(adapter: PlatformAdapter | null): PageTheme {
  const explicit = adapter?.theme();
  if (explicit) return explicit;
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const c = parseRgb(getComputedStyle(el).backgroundColor);
    if (c && c.a > 0.5) {
      const luminance = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
      return luminance < 0.45 ? 'dark' : 'light';
    }
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
