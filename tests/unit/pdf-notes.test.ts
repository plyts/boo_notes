import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildNotesPdf, type PdfNote } from '../../src/shared/pdf-notes';
import { timestampUrl } from '../../src/shared/platforms';
import { lessonDocument } from '../../src/shared/summary';

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
    // The lesson's video: « Revoir la leçon », its address, and in the references.
    expect(uris.filter((u) => u === URL1).length).toBe(3);
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

describe('the PDF of one course', () => {
  const lesson = (n: number, chapter: string, extra: Partial<PdfNote> = {}): PdfNote => ({
    id: `youtube:lesson${n}xxxx`,
    title: `Leçon ${n}`,
    url: `https://www.youtube.com/watch?v=lesson${n}xxxx`,
    source: 'YouTube',
    place: `AI Orchestration › ${chapter}`,
    chapter,
    updatedAt: Date.UTC(2026, 9, n),
    markdown: `[00:0${n}] idée ${n}\n[00:1${n}] ![Capture](assets/l${n}.png)\n📄 [Transcription — anglais · 2 répliques](transcripts/l${n}.md)`,
    ...extra,
  });

  async function course(): Promise<PDFDocument> {
    const bytes = await buildNotesPdf(
      [
        lesson(1, 'Les bases', {
          transcript: {
            label: 'Sous-titres YouTube · anglais → français',
            cues: [
              { start: 61, text: 'Airflow orchestrates tasks.', tr: 'Airflow orchestre des tâches.' },
              { start: 3725, text: 'A DAG is a graph.', note: 'à revoir' },
            ],
          },
        }),
        lesson(2, 'Les bases'),
        lesson(3, 'Hooks et outils', { transcript: { label: 'Sous-titres', cues: [{ start: 42, text: 'A hook wraps a connection.' }] } }),
      ],
      { picture: async () => ({ bytes: PNG, type: 'png' }), timeUrl: (note, sec) => timestampUrl(note.url, sec) },
      { title: 'AI Orchestration', date: new Date(Date.UTC(2026, 9, 8)), course: true },
    );
    return PDFDocument.load(bytes);
  }

  it('gathers every lesson: its note, its pictures, its video, its whole transcript — each moment clickable', async () => {
    const doc = await course();
    expect(doc.getTitle()).toBe('Boo Notes — AI Orchestration');
    const { uris, internal } = linksOf(doc);
    // The contents: one entry per lesson.
    expect(internal).toBe(3);
    // Every line of the transcripts, linked to its moment (only there: no note line at those moments).
    expect(uris).toContain('https://www.youtube.com/watch?v=lesson1xxxx#t=61');
    expect(uris).toContain('https://www.youtube.com/watch?v=lesson1xxxx#t=3725');
    expect(uris).toContain('https://www.youtube.com/watch?v=lesson3xxxx#t=42');
    // The notes' own moments and each lesson's video.
    expect(uris).toContain('https://www.youtube.com/watch?v=lesson2xxxx#t=2');
    for (const n of [1, 2, 3]) expect(uris).toContain(`https://www.youtube.com/watch?v=lesson${n}xxxx`);
    // The captures of the three lessons.
    let images = 0;
    for (const page of doc.getPages()) images += page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys().length ?? 0;
    expect(images).toBe(3);
  });
});

/** The text a PDF draws (its content streams, standard fonts: WinAnsi). */
function textOf(doc: PDFDocument): string {
  const WIN: Record<number, string> = { 0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—' };
  let out = '';
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const raw = obj.dict.get(PDFName.of('Filter')) === PDFName.of('FlateDecode') ? inflateSync(obj.contents) : Buffer.from(obj.contents);
    for (const m of raw.toString('latin1').matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      const bytes = m[1].match(/../g) ?? [];
      out += `${bytes.map((b) => WIN[parseInt(b, 16)] ?? String.fromCharCode(parseInt(b, 16))).join('')}\n`;
    }
  }
  return out;
}

describe('a summary as a PDF of its own', () => {
  const summary = {
    problem: { text: 'Un data lake ne garantit rien : comment écrire sans corrompre ?', at: [3] },
    goals: [{ text: 'Expliquer le journal de transactions', at: [130] }],
    solution: { text: 'Un journal ordonné de commits JSON.', at: [160] },
    plan: [
      {
        title: 'Les limites d’un data lake',
        at: 0,
        intro: 'Pourquoi de simples fichiers ne suffisent pas.',
        children: [
          { title: 'Pas d’atomicité', at: 48, children: [], detail: 'Un job qui échoue laisse des fichiers à moitié écrits.', kind: 'key' as const },
          { title: 'Fichiers modifiés à la main', at: 112, children: [], detail: 'Réécrire un fichier Parquet casse les lectures.', kind: 'warning' as const },
        ],
      },
      {
        title: 'Le journal de transactions',
        at: 130,
        intro: 'Un registre ordonné de toutes les écritures.',
        children: [
          { title: 'Un commit = un fichier JSON', at: 160, children: [], detail: 'Chaque écriture ajoute un fichier numéroté.', kind: 'key' as const },
          { title: 'Source de vérité', at: 200, children: [], detail: 'La table est l’état obtenu en rejouant ses commits.', kind: 'definition' as const },
          { title: 'Relire l’historique', at: 280, children: [], detail: 'Chaque version reste lisible.', kind: 'example' as const, code: 'DESCRIBE HISTORY ventes;' },
          { title: 'Checkpoint', at: 245, children: [], detail: 'Tous les 10 commits, un Parquet résume l’état.', kind: 'point' as const },
        ],
      },
    ],
  };

  it('has no cover; problem, goals, solution and the plan — each point labelled, every moment a link to the video', async () => {
    const markdown = lessonDocument(summary);
    expect(markdown).toContain('## Plan du cours\n\n1. Les limites d’un data lake [00:00]\n   *Pourquoi de simples fichiers ne suffisent pas.*\n   - ★ **Essentiel — Pas d’atomicité :**');
    const bytes = await buildNotesPdf(
      [{ id: 'boo:summary:youtube:abcdefghijk', title: 'Résumé — Delta Lake', url: URL1, source: 'Boo Notes · résumé par IA, à vérifier', place: null, updatedAt: Date.UTC(2026, 9, 9), markdown }],
      { picture: async () => null, timeUrl: (note, s) => timestampUrl(note.url, s) },
      { title: 'Résumé — Delta Lake', date: new Date(Date.UTC(2026, 9, 9)), cover: false },
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { uris, internal } = linksOf(doc);
    expect(internal).toBe(0);
    for (const s of [3, 130, 160, 0, 48, 112, 200, 280, 245]) expect(uris).toContain(`${URL1}#t=${s}`);
    const text = textOf(doc);
    // Labels in words (the marks ★ 📘 💡 ⚠️ are not in the PDF's fonts: never a « ? » in their place).
    for (const label of ['ESSENTIEL', 'DÉFINITION', 'EXEMPLE', 'ATTENTION']) expect(text).toContain(label);
    expect(text).not.toMatch(/\?\s*\n?\s*ESSENTIEL|★|📘/u);
    expect(text).toContain('Pourquoi de simples fichiers ne suffisent pas.');
    expect(text).toContain('DESCRIBE HISTORY ventes;');
    // No list marker written out as text.
    expect(text).not.toMatch(/^\s*- /m);
  });
});
