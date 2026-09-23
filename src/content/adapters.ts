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

const ADAPTERS: Record<Platform, PlatformAdapter> = {
  youtube: {
    platform: 'youtube',
    videoSelectors: ['#movie_player video.html5-main-video', 'video.html5-main-video'],
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
    progressBarSelectors: ['.vjs-progress-holder', '.vjs-progress-control'],
    headerSelectors: [],
    playerFocusSelectors: ['.video-js'],
    title: () =>
      firstText(['h1.video-name', 'main h1', 'h1']) || cleanDocumentTitle([/\s*\|\s*Coursera$/i]),
    theme: () => null,
  },
};

export function adapterForHost(hostname: string): PlatformAdapter | null {
  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) return ADAPTERS.youtube;
  if (hostname === 'udemy.com' || hostname.endsWith('.udemy.com')) return ADAPTERS.udemy;
  if (hostname === 'coursera.org' || hostname.endsWith('.coursera.org')) return ADAPTERS.coursera;
  return null;
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
