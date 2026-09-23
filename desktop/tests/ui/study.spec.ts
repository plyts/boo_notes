import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render } from '../../../scripts/icon-art.mjs';
import { expect, makePdf, test } from './fixtures';

async function libraryJson(vault: string): Promise<{ items: Record<string, any> }> {
  return JSON.parse(await readFile(join(vault, '.boo', 'library.json'), 'utf8'));
}
const byTitle = async (vault: string, title: string) =>
  Object.values((await libraryJson(vault)).items).find((i) => i.title === title);

test('fiches de révision : liens [[…]], aperçu, navigation et « Liée depuis »', async ({ ctx }) => {
  const { page } = await ctx.launch();
  await page.keyboard.press('Control+N');
  await page.locator('dialog .dialog-input').fill('Lois de Newton');
  await page.getByRole('button', { name: 'Créer' }).click();
  await expect(page.locator('.item-title')).toHaveText('Lois de Newton');
  await expect(page.locator('.sheet-side')).toBeVisible();

  // The new sheet has the focus: write, with a link to a sheet that does not exist yet.
  await page.keyboard.type('La deuxième loi relie ');
  await page.keyboard.type('[[Forces');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('nouvelle fiche');
  await page.waitForTimeout(150); // CodeMirror ignores Enter for 75 ms after the list opens.
  await page.keyboard.press('Enter');
  await page.keyboard.type(' et accélération.');
  await expect(page.locator('.save-state')).toHaveText('Enregistré');
  expect(await readFile(join(ctx.vault, 'Lois de Newton.md'), 'utf8')).toContain('La deuxième loi relie [[Forces]] et accélération.');
  await expect(page.locator('.side-link.missing', { hasText: 'Forces' })).toBeVisible();

  // Hover: preview card; click: the sheet is created and opened, with a way back.
  await page.locator('.notes-editor .cm-content').blur().catch(() => undefined);
  await page.locator('.sheet-side h3').first().click();
  await page.locator('.cm-boo-wiki', { hasText: 'Forces' }).hover();
  await expect(page.locator('.wiki-card')).toContainText('Cette fiche n’existe pas encore');
  await page.locator('.cm-boo-wiki', { hasText: 'Forces' }).click();
  await expect(page.locator('.item-title')).toHaveText('Forces');
  await expect(page.locator('.crumb')).toHaveText('Lois de Newton');
  await expect(page.locator('.side-link', { hasText: 'Lois de Newton' })).toBeVisible();

  // Completion lists the other notes.
  await page.locator('.notes-editor .cm-content').click();
  await page.keyboard.type('Voir [[Lo');
  await expect(page.locator('.cm-tooltip-autocomplete li', { hasText: 'Lois de Newton' })).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await expect(page.locator('.save-state')).toHaveText('Enregistré');
  expect(await readFile(join(ctx.vault, 'Forces.md'), 'utf8')).toContain('Voir [[Lois de Newton]]');

  // Back to the first sheet through the breadcrumb.
  await page.locator('.crumb').click();
  await expect(page.locator('.item-title')).toHaveText('Lois de Newton');
  // Forces is both linked from here and links back here.
  await expect(page.locator('.side-card', { hasText: 'Liens' }).locator('.side-link:not(.missing)', { hasText: 'Forces' })).toBeVisible();
  await expect(page.locator('.side-card', { hasText: 'Liée depuis' }).locator('.side-link', { hasText: 'Forces' })).toBeVisible();
  await page.locator('.cm-boo-wiki').hover();
  await expect(page.locator('.wiki-card')).toContainText('Voir Lois de Newton');
  await page.screenshot({ path: 'test-results/sheet.png' });
});

test('révision espacée : ajout, file « À réviser », notation', async ({ ctx }) => {
  const { page } = await ctx.launch();
  const sheet = await page.evaluate(() => window.boo.library.createNote('Dérivées', 'f′(x) = lim (f(x+h) − f(x)) / h'));
  await page.evaluate((id) => window.boo.library.review(id, 'start'), sheet.id);
  await expect(page.locator('.nav-item[data-key="due"] .nav-count')).toHaveText('1');
  await page.locator('.nav-item[data-key="due"]').click();
  await expect(page.locator('.page-head h1')).toHaveText('À réviser');
  await page.locator('.row-main', { hasText: 'Dérivées' }).click();
  await expect(page.locator('.review-pill')).toHaveText('À réviser');
  await expect(page.locator('.grade.good small')).toHaveText('demain');
  await page.locator('.grade.good').click();
  await expect(page.locator('.toast')).toContainText('prochaine révision demain');
  await expect(page.locator('.review-pill')).toHaveText('Révision demain');
  await expect(page.locator('.nav-item[data-key="due"] .nav-count')).toHaveCount(0);
  expect((await byTitle(ctx.vault, 'Dérivées')).review).toMatchObject({ interval: 1, count: 1 });
});

test('image annotée : repères numérotés liés aux notes, dans les deux sens', async ({ ctx }) => {
  const png = join(ctx.dir, 'Courbe offre-demande.png');
  await writeFile(png, render(400));
  const { page } = await ctx.launch();
  await page.evaluate((p) => window.boo.library.addFiles([p]), png);
  await page.locator('.row-main').first().click();
  const img = page.locator('.iv-img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(400);

  // Double-click places pin 1; the note line starts with it.
  const box = (await img.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await expect(page.locator('.iv-pin[data-n="1"]')).toBeVisible();
  await expect(page.locator('.notes-editor .cm-content')).toBeFocused();
  await page.keyboard.type('Point d’équilibre');
  await expect(page.locator('.save-state')).toHaveText('Enregistré');
  await expect(page.locator('.iv-pin[data-n="1"]')).toHaveClass(/has-notes/);

  // Alt+Shift+T then click: pin 2.
  await page.keyboard.press('Alt+Shift+T');
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.6);
  await expect(page.locator('.iv-pin[data-n="2"]')).toBeVisible();
  await expect(page.locator('.notes-editor .cm-content')).toBeFocused();
  await page.keyboard.type('Excédent d’offre');
  await expect(page.locator('.save-state')).toHaveText('Enregistré');

  const item = await byTitle(ctx.vault, 'Courbe offre-demande');
  expect(item.pins).toHaveLength(2);
  expect(item.pins[0]).toMatchObject({ n: 1, x: expect.closeTo(0.3, 1), y: expect.closeTo(0.4, 1) });
  expect(await readFile(join(ctx.vault, item.noteFile), 'utf8')).toContain('[pin 1] Point d’équilibre\n[pin 2] Excédent d’offre');

  // Note → image, image → note.
  await page.locator('.cm-boo-pin', { hasText: '1' }).first().click();
  await expect(page.locator('.iv-pin[data-n="1"]')).toHaveClass(/active/);
  await page.locator('.iv-pin[data-n="2"]').click();
  await expect(page.locator('.cm-boo-now')).toContainText('Excédent d’offre');
  await page.screenshot({ path: 'test-results/image.png' });
});

test('texte : paragraphes numérotés, notes [§ N] et citations', async ({ ctx }) => {
  const md = join(ctx.dir, 'Photosynthèse.md');
  await writeFile(
    md,
    '# La photosynthèse\n\nLes plantes captent la lumière.\n\nLa chlorophylle absorbe le rouge et le bleu.\n\n- Phase claire\n- Cycle de Calvin\n',
  );
  const { page } = await ctx.launch();
  await page.evaluate((p) => window.boo.library.addFiles([p]), md);
  await page.locator('.row-main').first().click();
  await expect(page.locator('.tx-block')).toHaveCount(5);
  await expect(page.locator('.tx-h1')).toHaveText('La photosynthèse');

  await page.locator('.tx-block[data-n="3"]').hover();
  await page.locator('.tx-block[data-n="3"] .tx-gutter').click();
  await page.keyboard.type('Pourquoi les feuilles sont vertes');
  await expect(page.locator('.save-state')).toHaveText('Enregistré');
  await expect(page.locator('.tx-block[data-n="3"] .tx-marker')).toHaveText('1');

  const span = page.locator('.tx-block[data-n="2"] p');
  await span.selectText();
  await page.keyboard.press('Alt+Shift+Q');
  await expect(page.locator('.notes-editor .cm-content')).toContainText('Les plantes captent la lumière.');
  const item = await byTitle(ctx.vault, 'Photosynthèse');
  await expect
    .poll(() => readFile(join(ctx.vault, item.noteFile), 'utf8'))
    .toContain('[§ 3] Pourquoi les feuilles sont vertes\n> Les plantes captent la lumière. [§ 2]');

  await page.locator('.cm-boo-section', { hasText: '§ 3' }).first().click();
  await expect(page.locator('.tx-block[data-n="3"]')).toHaveClass(/flash/);
  await page.locator('.tx-block[data-n="3"] .tx-marker').click();
  await expect(page.locator('.cm-boo-now')).toContainText('Pourquoi les feuilles');
});

test('PDF : pastille des notes dans la marge de chaque page', async ({ ctx }) => {
  const pdf = join(ctx.dir, 'Cours.pdf');
  await writeFile(pdf, makePdf([['Page un'], ['Page deux']]));
  const { page } = await ctx.launch();
  await page.evaluate((p) => window.boo.library.addFiles([p]), pdf);
  await page.locator('.row-main').first().click();
  await expect(page.locator('.pdf-page[data-page="1"].rendered')).toBeVisible();
  await page.locator('.notes-editor .cm-content').click();
  await page.keyboard.type('Introduction');
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-note-badge')).toHaveText('1');
  await expect(page.locator('.pdf-page[data-page="2"] .pdf-note-badge')).toHaveCount(0);
  await page.locator('.pdf-page[data-page="1"] .pdf-note-badge').click();
  await expect(page.locator('.cm-boo-now')).toContainText('Introduction');
});
