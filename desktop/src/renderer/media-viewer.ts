import { TypingAutoPause } from '../../../src/shared/autopause';
import { formatTimecode } from '../../../src/shared/time';
import type { ResourceView } from '../ipc';
import { h, icon, iconButton } from './dom';

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];

export interface MediaViewerOptions {
  item: Pick<ResourceView, 'id' | 'kind' | 'title' | 'source' | 'origin' | 'progress'>;
  onTime(seconds: number): void;
  onProgress(position: number, duration: number): void;
  onActivity(): void;
  /** A note marker of the timeline clicked (its timestamp). */
  onMarkerClick?(seconds: number): void;
}

/**
 * Local audio / video player: custom transport with the note's timestamps on
 * the scrubber, playback speed, resume where the lesson was left, and
 * auto-pause while typing.
 */
export class MediaViewer {
  readonly el: HTMLElement;
  readonly media: HTMLMediaElement;
  readonly autoPause: TypingAutoPause;
  private readonly playBtn: HTMLButtonElement;
  private readonly timeEl: HTMLElement;
  private readonly scrubber: HTMLInputElement;
  private readonly markersEl: HTMLElement;
  private readonly speedBtn: HTMLButtonElement;
  private readonly stage: HTMLElement;
  private lastSaved = 0;
  private markers: number[] = [];
  private destroyed = false;
  private hls: { destroy(): void } | null = null;

  constructor(private readonly opts: MediaViewerOptions) {
    const { item } = opts;
    // Adaptive streams (HLS) are played through Media Source Extensions; files and direct streams via the app origin.
    const stream = item.origin === 'url' && /\.m3u8(?:$|[?#])/i.test(item.source);
    const src = stream ? undefined : `boo://app/__media/${encodeURIComponent(item.id)}`;
    this.media =
      item.kind === 'video'
        ? h('video', { class: 'media-video', src, preload: 'auto', playsinline: true })
        : h('audio', { src, preload: 'auto' });
    if (stream) void this.attachStream(item.source);
    this.stage =
      item.kind === 'video'
        ? h('div', { class: 'media-stage video' }, this.media)
        : h(
            'div',
            { class: 'media-stage audio' },
            this.media,
            h(
              'div',
              { class: 'audio-art', 'aria-hidden': 'true' },
              h('span', { class: 'audio-disc' }, icon('headphones', 44)),
              h('span', { class: 'audio-wave' }, ...Array.from({ length: 28 }, (_, i) => waveBar(i))),
            ),
            h('p', { class: 'audio-title' }, item.title),
          );

    this.playBtn = iconButton('play', 'Lecture (Alt+Shift+Espace)', () => this.toggle());
    this.playBtn.classList.add('play-btn');
    this.timeEl = h('span', { class: 'media-time' }, '00:00 / 00:00');
    this.scrubber = h('input', { type: 'range', class: 'scrubber-input', min: '0', max: '0', step: '0.1', value: '0', 'aria-label': 'Position' });
    this.markersEl = h('div', { class: 'scrub-markers', 'aria-hidden': 'true' });
    this.speedBtn = h('button', { type: 'button', class: 'speed-btn', title: 'Vitesse de lecture' }, '1×');
    this.speedBtn.addEventListener('click', () => this.cycleSpeed());
    const transport = h(
      'div',
      { class: 'transport' },
      iconButton('replay', 'Revoir 5 s (Alt+←)', () => this.skip(-5)),
      this.playBtn,
      h('div', { class: 'scrub' }, this.markersEl, this.scrubber),
      this.timeEl,
      this.speedBtn,
      item.kind === 'video' ? iconButton('fit', 'Plein écran', () => void this.stage.requestFullscreen().catch(() => undefined)) : null,
    );
    this.el = h('section', { class: `media-viewer ${item.kind}`, 'aria-label': 'Lecteur' }, this.stage, transport);

    this.autoPause = new TypingAutoPause({
      isPlaying: () => !this.media.paused,
      pause: () => this.media.pause(),
      play: () => void this.media.play().catch(() => undefined),
    });
    this.autoPause.enabled = true;

    this.scrubber.addEventListener('input', () => {
      this.media.currentTime = Number(this.scrubber.value);
      this.opts.onActivity();
    });
    if (item.kind === 'video') this.media.addEventListener('click', () => this.toggle());
    this.media.addEventListener('loadedmetadata', () => this.onMetadata());
    this.media.addEventListener('timeupdate', () => this.onTime());
    this.media.addEventListener('play', () => this.renderPlay());
    this.media.addEventListener('pause', () => {
      this.renderPlay();
      this.saveProgress(true);
    });
    this.media.addEventListener('seeked', () => this.saveProgress(true));
  }

  get time(): number {
    return this.media.currentTime;
  }

  get isVideo(): boolean {
    return this.opts.item.kind === 'video';
  }

  toggle(): void {
    this.autoPause.release();
    if (this.media.paused) void this.media.play().catch(() => undefined);
    else this.media.pause();
    this.opts.onActivity();
  }

  seek(seconds: number): void {
    const d = this.media.duration;
    this.media.currentTime = Math.max(0, Number.isFinite(d) ? Math.min(seconds, d) : seconds);
  }

  skip(delta: number): void {
    this.seek(this.media.currentTime + delta);
    this.opts.onActivity();
  }

  /** Instants noted about this media, drawn on the scrubber. */
  setMarkers(times: number[]): void {
    this.markers = times;
    this.renderMarkers();
  }

  private async attachStream(url: string): Promise<void> {
    const { default: Hls } = await import('hls.js');
    if (this.destroyed) return;
    if (!Hls.isSupported()) {
      this.media.src = url;
      return;
    }
    const hls = new Hls({ enableWorker: false });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) this.media.dispatchEvent(new Event('error'));
    });
    hls.loadSource(url);
    hls.attachMedia(this.media);
    this.hls = hls;
  }

  /** Current frame as a JPEG data URL (video only). */
  capture(): string | null {
    const v = this.media;
    if (!(v instanceof HTMLVideoElement) || !v.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    this.stage.classList.remove('flash');
    void this.stage.offsetWidth;
    this.stage.classList.add('flash');
    return canvas.toDataURL('image/jpeg', 0.9);
  }

  destroy(): void {
    this.saveProgress(true);
    this.destroyed = true;
    this.hls?.destroy();
    this.autoPause.dispose();
    this.media.pause();
    this.media.removeAttribute('src');
    this.media.load();
  }

  private onMetadata(): void {
    const d = this.media.duration;
    this.scrubber.max = String(Number.isFinite(d) ? d : 0);
    const resume = this.opts.item.progress?.position ?? 0;
    if (resume > 3 && Number.isFinite(d) && resume < d - 3) this.media.currentTime = resume;
    this.renderMarkers();
    this.onTime();
  }

  private onTime(): void {
    const t = this.media.currentTime;
    const d = Number.isFinite(this.media.duration) ? this.media.duration : 0;
    if (document.activeElement !== this.scrubber) this.scrubber.value = String(t);
    this.scrubber.style.setProperty('--fill', d ? `${(t / d) * 100}%` : '0%');
    this.timeEl.textContent = `${formatTimecode(t)} / ${formatTimecode(d)}`;
    this.opts.onTime(t);
    if (!this.media.paused) this.saveProgress(false);
  }

  private saveProgress(force: boolean): void {
    if (this.destroyed) return;
    const now = Date.now();
    if (!force && now - this.lastSaved < 10_000) return;
    const d = this.media.duration;
    if (!Number.isFinite(d) || !d) return;
    this.lastSaved = now;
    this.opts.onProgress(this.media.currentTime, d);
  }

  private renderPlay(): void {
    const playing = !this.media.paused;
    this.playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 20));
    this.playBtn.title = playing ? 'Pause (Alt+Shift+Espace)' : 'Lecture (Alt+Shift+Espace)';
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
    this.el.classList.toggle('playing', playing);
  }

  private renderMarkers(): void {
    const d = this.media.duration;
    if (!Number.isFinite(d) || !d) {
      this.markersEl.replaceChildren();
      return;
    }
    this.markersEl.replaceChildren(
      ...this.markers
        .filter((s) => s <= d)
        .map((s) => {
          const m = h('button', { type: 'button', class: 'scrub-marker', title: `Note à ${formatTimecode(s)}`, 'aria-label': `Note à ${formatTimecode(s)}` });
          m.style.left = `${(s / d) * 100}%`;
          m.addEventListener('click', () => {
            this.seek(s);
            this.opts.onMarkerClick?.(s);
          });
          return m;
        }),
    );
  }

  private cycleSpeed(): void {
    const i = SPEEDS.indexOf(this.media.playbackRate);
    const next = SPEEDS[(i + 1) % SPEEDS.length];
    this.media.playbackRate = next;
    this.speedBtn.textContent = `${String(next).replace('.', ',')}×`;
  }
}

function waveBar(i: number): HTMLElement {
  const bar = h('i', {});
  const hgt = 18 + Math.round(34 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6)));
  bar.style.height = `${hgt}px`;
  bar.style.animationDelay = `${(i % 7) * 90}ms`;
  return bar;
}
