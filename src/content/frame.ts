import {
  FRAME_PORT,
  type BackgroundToFrame,
  type CaptureRect,
  type FrameCommand,
  type FrameMedia,
  type FrameToBackground,
} from '../shared/messages';
import { adapterForHost } from './adapters';
import { captureVideoFrame, probeFrame } from './capture';
import { MediaController } from './player';

/**
 * Frame agent: runs inside the sub-frames of a page (embedded players —
 * Vimeo, Kaltura, Panopto, Wistia, a YouTube embed, a school's own player…).
 * It has no UI: it reports the state of the frame's media to the page's
 * Boo Notes (through the background) and executes its commands, so notes,
 * timestamps and captures work as if the media were in the page itself.
 */
class FrameAgent {
  private readonly abort = new AbortController();
  private readonly player: MediaController;
  private readonly token = crypto.randomUUID();
  private port: chrome.runtime.Port | null = null;
  private announced = false;
  private lastSent = '';
  private lastSentAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.player = new MediaController(adapterForHost(location.hostname), {
      onEvent: () => this.schedule(0),
      send: () => undefined,
    });
  }

  start(): void {
    this.player.listen(this.abort.signal);
    // Heartbeat: late players, layout changes, and the page's clock resync.
    const beat = setInterval(() => this.report(), 2000);
    this.abort.signal.addEventListener('abort', () => clearInterval(beat));
    window.addEventListener('pagehide', () => this.post({ type: 'gone' }), { signal: this.abort.signal });
    this.report();
  }

  private schedule(delay: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.report();
    }, delay);
  }

  private report(): void {
    if (!chrome.runtime?.id) {
      this.abort.abort(); // Extension reloaded: this copy is orphaned.
      return;
    }
    const media = this.player.current;
    if (!media) {
      if (this.announced) this.post({ type: 'gone' });
      this.announced = false;
      return;
    }
    const kind = this.player.kind === 'audio' ? 'audio' : 'video';
    const state: FrameMedia = {
      kind,
      title: (document.title || location.hostname).trim(),
      playback: this.player.playback(),
      box: rect(this.player.rect()),
      content: rect(this.player.contentRect()),
      viewport: { width: innerWidth, height: innerHeight },
      token: this.token,
      href: location.href,
    };
    // Unchanged state (the page extrapolates the clock): a keep-alive every 6 s is enough.
    const p = state.playback;
    const key = JSON.stringify({ ...state, playback: { ...p, time: p.playing ? 0 : Math.round(p.time * 10), at: 0 } });
    const now = Date.now();
    if (key === this.lastSent && now - this.lastSentAt < 6000) return;
    this.lastSent = key;
    this.lastSentAt = now;
    this.announced = true;
    this.post({ type: 'media', media: state });
    // Lets the parent page find the <iframe> element holding this media.
    try {
      window.parent.postMessage({ booNotesFrame: this.token }, '*');
    } catch {
      // Parent gone.
    }
  }

  private post(msg: FrameToBackground): void {
    try {
      if (!this.port) {
        this.port = chrome.runtime.connect({ name: FRAME_PORT });
        this.port.onMessage.addListener((m: BackgroundToFrame) => void this.onMessage(m));
        this.port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          this.port = null;
          // The service worker restarted: announce the media again.
          this.lastSent = '';
        });
      }
      this.port.postMessage(msg);
    } catch {
      this.port = null;
    }
  }

  private async onMessage(msg: BackgroundToFrame): Promise<void> {
    if (msg.type !== 'command') return;
    await this.run(msg.command);
    this.lastSent = '';
    this.schedule(60);
  }

  private async run(c: FrameCommand): Promise<void> {
    switch (c.op) {
      case 'play':
        this.player.play();
        return;
      case 'pause':
        this.player.pause();
        return;
      case 'seek':
        this.player.seek(c.seconds);
        return;
      case 'capture': {
        const video = this.player.video;
        if (!video) {
          this.post({ type: 'shot', id: c.id, shot: null, error: 'no-video' });
          return;
        }
        const probe = probeFrame(video);
        if (probe !== 'ok') {
          // Cross-origin or protected picture: the page screenshots the visible area instead.
          this.post({ type: 'shot', id: c.id, shot: null, error: probe });
          return;
        }
        try {
          const shot = await captureVideoFrame(video, c.mime, c.quality);
          this.post({ type: 'shot', id: c.id, shot, error: null });
        } catch (e) {
          this.post({ type: 'shot', id: c.id, shot: null, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }
}

function rect(r: DOMRect | null): CaptureRect | null {
  return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
}

const KEY = '__booNotesFrameAgent';
type WindowWithAgent = Window & { [KEY]?: boolean };

// Sub-frames only: the top page runs the full content script.
if (window.top !== window && !(window as WindowWithAgent)[KEY]) {
  (window as WindowWithAgent)[KEY] = true;
  new FrameAgent().start();
}
