import { readFile } from 'node:fs/promises';
import type { Worker } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { expect, openNotes, openWatch, panel, runCommand, setVideo, storedNote, test } from './fixtures';

/**
 * Notes as a PDF: the note being taken (export menu of the panel), a whole
 * course — its lessons only, their notes, videos and transcripts (panel and
 * options) — and every note at once (options page): pictures embedded,
 * moments and passages clickable.
 */

async function downloadedPdf(sw: Worker): Promise<PDFDocument> {
  const file = await sw.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const [d] = await chrome.downloads.search({ mime: 'application/pdf' });
      if (d?.state === 'complete') return d.filename;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });
  expect(file).toBeTruthy();
  return PDFDocument.load(await readFile(file!));
}

function uris(doc: PDFDocument): string[] {
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const action = annots!.lookup(i, PDFDict).lookupMaybe(PDFName.of('A'), PDFDict);
      if (action) out.push((action.lookup(PDFName.of('URI'), PDFString) as PDFString).decodeText());
    }
  }
  return out;
}

function images(doc: PDFDocument): number {
  return doc.getPages().reduce((n, p) => n + (p.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys().length ?? 0), 0);
}

test('« Télécharger en PDF » : la note, sa capture (WebP redessinée) et ses instants cliquables', async ({ page, sw }) => {
  // PDF files take no WebP: the capture is redrawn as JPEG.
  await sw.evaluate(() => chrome.storage.sync.set({ settings: { captureFormat: 'image/webp' } }));
  await openWatch(page);
  await setVideo(page, 3);
  await openNotes(sw, page);
  await page.keyboard.type('Introduction au théorème');
  await runCommand(sw, page, 'capture-screenshot');
  await expect.poll(async () => (await storedNote(sw))?.markdown).toMatch(/!\[Capture 00:03\]\(assets\/[^)]+\.webp\)/);
  await sw.evaluate(() => chrome.downloads.erase({}));

  const p = panel(page);
  await p.getByRole('button', { name: 'Exporter la note' }).click();
  await p.getByRole('menuitem', { name: /Télécharger en PDF/ }).click();
  await expect(p.locator('.notice')).toContainText('PDF téléchargé');
  const doc = await downloadedPdf(sw);
  expect(doc.getTitle()).toBe('Boo Notes — Vidéo de test E2E');
  expect(images(doc)).toBe(1);
  expect(uris(doc)).toEqual(expect.arrayContaining(['https://www.youtube.com/watch?v=e2eTest0001#t=3', 'https://www.youtube.com/watch?v=e2eTest0001']));
  // Laid out in an offscreen document, closed afterwards.
  await expect
    .poll(() => sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length))
    .toBe(0);
});

test('options : toutes les notes en un PDF, sommaire compris', async ({ context, page, sw }) => {
  // Two notes: a video, and a second one filed in a course.
  await openWatch(page);
  await setVideo(page, 2);
  await openNotes(sw, page);
  await page.keyboard.type('Première note');
  await expect.poll(async () => (await storedNote(sw))?.markdown).toContain('Première note');
  await openWatch(page, '', 'e2eOther0002');
  await openNotes(sw, page);
  await page.keyboard.type('Deuxième note');
  await expect.poll(async () => (await storedNote(sw, 'youtube:e2eOther0002'))?.markdown).toContain('Deuxième note');
  await sw.evaluate(() => chrome.downloads.erase({}));

  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html#donnees`);
  await options.getByRole('button', { name: 'Télécharger le PDF' }).click();
  await expect(options.locator('#saved')).toContainText('PDF téléchargé : 2 notes');
  const doc = await downloadedPdf(sw);
  expect(doc.getTitle()).toBe('Boo Notes — Toutes les notes');
  // Cover + one page per note at least.
  expect(doc.getPageCount()).toBeGreaterThanOrEqual(3);
  expect(uris(doc)).toEqual(expect.arrayContaining(['https://www.youtube.com/watch?v=e2eTest0001#t=2', 'https://www.youtube.com/watch?v=e2eOther0002']));
});

/** Two lessons of a course (the video of the tests, and another), one with its transcript. */
async function seedCourse(sw: Worker): Promise<void> {
  await sw.evaluate(async () => {
    const lessons = [
      { id: 'youtube:e2eTest0001', title: 'Introduction to Airflow', chapter: 'Les bases', at: 1, md: '[00:02] Les DAG décrivent les dépendances' },
      { id: 'youtube:e2eOther0002', title: 'HookToolset', chapter: 'Hooks et outils', at: 2, md: '[00:05] Un hook enveloppe une connexion' },
    ];
    const items: Record<string, unknown> = {};
    const index: Record<string, unknown> = {};
    for (const l of lessons) {
      const url = `https://www.youtube.com/watch?v=${l.id.slice(8)}`;
      items[`note:${l.id}`] = { id: l.id, platform: 'youtube', kind: 'video', url, title: l.title, markdown: l.md, rev: 1, createdAt: l.at, updatedAt: l.at, course: 'AI Orchestration', chapter: l.chapter, placedAt: l.at };
      index[l.id] = { platform: 'youtube', kind: 'video', url, title: l.title, updatedAt: l.at, course: 'AI Orchestration', chapter: l.chapter };
    }
    // Another course's note: not in this PDF.
    items['note:youtube:e2eElse0003'] = { id: 'youtube:e2eElse0003', platform: 'youtube', kind: 'video', url: 'https://www.youtube.com/watch?v=e2eElse0003', title: 'Autre cours', markdown: 'ailleurs', rev: 1, createdAt: 3, updatedAt: 3, course: 'Maths', chapter: 'Analyse', placedAt: 3 };
    index['youtube:e2eElse0003'] = { platform: 'youtube', kind: 'video', url: 'https://www.youtube.com/watch?v=e2eElse0003', title: 'Autre cours', updatedAt: 3, course: 'Maths', chapter: 'Analyse' };
    items['transcript:youtube:e2eTest0001'] = {
      lang: 'en',
      label: 'Sous-titres du lecteur · English',
      source: 'track',
      target: 'fr',
      complete: true,
      covered: [[0, 30]],
      duration: 30,
      cues: [
        { id: 'c1000', start: 1, end: 4, text: 'Welcome to Airflow.' },
        { id: 'c17000', start: 17, end: 20, text: 'A DAG is a graph of tasks.', tr: 'Un DAG est un graphe de tâches.' },
      ],
      rev: 1,
    };
    await chrome.storage.local.set({ ...items, 'notes:index': index });
  });
}

test('le cours en un PDF (menu Exporter du panneau, puis options) : ses leçons seules, leurs notes, vidéos et transcriptions', async ({ context, page, sw }) => {
  await seedCourse(sw);
  await sw.evaluate(() => chrome.downloads.erase({}));
  await openWatch(page);
  await openNotes(sw, page);
  const p = panel(page);
  await expect(p.locator('.place')).toHaveAttribute('title', 'Rangée dans AI Orchestration › Les bases (changer)');
  await p.getByRole('button', { name: 'Exporter la note' }).click();
  const item = p.getByRole('menuitem', { name: /Télécharger le cours en PDF/ });
  await expect(item.locator('small')).toHaveText('« AI Orchestration » : toutes ses leçons, transcriptions comprises');
  await item.click();
  await expect(p.locator('.notice')).toContainText('PDF du cours « AI Orchestration » téléchargé : 2 leçons, 1 transcription');
  let doc = await downloadedPdf(sw);
  expect(doc.getTitle()).toBe('Boo Notes — AI Orchestration');
  const links = uris(doc);
  // Both lessons (their videos, their moments), every line of the transcript linked to its moment; not the other course.
  expect(links).toEqual(
    expect.arrayContaining([
      'https://www.youtube.com/watch?v=e2eTest0001',
      'https://www.youtube.com/watch?v=e2eTest0001#t=2',
      'https://www.youtube.com/watch?v=e2eTest0001#t=1',
      'https://www.youtube.com/watch?v=e2eTest0001#t=17',
      'https://www.youtube.com/watch?v=e2eOther0002',
      'https://www.youtube.com/watch?v=e2eOther0002#t=5',
    ]),
  );
  expect(links.some((u) => u.includes('e2eElse0003'))).toBe(false);

  // The same from the options: the course picked in the list.
  await sw.evaluate(() => chrome.downloads.erase({}));
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html#donnees`);
  await options.getByRole('combobox', { name: 'Que mettre dans le PDF' }).selectOption({ label: 'Cours : AI Orchestration (2 leçons)' });
  await options.getByRole('button', { name: 'Télécharger le PDF' }).click();
  await expect(options.locator('#saved')).toContainText('PDF du cours « AI Orchestration » téléchargé');
  doc = await downloadedPdf(sw);
  expect(doc.getTitle()).toBe('Boo Notes — AI Orchestration');
});
