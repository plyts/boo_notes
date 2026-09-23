import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PARENT_PAGE_ID } from '../../tools/mock-notion.mjs';
import { expect, makePdf, makeWav, test } from './fixtures';

const SAMPLE_VIDEO = fileURLToPath(new URL('../../../tests/e2e/fixtures/sample.webm', import.meta.url));

/** Waits for the end of the PDF smooth scroll. */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  let last = -1;
  await expect
    .poll(async () => {
      const top = await page.evaluate(() => document.querySelector('.pdf-scroller')!.scrollTop);
      const stable = top === last;
      last = top;
      return stable;
    }, { intervals: [150] })
    .toBe(true);
}

async function libraryJson(vault: string): Promise<{ items: Record<string, any> }> {
  return JSON.parse(await readFile(join(vault, '.boo', 'library.json'), 'utf8'));
}

test('premier lancement : accueil avec le jeton d’appairage', async ({ ctx }) => {
  const { page } = await ctx.launch({ onboarded: false });
  const dialog = page.locator('dialog.welcome');
  await expect(dialog).toBeVisible();
  const token = await dialog.locator('code.token').textContent();
  expect(token).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  await expect(dialog).toContainText(`ws://localhost:${ctx.port}`);
  await dialog.getByRole('button', { name: 'Commencer' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.empty-library')).toBeVisible();
  expect(await page.evaluate(() => window.boo.settings.get().then((s) => s.onboarded))).toBe(true);
});

test('PDF : lecture suivie, notes par page, citation et surlignage', async ({ ctx }) => {
  const pdf = join(ctx.dir, 'Algèbre linéaire.pdf');
  await writeFile(
    pdf,
    makePdf([
      ['Chapitre 1', 'Les espaces vectoriels', 'Un espace vectoriel est un ensemble muni de deux lois.'],
      ['Chapitre 2', 'Applications lineaires', 'Le noyau et l image sont des sous-espaces.'],
      ['Chapitre 3', 'Matrices', 'Toute application lineaire a une matrice dans une base.'],
    ]),
  );
  const { page } = await ctx.launch();
  await page.evaluate((p) => window.boo.library.addFiles([p]), pdf);
  await page.locator('.row-main', { hasText: 'Algèbre linéaire' }).click();

  await expect(page.locator('.item-title')).toHaveText('Algèbre linéaire');
  await expect(page.locator('.page-count')).toHaveText('/ 3');
  await expect(page.locator('.pdf-page[data-page="1"].rendered')).toBeVisible();
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer')).toContainText('Les espaces vectoriels');

  // Flow 1 for documents: each new line starts with the page being read.
  await page.locator('.notes-editor .cm-content').click();
  await page.keyboard.type('Définition d’un espace vectoriel');
  await page.locator('.page-input').fill('3');
  await page.locator('.page-input').press('Enter');
  await expect(page.locator('.page-input')).toHaveValue('3');
  await page.locator('.notes-editor .cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Matrice d’une application');
  await expect(page.locator('.save-state')).toHaveText('Enregistré');

  const item = Object.values((await libraryJson(ctx.vault)).items)[0];
  const md = await readFile(join(ctx.vault, item.noteFile), 'utf8');
  expect(md).toContain('[p. 1] Définition d’un espace vectoriel\n[p. 3] Matrice d’une application');
  expect(md).toMatch(/^---\ntitle: "Algèbre linéaire"\n/);
  expect(item.progress).toMatchObject({ position: 3, duration: 3 });
  expect(item.noteCount).toBe(2);

  // Page chips navigate back.
  await page.locator('.cm-boo-page', { hasText: 'p. 1' }).click();
  await expect(page.locator('.page-input')).toHaveValue('1');

  // Select a sentence of page 2: highlight it, then quote it.
  await page.locator('.page-input').fill('2');
  await page.locator('.page-input').press('Enter');
  await settle(page);
  const span = page.locator('.pdf-page[data-page="2"] .textLayer span', { hasText: 'Le noyau' });
  await expect(span).toBeVisible();
  await span.selectText();
  await span.dispatchEvent('mouseup');
  await expect(page.locator('.pdf-popover')).toBeVisible();
  await page.getByRole('button', { name: 'Surligner en jaune' }).click();
  await expect(page.locator('.pdf-page[data-page="2"] .pdf-mark.yellow').first()).toBeVisible();
  await expect.poll(async () => Object.values((await libraryJson(ctx.vault)).items)[0].highlights?.length).toBe(1);
  const hl = Object.values((await libraryJson(ctx.vault)).items)[0].highlights[0];
  expect(hl).toMatchObject({ page: 2, color: 'yellow', text: expect.stringContaining('Le noyau') });

  await span.selectText();
  await page.keyboard.press('Alt+Shift+Q');
  await expect(page.locator('.notes-editor .cm-content')).toContainText('Le noyau et l image sont des sous-espaces.');
  await expect.poll(async () => readFile(join(ctx.vault, item.noteFile), 'utf8')).toContain(
    '> Le noyau et l image sont des sous-espaces. [p. 2]',
  );
  await page.screenshot({ path: 'test-results/pdf.png' });

  // Back to the library: progress and status.
  await page.keyboard.press('Escape');
  await page.locator('.notes-editor .cm-content').blur().catch(() => undefined);
  await page.getByRole('button', { name: /Bibliothèque/ }).first().click();
  await expect(page.locator('.row', { hasText: 'Algèbre linéaire' }).locator('.status-chip')).toHaveText('Terminé');
});

test('audio local : notes horodatées, reprise et progression', async ({ ctx }) => {
  const wav = join(ctx.dir, 'Podcast épisode 4.wav');
  await writeFile(wav, makeWav(20));
  const { page } = await ctx.launch();
  const res = await page.evaluate((p) => window.boo.library.addFiles([p]), wav);
  expect(res.added[0]).toMatchObject({ kind: 'audio', title: 'Podcast épisode 4' });
  await page.locator('.row-main').first().click();
  await expect(page.locator('.media-stage.audio')).toBeVisible();
  await expect(page.locator('.media-time')).toHaveText('00:00 / 00:20');
  await page.evaluate(async () => {
    const a = document.querySelector('audio')!;
    const seeked = new Promise((r) => a.addEventListener('seeked', r, { once: true }));
    a.currentTime = 7;
    await seeked;
  });
  await page.locator('.notes-editor .cm-content').click();
  await page.keyboard.type('Idée principale');
  await expect(page.locator('.save-state')).toHaveText('Enregistré');
  await expect(page.locator('.scrub-marker')).toHaveCount(1);

  // The timestamp chip seeks back.
  await page.evaluate(() => {
    const a = document.querySelector('audio')!;
    a.currentTime = 15;
  });
  await page.locator('.cm-boo-ts', { hasText: '00:07' }).click();
  await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('audio')!.currentTime))).toBe(7);
  await page.evaluate(() => document.querySelector('audio')!.pause());

  const item = Object.values((await libraryJson(ctx.vault)).items)[0];
  expect(await readFile(join(ctx.vault, item.noteFile), 'utf8')).toContain('[00:07] Idée principale');
  await expect.poll(async () => Object.values((await libraryJson(ctx.vault)).items)[0].progress?.duration).toBe(20);
  await page.screenshot({ path: 'test-results/audio.png' });
});

test('vidéo locale : capture insérée dans la note', async ({ ctx }) => {
  const video = join(ctx.dir, 'Cours vidéo.webm');
  await copyFile(SAMPLE_VIDEO, video);
  const { page } = await ctx.launch();
  await page.evaluate((p) => window.boo.library.addFiles([p]), video);
  await page.locator('.row-main').first().click();
  await expect.poll(() => page.evaluate(() => document.querySelector('video')?.readyState ?? 0)).toBeGreaterThanOrEqual(2);
  await page.evaluate(async () => {
    const v = document.querySelector('video')!;
    const seeked = new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    v.currentTime = 4;
    await seeked;
  });
  await page.keyboard.press('Alt+Shift+S');
  await expect(page.locator('.toast')).toContainText('00:04 - Capture sauvegardée');
  await expect(page.locator('.cm-boo-img img')).toBeVisible();
  const item = Object.values((await libraryJson(ctx.vault)).items)[0];
  const note = () => readFile(join(ctx.vault, item.noteFile), 'utf8');
  await expect.poll(note).toMatch(/\[00:04\] !\[Capture 00:04\]\(assets\/[^)]+\.jpg\)/);
  const asset = /!\[Capture 00:04\]\((assets\/[^)]+\.jpg)\)/.exec(await note())?.[1];
  expect((await readFile(join(ctx.vault, asset!))).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  await page.screenshot({ path: 'test-results/video.png' });
});

test('extension : les notes du navigateur arrivent dans la bibliothèque', async ({ ctx }) => {
  const { page } = await ctx.launch();
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}`, { origin: 'chrome-extension://abcdefghijklmnop' });
  await new Promise((r) => ws.once('open', r));
  const replies: any[] = [];
  ws.on('message', (m) => replies.push(JSON.parse(String(m))));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'TEST-TOKN-ABCD-EFGH', client: { name: 'test', version: '1' } }));
  await expect.poll(() => replies[0]?.type).toBe('welcome');
  await expect(page.locator('.conn.ok')).toContainText('Extension connectée');

  ws.send(
    JSON.stringify({
      type: 'note.upsert',
      note: {
        id: 'youtube:abcdefghijk',
        platform: 'youtube',
        kind: 'video',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        title: 'React — Les hooks',
        markdown: '[00:05] Intro\n[01:10] useEffect',
        createdAt: 1,
        updatedAt: Date.now(),
        rev: 1,
      },
    }),
  );
  ws.send(JSON.stringify({ type: 'media.progress', noteId: 'youtube:abcdefghijk', position: 300, duration: 600 }));
  ws.send(JSON.stringify({ type: 'player.active', player: { noteId: 'youtube:abcdefghijk', title: 'React — Les hooks', url: 'https://www.youtube.com/watch?v=abcdefghijk' } }));
  await expect(page.locator('.card', { hasText: 'React — Les hooks' })).toBeVisible();
  await expect(page.locator('.now-playing')).toContainText('React — Les hooks');
  await expect(page.locator('.card', { hasText: 'React — Les hooks' })).toContainText('05:00 / 10:00');

  await page.locator('.card', { hasText: 'React — Les hooks' }).click();
  await expect(page.locator('.web-course h2')).toHaveText('React — Les hooks');
  await expect(page.locator('.web-actions')).toContainText('Reprendre à 05:00');
  await expect(page.locator('.readonly-chip')).toBeVisible();
  await expect(page.locator('.cm-boo-ts')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/web-course.png' });
  ws.close();
  await expect(page.locator('.conn.wait')).toContainText('Extension en attente');
});

test('Notion : connexion puis une page par cours', async ({ ctx }) => {
  const pdf = join(ctx.dir, 'Statistiques.pdf');
  await writeFile(pdf, makePdf([['Statistiques', 'Moyenne et variance'], ['Lois usuelles']]));
  const { page } = await ctx.launch();
  await page.locator('.conn', { hasText: 'Notion non connecté' }).click();
  await expect(page.locator('#set-notion')).toBeVisible();
  await page.locator('#notion-token').fill('secret_test');
  await page.locator('#notion-target').fill(`https://www.notion.so/Mes-cours-${PARENT_PAGE_ID.replace(/-/g, '')}`);
  await page.getByRole('button', { name: 'Connecter Notion' }).click();
  await expect(page.locator('#set-notion .conn-status.ok')).toContainText('Connecté à Espace de test');
  await page.screenshot({ path: 'test-results/settings.png', fullPage: true });
  expect(ctx.notion.state.databases.size).toBe(1);
  // The secret never lands in the config file in clear text.
  expect(await readFile(join(ctx.dir, 'user-data', 'config.json'), 'utf8')).not.toContain('secret_test');

  await page.evaluate((p) => window.boo.library.addFiles([p]), pdf);
  await page.getByRole('button', { name: /Bibliothèque/ }).first().click();
  await page.locator('.row-main', { hasText: 'Statistiques' }).click();
  await expect(page.locator('.pdf-page[data-page="1"].rendered')).toBeVisible();
  await page.locator('.notes-editor .cm-content').click();
  await page.keyboard.type('Formule de la variance');
  await expect(page.locator('.save-state')).toHaveText('Enregistré');
  // Automatic sync (default): the course page appears in Notion with the note.
  const coursePages = () => [...ctx.notion.state.pages.values()].filter((p) => p.parent?.database_id);
  await expect.poll(() => coursePages().length).toBe(1);
  await expect
    .poll(() => ctx.notion.pageContent(coursePages()[0].id))
    .toEqual([
      { type: 'callout', text: 'Fichier local : Statistiques.pdf' },
      { type: 'paragraph', text: 'p. 1 Formule de la variance' },
    ]);
  const notionPage = coursePages()[0];
  expect(notionPage.properties.Nom.title[0].text.content).toBe('Statistiques');
  expect(notionPage.properties.Type.select.name).toBe('PDF');
  expect(notionPage.properties.Position.rich_text[0].text.content).toBe('p. 1 / 2');
  await expect(page.locator('.notion-btn')).toHaveAttribute('data-state', 'ok');

  // Manual sync from the menu.
  await page.locator('.notion-btn').click();
  await page.getByRole('menuitem', { name: 'Synchroniser maintenant' }).click();
  await expect(page.locator('.toast', { hasText: 'Cours synchronisé avec Notion' })).toBeVisible();
  expect(coursePages()).toHaveLength(1);
});
