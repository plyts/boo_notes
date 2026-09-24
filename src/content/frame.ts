import { CAPTIONS_EVENT, CAPTIONS_REQUEST_EVENT, readCaptionPayload } from '../shared/caption-bridge';
import {
  FRAME_PORT,
  type BackgroundToFrame,
  type CaptureRect,
  type FrameCaptions,
  type FrameCommand,
  type FrameMedia,
  type FrameNotice,
  type FrameToBackground,
} from '../shared/messages';
import { frameHello, liftHello, readHello } from '../shared/frame-hello';
import { saveSettings } from '../shared/settings';
import { adapterForHost } from './adapters';
import { captureVideoFrame, probeFrame } from './capture';
import { Drawer } from './drawer';
import { FrameReading } from './frame-reading';
import { allFrames } from './media-scan';
import { MediaController } from './player';
import { captionFile, readLiveLines, readTextTrack, SubtitleCollector } from './subtitles';

/**
 * Frame agent: runs inside the sub-frames of a page (embedded players —
 * Vimeo, Kaltura, Panopto, Wistia, a YouTube embed, a school's own player…).
 * It has no UI: it reports the state of the frame's media to the page's
 * Boo Notes (through the background) and executes its commands, so notes,
 * timestamps and captures work as if the media were in the page itself. It
 * also reads the player's subtitles (its tracks, the files it downloads, the
 * lines it displays) for the page's transcript.
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
  private track: TextTrack | null = null;
  private trackCount = -1;
  /** Last subtitles file found, sent again whenever the media is announced again. */
  private file: Extract<FrameCaptions, { kind: 'file' }> | null = null;
  private lines = '';
  /** Reading in this frame (course modules): quotes, anchors, SCORM, shortcuts. */
  private readonly reading: FrameReading;

  constructor() {
    this.player = new MediaController(adapterForHost(location.hostname), {
      onEvent: () => this.schedule(0),
      send: () => undefined,
    });
    this.reading = new FrameReading((event) => this.post({ type: 'event', event }), this.token, this.abort.signal, () => this.port !== null);
  }

  start(): void {
    this.player.listen(this.abort.signal);
    // Heartbeat: late players, layout changes, and the page's clock resync.
    const beat = setInterval(() => this.report(), 2000);
    this.abort.signal.addEventListener('abort', () => clearInterval(beat));
    window.addEventListener('pagehide', () => this.post({ type: 'gone' }), { signal: this.abort.signal });
    // Subtitles: the files the player downloads (main-world bridge), its tracks and the lines it shows.
    document.addEventListener(
      CAPTIONS_EVENT,
      (e) => {
        const payload = readCaptionPayload((e as CustomEvent<unknown>).detail);
        const found = payload ? captionFile(payload) : null;
        if (found) this.setFile({ kind: 'file', ...found });
      },
      { signal: this.abort.signal },
    );
    document.dispatchEvent(new CustomEvent(CAPTIONS_REQUEST_EVENT));
    const captions = setInterval(() => this.sampleCaptions(), 400);
    this.abort.signal.addEventListener('abort', () => clearInterval(captions));
    // A media deeper in this frame (course module → its player): its hello goes on up, placed in this frame.
    window.addEventListener(
      'message',
      (e) => {
        const hello = readHello(e.data);
        if (!hello || !e.source || e.source === window) return;
        const iframe = allFrames().find((f) => f.contentWindow === e.source);
        if (!iframe) return;
        try {
          window.parent.postMessage(liftHello(hello, iframe), '*');
        } catch {
          // Parent gone.
        }
      },
      { signal: this.abort.signal },
    );
    this.abort.signal.addEventListener('abort', () => this.notes?.destroy());
    this.reading.start();
    this.report();
  }

  private setFile(file: Extract<FrameCaptions, { kind: 'file' }>): void {
    this.file = file;
    if (this.announced) this.post({ type: 'captions', captions: file });
  }

  private sampleCaptions(): void {
    const media = this.player.current;
    if (!media || !this.announced) return;
    const read = readTextTrack(media, this.track, this.trackCount);
    if (read) {
      this.track = read.track;
      this.trackCount = read.count;
      if (read.cues.length) this.setFile({ kind: 'file', cues: read.cues, lang: read.lang, label: read.label, source: 'track', complete: true });
    }
    // Lines on screen (subtitles drawn by the player), as they change.
    const lines = readLiveLines(document, media);
    const key = JSON.stringify(lines);
    if (key === this.lines) return;
    this.lines = key;
    this.post({ type: 'captions', captions: { kind: 'lines', lines } });
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
    const first = !this.announced;
    this.announced = true;
    this.post({ type: 'media', media: state });
    if (first && this.file) this.post({ type: 'captions', captions: this.file });
    // Lets the parent page find the <iframe> element holding this media (relayed up by the frames between).
    try {
      window.parent.postMessage(frameHello(this.token), '*');
    } catch {
      // Parent gone.
    }
  }

  /** The tab's notes panel, shown here while this frame alone is fullscreen. */
  private notes: Drawer | null = null;

  private hostNotes(n: Extract<FrameNotice, { kind: 'notes-host' }>): void {
    if (n.token !== this.token) return;
    if (!n.show) {
      this.notes?.destroyFrame();
      return;
    }
    this.notes ??= new Drawer({
      width: n.width,
      layout: n.layout,
      topInset: () => 0,
      // The same panel as in the page: it talks to the page's script (its tab), wherever it is shown.
      panelUrl: () => chrome.runtime.getURL(`panel/panel.html?tab=${n.tabId}&mode=embedded`),
      onResized: (width) => void saveSettings({ drawerWidth: width }).catch(() => undefined),
    });
    this.notes.setWidth(n.width);
    this.notes.setLayout(n.layout);
    this.notes.open();
    this.notes.focus();
  }

  private post(msg: FrameToBackground): void {
    if (!chrome.runtime?.id) {
      this.abort.abort(); // Extension reloaded: this copy is orphaned (its listeners go with it).
      return;
    }
    try {
      if (!this.port) {
        this.port = chrome.runtime.connect({ name: FRAME_PORT });
        this.port.onMessage.addListener((m: BackgroundToFrame) => void this.onMessage(m));
        this.port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          this.port = null;
          // The service worker restarted: announce the media (and its subtitles) again.
          this.lastSent = '';
          this.announced = false;
          this.lines = '';
        });
      }
      this.port.postMessage(msg);
    } catch {
      this.port = null;
    }
  }

  private async onMessage(msg: BackgroundToFrame): Promise<void> {
    if (msg.type === 'notice') {
      if (msg.notice.kind === 'notes-host') this.hostNotes(msg.notice);
      else this.reading.onNotice(msg.notice);
      return;
    }
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
      case 'captions':
        SubtitleCollector.showCaptions();
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
