import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render } from '../../../scripts/icon-art.mjs';
import { editor, expect, importAndOpen, makePdf, noteByTitle, noteText, resourceByTitle, settled, test } from './fixtures';

test('fiches : liens [[…]], aperçu, navigation et « Liée depuis »', async ({ ctx }) => {
  const { page } = await ctx.launch();
  await page.keyboard.press('Control+N');
  const ask = page.getByRole('dialog', { name: 'Nouvelle note' });
  await ask.getByRole('textbox').fill('Lois de Newton');
  await ask.getByRole('button', { name: 'Créer' }).click();
  await settled(page);
  await expect(page.locator('.note-title')).toHaveText('Lois de Newton');

  // Write, with a link to a note that does not exist yet.
  await editor(page).click();
  await page.keyboard.type('La deuxième loi relie ');
  await page.keyboard.type('[[Forces');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('nouvelle fiche');
  await page.waitForTimeout(150); // CodeMirror ignores Enter for 75 ms after the list opens.
  await page.keyboard.press('Enter');
  await page.keyboard.type(' et accélération.');
  await expect.poll(() => readFile(join(ctx.vault, 'Lois de Newton.md'), 'utf8')).toContain('La deuxième loi relie [[Forces]] et accélération.');
  const inspector = page.locator('.inspector');
  await expect(inspector.locator('.link-chip.missing', { hasText: 'Forces' })).toBeVisible();

  // Hover: preview card; click: the note is created and opened.
  await page.locator('.cm-boo-wiki', { hasText: 'Forces' }).hover();
  await expect(page.locator('.wiki-preview')).toContainText('Cette note n’existe pas encore');
  await page.locator('.cm-boo-wiki', { hasText: 'Forces' }).click();
  await settled(page);
  await expect(page.locator('.note-title')).toHaveText('Forces');
  await expect(inspector.locator('.insp-section', { hasText: 'Liée depuis' }).locator('.link-chip', { hasText: 'Lois de Newton' })).toBeVisible();

  // Completion lists the other notes.
  await editor(page).click();
  await page.keyboard.type('Voir [[Lo');
  await expect(page.locator('.cm-tooltip-autocomplete li', { hasText: 'Lois de Newton' })).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await expect.poll(() => readFile(join(ctx.vault, 'Forces.md'), 'utf8')).toContain('Voir [[Lois de Newton]]');

  // Back (history), both ways linked.
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('.nav-item', { hasText: 'Toutes les notes' }).click();
  await settled(page);
  await page.locator('.row', { hasText: 'Lois de Newton' }).click();
  await settled(page);
  await expect(inspector.locator('.insp-section', { hasText: 'Liens' }).first().locator('.link-chip:not(.missing)', { hasText: 'Forces' })).toBeVisible();
  await expect(inspector.locator('.insp-section', { hasText: 'Liée depuis' }).locator('.link-chip', { hasText: 'Forces' })).toBeVisible();
  await page.locator('.cm-boo-wiki').hover();
  await expect(page.locator('.wiki-preview')).toContainText('Voir Lois de Newton');
});

test('révisions : cartes de la note, retournement, notation', async ({ ctx }) => {
  const { page } = await ctx.launch();
  const sheet = await page.evaluate(() =>
    window.boo.library.createNote({ title: 'Dérivées', body: 'Dérivée de x² :: 2x\nLa dérivée de ==sin== est cos.\n' }),
  );
  await page.evaluate((id) => window.boo.library.review(id, 'start'), sheet.id);
  await expect(page.locator('.nav-item', { hasText: 'À réviser' }).locator('.nav-badge')).toHaveText('1');
  await page.locator('.nav-item', { hasText: 'À réviser' }).click();
  await settled(page);
  await page.getByRole('button', { name: 'Réviser (1)' }).click();

  const card = page.locator('.flashcard');
  await expect(card).toContainText('Dérivée de x²');
  await expect(card).not.toContainText('2x');
  await page.keyboard.press('Space');
  await expect(card).toContainText('2x');
  await page.keyboard.press('Space');
  // Cloze card: the word is hidden, then revealed.
  await expect(card.locator('.cloze')).toHaveText('…');
  await page.keyboard.press('Space');
  await expect(card.locator('.cloze')).toHaveText('sin');
  await expect(page.getByRole('button', { name: /Je sais/ })).toContainText('demain');
  await page.keyboard.press('2');
  await expect(page.locator('.review-done')).toContainText('Révision terminée');
  await expect(page.locator('.nav-item', { hasText: 'À réviser' }).locator('.nav-badge')).toHaveCount(0);
  expect((await noteByTitle(ctx.vault, 'Dérivées'))?.review).toMatchObject({ interval: 1, count: 1 });
});

test('image annotée : repères numérotés liés aux notes, dans les deux sens', async ({ ctx }) => {
  const png = join(ctx.dir, 'Courbe offre-demande.png');
  await writeFile(png, render(400));
  const { page } = await ctx.launch();
  await importAndOpen(page, [png], 'Courbe offre-demande');
  const img = page.locator('.iv-img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(400);

  // Double-click places pin 1; the note line starts with it.
  const box = (await img.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await expect(page.locator('.iv-pin[data-n="1"]')).toBeVisible();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('Point d’équilibre');
  await expect(page.locator('.iv-pin[data-n="1"]')).toHaveClass(/has-notes/);

  // Alt+Shift+T then click: pin 2.
  await page.keyboard.press('Alt+Shift+T');
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.6);
  await expect(page.locator('.iv-pin[data-n="2"]')).toBeVisible();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('Excédent d’offre');
  await expect.poll(() => noteText(ctx.vault, 'Courbe offre-demande')).toContain('[pin 1] Point d’équilibre\n[pin 2] Excédent d’offre');
  const res = await resourceByTitle(ctx.vault, 'Courbe offre-demande');
  expect(res.pins).toHaveLength(2);
  expect(res.pins[0]).toMatchObject({ n: 1, x: expect.closeTo(0.3, 1), y: expect.closeTo(0.4, 1) });

  // Note → image, image → note.
  await page.locator('.cm-boo-pin', { hasText: '1' }).first().click();
  await expect(page.locator('.iv-pin[data-n="1"]')).toHaveClass(/active/);
  await page.locator('.iv-pin[data-n="2"]').click();
  await expect(page.locator('.cm-boo-now')).toContainText('Excédent d’offre');
});

test('texte : paragraphes numérotés, notes [§ N] et citations', async ({ ctx }) => {
  const md = join(ctx.dir, 'Photosynthèse.md');
  await writeFile(md, '# La photosynthèse\n\nLes plantes captent la lumière.\n\nLa chlorophylle absorbe le rouge et le bleu.\n\n- Phase claire\n- Cycle de Calvin\n');
  const { page } = await ctx.launch();
  await importAndOpen(page, [md], 'Photosynthèse');
  await expect(page.locator('.tx-block')).toHaveCount(5);
  await expect(page.locator('.tx-h1')).toHaveText('La photosynthèse');

  await page.locator('.tx-block[data-n="3"]').hover();
  await page.locator('.tx-block[data-n="3"] .tx-gutter').click();
  await page.keyboard.type('Pourquoi les feuilles sont vertes');
  await expect(page.locator('.tx-block[data-n="3"] .tx-marker')).toHaveText('1');

  await page.locator('.tx-block[data-n="2"] p').selectText();
  await page.keyboard.press('Alt+Shift+Q');
  await expect(editor(page)).toContainText('Les plantes captent la lumière.');
  await expect
    .poll(() => noteText(ctx.vault, 'Photosynthèse'))
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
  await importAndOpen(page, [pdf], 'Cours');
  await expect(page.locator('.pdf-page[data-page="1"].rendered')).toBeVisible();
  await editor(page).click();
  await page.keyboard.type('Introduction');
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-note-badge')).toHaveText('1');
  await expect(page.locator('.pdf-page[data-page="2"] .pdf-note-badge')).toHaveCount(0);
  await page.locator('.pdf-page[data-page="1"] .pdf-note-badge').click();
  await expect(page.locator('.cm-boo-now')).toContainText('Introduction');
});
