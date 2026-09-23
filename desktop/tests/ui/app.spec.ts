import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PARENT_PAGE_ID } from '../../tools/mock-notion.mjs';
import { editor, expect, importAndOpen, libraryJson, makePdf, makeWav, noteByTitle, noteText, openNote, resourceByTitle, settled, test } from './fixtures';

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

test('premier lancement : découverte, jeton d’appairage, premier cours', async ({ ctx }) => {
  const { page } = await ctx.launch({ onboarded: false });
  const sheet = page.getByRole('dialog', { name: 'Découvrir Boo Notes' });
  await expect(sheet).toContainText('Bienvenue dans Boo Notes');
  await sheet.getByRole('button', { name: 'Continuer' }).click();
  await expect(sheet).toContainText('Cours › chapitres › notes');
  await sheet.getByRole('button', { name: 'Continuer' }).click();
  await expect(sheet).toContainText('Relier le navigateur');
  const token = await sheet.locator('code.token').textContent();
  expect(token).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  await expect(sheet).toContainText(`ws://localhost:${ctx.port}`);
  await sheet.getByRole('button', { name: 'Continuer' }).click();
  await sheet.getByRole('button', { name: 'Créer mon premier cours' }).click();
  // The first course is one prompt away.
  const ask = page.getByRole('dialog', { name: 'Nouveau cours' });
  await ask.getByRole('textbox').fill('Physique — Électricité');
  await ask.getByRole('button', { name: 'Créer le cours' }).click();
  await settled(page);
  await expect(page.locator('.large-title h1')).toHaveText('Physique — Électricité');
  await expect(page.locator('.tree-item', { hasText: 'Physique — Électricité' })).toBeVisible();
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
  await importAndOpen(page, [pdf], 'Algèbre linéaire');
  await expect(page.locator('.page-count')).toHaveText('/ 3');
  await expect(page.locator('.pdf-page[data-page="1"].rendered')).toBeVisible();
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer')).toContainText('Les espaces vectoriels');

  // Each new line starts with the page being read.
  await editor(page).click();
  await page.keyboard.type('Définition d’un espace vectoriel');
  await page.locator('.page-input').fill('3');
  await page.locator('.page-input').press('Enter');
  await expect(page.locator('.page-input')).toHaveValue('3');
  await editor(page).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Matrice d’une application');
  await expect
    .poll(() => noteText(ctx.vault, 'Algèbre linéaire'))
    .toContain('[p. 1] Définition d’un espace vectoriel\n[p. 3] Matrice d’une application');
  expect(await noteText(ctx.vault, 'Algèbre linéaire')).toMatch(/^---\ntitle: "Algèbre linéaire"\n/);
  await expect.poll(async () => (await resourceByTitle(ctx.vault, 'Algèbre linéaire'))?.progress).toMatchObject({ position: 3, duration: 3 });
  expect((await noteByTitle(ctx.vault, 'Algèbre linéaire'))?.noteCount).toBe(2);

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
  await expect.poll(async () => (await resourceByTitle(ctx.vault, 'Algèbre linéaire'))?.highlights?.length).toBe(1);
  expect((await resourceByTitle(ctx.vault, 'Algèbre linéaire'))!.highlights[0]).toMatchObject({ page: 2, color: 'yellow', text: expect.stringContaining('Le noyau') });

  await span.selectText();
  await page.keyboard.press('Alt+Shift+Q');
  await expect(editor(page)).toContainText('Le noyau et l image sont des sous-espaces.');
  await expect.poll(() => noteText(ctx.vault, 'Algèbre linéaire')).toContain('> Le noyau et l image sont des sous-espaces. [p. 2]');

  // In the list: read to the end.
  await page.locator('.nav-item', { hasText: 'Toutes les notes' }).click();
  await settled(page);
  await expect(page.locator('.row', { hasText: 'Algèbre linéaire' }).locator('.chip')).toHaveText('Terminé');
});

test('audio local : notes horodatées, saut et progression', async ({ ctx }) => {
  const wav = join(ctx.dir, 'Podcast épisode 4.wav');
  await writeFile(wav, makeWav(20));
  const { page } = await ctx.launch();
  const res = await page.evaluate((p) => window.boo.library.importFiles(p), [wav]);
  expect(res.notes[0]).toMatchObject({ kind: 'audio', title: 'Podcast épisode 4' });
  await openNote(page, 'Podcast épisode 4');
  await expect(page.locator('.media-stage.audio')).toBeVisible();
  await expect(page.locator('.media-time')).toHaveText('00:00 / 00:20');
  await page.evaluate(async () => {
    const a = document.querySelector('audio')!;
    const seeked = new Promise((r) => a.addEventListener('seeked', r, { once: true }));
    a.currentTime = 7;
    await seeked;
  });
  await editor(page).click();
  await page.keyboard.type('Idée principale');
  await expect.poll(() => noteText(ctx.vault, 'Podcast épisode 4')).toContain('[00:07] Idée principale');
  await expect(page.locator('.scrub-marker')).toHaveCount(1);

  await page.evaluate(() => {
    document.querySelector('audio')!.currentTime = 15;
  });
  await page.locator('.cm-boo-ts', { hasText: '00:07' }).click();
  await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('audio')!.currentTime))).toBe(7);
  await page.evaluate(() => document.querySelector('audio')!.pause());
  await expect.poll(async () => (await resourceByTitle(ctx.vault, 'Podcast épisode 4'))?.progress?.duration).toBe(20);
});

test('vidéo locale : capture insérée dans la note', async ({ ctx }) => {
  const video = join(ctx.dir, 'Cours vidéo.webm');
  await copyFile(SAMPLE_VIDEO, video);
  const { page } = await ctx.launch();
  await importAndOpen(page, [video], 'Cours vidéo');
  await expect.poll(() => page.evaluate(() => document.querySelector('video')?.readyState ?? 0)).toBeGreaterThanOrEqual(2);
  await page.evaluate(async () => {
    const v = document.querySelector('video')!;
    const seeked = new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    v.currentTime = 4;
    await seeked;
  });
  await editor(page).click();
  await page.keyboard.press('Alt+Shift+S');
  await expect(page.locator('.toast')).toContainText('00:04 — capture ajoutée');
  await expect(page.locator('.cm-boo-img img')).toBeVisible();
  const note = () => noteText(ctx.vault, 'Cours vidéo');
  await expect.poll(note).toMatch(/\[00:04\] !\[Capture 00:04\]\(assets\/[^)]+\.jpg\)/);
  const asset = /!\[Capture 00:04\]\((assets\/[^)]+\.jpg)\)/.exec(await note())?.[1];
  expect((await readFile(join(ctx.vault, asset!))).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
});

test('extension : les notes du navigateur arrivent, rangées dans leur cours', async ({ ctx }) => {
  const { page } = await ctx.launch();
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}`, { origin: 'chrome-extension://abcdefghijklmnop' });
  await new Promise((r) => ws.once('open', r));
  const replies: any[] = [];
  ws.on('message', (m) => replies.push(JSON.parse(String(m))));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'TEST-TOKN-ABCD-EFGH', client: { name: 'test', version: '1' } }));
  await expect.poll(() => replies[0]?.type).toBe('welcome');
  await expect(page.locator('.status-pill').first()).toContainText('Extension connectée');

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
        course: 'React',
        chapter: 'Hooks',
        placedAt: Date.now(),
      },
    }),
  );
  ws.send(JSON.stringify({ type: 'media.progress', noteId: 'youtube:abcdefghijk', position: 300, duration: 600 }));
  // Filed in the browser: the course and its chapter exist in the app.
  const tree = page.locator('.tree-item', { hasText: 'React' }).first();
  await expect(tree).toBeVisible();
  await tree.click();
  await settled(page);
  await expect(page.locator('.chapter', { hasText: 'Hooks' }).locator('.row', { hasText: 'React — Les hooks' })).toBeVisible();
  // The app shares its courses back, for the browser's picker.
  await expect.poll(() => replies.find((r) => r.type === 'library.courses' && r.courses.some((c: any) => c.title === 'React'))).toBeTruthy();

  await page.locator('.row', { hasText: 'React — Les hooks' }).click();
  await settled(page);
  await expect(page.locator('.web-source h2')).toHaveText('React — Les hooks');
  await expect(page.locator('.web-source')).toContainText('Reprendre à 05:00');
  await expect(page.locator('.chip', { hasText: 'Navigateur' })).toBeVisible();
  await expect(page.locator('.cm-boo-ts')).toHaveCount(2);
  ws.close();
  await expect(page.locator('.status-pill').first()).toContainText('Extension en attente');
});

test('Notion : connexion puis une page par note, avec son cours', async ({ ctx }) => {
  const pdf = join(ctx.dir, 'Statistiques.pdf');
  await writeFile(pdf, makePdf([['Statistiques', 'Moyenne et variance'], ['Lois usuelles']]));
  const { page } = await ctx.launch();
  await page.locator('.status-pill', { hasText: 'Notion non connecté' }).click();
  await expect(page.locator('#set-notion')).toBeVisible();
  await page.getByLabel('Secret de l’intégration').fill('secret_test');
  await page.getByLabel('Lien de la page (ou d’une base existante)').fill(`https://www.notion.so/Mes-cours-${PARENT_PAGE_ID.replace(/-/g, '')}`);
  await page.getByRole('button', { name: 'Connecter Notion' }).click();
  await expect(page.locator('#set-notion .conn-status.ok')).toContainText('Connecté à Espace de test');
  expect(ctx.notion.state.databases.size).toBe(1);
  // The secret never lands in the config file in clear text.
  expect(await readFile(join(ctx.dir, 'user-data', 'config.json'), 'utf8')).not.toContain('secret_test');

  const course = await page.evaluate(() => window.boo.library.createCourse({ title: 'Probabilités' }));
  const snap = await page.evaluate(() => window.boo.library.snapshot());
  const chapter = snap.courses.find((c) => c.id === course.id)!.chapters[0];
  await page.evaluate(([p, courseId, chapterId]) => window.boo.library.importFiles([p], { courseId, chapterId }), [pdf, course.id, chapter.id]);
  await openNote(page, 'Statistiques');
  await expect(page.locator('.pdf-page[data-page="1"].rendered')).toBeVisible();
  await editor(page).click();
  await page.keyboard.type('Formule de la variance');
  // Automatic sync: the note's page appears in Notion.
  const notePages = () => [...ctx.notion.state.pages.values()].filter((p) => p.parent?.database_id);
  await expect.poll(() => notePages().length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => ctx.notion.pageContent(notePages()[0].id), { timeout: 15_000 }).toContainEqual({ type: 'paragraph', text: 'p. 1 Formule de la variance' });
  const props = notePages()[0].properties;
  expect(props.Nom.title[0].text.content).toBe('Statistiques');
  expect(props.Type.select.name).toBe('PDF');
  expect(props.Cours.select.name).toBe('Probabilités');

  // Manual sync from the note's toolbar.
  await page.getByRole('button', { name: /Synchroniser avec Notion|Envoyer vers Notion/ }).click();
  await expect(page.locator('.toast', { hasText: 'Note synchronisée avec Notion' })).toBeVisible();
  expect(notePages()).toHaveLength(1);
  expect(Object.keys((await libraryJson(ctx.vault)).notes)).toHaveLength(1);
});
