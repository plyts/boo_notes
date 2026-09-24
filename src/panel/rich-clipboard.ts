import { isPlainHtml } from '../shared/html-markdown';
import { toPortableMarkdown } from '../shared/markdown';
export { pastedMediaPath } from '../shared/media-paths';

/**
 * Copy and paste « tout compris » in the notes (extension panel and desktop
 * app): what a paste holds, pictures made ready for the note, pasted videos
 * and audios named and filed, and Boo Notes' own clipboard format — a copy
 * from a note keeps its screenshots, passages, extracts and timestamps when
 * pasted into another note.
 */

/** Boo Notes' own clipboard format: the Markdown as written, and where it comes from. */
export const BOO_CLIP_TYPE = 'application/x-boo-notes';

export interface BooClip {
  v: 1;
  noteId: string;
  /** Page of the note's media or article ('' when none). */
  url: string;
  /** Its timestamps are moments of that media. */
  timed: boolean;
  markdown: string;
}

export function writeBooClip(data: DataTransfer, clip: Omit<BooClip, 'v'>): void {
  data.setData(BOO_CLIP_TYPE, JSON.stringify({ v: 1, ...clip }));
}

export function readBooClip(data: DataTransfer): BooClip | null {
  const raw = data.getData(BOO_CLIP_TYPE);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<BooClip>;
    if (c.v !== 1 || typeof c.markdown !== 'string' || typeof c.noteId !== 'string') return null;
    return { v: 1, noteId: c.noteId, url: typeof c.url === 'string' ? c.url : '', timed: c.timed === true, markdown: c.markdown };
  } catch {
    return null;
  }
}

/**
 * A clip pasted into a note: as is into its own note; from another video,
 * its bare timestamps are linked to that video's moments (they would
 * otherwise point into this one).
 */
export function adaptClip(clip: BooClip, noteId: string): string {
  if (clip.noteId === noteId || !clip.timed || !/^https?:\/\//.test(clip.url)) return clip.markdown;
  return toPortableMarkdown({ title: '', url: clip.url, platform: 'web', markdown: clip.markdown, createdAt: 0, updatedAt: 0 }, { frontMatter: false });
}

export type MediaFileKind = 'image' | 'video' | 'audio';

const EXT_KIND: Record<string, MediaFileKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', avif: 'image', svg: 'image', heic: 'image',
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', mkv: 'video', ogv: 'video',
  mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', flac: 'audio', weba: 'audio',
};

const extOf = (name: string) => /\.([a-z0-9]{2,5})$/i.exec(name)?.[1].toLowerCase() ?? '';

/** Picture, video or audio (by type, else by extension); null for other files. */
export function fileKind(file: { type: string; name: string }): MediaFileKind | null {
  const major = file.type.split('/')[0];
  if (major === 'image' || major === 'video' || major === 'audio') return major;
  return EXT_KIND[extOf(file.name)] ?? null;
}

/** What a paste (or a drop) brings, best first. */
export type PasteContent =
  | { kind: 'clip'; clip: BooClip }
  | { kind: 'files'; files: File[]; skipped: string[] }
  | { kind: 'html'; html: string }
  | { kind: 'text' };

/** Only pictures and no text: « Copier l’image » of a browser, a picture copied from an app. */
function onlyPictures(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return !doc.body.textContent?.trim() && doc.body.querySelector('img') !== null;
}

/** Read during the event (the clipboard is emptied right after it). */
export function classifyPaste(data: DataTransfer): PasteContent {
  const clip = readBooClip(data);
  if (clip) return { kind: 'clip', clip };
  const files = [...data.files];
  const html = data.getData('text/html');
  // Word and Excel also put a picture of the copied text: the text wins then.
  const useFiles = files.length > 0 && (!html || onlyPictures(html) || isPlainHtml(html));
  if (useFiles) {
    const media = files.filter((f) => fileKind(f) !== null);
    const skipped = files.filter((f) => fileKind(f) === null).map((f) => f.name || f.type || 'fichier');
    if (media.length || skipped.length) return { kind: 'files', files: media, skipped };
  }
  if (html && !isPlainHtml(html)) return { kind: 'html', html };
  return { kind: 'text' };
}

// --- Pictures -----------------------------------------------------------------------------

export interface PreparedImage {
  dataUrl: string;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
}

/** Longest side kept for a pasted picture: sharp in the notes, light in storage and sync. */
const MAX_SIDE = 2400;
/** A picture already in a stored format and this light is kept byte for byte. */
const KEEP_BYTES = 1_500_000;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Lecture impossible'));
    r.readAsDataURL(blob);
  });
}

async function decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  try {
    const bmp = await createImageBitmap(blob);
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    // SVG and a few others: through an <img>.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const width = img.naturalWidth || 1200;
      const height = img.naturalHeight || 800;
      return { source: img, width, height, close: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw new Error('Image illisible', { cause: e });
    }
  }
}

/**
 * A picture for the note: PNG, JPEG or WebP, at most 2400 px wide or high.
 * Light pictures in those formats are kept as they are; others are redrawn
 * (PNG when small, else JPEG on white).
 */
export async function prepareImage(blob: Blob): Promise<PreparedImage> {
  const img = await decode(blob);
  try {
    const keep = (blob.type === 'image/png' || blob.type === 'image/jpeg' || blob.type === 'image/webp') && blob.size <= KEEP_BYTES;
    if (keep && Math.max(img.width, img.height) <= MAX_SIDE) {
      return { dataUrl: await blobToDataUrl(blob), mime: blob.type as PreparedImage['mime'], width: img.width, height: img.height };
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img.source, 0, 0, width, height);
    const png = canvas.toDataURL('image/png');
    // Base64 is 4/3 of the bytes.
    if (png.length * 0.75 <= KEEP_BYTES) return { dataUrl: png, mime: 'image/png', width, height };
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), mime: 'image/jpeg', width, height };
  } finally {
    img.close();
  }
}

/** A `data:` URL as a Blob, without a request (some pages forbid fetching them). */
export function dataUrlToBlob(url: string): Blob {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(url);
  if (!m) throw new Error('Adresse de données invalide');
  const bytes = m[3] ? Uint8Array.from(atob(m[4]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[4]));
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
}

/** A picture's bytes: a data URL decoded, anything else fetched. */
export async function pictureBlob(src: string): Promise<Blob> {
  if (src.startsWith('data:')) return dataUrlToBlob(src);
  const res = await fetch(src, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Image introuvable (${res.status})`);
  return res.blob();
}

/** A picture as PNG (the only picture type every clipboard takes). */
export async function toPngBlob(src: string): Promise<Blob> {
  const blob = await pictureBlob(src);
  if (blob.type === 'image/png') return blob;
  const img = await decode(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d')!.drawImage(img.source, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Conversion impossible'))), 'image/png'));
  } finally {
    img.close();
  }
}

// --- Videos and audios --------------------------------------------------------------------

/** Largest video or audio a paste keeps in the notes (IndexedDB, then the desktop app). */
export const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

/** Its line in the note: a chip that plays it, named like the file. */
export function mediaFileLine(name: string, path: string, kind: 'video' | 'audio', timestamp: string | null): string {
  const label = `${kind === 'video' ? '🎬' : '🎵'} ${name.replace(/[[\]\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || (kind === 'video' ? 'Vidéo' : 'Audio')}`;
  return `${timestamp ? `${timestamp} ` : ''}[${label}](${path})`;
}

/** The line of a pasted picture: at the moment of the media when there is one (a card, like a capture). */
export function imageLine(path: string, alt: string, timestamp: string | null): string {
  const clean = alt.replace(/[[\]\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return timestamp ? `${timestamp} ![${clean || 'Image collée'} ${timestamp.slice(1, -1)}](${path})` : `![${clean || 'Image collée'}](${path})`;
}
