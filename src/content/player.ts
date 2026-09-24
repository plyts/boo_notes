import { liftMap, type FrameHello } from '../shared/frame-hello';
import type { FrameCommand, FrameMedia, MediaSource, PlaybackState } from '../shared/messages';
import type { MediaKind } from '../shared/platforms';
import { queryVisible, type PlatformAdapter } from './adapters';
import { scanMedia } from './media-scan';

const MIN_VIDEO_AREA = 200 * 112;
/** Between two deep scans (shadow trees) while no media is found in the document itself. */
const SCAN_INTERVAL = 900;

export const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'seeked', 'ratechange', 'durationchange', 'loadedmetadata', 'emptied', 'waiting'];

/**
 * A clock the user starts by hand, when no script can read the stream
 * (protected player, native app, lecture in the room): timestamps then refer
 * to it, and the notes stay in sync with what was heard.
 */
export class Stopwatch {
  private base = 0;
  private startedAt: number | null = null;
  /** Started at least once for this page. */
  active = false;

  get running(): boolean {
    return this.startedAt !== null;
  }

  time(): number {
    return this.base + (this.startedAt !== null ? (Date.now() - this.startedAt) / 1000 : 0);
  }

  start(): void {
    this.active = true;
    this.startedAt ??= Date.now();
  }

  pause(): void {
    this.base = this.time();
    this.startedAt = null;
  }

  seek(seconds: number): void {
    this.base = Math.max(0, seconds);
    if (this.startedAt !== null) this.startedAt = Date.now();
  }

  reset(): void {
    this.base = 0;
    this.startedAt = null;
    this.active = false;
  }
}

interface Remote {
  frameId: number;
  media: FrameMedia;
  seen: number;
}

export interface MediaHooks {
  /** A media event on a local element (document, shadow trees, docked off-DOM players). */
  onEvent(type: string, media: HTMLMediaElement): void;
  /** Sends a command to the frame agent of `frameId`. */
  send(frameId: number, command: FrameCommand): void;
}

/**
 * Read / drive access to the page's main media, wherever it is:
 * - a <video> or <audio> of the page — shadow trees included, and off-DOM
 *   `new Audio()` players docked by the main-world bridge; when several exist
 *   (previews, ads…), the one that last started playing wins;
 * - else the media of an embedded player (sub-frame), through its agent;
 * - else the stopwatch, once the user started it.
 */
export class MediaController {
  private media: HTMLMediaElement | null = null;
  private lastScan = 0;
  /** Media found inside shadow trees by the last deep scan. */
  private deep: HTMLMediaElement[] = [];
  private signal: AbortSignal | null = null;
  private readonly roots = new WeakSet<ShadowRoot>();
  private readonly remotes = new Map<number, Remote>();
  /** Frame agent token → its <iframe> element (from the agent's postMessage). */
  private readonly frames = new Map<string, HTMLIFrameElement>();
  /** Where each media's frame sits in its <iframe> (hello, maybe relayed through nested frames). */
  private readonly hellos = new Map<string, FrameHello>();
  readonly stopwatch = new Stopwatch();
  stopwatchKind: 'video' | 'audio' = 'audio';

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly hooks: MediaHooks,
  ) {}

  /** Listens to media events in the document, then in every shadow tree met by the scans. */
  listen(signal: AbortSignal): void {
    this.signal = signal;
    this.listenOn(document);
  }

  private listenOn(target: Document | ShadowRoot): void {
    if (!this.signal) return;
    for (const type of MEDIA_EVENTS) {
      target.addEventListener(
        type,
        (e) => {
          if (e.target instanceof HTMLMediaElement) {
            if (type === 'play') this.adopt(e.target);
            this.hooks.onEvent(type, e.target);
          }
        },
        { capture: true, signal: this.signal },
      );
    }
  }

  // --- Sources ------------------------------------------------------------------------------

  /** The local media element, re-resolved if the page swapped it. */
  get current(): HTMLMediaElement | null {
    if (this.media && this.media.isConnected && isUsable(this.media)) return this.media;
    this.media = this.find();
    return this.media;
  }

  /** Media of a sub-frame: the one playing, else the last one heard from. */
  get remote(): Remote | null {
    let best: Remote | null = null;
    for (const r of this.remotes.values()) {
      if (!best || (r.media.playback.playing && !best.media.playback.playing) || (r.media.playback.playing === best.media.playback.playing && r.seen > best.seen)) best = r;
    }
    return best;
  }

  get source(): MediaSource | null {
    if (this.current) return 'element';
    if (this.remote) return 'frame';
    return this.stopwatch.active ? 'stopwatch' : null;
  }

  get available(): boolean {
    return this.source !== null;
  }

  /** Local element when it is a video (frame capture, geometry). */
  get video(): HTMLVideoElement | null {
    const m = this.current;
    return m instanceof HTMLVideoElement && this.kind === 'video' ? m : null;
  }

  /** `audio` for <audio> players and for audio-only streams played through a <video> tag. */
  get kind(): MediaKind {
    const m = this.current;
    if (m) {
      if (m instanceof HTMLAudioElement) return 'audio';
      const v = m as HTMLVideoElement;
      return v.readyState >= HTMLMediaElement.HAVE_METADATA && v.videoWidth === 0 ? 'audio' : 'video';
    }
    const r = this.remote;
    if (r) return r.media.kind;
    return this.stopwatch.active ? this.stopwatchKind : 'video';
  }

  /** Called for every `play` seen on the page (capture phase). */
  adopt(media: HTMLMediaElement): void {
    if (isUsable(media)) this.media = media;
  }

  reset(): void {
    this.media = null;
    this.lastScan = 0;
    this.deep = [];
    this.stopwatch.reset();
  }

  // --- Embedded players -----------------------------------------------------------------

  setRemote(frameId: number, media: FrameMedia | null): void {
    if (media) this.remotes.set(frameId, { frameId, media, seen: Date.now() });
    else this.remotes.delete(frameId);
  }

  bindFrame(token: string, iframe: HTMLIFrameElement, hello: FrameHello): void {
    this.frames.set(token, iframe);
    this.hellos.set(token, hello);
  }

  /** <iframe> elements that hold a reporting agent. */
  reportingFrames(): Set<HTMLIFrameElement> {
    const out = new Set<HTMLIFrameElement>();
    for (const r of this.remotes.values()) {
      const f = this.frames.get(r.media.token);
      if (f) out.add(f);
    }
    return out;
  }

  // --- Playback -------------------------------------------------------------------------

  time(): number {
    return this.playback().time;
  }

  playback(): PlaybackState {
    const now = Date.now();
    const m = this.current;
    if (m) {
      return {
        time: m.currentTime,
        playing: !m.paused && !m.ended,
        rate: m.playbackRate,
        duration: Number.isFinite(m.duration) ? m.duration : 0,
        at: now,
      };
    }
    const r = this.remote;
    if (r) {
      const p = r.media.playback;
      let time = p.playing ? p.time + ((now - p.at) / 1000) * p.rate : p.time;
      if (p.duration > 0) time = Math.min(time, p.duration);
      return { ...p, time: Math.max(0, time), at: now };
    }
    if (this.stopwatch.active) return { time: this.stopwatch.time(), playing: this.stopwatch.running, rate: 1, duration: 0, at: now };
    return { time: 0, playing: false, rate: 1, duration: 0, at: now };
  }

  get paused(): boolean {
    return !this.playback().playing;
  }

  pause(): void {
    const m = this.current;
    if (m) m.pause();
    else if (this.remote) this.command({ op: 'pause' });
    else this.stopwatch.pause();
  }

  play(): void {
    const m = this.current;
    if (m) void m.play().catch(() => undefined);
    else if (this.remote) this.command({ op: 'play' });
    else if (this.stopwatch.active) this.stopwatch.start();
  }

  seek(seconds: number): void {
    const m = this.current;
    if (m) {
      const max = Number.isFinite(m.duration) ? m.duration : Number.POSITIVE_INFINITY;
      m.currentTime = Math.min(Math.max(0, seconds), max);
    } else if (this.remote) this.command({ op: 'seek', seconds: Math.max(0, seconds) });
    else this.stopwatch.seek(seconds);
  }

  skip(delta: number): number {
    const target = Math.max(0, this.time() + delta);
    this.seek(target);
    return this.current?.currentTime ?? target;
  }

  /** Sends `command` to the current remote media, updating the local copy of its state. */
  command(command: FrameCommand): Remote | null {
    const r = this.remote;
    if (!r) return null;
    const p = this.playback();
    if (command.op === 'pause') r.media.playback = { ...p, playing: false };
    else if (command.op === 'play') r.media.playback = { ...p, playing: true };
    else if (command.op === 'seek') r.media.playback = { ...p, time: command.seconds };
    this.hooks.send(r.frameId, command);
    return r;
  }

  // --- Geometry -------------------------------------------------------------------------

  /** Displayed video picture (letterboxing removed), in viewport CSS pixels. */
  contentRect(): DOMRect | null {
    const v = this.video;
    if (v) {
      const r = v.getBoundingClientRect();
      if (!v.videoWidth || !v.videoHeight) return r;
      const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      return new DOMRect(r.left + (r.width - w) / 2, r.top + (r.height - h) / 2, w, h);
    }
    const r = this.remote;
    return r && !this.current && r.media.kind === 'video' ? this.frameRect(r, r.media.content ?? r.media.box) : null;
  }

  /**
   * The element holding the picture and its controls: the site's player
   * (`#movie_player`…), else the video's closest wrapper of the same size;
   * the <iframe> of an embedded player. Null for audio.
   */
  box(): HTMLElement | null {
    const v = this.video;
    if (v) return playerBoxOf(v, this.adapter.playerFocusSelectors);
    const r = this.remote;
    if (!r || r.media.kind !== 'video') return null;
    const iframe = this.frames.get(r.media.token);
    return iframe?.isConnected ? iframe : null;
  }

  /** On-screen box of the player (a hidden audio element has none). */
  rect(): DOMRect | null {
    const m = this.current;
    if (m) {
      const r = m.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    }
    const r = this.remote;
    return r ? this.frameRect(r, r.media.box) : null;
  }

  /** A box of the frame's viewport, in this page's viewport. */
  private frameRect(r: Remote, box: FrameMedia['box']): DOMRect | null {
    const iframe = this.frames.get(r.media.token);
    if (!box || !iframe?.isConnected) return null;
    const f = iframe.getBoundingClientRect();
    if (!f.width || !f.height) return null;
    // The media's frame may sit several frames deep in this <iframe> (course modules).
    const hello = this.hellos.get(r.media.token) ?? { booNotesFrame: r.media.token, map: { x: 0, y: 0, sx: 1, sy: 1 }, view: { w: r.media.viewport.width, h: r.media.viewport.height } };
    const m = liftMap(hello, iframe);
    return new DOMRect(m.x + box.x * m.sx, m.y + box.y * m.sy, box.width * m.sx, box.height * m.sy);
  }

  progressBarRect(): DOMRect | null {
    if (!this.current) return null;
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
    // Media of the document (docked off-DOM players included): a cheap query, every time.
    const light = [...document.querySelectorAll<HTMLMediaElement>('video, audio')];
    // Shadow trees (custom players are often web components): a full walk, at most every 0.9 s.
    const now = performance.now();
    if (now - this.lastScan > SCAN_INTERVAL) {
      this.lastScan = now;
      const { media, roots } = scanMedia();
      this.deep = media.filter((m) => m.getRootNode() !== document);
      for (const root of roots) {
        if (this.roots.has(root)) continue;
        this.roots.add(root);
        // Media events are not composed: they must be listened to inside each shadow tree.
        this.listenOn(root);
      }
    }
    const media = [...light, ...this.deep.filter((m) => m.isConnected)];
    let best: HTMLVideoElement | null = null;
    for (const m of media) {
      if (!(m instanceof HTMLVideoElement) || !isVisible(m) || area(m) < MIN_VIDEO_AREA) continue;
      const better = !best || (!m.paused && best.paused) || (m.paused === best.paused && area(m) > area(best));
      if (better) best = m;
    }
    if (best) return best;
    // No main video: an audio player (or an audio-only stream in a hidden <video>).
    const audios = media.filter((m) => m instanceof HTMLAudioElement || isAudioOnly(m));
    return (
      audios.find((a) => !a.paused) ??
      audios.find((a) => Boolean(a.currentSrc || a.src || a.srcObject || a.querySelector('source'))) ??
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

function isAudioOnly(m: HTMLMediaElement): boolean {
  return m instanceof HTMLVideoElement && m.readyState >= HTMLMediaElement.HAVE_METADATA && m.videoWidth === 0;
}

/** Audio players are often invisible (custom UI): only videos must be on screen and large enough. */
function isUsable(media: HTMLMediaElement): boolean {
  if (media instanceof HTMLAudioElement || isAudioOnly(media)) return true;
  return isVisible(media) && area(media) >= MIN_VIDEO_AREA;
}

/** The site's player around a video, else its closest wrapper of about the same size (controls included). */
export function playerBoxOf(video: HTMLVideoElement, selectors: string[]): HTMLElement {
  const vr = video.getBoundingClientRect();
  for (const sel of selectors) {
    const el = video.closest<HTMLElement>(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height <= Math.max(1, vr.width * vr.height) * 1.8) return el;
  }
  let box: HTMLElement = video;
  for (let el = video.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const r = el.getBoundingClientRect();
    if (r.width > vr.width + 48 || r.height > vr.height + 120) break;
    box = el;
  }
  return box;
}
