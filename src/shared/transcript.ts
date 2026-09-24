import { noteSlug } from './platforms';
import { formatTimecode } from './time';

/**
 * Transcription of a video or audio: its timed subtitles, captured while the
 * media plays and kept apart from the personal notes. Each line (« réplique »)
 * may carry the user's translation and comment. Pure data and helpers,
 * shared by the extension, its panel and the desktop app.
 */

export interface Cue {
  /** Stable id (from the start time): translations and comments survive merges. */
  id: string;
  /** Seconds. */
  start: number;
  end: number;
  text: string;
  /** Translation (target language of the transcript). */
  tr?: string;
  /** The user's comment. */
  note?: string;
}

/** `track`: subtitles file of the player; `platform`: the platform's caption list; `live`: captured as displayed; `file`: .vtt / .srt imported. */
export type TranscriptSource = 'track' | 'platform' | 'live' | 'file';

export interface Transcript {
  noteId: string;
  /** Language of the subtitles (BCP 47), '' when unknown. */
  lang: string;
  /** Where they come from, for people: « Sous-titres YouTube · anglais (automatiques) ». */
  label: string;
  source: TranscriptSource;
  /** Language translations are written in. */
  target: string;
  /** The whole media is covered (a subtitles file); live captures grow as the media plays. */
  complete: boolean;
  /** Stretches of the media (seconds) watched while captions were captured. */
  covered: Array<[number, number]>;
  /** Media duration (s), 0 if unknown. */
  duration: number;
  cues: Cue[];
  updatedAt: number;
  rev: number;
}

export function emptyTranscript(noteId: string, init: Partial<Transcript> = {}): Transcript {
  return {
    noteId,
    lang: '',
    label: 'Sous-titres',
    source: 'live',
    target: 'fr',
    complete: false,
    covered: [],
    duration: 0,
    cues: [],
    updatedAt: Date.now(),
    rev: 0,
    ...init,
  };
}

const SOURCES: TranscriptSource[] = ['track', 'platform', 'live', 'file'];
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A transcript received from elsewhere (network, file), checked field by field; null when unusable. */
export function normalizeTranscript(raw: unknown): Transcript | null {
  const r = raw as Partial<Record<keyof Transcript, unknown>> | null;
  if (!r || typeof r.noteId !== 'string' || !r.noteId || !Array.isArray(r.cues)) return null;
  const cues: Cue[] = [];
  for (const c of r.cues.slice(0, 50_000) as Array<Partial<Record<keyof Cue, unknown>>>) {
    if (!c || typeof c.text !== 'string' || typeof c.start !== 'number' || !Number.isFinite(c.start)) continue;
    const cue: Cue = { id: str(c.id, 40) || cueId(c.start), start: Math.max(0, c.start), end: Math.max(num(c.end), c.start), text: c.text.slice(0, 2000) };
    if (typeof c.tr === 'string' && c.tr.trim()) cue.tr = c.tr.slice(0, 2000);
    if (typeof c.note === 'string' && c.note.trim()) cue.note = c.note.slice(0, 2000);
    cues.push(cue);
  }
  const covered = Array.isArray(r.covered)
    ? (r.covered as unknown[]).filter((x): x is [number, number] => Array.isArray(x) && x.length === 2 && x.every((n) => typeof n === 'number' && Number.isFinite(n)))
    : [];
  return {
    noteId: r.noteId.slice(0, 300),
    lang: str(r.lang, 35),
    label: str(r.label, 200) || 'Sous-titres',
    source: SOURCES.includes(r.source as TranscriptSource) ? (r.source as TranscriptSource) : 'live',
    target: str(r.target, 35) || 'fr',
    complete: r.complete === true,
    covered,
    duration: num(r.duration),
    cues: sortCues(cues),
    updatedAt: num(r.updatedAt) || Date.now(),
    rev: Math.max(0, Math.floor(num(r.rev))),
  };
}

export function cueId(start: number): string {
  return `c${Math.round(start * 100)}`;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  ndash: '–',
  mdash: '—',
};

/** Subtitle markup removed (`<c>`, `<i>`, `<v Nom>`, karaoke timestamps), entities decoded, spaces collapsed. */
export function cleanCueText(raw: string): string {
  return raw
    .replace(/<[^>\n]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&(#?\w+);/g, (all, name: string) => {
      if (ENTITIES[name]) return ENTITIES[name];
      const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : name.startsWith('#') ? Number(name.slice(1)) : NaN;
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function vttTime(label: string): number {
  const parts = label.replace(',', '.').split(':').map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

/** Gives every cue a unique id, in time order. */
export function sortCues(cues: Cue[]): Cue[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const seen = new Set<string>();
  for (const c of sorted) {
    let id = c.id || cueId(c.start);
    for (let n = 1; seen.has(id); n++) id = `${cueId(c.start)}-${n}`;
    c.id = id;
    seen.add(id);
  }
  return sorted;
}

/**
 * Cues in time order, cleaned; a line repeated by rolling captions (same text
 * right after itself) becomes one longer cue.
 */
export function compactCues(raw: Array<{ start: number; end: number; text: string }>): Cue[] {
  const out: Cue[] = [];
  for (const r of [...raw].sort((a, b) => a.start - b.start)) {
    const text = cleanCueText(r.text);
    if (!text || !Number.isFinite(r.start)) continue;
    const end = Number.isFinite(r.end) ? Math.max(r.end, r.start) : r.start;
    const prev = out.at(-1);
    if (prev && prev.text === text && r.start - prev.end < 0.5) {
      prev.end = Math.max(prev.end, end);
      continue;
    }
    out.push({ id: '', start: r.start, end, text });
  }
  return sortCues(out);
}

/** WebVTT or SubRip (.srt) → cues. Styles, regions and notes are skipped; duplicate consecutive lines merged. */
export function parseVtt(text: string): Cue[] {
  const blocks = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split(/\n{2,}/);
  const out: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => TIMING.test(l));
    if (i === -1) continue;
    const m = TIMING.exec(lines[i])!;
    const body = cleanCueText(lines.slice(i + 1).join('\n'));
    if (!body) continue;
    const start = vttTime(m[1]);
    const end = vttTime(m[2]);
    const prev = out.at(-1);
    // Rolling captions repeat the previous line: keep one cue, extended.
    if (prev && prev.text === body && start - prev.end < 0.5) {
      prev.end = Math.max(prev.end, end);
      continue;
    }
    out.push({ id: '', start, end: Math.max(end, start), text: body });
  }
  return sortCues(out);
}

/** YouTube caption track in `json3` format (`{ events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }`). */
export function parseYouTubeJson3(json: unknown): Cue[] {
  const events = (json as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> })?.events;
  if (!Array.isArray(events)) return [];
  const out: Cue[] = [];
  for (const e of events) {
    if (!e.segs || typeof e.tStartMs !== 'number') continue;
    const text = cleanCueText(e.segs.map((s) => s.utf8 ?? '').join(''));
    if (!text) continue;
    const start = e.tStartMs / 1000;
    out.push({ id: '', start, end: start + (e.dDurationMs ?? 2000) / 1000, text });
  }
  return sortCues(out);
}

/** A user edit of one cue: `null` (or blank) clears the field. */
export interface CuePatch {
  id: string;
  tr?: string | null;
  note?: string | null;
}

/** Translations and comments applied to the cues they name. */
export function annotateCues(cues: Cue[], patches: CuePatch[]): Cue[] {
  const byId = new Map(patches.map((p) => [p.id, p]));
  return cues.map((c) => {
    const p = byId.get(c.id);
    if (!p) return c;
    const next = { ...c };
    for (const field of ['tr', 'note'] as const) {
      const v = p[field];
      if (v === undefined) continue;
      if (v === null || !v.trim()) delete next[field];
      else next[field] = v.slice(0, 2000);
    }
    return next;
  });
}

/** Union of two cue lists: `incoming` updates text and timing, the user's translations and comments are kept. */
export function mergeCues(base: Cue[], incoming: Cue[]): Cue[] {
  const byId = new Map(base.map((c) => [c.id, c]));
  for (const c of incoming) {
    const prev = byId.get(c.id);
    byId.set(c.id, prev ? { ...c, tr: c.tr ?? prev.tr, note: c.note ?? prev.note } : c);
  }
  return sortCues([...byId.values()]);
}

/** A better source replaces the cues of a weaker one: a subtitles file beats a live capture. */
export const SOURCE_RANK: Record<TranscriptSource, number> = { live: 0, platform: 1, track: 2, file: 3 };

/**
 * `to` with the translations and comments of `from` moved over, cue by cue
 * (the cue of `to` being spoken when the old one started): used when a
 * better source replaces the cues.
 */
export function carryAnnotations(from: Cue[], to: Cue[]): Cue[] {
  const out = to.map((c) => ({ ...c }));
  for (const old of from) {
    if (!old.tr && !old.note) continue;
    let i = lastStartingBefore(out, old.start + 0.75);
    if (i === -1) i = 0;
    const c = out[i];
    if (!c) continue;
    if (old.tr && !c.tr) c.tr = old.tr;
    if (old.note) c.note = c.note && c.note !== old.note ? `${c.note}\n${old.note}` : old.note;
  }
  return out;
}

/** Index of the last cue starting at or before `time`, -1 if none. */
function lastStartingBefore(cues: Cue[], time: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The cue being spoken at `time` (or the last one before it, within 2 s after its end); -1 if none. */
export function cueIndexAt(cues: Cue[], time: number): number {
  const i = lastStartingBefore(cues, time);
  if (i === -1) return -1;
  return time <= cues[i].end + 2 ? i : -1;
}

/**
 * Live capture: the subtitle lines on screen at `time` are folded into the
 * cues. Rolling captions (words appearing one by one, a line moving up) grow
 * the cue they started; a new line starts a new cue. Returns true if the cues
 * changed. `cues` must be sorted; it is updated in place.
 */
export function applyLiveSample(cues: Cue[], time: number, lines: string[]): boolean {
  const shown = lines.map(cleanCueText).filter(Boolean);
  let changed = false;
  shown.forEach((line, i) => {
    // Recent cues only: an identical sentence minutes later is a new line.
    const hi = lastStartingBefore(cues, time + 0.5);
    let match: Cue | undefined;
    for (let k = hi; k >= 0 && cues[k].end >= time - 15; k--) {
      const c = cues[k];
      if (c.text === line || line.startsWith(c.text) || c.text.startsWith(line)) {
        match = c;
        break;
      }
    }
    if (match) {
      if (line.length > match.text.length && line.startsWith(match.text)) {
        match.text = line;
        changed = true;
      }
      if (time > match.end) {
        match.end = time;
        changed = true;
      }
      return;
    }
    const start = Math.max(0, time + i * 0.01);
    const cue: Cue = { id: '', start, end: start + 0.5, text: line };
    const at = lastStartingBefore(cues, start) + 1;
    cues.splice(at, 0, cue);
    let id = cueId(start);
    for (let n = 1; cues.some((c) => c !== cue && c.id === id); n++) id = `${cueId(start)}-${n}`;
    cue.id = id;
    changed = true;
  });
  return changed;
}

/** Adds [a, b] to sorted, disjoint ranges (gaps under 2 s are bridged). */
export function addCoverage(ranges: Array<[number, number]>, a: number, b: number): Array<[number, number]> {
  if (!(b > a)) return ranges;
  const all = [...ranges, [a, b] as [number, number]].sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of all) {
    const last = out.at(-1);
    if (last && s <= last[1] + 2) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function coverageRatio(t: Pick<Transcript, 'complete' | 'covered' | 'duration'>): number {
  if (t.complete) return 1;
  if (!t.duration) return 0;
  return Math.min(1, t.covered.reduce((sum, [a, b]) => sum + (b - a), 0) / t.duration);
}

export function cuesInRange(cues: Cue[], start: number, end: number): Cue[] {
  return cues.filter((c) => c.end > start && c.start < end);
}

// --- Labels ------------------------------------------------------------------------------------

export function languageName(code: string): string {
  if (!code) return 'langue inconnue';
  try {
    return new Intl.DisplayNames(['fr'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** « anglais → français », « français ». */
export function languagesLabel(t: Pick<Transcript, 'lang' | 'target' | 'cues'>): string {
  const from = t.lang ? languageName(t.lang) : '';
  const translated = t.cues.some((c) => c.tr);
  const base = t.lang && t.target && t.lang.split('-')[0] === t.target.split('-')[0];
  if (translated && !base) return `${from || 'original'} → ${languageName(t.target)}`;
  return from || 'sous-titres';
}

// --- Files and note lines ------------------------------------------------------------------------

export function transcriptPath(noteId: string, ext: 'md' | 'vtt' | 'json'): string {
  return `transcripts/${noteSlug(noteId)}.${ext}`;
}

/** The attachment line pinned at the end of the note. */
export function transcriptLine(t: Transcript): string {
  const n = t.cues.length;
  return `📄 [Transcription — ${languagesLabel(t)} · ${n} réplique${n > 1 ? 's' : ''}](${transcriptPath(t.noteId, 'md')})`;
}

export const TRANSCRIPT_LINE = /^📄 \[[^\]\n]*\]\((transcripts\/[^)\s]+)\)[ \t]*$/;

/** The line of the note that pins the transcript, and its position. */
export function findTranscriptLine(markdown: string): { from: number; to: number; path: string } | null {
  let pos = 0;
  for (const line of markdown.split('\n')) {
    const m = TRANSCRIPT_LINE.exec(line);
    if (m) return { from: pos, to: pos + line.length, path: m[1] };
    pos += line.length + 1;
  }
  return null;
}

/** The note with the transcript line added at its end, or updated where it already is. */
export function pinTranscriptLine(markdown: string, line: string): string {
  const found = findTranscriptLine(markdown);
  if (found) return markdown.slice(0, found.from) + line + markdown.slice(found.to);
  const body = markdown.replace(/\s+$/, '');
  return body ? `${body}\n\n${line}\n` : `${line}\n`;
}

/** A cue quoted in the note: `> [04:12] « text » — *traduction*`. */
export function cueQuote(cue: Cue): string {
  const tr = cue.tr?.trim() ? ` — *${cue.tr.trim()}*` : '';
  return `> [${formatTimecode(cue.start)}] « ${cue.text} »${tr}`;
}

/** Readable transcript: one paragraph per cue, translation in italics, comment after 💬. */
export function transcriptToMarkdown(t: Transcript, meta: { title: string; url?: string }): string {
  const lines = [`# Transcription — ${meta.title}`, '', `${t.label} · ${languagesLabel(t)}${meta.url ? ` · [source](${meta.url})` : ''}`, ''];
  for (const c of t.cues) {
    lines.push(`[${formatTimecode(c.start)}] ${c.text}`);
    if (c.tr?.trim()) lines.push(`*${c.tr.trim()}*`);
    if (c.note?.trim()) lines.push(`💬 ${c.note.trim()}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function vttStamp(s: number): string {
  const ms = Math.round(Math.max(0, s) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms % 1000, 3)}`;
}

/** WebVTT of the original subtitles, or of the translation (`translated`). */
export function transcriptToVtt(t: Transcript, translated = false): string {
  const body = t.cues
    .map((c) => ({ c, text: translated ? c.tr?.trim() || c.text : c.text }))
    .map(({ c, text }) => `${vttStamp(c.start)} --> ${vttStamp(Math.max(c.end, c.start + 0.5))}\n${text}`);
  return `WEBVTT\n\n${body.join('\n\n')}\n`;
}

// --- Passages ------------------------------------------------------------------------------------

/**
 * A passage (extract) of a media, written as one note line:
 *   `[02:05–06:07] ![Passage 02:05–06:07 · Titre](assets/….jpg) [Extrait](media/….webm)`
 * The image is its first frame; the recorded extract (image + sound, or sound) is optional.
 */
export interface PassageMatch {
  from: number;
  to: number;
  start: number;
  end: number;
  title: string;
  image: string;
  media: string | null;
}

const RANGE = String.raw`((?:\d+:)?\d{1,3}:\d{2})\s?[–-]\s?((?:\d+:)?\d{1,3}:\d{2})`;
export const PASSAGE_LINE = new RegExp(
  String.raw`^\[${RANGE}\]\s+!\[Passage[^\]\n]*?(?:·\s*([^\]\n]*))?\]\((assets\/[^)\s]+)\)(?:\s+\[[^\]\n]*\]\((media\/[^)\s]+)\))?[ \t]*$`,
);

function seconds(label: string): number {
  const p = label.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

export function rangeLabel(start: number, end: number): string {
  return `${formatTimecode(start)}–${formatTimecode(end)}`;
}

export function passageLine(p: { start: number; end: number; title?: string; image: string; media?: string | null }): string {
  const range = rangeLabel(p.start, p.end);
  const title = p.title?.replace(/[[\]\n]/g, ' ').replace(/\s+/g, ' ').trim();
  const media = p.media ? ` [Extrait](${p.media})` : '';
  return `[${range}] ![Passage ${range}${title ? ` · ${title}` : ''}](${p.image})${media}`;
}

export function findPassages(markdown: string): PassageMatch[] {
  const out: PassageMatch[] = [];
  let pos = 0;
  for (const line of markdown.split('\n')) {
    const m = PASSAGE_LINE.exec(line);
    if (m) {
      out.push({
        from: pos,
        to: pos + line.length,
        start: seconds(m[1]),
        end: seconds(m[2]),
        title: m[3]?.trim() ?? '',
        image: m[4],
        media: m[5] ?? null,
      });
    }
    pos += line.length + 1;
  }
  return out;
}

/** Adds (or replaces) the recorded extract of the passage starting at `start`. */
export function setPassageMedia(markdown: string, start: number, media: string): string {
  return markdown
    .split('\n')
    .map((line) => {
      const m = PASSAGE_LINE.exec(line);
      if (!m || seconds(m[1]) !== Math.floor(start)) return line;
      return passageLine({ start: seconds(m[1]), end: seconds(m[2]), title: m[3], image: m[4], media });
    })
    .join('\n');
}

function stamp(start: number): string {
  return formatTimecode(start).replace(/:/g, '-');
}

export function passageImagePath(noteId: string, start: number, nonce: string, ext = 'jpg'): string {
  return `assets/${noteSlug(noteId)}-passage-${stamp(start)}-${nonce}.${ext}`;
}

export function passageMediaPath(noteId: string, start: number, nonce: string, ext = 'webm'): string {
  return `media/${noteSlug(noteId)}-passage-${stamp(start)}-${nonce}.${ext}`;
}

export function traceMediaPath(noteId: string, start: number, nonce: string, ext = 'webm'): string {
  return `media/${noteSlug(noteId)}-audio-${stamp(start)}-${nonce}.${ext}`;
}

/** Recorded media (`media/…`) referenced by a note. */
export function findMediaRefs(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/\]\((media\/[^)\s]+)\)/g)].map((m) => m[1]))];
}

/** Lines of the note anchored inside [start, end] (timestamps), passages excluded. */
export function notesInRange(markdown: string, start: number, end: number): string[] {
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    if (PASSAGE_LINE.test(line)) continue;
    const m = /^(?:\s*(?:[-*+]|\d+[.)]|>)\s+)?\[((?:\d+:)?\d{1,3}:\d{2})\]/.exec(line);
    if (!m) continue;
    const t = seconds(m[1]);
    if (t >= start && t <= end) out.push(line);
  }
  return out;
}
