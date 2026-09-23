import type { PlaybackState } from '../shared/messages';
import { queryVisible, type PlatformAdapter } from './adapters';

const MIN_VIDEO_AREA = 200 * 112;

/**
 * Read / drive access to the page's main <video>. When several videos exist
 * (previews, ads…), the one that last started playing wins.
 */
export class VideoController {
  private video: HTMLVideoElement | null = null;

  constructor(private readonly adapter: PlatformAdapter) {}

  /** The current main video, re-resolved if the page swapped it. */
  get current(): HTMLVideoElement | null {
    if (this.video && this.video.isConnected && isVisible(this.video)) return this.video;
    this.video = this.find();
    return this.video;
  }

  /** Called for every media event seen on the page (capture phase). */
  adopt(video: HTMLVideoElement): void {
    if (isVisible(video) && area(video) >= MIN_VIDEO_AREA) this.video = video;
  }

  reset(): void {
    this.video = null;
  }

  time(): number {
    return this.current?.currentTime ?? 0;
  }

  playback(): PlaybackState {
    const v = this.current;
    return {
      time: v?.currentTime ?? 0,
      playing: Boolean(v && !v.paused && !v.ended),
      rate: v?.playbackRate ?? 1,
      duration: v && Number.isFinite(v.duration) ? v.duration : 0,
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
    const v = this.current;
    if (!v) return;
    const max = Number.isFinite(v.duration) ? v.duration : Number.POSITIVE_INFINITY;
    v.currentTime = Math.min(Math.max(0, seconds), max);
  }

  skip(delta: number): number {
    const v = this.current;
    if (!v) return 0;
    this.seek(v.currentTime + delta);
    return v.currentTime;
  }

  /** Displayed video picture (letterboxing removed), in viewport CSS pixels. */
  contentRect(): DOMRect | null {
    const v = this.current;
    if (!v) return null;
    const r = v.getBoundingClientRect();
    if (!v.videoWidth || !v.videoHeight) return r;
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    return new DOMRect(r.left + (r.width - w) / 2, r.top + (r.height - h) / 2, w, h);
  }

  rect(): DOMRect | null {
    return this.current?.getBoundingClientRect() ?? null;
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

  private find(): HTMLVideoElement | null {
    const preferred = queryVisible<HTMLVideoElement>(this.adapter.videoSelectors, 100);
    if (preferred instanceof HTMLVideoElement && area(preferred) >= MIN_VIDEO_AREA) return preferred;
    let best: HTMLVideoElement | null = null;
    for (const v of document.querySelectorAll('video')) {
      if (isVisible(v) && area(v) >= MIN_VIDEO_AREA && (!best || area(v) > area(best))) best = v;
    }
    return best;
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
