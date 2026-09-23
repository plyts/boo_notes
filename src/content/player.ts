import type { PlaybackState } from '../shared/messages';
import type { MediaKind } from '../shared/platforms';
import { queryVisible, type PlatformAdapter } from './adapters';

const MIN_VIDEO_AREA = 200 * 112;

/**
 * Read / drive access to the page's main media: the main <video>, or an
 * <audio> player (podcasts, audio lectures) when there is no video. When
 * several exist (previews, ads…), the one that last started playing wins.
 */
export class MediaController {
  private media: HTMLMediaElement | null = null;

  constructor(private readonly adapter: PlatformAdapter) {}

  /** The current main media, re-resolved if the page swapped it. */
  get current(): HTMLMediaElement | null {
    if (this.media && this.media.isConnected && isUsable(this.media)) return this.media;
    this.media = this.find();
    return this.media;
  }

  /** Current element when it is a video (screenshots, geometry). */
  get video(): HTMLVideoElement | null {
    const m = this.current;
    return m instanceof HTMLVideoElement && this.kind === 'video' ? m : null;
  }

  /** `audio` for <audio> players and for audio-only streams played through a <video> tag. */
  get kind(): MediaKind {
    const m = this.current;
    if (!m || m instanceof HTMLAudioElement) return m ? 'audio' : 'video';
    const v = m as HTMLVideoElement;
    return v.readyState >= HTMLMediaElement.HAVE_METADATA && v.videoWidth === 0 ? 'audio' : 'video';
  }

  /** Called for every media event seen on the page (capture phase). */
  adopt(media: HTMLMediaElement): void {
    if (isUsable(media)) this.media = media;
  }

  reset(): void {
    this.media = null;
  }

  time(): number {
    return this.current?.currentTime ?? 0;
  }

  playback(): PlaybackState {
    const m = this.current;
    return {
      time: m?.currentTime ?? 0,
      playing: Boolean(m && !m.paused && !m.ended),
      rate: m?.playbackRate ?? 1,
      duration: m && Number.isFinite(m.duration) ? m.duration : 0,
      at: Date.now(),
    };
  }

  pause(): void {
    this.current?.pause();
  }

  play(): void {
    void this.current?.play().catch(() => undefined);
  }

  seek(seconds: number): void {
    const m = this.current;
    if (!m) return;
    const max = Number.isFinite(m.duration) ? m.duration : Number.POSITIVE_INFINITY;
    m.currentTime = Math.min(Math.max(0, seconds), max);
  }

  skip(delta: number): number {
    const m = this.current;
    if (!m) return 0;
    this.seek(m.currentTime + delta);
    return m.currentTime;
  }

  /** Displayed video picture (letterboxing removed), in viewport CSS pixels. */
  contentRect(): DOMRect | null {
    const v = this.video;
    if (!v) return null;
    const r = v.getBoundingClientRect();
    if (!v.videoWidth || !v.videoHeight) return r;
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    return new DOMRect(r.left + (r.width - w) / 2, r.top + (r.height - h) / 2, w, h);
  }

  /** On-screen box of the player (a hidden audio element has none). */
  rect(): DOMRect | null {
    const m = this.current;
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  progressBarRect(): DOMRect | null {
    const video = this.rect();
    const bar = queryVisible<HTMLElement>(this.adapter.progressBarSelectors, 40);
    if (!bar || !video) return null;
    const r = bar.getBoundingClientRect();
    // Only trust a bar lying over / right under the video.
    const overlaps = r.left < video.right && r.right > video.left && r.top < video.bottom + 80 && r.bottom > video.top;
    return overlaps ? r : null;
  }

  private find(): HTMLMediaElement | null {
    const preferred = queryVisible<HTMLVideoElement>(this.adapter.videoSelectors, 100);
    if (preferred instanceof HTMLVideoElement && area(preferred) >= MIN_VIDEO_AREA) return preferred;
    let best: HTMLVideoElement | null = null;
    for (const v of document.querySelectorAll('video')) {
      if (isVisible(v) && area(v) >= MIN_VIDEO_AREA && (!best || area(v) > area(best))) best = v;
    }
    if (best) return best;
    // No main video: an audio player. Prefer one playing, then one with a source.
    const audios = this.adapter.audioSelectors.flatMap((sel) => [...document.querySelectorAll<HTMLAudioElement>(sel)]);
    return (
      audios.find((a) => !a.paused) ??
      audios.find((a) => Boolean(a.currentSrc || a.src || a.querySelector('source'))) ??
      null
    );
  }
}

function area(el: Element): number {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Audio players are often invisible (custom UI): only videos must be on screen and large enough. */
function isUsable(media: HTMLMediaElement): boolean {
  if (media instanceof HTMLAudioElement) return true;
  return isVisible(media) && area(media) >= MIN_VIDEO_AREA;
}
