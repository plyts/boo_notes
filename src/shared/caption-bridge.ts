/**
 * Subtitle files downloaded by a page's player, handed by the main-world
 * bridge (media-bridge.ts) to the content script or frame agent of the same
 * frame. Kept tiny: the bridge runs at document_start in every frame.
 */

/** Main world → isolated world: `detail` is a JSON `CaptionFilePayload`. */
export const CAPTIONS_EVENT = 'boo-notes:caption-file';
/** Isolated world → main world: send again the files already seen. */
export const CAPTIONS_REQUEST_EVENT = 'boo-notes:caption-files?';

export interface CaptionFilePayload {
  url: string;
  contentType: string;
  body: string;
  /** When the player downloaded it (ms): files replayed after a navigation are told apart. */
  at: number;
}

/** URLs of subtitle files, as players name them (thumbnails, chapters and storyboards excluded). */
export function isCaptionUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url, 'https://x.invalid');
  } catch {
    return false;
  }
  const path = u.pathname.toLowerCase();
  if (/thumb|sprite|storyboard|chapter|preview|metadata/.test(path)) return false;
  return (
    path.endsWith('/api/timedtext') ||
    /\.(?:vtt|webvtt|srt|ttml|dfxp)$/.test(path) ||
    /(?:^|\/)(?:captions?|subtitles?|texttracks?|timedtext)(?:\/|$)/.test(path) ||
    /^(?:vtt|webvtt|srt|ttml|json3|srv3)$/.test(u.searchParams.get('fmt') ?? u.searchParams.get('format') ?? '')
  );
}

/** Content types of subtitle files. */
export function isCaptionType(contentType: string | null | undefined): boolean {
  return /\b(?:text\/vtt|application\/x-subrip|text\/srt|application\/ttml\+xml|application\/ttaf\+xml)\b/i.test(contentType ?? '');
}

/** A payload received from the main world (any page script may send one): checked, or null. */
export function readCaptionPayload(detail: unknown): CaptionFilePayload | null {
  if (typeof detail !== 'string' || detail.length > 12 * 1024 * 1024) return null;
  try {
    const p = JSON.parse(detail) as Partial<CaptionFilePayload>;
    if (typeof p.url !== 'string' || typeof p.body !== 'string') return null;
    return {
      url: p.url.slice(0, 4000),
      contentType: typeof p.contentType === 'string' ? p.contentType.slice(0, 200) : '',
      body: p.body,
      at: typeof p.at === 'number' && Number.isFinite(p.at) ? p.at : Date.now(),
    };
  } catch {
    return null;
  }
}
