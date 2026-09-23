/**
 * Finds the media of a page wherever they live: in the document, inside
 * shadow trees (web components of custom players — open or *closed*, which
 * content scripts may open), and off-DOM `new Audio()` players, docked into
 * the page by the main-world bridge (media-bridge.ts) as soon as they play.
 */

/** Custom element the main-world bridge moves off-DOM media into (hidden). */
export const MEDIA_DOCK = 'boo-media-dock';

/** Shadow root of an element, open or closed. */
export function shadowRootOf(el: Element): ShadowRoot | null {
  const open = (el as HTMLElement).shadowRoot;
  if (open) return open;
  try {
    return chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement) ?? null;
  } catch {
    return null;
  }
}

/** Elements allowed to host a shadow root, besides custom elements. */
const SHADOW_HOSTS = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span']);

export interface ScanResult {
  media: HTMLMediaElement[];
  /** Shadow roots crossed (listeners for non-composed media events must be added there). */
  roots: ShadowRoot[];
}

/** Every <video> and <audio> under `root`, shadow trees included, in document order. */
export function scanMedia(root: Document | ShadowRoot = document, limit = 20_000): ScanResult {
  const media: HTMLMediaElement[] = [];
  const roots: ShadowRoot[] = [];
  let budget = limit;
  const walk = (scope: Document | ShadowRoot) => {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node && budget-- > 0; node = walker.nextNode()) {
      const el = node as Element;
      if (el instanceof HTMLMediaElement) media.push(el);
      const shadow = el.localName.includes('-') || SHADOW_HOSTS.has(el.localName) ? shadowRootOf(el) : null;
      if (shadow) {
        roots.push(shadow);
        walk(shadow);
      }
    }
  };
  walk(root);
  return { media, roots };
}

/** The <iframe> elements of the page (shadow trees included) large enough to hold a player. */
export function playerFrames(minArea: number): HTMLIFrameElement[] {
  const out: HTMLIFrameElement[] = [];
  const visit = (scope: Document | ShadowRoot) => {
    for (const f of scope.querySelectorAll('iframe')) {
      const r = f.getBoundingClientRect();
      if (r.width * r.height >= minArea) out.push(f);
    }
  };
  visit(document);
  for (const root of scanMedia(document, 8000).roots) visit(root);
  return out;
}

/** Hosts of the embedded players people learn with: offered a permission when found in a page. */
export const KNOWN_PLAYER_HOSTS = [
  'player.vimeo.com',
  'fast.wistia.net',
  'fast.wistia.com',
  'cdnapisec.kaltura.com',
  'players.brightcove.net',
  'panopto.com',
  'panopto.eu',
  'www.youtube.com',
  'www.youtube-nocookie.com',
  'www.dailymotion.com',
  'geo.dailymotion.com',
  'cdn.jwplayer.com',
  'content.jwplatform.com',
  'www.loom.com',
  'play.vidyard.com',
  'w.soundcloud.com',
  'embed.podcasts.apple.com',
  'iframe.mediadelivery.net',
  'customer-*.cloudflarestream.com',
  'mediasite',
  'echo360',
  'streamable.com',
];

export function looksLikePlayer(src: string): boolean {
  let host = '';
  try {
    host = new URL(src, location.href).hostname;
  } catch {
    return false;
  }
  return KNOWN_PLAYER_HOSTS.some((h) =>
    h.includes('*')
      ? new RegExp(`^${h.replace(/\./g, '\\.').replace('*', '[\\w-]+')}$`).test(host)
      : h.includes('.')
        ? host === h || host.endsWith(`.${h}`)
        : host.includes(h),
  );
}
