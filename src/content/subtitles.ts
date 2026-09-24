import type { CaptionFilePayload } from '../shared/caption-bridge';
import type { CaptionState } from '../shared/messages';
import type { Platform } from '../shared/platforms';
import {
  applyLiveSample,
  cleanCueText,
  compactCues,
  cueIndexAt,
  languageName,
  looksLikeSubtitles,
  mergeCues,
  readCaptionFile,
  parseYouTubeJson3,
  sortCues,
  type Cue,
  type TranscriptSource,
} from '../shared/transcript';
import type { TranscriptInfo } from '../shared/transcript-store';

/**
 * Collects the subtitles of the media being watched, in the background,
 * without ever touching the notes. Sources, best first:
 * 1. the player's subtitle tracks (`video.textTracks`, WebVTT): the whole file;
 * 2. the subtitle files the player downloads (seen by the main-world bridge:
 *    YouTube's captions, WebVTT / SubRip / TTML of any player), the whole file
 *    or, for streams (HLS), piece by piece;
 * 3. the platform's caption list (YouTube: its captions, else the transcript
 *    of the video, as its « Afficher la transcription » panel reads it);
 * 4. the subtitles displayed on screen, captured as they appear (any player,
 *    embedded players included: their frame agent reads the lines).
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

/** Player buttons telling that subtitles exist but are hidden (a click shows them). */
const CAPTIONS_OFF = [
  '.ytp-subtitles-button[aria-pressed="false"]',
  '.plyr__controls [data-plyr="captions"][aria-pressed="false"]',
  '[data-purpose="captions-dropdown-button"]',
];
/** Of these, the ones a click switches on (the others open a menu); then any « CC » toggle of other players. */
const CAPTIONS_TOGGLES = [
  '.ytp-subtitles-button[aria-pressed="false"]',
  '.plyr__controls [data-plyr="captions"][aria-pressed="false"]',
  'button[aria-pressed="false"]:is([aria-label*="sous-titre" i], [aria-label*="subtitle" i], [aria-label*="caption" i], [aria-label="CC" i], [title*="sous-titre" i], [title*="subtitle" i], [title*="caption" i])',
];

/** Elements some other players draw their subtitles in (checked against the video's box). */
const GENERIC_LINES = '[class*="caption" i], [class*="subtitle" i], [class*="texttrack" i], [class*="text-track" i]';
/** Words of class names that are controls, not subtitles (`captions-toggle`, `subtitlesMenu`…). */
const NOT_LINES = new Set(['button', 'btn', 'menu', 'menuitem', 'settings', 'setting', 'toggle', 'control', 'controls', 'icon', 'label', 'select', 'selector', 'picker', 'switch', 'option', 'options', 'tooltip', 'dropdown', 'panel', 'list', 'title', 'toolbar', 'badge']);
const isControlClass = (cls: string): boolean =>
  cls
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((w) => NOT_LINES.has(w));

const FLUSH_LIVE_MS = 2000;
/** Storage refused (no note yet, panel closed): tried again this late, or as soon as the panel opens. */
const RETRY_REFUSED_MS = 5000;

/** Subtitles found in a file (downloaded by the player, or read in an embedded player). */
export interface FoundCaptions {
  cues: Cue[];
  lang: string;
  label: string;
  /** `platform`: YouTube's own captions; `track`: a player's subtitles file. */
  source: 'platform' | 'track';
  /** Covers the whole media (else a piece of a stream, merged with the others). */
  complete: boolean;
  /** YouTube's machine translation of another track (`tlang`): never replaces the original. */
  translated?: boolean;
}

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
  /** The platform says this media has no subtitles at all. */
  private none = false;
  /** Subtitle files of the player, by language (streams send theirs piece by piece). */
  private files = new Map<string, Cue[]>();
  /** Lines displayed by the embedded player now playing (its frame agent reads them). */
  private remoteLines: string[] | null = null;
  /** Continuous stretch watched with captions shown (live capture). */
  private cover: { from: number; to: number } | null = null;
  private pendingCover: [number, number] | null = null;
  private last: { time: number; at: number } | null = null;
  private lastFlush = 0;
  private refused = false;
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
    this.none = false;
    this.files.clear();
    this.remoteLines = null;
    this.cover = null;
    this.pendingCover = null;
    this.last = null;
    this.refused = false;
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

  /**
   * Called a few times per second with the media and its clock. `media` is null
   * when it plays in an embedded player (its lines come through `setRemoteLines`).
   */
  tick(media: HTMLMediaElement | null, time: number, playing: boolean, duration: number, engaged: boolean, remote = false): void {
    if (!this.enabled || !this.noteId) {
      this.emit(null);
      return;
    }
    if (duration > 0) this.info.duration = duration;
    // The track is read again as it grows (streams add their subtitles as they load).
    if (media && (this.source !== 'track' || this.track)) this.readTracks(media);
    if (!this.source && this.platform === 'youtube' && this.platformTried !== this.noteId) void this.loadYouTube(this.noteId);
    if (!this.source || this.source === 'live') this.sampleLive(remote ? this.remoteLines : readLiveLines(document, media), time, playing);
    this.status =
      this.source === 'track' || this.source === 'platform'
        ? 'complete'
        : this.source === 'live'
          ? 'capturing'
          : !remote && this.captionsHidden()
            ? 'captions-off'
            : this.none
              ? 'none'
              : 'searching';

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

  /** « Afficher les sous-titres »: switches the player's captions on (the player then downloads them). */
  static showCaptions(): boolean {
    for (const sel of CAPTIONS_TOGGLES) {
      const button = document.querySelector<HTMLElement>(sel);
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  }

  /** Lines shown by the embedded player (null: no subtitles displayed there). */
  setRemoteLines(lines: string[] | null): void {
    this.remoteLines = lines;
  }

  /** A subtitles file downloaded by the player (or read in an embedded player). */
  offerFile(found: FoundCaptions): void {
    if (!this.noteId || !found.cues.length) return;
    // The player's own track already gives everything.
    if (this.source === 'track' && this.track) return;
    // The original subtitles stay the transcript (translations are the user's, in the tab).
    if (found.translated && this.source === 'platform' && !this.info.label.includes('traduction')) return;
    let cues: Cue[];
    if (found.source === 'platform' || found.complete) {
      cues = sortCues(found.cues.map((c) => ({ ...c })));
      this.files.set(found.lang, cues);
    } else {
      // A piece of a stream: added to the pieces already seen in that language.
      cues = mergeCues(this.files.get(found.lang) ?? [], found.cues);
      this.files.set(found.lang, cues);
    }
    const complete = found.complete || (this.info.duration > 0 && (cues.at(-1)?.end ?? 0) >= this.info.duration * 0.9);
    if (this.source === found.source && this.info.lang === found.lang && this.cues.length === cues.length && this.cues.every((c, i) => c.id === cues[i].id && c.text === cues[i].text)) return;
    this.cues = cues;
    this.source = found.source;
    this.info = { ...this.info, lang: found.lang, source: found.source, complete, label: found.label };
    this.dirty.clear();
    this.fullPending = true;
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
    const read = readTextTrack(media, this.track, this.trackCount);
    if (!read) return;
    this.track = read.track;
    this.trackCount = read.count;
    if (!read.cues.length) return;
    this.cues = read.cues;
    this.source = 'track';
    this.info = { ...this.info, lang: read.lang, source: 'track', complete: true, label: read.label };
    this.dirty.clear();
    this.fullPending = true;
  }

  // --- 3. Caption list of the platform ------------------------------------------------------

  private async loadYouTube(noteId: string): Promise<void> {
    this.platformTried = noteId;
    const videoId = noteId.replace(/^youtube:/, '');
    try {
      const found = await youtubeCaptions(videoId);
      if (!found || this.noteId !== noteId || this.source === 'track' || this.source === 'platform') return;
      if ('none' in found) {
        this.none = true;
        return;
      }
      this.cues = found.cues;
      this.source = 'platform';
      this.info = { ...this.info, lang: found.lang, source: 'platform', complete: true, label: found.label };
      this.dirty.clear();
      this.fullPending = true;
    } catch {
      // Not available (no captions, format changed): the player's download or the live capture takes over.
    }
  }

  // --- 4. Subtitles displayed on screen ----------------------------------------------------------

  private sampleLive(lines: string[] | null, time: number, playing: boolean): void {
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
    // Not kept yet (no note, panel closed): no use sending everything again and again.
    if (this.refused && !engaged && now - this.lastFlush < RETRY_REFUSED_MS) return;
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
    if (this.noteId !== noteId) return;
    this.refused = !stored;
    if (stored) return;
    // Not kept (no note yet): everything is sent again once the user takes notes.
    if (replace) this.fullPending = true;
    else {
      for (const c of this.cues) this.dirty.add(c.id);
      if (covered) this.pendingCover = this.pendingCover ? [Math.min(covered[0], this.pendingCover[0]), Math.max(covered[1], this.pendingCover[1])] : covered;
    }
  }
}

// --- Player tracks --------------------------------------------------------------------------

/**
 * The subtitles of the media's text tracks (the one shown, else the page's
 * language, else the first); null when unchanged since `count` cues were read.
 */
export function readTextTrack(
  media: HTMLMediaElement,
  current: TextTrack | null,
  count: number,
): { track: TextTrack; count: number; cues: Cue[]; lang: string; label: string } | null {
  let tracks: TextTrack[];
  try {
    tracks = [...media.textTracks].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
  } catch {
    return null;
  }
  if (!tracks.length) return null;
  const pageLang = document.documentElement.lang.split('-')[0];
  const track =
    tracks.find((t) => t.mode === 'showing') ??
    (current && tracks.includes(current) ? current : null) ??
    tracks.find((t) => t.language && t.language.split('-')[0] === pageLang) ??
    tracks[0];
  // A disabled track loads its cues once hidden (never shown by us).
  if (track.mode === 'disabled') track.mode = 'hidden';
  const list = track.cues;
  const n = list?.length ?? 0;
  if (!list || n === 0 || (track === current && n === count)) return track === current ? null : { track, count: -1, cues: [], lang: '', label: '' };
  const raw: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < n; i++) {
    const c = list[i] as TextTrackCue & { text?: string };
    if (typeof c.text === 'string') raw.push({ start: c.startTime, end: c.endTime, text: c.text });
  }
  const cues = compactCues(raw);
  if (!looksLikeSubtitles(cues)) return { track, count: n, cues: [], lang: '', label: '' };
  const lang = track.language || '';
  return { track, count: n, cues, lang, label: `Sous-titres du lecteur · ${track.label || (lang ? languageName(lang) : 'langue inconnue')}` };
}

// --- Subtitle files downloaded by the player ---------------------------------------------------

/** Language named in a subtitles URL: `lang=`, `srclang=`, `…_en.vtt`, `/fr-FR/…`. */
function urlLanguage(url: URL | null): string {
  if (!url) return '';
  const q = url.searchParams;
  const param = q.get('tlang') || q.get('lang') || q.get('language') || q.get('srclang') || q.get('locale');
  if (param && /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?$/i.test(param)) return param.replace('_', '-');
  const m =
    /(?:^|[/._-])([a-z]{2}(?:[-_][A-Z]{2})?)(?:[/._-](?:auto|cc|sdh|forced))?\.(?:vtt|webvtt|srt|ttml|dfxp)$/.exec(url.pathname) ??
    /[/._-]([a-z]{2}(?:-[A-Z]{2})?)\//.exec(url.pathname);
  const code = m ? m[1].replace('_', '-') : '';
  // Only real languages (« us », « hd » in a path are not).
  return code && languageName(code) !== code ? code : '';
}

/** A file handed by the main-world bridge, as subtitles; null when it holds none. */
export function captionFile(p: CaptionFilePayload, base = location.href): FoundCaptions | null {
  const read = readCaptionFile(p.body);
  const cues = read.cues;
  if (!cues.length || !looksLikeSubtitles(cues)) return null;
  let url: URL | null = null;
  try {
    url = new URL(p.url, base);
  } catch {
    url = null;
  }
  const lang = read.lang || urlLanguage(url);
  const name = lang ? languageName(lang) : 'langue inconnue';
  if (url && /(?:^|\.)youtube(?:-nocookie)?\.com$/.test(url.hostname) && url.pathname.endsWith('/api/timedtext')) {
    const auto = url.searchParams.get('kind') === 'asr' ? ' (automatiques)' : '';
    const translated = url.searchParams.get('tlang') ? ' (traduction YouTube)' : '';
    return { cues, lang, source: 'platform', complete: true, label: `Sous-titres YouTube · ${name}${auto}${translated}`, ...(translated ? { translated: true } : {}) };
  }
  // A stream's subtitles come in pieces of a few seconds (HLS): each one is short.
  const span = (cues.at(-1)?.end ?? 0) - cues[0].start;
  return { cues, lang, source: 'track', complete: span > 120 || cues.length > 40, label: `Sous-titres du lecteur · ${name}` };
}

// --- Subtitles on screen ---------------------------------------------------------------------

/**
 * Text of the subtitle lines on screen; null when no subtitles are displayed.
 * Known players first; else (with `media`) the caption-looking elements drawn
 * over the video.
 */
export function readLiveLines(root: ParentNode = document, media: HTMLMediaElement | null = null): string[] | null {
  for (const sel of LIVE_LINES) {
    const els = [...root.querySelectorAll<HTMLElement>(sel)];
    if (!els.length) continue;
    const visible = els.filter((el) => el.getClientRects().length > 0);
    return visible.map((el) => el.textContent ?? '').filter((t) => t.trim());
  }
  return media instanceof HTMLVideoElement ? genericLines(media) : null;
}

/** Subtitles of an unknown player: short texts over the video, in elements named like captions. */
function genericLines(video: HTMLVideoElement): string[] | null {
  const box = video.getBoundingClientRect();
  if (box.width < 160 || box.height < 90) return null;
  const scope = video.closest('[class*="player" i], [id*="player" i]') ?? video.parentElement?.parentElement ?? null;
  if (!scope) return null;
  const found = [...scope.querySelectorAll<HTMLElement>(GENERIC_LINES)].filter((el) => {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (isControlClass(cls) || el.closest('button, [role="button"], [role="menu"], [role="menuitem"], [role="dialog"], [role="slider"], select')) return false;
    if (el.querySelector('button, input, select, svg, [role="button"], [role="menu"]')) return false;
    const r = el.getBoundingClientRect();
    if (!el.getClientRects().length) return false;
    // Over the picture, its lower two thirds (where subtitles are drawn).
    return r.bottom > box.top + box.height / 3 && r.top < box.bottom && r.right > box.left && r.left < box.right;
  });
  if (!found.length) return null;
  const leaves = found.filter((el) => !found.some((o) => o !== el && el.contains(o)));
  const lines = leaves.flatMap((el) => (el.innerText || el.textContent || '').split('\n')).map(cleanCueText).filter((t) => t && t.length <= 300);
  return lines;
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

const trackName = (t: YouTubeTrack): string => t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? '';

/**
 * The transcript of a video as YouTube's « Afficher la transcription » panel
 * gets it (`/youtubei/v1/get_transcript`): segments, and the language selected.
 */
export function parseYouTubeTranscript(json: unknown): { cues: Cue[]; language: string } {
  const raw: Array<{ start: number; end: number; text: string }> = [];
  let language = '';
  const text = (v: unknown): string => {
    const o = v as { simpleText?: string; runs?: Array<{ text?: string }> } | null;
    return o?.simpleText ?? o?.runs?.map((r) => r.text ?? '').join('') ?? '';
  };
  let budget = 500_000;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || budget-- <= 0) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const o = node as Record<string, unknown>;
    const seg = o.transcriptSegmentRenderer as { startMs?: string; endMs?: string; snippet?: unknown } | undefined;
    if (seg) {
      const start = Number(seg.startMs) / 1000;
      const end = Number(seg.endMs) / 1000;
      if (Number.isFinite(start)) raw.push({ start, end: Number.isFinite(end) ? end : start + 2, text: text(seg.snippet) });
      return;
    }
    const cue = o.transcriptCueRenderer as { cue?: unknown; startOffsetMs?: string; durationMs?: string } | undefined;
    if (cue) {
      const start = Number(cue.startOffsetMs) / 1000;
      if (Number.isFinite(start)) raw.push({ start, end: start + (Number(cue.durationMs) || 2000) / 1000, text: text(cue.cue) });
      return;
    }
    if (Array.isArray(o.subMenuItems)) {
      const selected = (o.subMenuItems as Array<{ title?: string; selected?: boolean }>).find((i) => i.selected);
      if (selected?.title) language = selected.title;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(json);
  return { cues: compactCues(raw), language };
}

/** A string of the page's JSON (`"…\\u0026…"`) decoded. */
function jsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

const lowerFirst = (s: string) => s.charAt(0).toLocaleLowerCase('fr') + s.slice(1);

type YouTubeFound = { cues: Cue[]; lang: string; label: string } | { none: true };

async function youtubeCaptions(videoId: string): Promise<YouTubeFound | null> {
  const page = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: 'include' });
  if (!page.ok) return null;
  const html = await page.text();
  const tracks = ((extractJsonArray(html, '"captionTracks":') ?? []) as YouTubeTrack[]).filter((t) => typeof t?.baseUrl === 'string');
  if (!tracks.length) return /ytInitialPlayerResponse/.test(html) && /"playabilityStatus":\{"status":"OK"/.test(html) ? { none: true } : null;
  const track = pickYouTubeTrack(tracks);
  if (!track) return null;
  const lang = track.languageCode ?? '';
  const name = trackName(track) || (lang ? languageName(lang) : '');
  const auto = track.kind === 'asr' && !/auto/i.test(name) ? ' (automatiques)' : '';

  // 1. The captions file (served without the player's token for a few videos only).
  try {
    const url = new URL(track.baseUrl, location.origin);
    if (url.origin === location.origin) {
      url.searchParams.set('fmt', 'json3');
      const res = await fetch(url, { credentials: 'include' });
      const body = res.ok ? await res.text() : '';
      const cues = body.trim() ? parseYouTubeJson3(JSON.parse(body)) : [];
      if (cues.length) return { cues, lang, label: `Sous-titres YouTube · ${name}${auto}` };
    }
  } catch {
    // Next way.
  }

  // 2. The transcript of the video (its « Afficher la transcription » panel).
  const params = /"getTranscriptEndpoint":\{"params":"([^"]+)"/.exec(html)?.[1];
  if (!params) return null;
  const version = /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1] ?? '2.20250101.00.00';
  const visitor = /"VISITOR_DATA":"([^"]+)"/.exec(html)?.[1];
  const hl = /"INNERTUBE_CONTEXT_HL":"([^"]+)"/.exec(html)?.[1] ?? 'fr';
  const key = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1];
  const body = JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion: version, hl, ...(visitor ? { visitorData: jsonString(visitor) } : {}) } },
    params: jsonString(params),
  });
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-youtube-client-name': '1', 'x-youtube-client-version': version };
  if (visitor) headers['x-goog-visitor-id'] = jsonString(visitor);
  for (const credentials of ['include', 'omit'] as const) {
    try {
      const res = await fetch(`/youtubei/v1/get_transcript?prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ''}`, { method: 'POST', credentials, headers, body });
      if (!res.ok) continue;
      const found = parseYouTubeTranscript(await res.json());
      if (!found.cues.length) continue;
      // The language shown by the panel, matched to the caption tracks.
      const picked = tracks.find((t) => found.language && trackName(t) === found.language) ?? (found.language ? null : track);
      const code = picked?.languageCode ?? (/auto/i.test(found.language) ? (tracks.find((t) => t.kind === 'asr')?.languageCode ?? '') : '');
      const label = found.language ? lowerFirst(found.language) : name;
      return { cues: found.cues, lang: code, label: `Sous-titres YouTube · ${label}${picked?.kind === 'asr' && !/auto/i.test(label) ? ' (automatiques)' : ''}` };
    } catch {
      // Next attempt.
    }
  }
  return null;
}
