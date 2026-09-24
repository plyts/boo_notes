// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  adaptClip,
  BOO_CLIP_TYPE,
  classifyPaste,
  dataUrlToBlob,
  fileKind,
  imageLine,
  mediaFileLine,
  readBooClip,
  writeBooClip,
} from '../../src/panel/rich-clipboard';
import { pastedMediaPath } from '../../src/shared/media-paths';
import { renderRichCopy } from '../../src/shared/rich-copy';

/** The part of DataTransfer a paste reads (jsdom has none). */
function clipboard(items: Record<string, string>, files: File[] = []): DataTransfer {
  const data = { ...items };
  return {
    getData: (t: string) => data[t] ?? '',
    setData: (t: string, v: string) => void (data[t] = v),
    files: files as unknown as FileList,
  } as unknown as DataTransfer;
}

const file = (name: string, type: string) => new File([new Uint8Array([1, 2, 3])], name, { type });

describe('Boo Notes clip (copy from a note, paste into a note)', () => {
  it('round-trips through the clipboard', () => {
    const dt = clipboard({});
    writeBooClip(dt, { noteId: 'youtube:abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', timed: true, markdown: '[00:05] Définition' });
    expect(JSON.parse(dt.getData(BOO_CLIP_TYPE))).toMatchObject({ v: 1, noteId: 'youtube:abcdefghijk' });
    expect(readBooClip(dt)?.markdown).toBe('[00:05] Définition');
    expect(readBooClip(clipboard({ [BOO_CLIP_TYPE]: '{"v":2}' }))).toBeNull();
    expect(readBooClip(clipboard({ [BOO_CLIP_TYPE]: 'oops' }))).toBeNull();
  });

  it('links the moments of another video, keeps its own note as is', () => {
    const clip = { v: 1 as const, noteId: 'youtube:abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', timed: true, markdown: '[00:05] Définition\n[00:12] ![Capture 00:12](assets/x.jpg)' };
    expect(adaptClip(clip, 'youtube:abcdefghijk')).toBe(clip.markdown);
    expect(adaptClip(clip, 'youtube:otherVideo1')).toBe(
      '[00:05](https://www.youtube.com/watch?v=abcdefghijk#t=5) Définition\n[00:12](https://www.youtube.com/watch?v=abcdefghijk#t=12) ![Capture 00:12](assets/x.jpg)',
    );
    // An article's note: its « timestamps » are not moments.
    expect(adaptClip({ ...clip, timed: false }, 'other')).toBe(clip.markdown);
  });
});

describe('what a paste holds', () => {
  it('prefers a clip, then pictures and media files, then formatted text; plain text is left to the editor', () => {
    const clip = clipboard({ [BOO_CLIP_TYPE]: JSON.stringify({ v: 1, noteId: 'n', url: '', timed: false, markdown: 'x' }), 'text/html': '<b>x</b>' });
    expect(classifyPaste(clip).kind).toBe('clip');
    // « Copier l’image » of a browser: the picture and an <img> only.
    const copied = classifyPaste(clipboard({ 'text/html': '<img src="https://x/a.png">' }, [file('image.png', 'image/png')]));
    expect(copied).toMatchObject({ kind: 'files', skipped: [] });
    // Word: formatted text and a picture of it: the text wins.
    expect(classifyPaste(clipboard({ 'text/html': '<p>du <b>gras</b></p>' }, [file('image.png', 'image/png')])).kind).toBe('html');
    expect(classifyPaste(clipboard({}, [file('cours.mp4', ''), file('notes.pdf', 'application/pdf')]))).toMatchObject({ kind: 'files', skipped: ['notes.pdf'] });
    expect(classifyPaste(clipboard({ 'text/plain': 'bonjour', 'text/html': '<span>bonjour</span>' })).kind).toBe('text');
  });

  it('recognises pictures, videos and audios by type or extension', () => {
    expect(fileKind({ name: 'a.png', type: 'image/png' })).toBe('image');
    expect(fileKind({ name: 'cours.mkv', type: '' })).toBe('video');
    expect(fileKind({ name: 'podcast.opus', type: '' })).toBe('audio');
    expect(fileKind({ name: 'notes.pdf', type: 'application/pdf' })).toBeNull();
  });
});

describe('lines and files of what is pasted', () => {
  it('names the media files and their lines', () => {
    expect(pastedMediaPath('youtube:abcdefghijk', 'Intro du cours (v2).mp4', 'video/mp4', 'x1y2')).toBe('media/youtube-abcdefghijk-file-Intro-du-cours-v2-x1y2.mp4');
    expect(pastedMediaPath('web:site/leçon', 'Écoute', 'audio/mpeg', 'n0')).toMatch(/^media\/[\w.-]+-file-Ecoute-n0\.mp3$/);
    expect(mediaFileLine('démo [final].webm', 'media/x.webm', 'video', '[04:12]')).toBe('[04:12] [🎬 démo final .webm](media/x.webm)');
    expect(mediaFileLine('podcast.mp3', 'media/y.mp3', 'audio', null)).toBe('[🎵 podcast.mp3](media/y.mp3)');
    expect(imageLine('assets/a.png', '', '[00:07]')).toBe('[00:07] ![Image collée 00:07](assets/a.png)');
    expect(imageLine('assets/a.png', 'Schéma', null)).toBe('![Schéma](assets/a.png)');
  });

  it('decodes data URLs without a request', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,iVBORw0KGgo=');
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(8);
    expect(await dataUrlToBlob('data:text/plain,bonjour%20%C3%A0%20tous').text()).toBe('bonjour à tous');
  });
});

describe('copy of a selection', () => {
  it('carries its pictures and names its pasted media, without a title', () => {
    const url = 'https://www.youtube.com/watch?v=abcdefghijk';
    const copy = renderRichCopy(
      {
        sourceUrl: url,
        markdown: '[00:05] Idée\n[00:12] ![Capture 00:12](assets/a.jpg)\n[00:20] [🎬 démo.webm](media/n-file-demo-1.webm)',
        linkify: (md) => md.replace(/\[(\d\d:\d\d)\](?!\()/g, (_a, tc: string) => `[${tc}](${url}#t=${Number(tc.slice(3))})`),
        context: { anchor: () => null },
        timeUrl: (s) => `${url}#t=${s}`,
      },
      new Map([['assets/a.jpg', 'data:image/jpeg;base64,/9j/']]),
    );
    expect(copy.markdown.startsWith('[00:05]')).toBe(true);
    expect(copy.markdown).toContain('![Capture 00:12](data:image/jpeg;base64,/9j/)');
    expect(copy.markdown).toContain(`[00:20](${url}#t=20) 🎬 démo.webm`);
    expect(copy.markdown).not.toContain('media/');
    expect(copy.html).not.toContain('<h1>');
    expect(copy.html).toContain('<img src="data:image/jpeg;base64,/9j/"');
    expect(copy.images).toBe(1);
  });
});
