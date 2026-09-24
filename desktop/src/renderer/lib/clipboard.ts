import type { NotesEditor } from '../../../../src/panel/editor';
import {
  adaptClip,
  classifyPaste,
  fileKind,
  imageLine,
  MAX_MEDIA_BYTES,
  mediaFileLine,
  pictureBlob,
  prepareImage,
  toPngBlob,
  writeBooClip,
} from '../../../../src/panel/rich-clipboard';
import { htmlToMarkdown } from '../../../../src/shared/html-markdown';
import { findAssetRefs, toPortableMarkdown } from '../../../../src/shared/markdown';
import { timestampUrl } from '../../../../src/shared/platforms';
import { renderRichCopy } from '../../../../src/shared/rich-copy';
import { formatTimecode } from '../../../../src/shared/time';

/**
 * Copy and paste « tout compris » in the app's notes, as in the browser
 * panel: pictures, videos and audios pasted or dropped are saved in the
 * notes folder, formatted text keeps its pictures, and a copied part of a
 * note carries its pictures (HTML) and Boo Notes' own format.
 */
export interface ClipNote {
  id: string;
  /** Web page of the note's main media, if any: its moments are linked in a copy. */
  source: string | null;
  /** Its timestamps are moments of a media. */
  timed: boolean;
}

export const vaultUrl = (path: string) => `boo://app/__vault/${path.split('/').map(encodeURIComponent).join('/')}`;

/** Pictures of the notes already read (data URL by path): a copy fills the clipboard at once. */
const assetData = new Map<string, string>();
const loading = new Set<string>();

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Lecture impossible'));
    r.readAsDataURL(blob);
  });
}

/** Reads beforehand the pictures a copy of the note may carry. */
export function preloadAssets(markdown: string): void {
  for (const path of findAssetRefs(markdown)) {
    if (assetData.has(path) || loading.has(path)) continue;
    loading.add(path);
    void fetch(vaultUrl(path))
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(dataUrl)
      .then((d) => assetData.set(path, d))
      .catch(() => undefined)
      .finally(() => loading.delete(path));
  }
}

/** Copy (or cut) of a part of a note: Markdown and HTML with its pictures, and the Boo Notes clip. */
export function copySelection(markdown: string, data: DataTransfer, note: ClipNote): boolean {
  const web = note.source && /^https?:\/\//.test(note.source) ? note.source : null;
  const timeUrl = (s: number) => (web && note.timed ? timestampUrl(web, s) : null);
  const copy = renderRichCopy(
    {
      sourceUrl: web,
      markdown,
      linkify: (md) => (web && note.timed ? toPortableMarkdown({ title: '', url: web, platform: 'web', markdown: md, createdAt: 0, updatedAt: 0 }, { frontMatter: false }) : md),
      context: { anchor: (kind, value) => (kind === 'time' ? { url: timeUrl(value) } : null) },
      timeUrl,
    },
    assetData,
  );
  data.setData('text/plain', copy.markdown.trimEnd());
  data.setData('text/html', copy.html);
  writeBooClip(data, { noteId: note.id, url: web ?? '', timed: note.timed, markdown });
  return true;
}

/** « Copier l’image » of a card. */
export async function copyImage(path: string): Promise<void> {
  const png = toPngBlob(/^https?:\/\//.test(path) ? path : vaultUrl(path));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

type Notify = (text: string, kind: 'success' | 'error' | 'info') => void;

async function saveImage(noteId: string, blob: Blob): Promise<string> {
  const img = await prepareImage(blob);
  const path = await window.boo.library.pasteImage(noteId, img.dataUrl);
  assetData.set(path, img.dataUrl);
  return path;
}

async function pasteFiles(editor: NotesEditor, files: File[], note: ClipNote, now: number | null, notify: Notify): Promise<void> {
  const stamp = now === null ? null : `[${formatTimecode(now)}]`;
  const slots = files.map((file) => ({ file, id: editor.reserve(`Import de ${file.name || 'l’image'}…`) }));
  let done = 0;
  for (const { file, id } of slots) {
    try {
      const kind = fileKind(file);
      if (kind === 'image') {
        const alt = file.name.replace(/\.[^.]*$/, '');
        editor.fill(id, imageLine(await saveImage(note.id, file), alt === 'image' ? '' : alt, stamp));
      } else if (kind === 'video' || kind === 'audio') {
        if (file.size > MAX_MEDIA_BYTES) throw new Error(`${file.name} dépasse ${MAX_MEDIA_BYTES / 1024 / 1024} Mo`);
        const mime = file.type || (kind === 'video' ? 'video/mp4' : 'audio/mpeg');
        const path = await window.boo.library.pasteMedia(note.id, { name: file.name || kind, mime, at: now ?? 0 }, new Uint8Array(await file.arrayBuffer()));
        editor.fill(id, mediaFileLine(file.name, path, kind, stamp));
      } else editor.fill(id, null);
      done++;
    } catch (e) {
      editor.fill(id, null);
      notify(`${file.name || 'Fichier'} non collé : ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }
  if (done) notify(done > 1 ? `${done} fichiers ajoutés à la note` : 'Ajouté à la note', 'success');
}

async function pasteHtml(editor: NotesEditor, html: string, note: ClipNote, notify: Notify): Promise<void> {
  const { markdown, images } = htmlToMarkdown(html);
  const id = editor.reserve(images.length ? `Import de ${images.length} image${images.length > 1 ? 's' : ''}…` : '');
  let text = markdown;
  let kept = 0;
  for (const [i, img] of images.entries()) {
    let target: string | null = null;
    if (i < 40) {
      try {
        // The picture itself (a data URL, or a site that allows it)…
        const blob = await pictureBlob(img.src);
        if (blob.type.startsWith('image/')) target = await saveImage(note.id, blob);
      } catch {
        // …else the app downloads it (no browser restriction there).
        if (/^https?:\/\//.test(img.src)) target = await window.boo.library.pasteImage(note.id, img.src).catch(() => null);
      }
    }
    if (target) kept++;
    else if (/^https?:\/\//.test(img.src)) target = img.src;
    text = target ? text.split(`](${img.token})`).join(`](${target})`) : text.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${img.token}\\)`), (_a, alt: string) => (alt ? `*${alt}*` : ''));
  }
  const block = text.includes('\n') || /^(?:#|>|[-*+] |\d+\. |!\[|```|\|)/.test(text);
  editor.fill(id, text.trim() || null, block);
  if (images.length) {
    const online = images.length - kept;
    notify(`Collé avec ${images.length} image${images.length > 1 ? 's' : ''}${online ? ` (${online} restée${online > 1 ? 's' : ''} en ligne)` : ''}`, online ? 'info' : 'success');
  }
}

/** Paste or drop into a note of the app: true when taken (the rest is plain text, left to the editor). */
export function pasteInto(editor: NotesEditor, data: DataTransfer, note: ClipNote, now: number | null, notify: Notify): boolean {
  const content = classifyPaste(data);
  switch (content.kind) {
    case 'clip': {
      const id = editor.reserve('');
      editor.fill(id, adaptClip(content.clip, note.id), false);
      return true;
    }
    case 'files':
      if (content.skipped.length) notify(`Non collé${content.skipped.length > 1 ? 's' : ''} : ${content.skipped.join(', ')} (images, vidéos et audios seulement)`, 'error');
      if (content.files.length) void pasteFiles(editor, content.files, note, now, notify);
      return true;
    case 'html':
      void pasteHtml(editor, content.html, note, notify);
      return true;
    default:
      return false;
  }
}
