import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildNotesPdf, type PdfNote } from '../../src/shared/pdf-notes';
import { timestampUrl } from '../../src/shared/platforms';

/** A 2×2 PNG. */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNk+M9QzwAEjDAGNzYAAB0VAwFyX4bOAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);

const URL1 = 'https://www.youtube.com/watch?v=abcdefghijk';

const notes: PdfNote[] = [
  {
    id: 'youtube:abcdefghijk',
    title: 'Théorème de Stokes — Cours 7',
    url: URL1,
    source: 'YouTube',
    place: 'Maths › Analyse',
    updatedAt: Date.UTC(2026, 8, 24),
    markdown: [
      '## Définition',
      '[00:05] La **circulation** le long du bord, voir [[Flux]] et [Wikipédia](https://fr.wikipedia.org/wiki/Stokes)',
      '[00:12] ![Capture 00:12](assets/a.png)',
      '[02:05–06:07] ![Passage 02:05–06:07 · Stokes](assets/b.png) [Extrait](media/youtube-abc-passage-02-05-x.webm)',
      '> [04:12] « the curl of F » — *le rotationnel de F*',
      '- premier point ==important==',
      '  - détail',
      '1. étape',
      '- [x] fait',
      '```',
      'code(x)',
      '```',
      '[00:30] [🎬 démo.webm](media/youtube-abc-file-demo-1.webm)',
      '![Perdue](assets/missing.png)',
      '',
      '📄 [Transcription — anglais → français · 12 répliques](transcripts/youtube-abcdefghijk.md)',
    ].join('\n'),
  },
  {
    id: 'web:site/article',
    title: 'Article sans cours',
    url: 'https://blog.example.com/article',
    source: 'Web · Lecture',
    place: null,
    updatedAt: Date.UTC(2026, 8, 20),
    markdown: Array.from({ length: 80 }, (_, i) => `Ligne ${i + 1} : un texte assez long pour remplir la page et vérifier que la mise en page passe à la page suivante sans rien perdre du contenu.`).join('\n'),
  },
];

async function build(): Promise<PDFDocument> {
  const bytes = await buildNotesPdf(
    notes,
    {
      picture: async (path) => (path === 'assets/missing.png' ? null : { bytes: PNG, type: 'png' }),
      timeUrl: (note, s) => (note.url.includes('youtube') ? timestampUrl(note.url, s) : null),
    },
    { title: 'Toutes les notes', date: new Date(Date.UTC(2026, 8, 24)) },
  );
  expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  return PDFDocument.load(bytes);
}

function linksOf(doc: PDFDocument): { uris: string[]; internal: number } {
  const uris: string[] = [];
  let internal = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i, PDFDict);
      const action = a.lookupMaybe(PDFName.of('A'), PDFDict);
      if (action) uris.push((action.lookup(PDFName.of('URI'), PDFString) as PDFString).decodeText());
      else if (a.get(PDFName.of('Dest'))) internal++;
    }
  }
  return { uris, internal };
}

describe('notes as a PDF', () => {
  it('has a cover with a clickable table of contents, then each note on its pages', async () => {
    const doc = await build();
    expect(doc.getTitle()).toBe('Boo Notes — Toutes les notes');
    // Cover + note 1 + note 2 over several pages.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(4);
    const { internal } = linksOf(doc);
    expect(internal).toBe(2);
  });

  it('links every moment, the source, the passages; embeds the pictures', async () => {
    const doc = await build();
    const { uris } = linksOf(doc);
    // Timestamps → moments of the video.
    expect(uris).toContain(`${URL1}#t=5`);
    expect(uris).toContain(`${URL1}#t=252`);
    expect(uris).toContain(`${URL1}#t=30`);
    // Capture caption « Revoir à 00:12 », passage « Revoir le passage » (and in the references).
    expect(uris).toContain(`${URL1}#t=12`);
    expect(uris.filter((u) => u === `${URL1}#t=125`).length).toBe(2);
    // Plain links and the sources.
    expect(uris).toContain('https://fr.wikipedia.org/wiki/Stokes');
    expect(uris.filter((u) => u === URL1).length).toBe(2);
    expect(uris).toContain('https://blog.example.com/article');
    // Two pictures (the capture, the passage card), the same PNG embedded once per path.
    let images = 0;
    for (const page of doc.getPages()) {
      const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      images += xobjects?.keys().length ?? 0;
    }
    expect(images).toBe(2);
  });
});
