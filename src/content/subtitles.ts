import type { CaptionState } from '../shared/messages';
import type { Platform } from '../shared/platforms';
import {
  applyLiveSample,
  compactCues,
  cueIndexAt,
  languageName,
  parseYouTubeJson3,
  type Cue,
  type TranscriptSource,
} from '../shared/transcript';
import type { TranscriptInfo } from '../shared/transcript-store';

/**
 * Collects the subtitles of the media being watched, in the background,
 * without ever touching the notes. Sources, best first:
 * 1. the player's subtitle tracks (`video.textTracks`, WebVTT): the whole file;
 * 2. the platform's caption list (YouTube): the whole file;
 * 3. the subtitles displayed on screen, captured as they appear (any player).
 * The cues are handed to the service worker (see TranscriptStore); the line
 * being spoken goes to the notes panel (live subtitle strip).
 */
export interface CollectorHooks {
  /** Stores cues (`replace`: the whole list); resolves false when the background did not keep them (no note yet). */
  flush(noteId: string, info: TranscriptInfo, cues: Cue[], replace: boolean, engaged: boolean): Promise<boolean>;
  /** Line being spoken, and the state of the collection. */
  caption(cue: Cue | null, state: CaptionState): void;
}

/** Subtitle lines drawn by the players, one element per line. */
const LIVE_LINES = [
  '.ytp-caption-window-container .caption-visual-line', // YouTube
  '[data-purpose="captions-cue-text"]', // Udemy
  '.vjs-text-track-display .vjs-text-track-cue > div', // video.js
  '.plyr__captions .plyr__caption', // Plyr
  '.jw-captions .jw-text-track-cue', // JW Player
  '.mejs__captions-text', // MediaElement.js
  '.shaka-text-container > div', // Shaka
  '[class*="caption-line" i]',
  '[class*="subtitle-line" i]',
];

/** Player buttons telling that subtitles exist but are hidden. */
const CAPTIONS_OFF = ['.ytp-subtitles-button[aria-pressed="false"]', '[data-purpose="captions-dropdown-button"]'];

const FLUSH_LIVE_MS = 2000;

export class SubtitleCollector {
  private noteId: string | null = null;
  private platform: Platform | null = null;
  private enabled = true;
  private source: TranscriptSource | null = null;
  private info: TranscriptInfo = { lang: '', label: '', source: 'live', complete: false, duration: 0 };
  private cues: Cue[] = [];
  /** Live capture: cues added or grown since the last flush. */
  private dirty = new Set<string>();
  /** A whole list (track, platform) waits to be stored. */
  private fullPending = false;
  private track: TextTrack | null = null;
  private trackCount = -1;
  private platformTried: string | null = null;
  /** Continuous stretch watched with captions shown (live capture). */
  private cover: { from: number; to: number } | null = null;
  private pendingCover: [number, number] | null = null;
  private last: { time: number; at: number } | null = null;
  private lastFlush = 0;
  private flushing = false;
  private stateKey = '';
  private status: CaptionState['status'] = 'searching';

  constructor(private readonly hooks: CollectorHooks) {}

  /** New media page (or none): everything starts over. */
  reset(noteId: string | null, platform: Platform | null): void {
    this.noteId = noteId;
    this.platform = platform;
    this.source = null;
    this.info = { lang: '', label: '', source: 'live', complete: false, duration: 0 };
    this.cues = [];
    this.dirty.clear();
    this.fullPending = false;
    this.track = null;
    this.trackCount = -1;
    this.cover = null;
    this.pendingCover = null;
    this.last = null;
    this.stateKey = '';
    this.status = 'searching';
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.emit(null);
  }

  get count(): number {
    return this.cues.length;
  }

  /** Called a few times per second with the media and its clock. */
  tick(media: HTMLMediaElement | null, time: number, playing: boolean, duration: number, engaged: boolean): void {
    if (!this.enabled || !this.noteId) {
      this.emit(null);
      return;
    }
    if (duration > 0) this.info.duration = duration;
    if (this.source !== 'track' && media) this.readTracks(media);
    if (!this.source && this.platform === 'youtube' && this.platformTried !== this.noteId) void this.loadYouTube(this.noteId);
    if (!this.source || this.source === 'live') this.sampleLive(time, playing);
    this.status = this.source === 'track' || this.source === 'platform' ? 'complete' : this.source === 'live' ? 'capturing' : this.captionsHidden() ? 'captions-off' : 'searching';

    let cue: Cue | null = null;
    const i = cueIndexAt(this.cues, time);
    if (i !== -1 && time <= this.cues[i].end + (this.source === 'live' ? 2 : 0.3)) cue = this.cues[i];
    this.emit(cue);
    this.maybeFlush(engaged);
  }

  /** Stores what is pending now (media ended, page left). */
  async flushNow(engaged: boolean): Promise<void> {
    this.closeCover();
    await this.flush(engaged);
  }

  private emit(cue: Cue | null): void {
    const state: CaptionState = this.enabled
      ? { status: this.status, source: this.source, label: this.info.label }
      : { status: 'off', source: null, label: '' };
    const key = `${cue?.id ?? ''}|${cue?.text ?? ''}|${state.status}|${state.label}`;
    if (key === this.stateKey) return;
    this.stateKey = key;
    this.hooks.caption(cue ? { ...cue } : null, state);
  }

  // --- 1. Tracks of the player ------------------------------------------------------------

  private readTracks(media: HTMLMediaElement): void {
    const tracks = [...media.textTracks].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
    if (!tracks.length) return;
    const pageLang = document.documentElement.lang.split('-')[0];
    const track =
      tracks.find((t) => t.mode === 'showing') ??
      (this.track && tracks.includes(this.track) ? this.track : null) ??
      tracks.find((t) => t.language && t.language.split('-')[0] === pageLang) ??
      tracks[0];
    // A disabled track loads its cues once hidden (never shown by us).
    if (track.mode === 'disabled') track.mode = 'hidden';
    if (track !== this.track) {
      this.track = track;
      this.trackCount = -1;
    }
    const list = track.cues;
    if (!list || list.length === 0 || list.length === this.trackCount) return;
    this.trackCount = list.length;
    const raw: Array<{ start: number; end: number; text: string }> = [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i] as TextTrackCue & { text?: string };
      if (typeof c.text === 'string') raw.push({ start: c.startTime, end: c.endTime, text: c.text });
    }
    const cues = compactCues(raw);
    if (!cues.length) return;
    this.cues = cues;
    this.source = 'track';
    const lang = track.language || '';
    this.info = {
      ...this.info,
      lang,
      source: 'track',
      complete: true,
      label: `Sous-titres du lecteur · ${track.label || (lang ? languageName(lang) : 'langue inconnue')}`,
    };
    this.dirty.clear();
    this.fullPending = true;
  }

  // --- 2. Caption list of the platform ------------------------------------------------------

  private async loadYouTube(noteId: string): Promise<void> {
    this.platformTried = noteId;
    const videoId = noteId.replace(/^youtube:/, '');
    try {
      const found = await youtubeCaptions(videoId);
      if (!found || this.noteId !== noteId || this.source === 'track') return;
      this.cues = found.cues;
      this.source = 'platform';
      this.info = { ...this.info, lang: found.lang, source: 'platform', complete: true, label: found.label };
      this.dirty.clear();
      this.fullPending = true;
    } catch {
      // Not available (no captions, format changed): the live capture takes over.
    }
  }

  // --- 3. Subtitles displayed on screen ----------------------------------------------------------

  private sampleLive(time: number, playing: boolean): void {
    const lines = readLiveLines();
    const now = Date.now();
    const jumped = this.last ? Math.abs(time - (this.last.time + (playing ? (now - this.last.at) / 1000 : 0))) > 1.5 : true;
    this.last = { time, at: now };
    if (lines === null || !playing || jumped) this.closeCover();
    if (lines === null || !playing) return;
    if (!this.cover) this.cover = { from: time, to: time };
    else this.cover.to = time;
    if (!lines.length) return;
    if (applyLiveSample(this.cues, time, lines)) {
      if (!this.source) {
        this.source = 'live';
        this.info = { ...this.info, source: 'live', complete: false, label: 'Sous-titres affichés · capture en direct' };
      }
      for (const c of this.cues) if (c.end >= time - 16) this.dirty.add(c.id);
    }
  }

  private closeCover(): void {
    if (!this.cover) return;
    const { from, to } = this.cover;
    this.cover = null;
    if (to - from < 0.5 || this.source !== 'live') return;
    this.pendingCover = this.pendingCover ? [Math.min(this.pendingCover[0], from), Math.max(this.pendingCover[1], to)] : [from, to];
  }

  private captionsHidden(): boolean {
    return CAPTIONS_OFF.some((sel) => document.querySelector(sel) !== null);
  }

  // --- Storage -------------------------------------------------------------------------

  private maybeFlush(engaged: boolean): void {
    const now = Date.now();
    if (this.fullPending) {
      if (now - this.lastFlush > 500) void this.flush(engaged);
      return;
    }
    if (this.source !== 'live' || now - this.lastFlush < FLUSH_LIVE_MS) return;
    if (this.cover && this.cover.to - this.cover.from > 10) {
      // Long stretches are reported as they go.
      const { to } = this.cover;
      this.closeCover();
      this.cover = { from: to, to };
    }
    if (this.dirty.size || this.pendingCover) void this.flush(engaged);
  }

  private async flush(engaged: boolean): Promise<void> {
    if (this.flushing || !this.noteId || !this.source) return;
    const noteId = this.noteId;
    const replace = this.fullPending;
    const cues = replace ? this.cues : this.cues.filter((c) => this.dirty.has(c.id));
    const covered = this.pendingCover;
    if (!replace && !cues.length && !covered) return;
    this.flushing = true;
    this.lastFlush = Date.now();
    this.fullPending = false;
    this.dirty.clear();
    this.pendingCover = null;
    const info: TranscriptInfo = { ...this.info, ...(covered ? { covered } : {}) };
    let stored = false;
    try {
      stored = await this.hooks.flush(noteId, info, cues.map((c) => ({ ...c })), replace, engaged);
    } catch {
      stored = false;
    } finally {
      this.flushing = false;
    }
    if (stored || this.noteId !== noteId) return;
    // Not kept (no note yet): everything is sent again once the user takes notes.
    if (replace) this.fullPending = true;
    else {
      for (const c of this.cues) this.dirty.add(c.id);
      if (covered) this.pendingCover = this.pendingCover ? [Math.min(covered[0], this.pendingCover[0]), Math.max(covered[1], this.pendingCover[1])] : covered;
    }
  }
}

/** Text of the subtitle lines on screen; null when no subtitles are displayed. */
export function readLiveLines(root: ParentNode = document): string[] | null {
  for (const sel of LIVE_LINES) {
    const els = [...root.querySelectorAll<HTMLElement>(sel)];
    if (!els.length) continue;
    const visible = els.filter((el) => el.getClientRects().length > 0);
    return visible.map((el) => el.textContent ?? '').filter((t) => t.trim());
  }
  return null;
}

// --- YouTube -----------------------------------------------------------------------------

interface YouTubeTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: Array<{ text: string }> };
}

/** The JSON array following `key` in `text` (brackets matched, strings skipped). */
export function extractJsonArray(text: string, key: string): unknown[] | null {
  const at = text.indexOf(key);
  if (at === -1) return null;
  const start = text.indexOf('[', at + key.length);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown[];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Spoken language first: its manual subtitles, else its automatic ones; else the first manual track. */
export function pickYouTubeTrack(tracks: YouTubeTrack[]): YouTubeTrack | null {
  const asr = tracks.find((t) => t.kind === 'asr');
  const manual = tracks.filter((t) => t.kind !== 'asr');
  if (asr) return manual.find((t) => t.languageCode === asr.languageCode) ?? asr;
  return manual[0] ?? null;
}

async function youtubeCaptions(videoId: string): Promise<{ cues: Cue[]; lang: string; label: string } | null> {
  const page = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: 'include' });
  if (!page.ok) return null;
  const tracks = (extractJsonArray(await page.text(), '"captionTracks":') ?? []) as YouTubeTrack[];
  const track = pickYouTubeTrack(tracks.filter((t) => typeof t?.baseUrl === 'string'));
  if (!track) return null;
  const url = new URL(track.baseUrl, location.origin);
  if (url.origin !== location.origin) return null;
  url.searchParams.set('fmt', 'json3');
  const res = await fetch(url, { credentials: 'include' });
  const body = res.ok ? await res.text() : '';
  if (!body.trim()) return null;
  const cues = parseYouTubeJson3(JSON.parse(body));
  if (!cues.length) return null;
  const lang = track.languageCode ?? '';
  const name = track.name?.simpleText ?? track.name?.runs?.map((r) => r.text).join('') ?? (lang ? languageName(lang) : '');
  return { cues, lang, label: `Sous-titres YouTube · ${name}${track.kind === 'asr' && !/auto/i.test(name) ? ' (automatiques)' : ''}` };
}
