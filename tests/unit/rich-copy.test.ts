import { describe, expect, it } from 'vitest';
import { toPortableMarkdown } from '../../src/shared/markdown';
import { timestampUrl } from '../../src/shared/platforms';
import { buildRichCopy } from '../../src/shared/rich-copy';
import { emptyTranscript } from '../../src/shared/transcript';

const URL = 'https://www.youtube.com/watch?v=abcdefghijk';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQ';

const note = [
  '## Théorème de Stokes',
  '[00:05] La ==circulation== le long du bord, voir [[Flux]]',
  '[00:12] ![Capture 00:12](assets/youtube-abc-00-12-x.png)',
  '[02:05–06:07] ![Passage 02:05–06:07 · Stokes](assets/youtube-abc-02-05-y.jpg) [Extrait](media/youtube-abc-passage-02-05-z.webm)',
  '> [04:12] « the curl of F » — *le rotationnel de F*',
  '![Schéma](assets/perdu.png)',
  '',
  '📄 [Transcription — anglais → français · 1 réplique](transcripts/youtube-abcdefghijk.md)',
].join('\n');

async function copy() {
  const timeUrl = (s: number) => timestampUrl(URL, s);
  return buildRichCopy({
    title: 'Cours 7 — Stokes',
    sourceUrl: URL,
    place: 'Maths › Analyse',
    markdown: note,
    linkify: (md) => toPortableMarkdown({ title: 'x', url: URL, platform: 'youtube', markdown: md, createdAt: 0, updatedAt: 0 }, { frontMatter: false }),
    context: { anchor: (kind, value) => (kind === 'time' ? { url: timeUrl(value) } : null) },
    timeUrl,
    image: async (path) => (path.endsWith('.png') && !path.includes('perdu') ? PNG : path.endsWith('.jpg') ? JPG : null),
    transcript: emptyTranscript('youtube:abcdefghijk', {
      lang: 'en',
      label: 'Sous-titres YouTube',
      cues: [{ id: 'c252', start: 252, end: 255, text: 'the curl of F', tr: 'le rotationnel de F', note: 'à retenir' }],
    }),
  });
}

describe('buildRichCopy (Markdown flavour, for Obsidian)', () => {
  it('embeds the pictures and links every instant to the video', async () => {
    const { markdown, images, missing } = await copy();
    expect(images).toBe(2);
    expect(missing).toEqual(['assets/perdu.png']);
    expect(markdown.startsWith(`# Cours 7 — Stokes\n\n[${URL}](${URL}) · Maths › Analyse\n\n## Théorème de Stokes\n`)).toBe(true);
    expect(markdown).toContain(`[00:05](${URL}#t=5) La ==circulation== le long du bord, voir [[Flux]]`);
    expect(markdown).toContain(`[00:12](${URL}#t=12) ![Capture 00:12](${PNG})`);
    // The passage: its card embedded, the extract replaced by a link replaying it.
    expect(markdown).toContain(`[02:05–06:07](${URL}#t=125) ![Passage 02:05–06:07 · Stokes](${JPG})\n[▶ Revoir le passage 02:05–06:07](${URL}#t=125)`);
    expect(markdown).not.toContain('media/');
    expect(markdown).toContain('*Schéma (image introuvable)*');
    // The transcript replaces its attachment line.
    expect(markdown).not.toContain('transcripts/');
    expect(markdown).toContain(`## Transcription\n\n*Sous-titres YouTube · anglais → français · 1 réplique*\n\n[04:12](${URL}#t=252) the curl of F  \n*le rotationnel de F*  \n💬 à retenir`);
  });
});

describe('buildRichCopy (HTML flavour, for Notion, Docs, Word)', () => {
  it('renders the note with its pictures, time links, passage card and transcript', async () => {
    const { html } = await copy();
    expect(html).toContain('<h1>Cours 7 — Stokes</h1>');
    expect(html).toContain(`<a href="${URL}">${URL}</a> · Maths › Analyse`);
    expect(html).toContain('<h3>Théorème de Stokes</h3>');
    expect(html).toContain(`<a href="${URL}#t=5"><code>00:05</code></a> La <mark>circulation</mark> le long du bord`);
    expect(html).toContain(`<img src="${PNG}" alt="00:12">`);
    expect(html).toContain(`<img src="${JPG}" alt="Passage 02:05–06:07 · Stokes"><figcaption><a href="${URL}#t=125"><code>Passage 02:05–06:07</code></a> · Stokes</figcaption>`);
    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('assets/');
    expect(html).not.toContain('media/');
    expect(html).toContain('<h3>Transcription</h3>');
    expect(html).toContain(`<a href="${URL}#t=252"><code>04:12</code></a> the curl of F<em><br>le rotationnel de F</em><br>💬 à retenir`);
  });
});
