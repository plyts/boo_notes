import { readFile } from 'node:fs/promises';
import type { Worker } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { expect, openNotes, openWatch, panel, runCommand, setVideo, storedNote, test } from './fixtures';

/**
 * Notes as a PDF: the note being taken (export menu of the panel), and every
 * note at once (options page) — pictures embedded, moments and passages
 * clickable.
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
