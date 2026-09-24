import { noteSlug } from './platforms';

function extOf(name: string): string {
  return /\.([a-z0-9]{2,5})$/i.exec(name)?.[1].toLowerCase() ?? '';
}

/**
 * A video or audio pasted into a note: its file among the note's media,
 * `media/<note>-file-<name>-<nonce>.<ext>` (extension and desktop app alike).
 */
export function pastedMediaPath(noteId: string, name: string, mime: string, nonce: string): string {
  const fromMime = /\/(mp4|webm|ogg|mpeg|wav|x-m4a|quicktime)/.exec(mime)?.[1] ?? 'bin';
  const ext = extOf(name) || ({ mpeg: 'mp3', 'x-m4a': 'm4a', quicktime: 'mov' } as Record<string, string>)[fromMime] || fromMime;
  const base =
    name
      .replace(/\.[^.]*$/, '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'media';
  return `media/${noteSlug(noteId)}-file-${base}-${nonce}.${ext}`;
}
