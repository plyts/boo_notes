import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { editor, expect, importAndOpen, libraryJson, makePdf, makeWav, noteText, openNote, settled, test } from './fixtures';

test('cours › chapitres › notes : créer, ranger, déplacer', async ({ ctx }) => {
  const { page } = await ctx.launch();
  await page.getByRole('button', { name: 'Nouveau cours' }).first().click();
  let ask = page.getByRole('dialog', { name: 'Nouveau cours' });
  await ask.getByRole('textbox').fill('Physique');
  await ask.getByRole('button', { name: 'Créer le cours' }).click();
  await settled(page);
  await expect(page.locator('.large-title h1')).toHaveText('Physique');

  await page.getByRole('button', { name: 'Ajouter un chapitre' }).click();
  ask = page.getByRole('dialog', { name: 'Nouveau chapitre' });
  await ask.getByRole('textbox').fill('Circuits RC');
  await ask.getByRole('button', { name: 'Ajouter' }).click();
  const rc = page.locator('.chapter', { hasText: 'Circuits RC' });
  await expect(rc).toBeVisible();

  // A note created in a chapter lands there.
  await rc.getByRole('button', { name: 'Note' }).click();
  ask = page.getByRole('dialog', { name: 'Nouvelle note' });
  await ask.getByRole('textbox').fill('Condensateur');
  await ask.getByRole('button', { name: 'Créer' }).click();
  await settled(page);
  await expect(page.locator('.crumbs')).toContainText('Physique');
  await expect(page.locator('.crumbs')).toContainText('Circuits RC');
  const course = (await libraryJson(ctx.vault)).courses[0];
  expect(course.chapters.map((c) => [c.title, c.notes.length])).toEqual([
    ['Chapitre 1', 0],
    ['Circuits RC', 1],
  ]);

  // Moved from the inspector.
  await page.locator('.picker', { hasText: 'Chapitre' }).getByRole('button').click();
  await page.getByRole('option', { name: '1. Chapitre 1' }).click();
  await expect.poll(async () => (await libraryJson(ctx.vault)).courses[0].chapters[0].notes.length).toBe(1);

  // An unfiled note dragged onto a chapter of the sidebar.
  await page.evaluate(() => window.boo.library.createNote({ title: 'Loi d’Ohm' }));
  const unfold = page.locator('.tree-item', { hasText: 'Physique' }).getByRole('button', { name: 'Déplier' });
  if (await unfold.count()) await unfold.click();
  await page.locator('.nav-item', { hasText: 'Non classées' }).click();
  await settled(page);
  await page.locator('.row', { hasText: 'Loi d’Ohm' }).dragTo(page.locator('.tree-item', { hasText: 'Circuits RC' }));
  await expect(page.locator('.toast', { hasText: 'Note classée dans « Circuits RC »' })).toBeVisible();
  await expect.poll(async () => (await libraryJson(ctx.vault)).courses[0].chapters[1].notes.length).toBe(1);
});

test('une note, plusieurs supports : chaque repère renvoie au sien', async ({ ctx }) => {
  const pdf = join(ctx.dir, 'Électrocinétique.pdf');
  await writeFile(pdf, makePdf([['Loi d Ohm'], ['Condensateur']]));
  const wav = join(ctx.dir, 'Amphi 3.wav');
  await writeFile(wav, makeWav(20));
  const { page } = await ctx.launch();
  await page.evaluate((p) => window.boo.library.importFiles(p), [wav]);
  await importAndOpen(page, [pdf], 'Électrocinétique');
  await expect(page.locator('.pdf-page[data-page="1"].rendered')).toBeVisible();
  await editor(page).click();
  await page.keyboard.type('Définition');

  // Link the lecture recording from the library.
  await page.locator('.inspector').getByRole('button', { name: 'Lier un support' }).click();
  const sheet = page.getByRole('dialog', { name: 'Lier un support' });
  await sheet.getByRole('tab', { name: 'Bibliothèque' }).click();
  await sheet.getByRole('row', { name: /Amphi 3/ }).click();
  await expect(page.locator('.stage-tabs .tab')).toHaveCount(2);
  await expect(page.locator('.stage-tabs .tab', { hasText: 'Amphi 3' }).locator('.tab-badge')).toHaveText('2');
  await page.locator('.stage-tabs .tab', { hasText: 'Amphi 3' }).click();
  await expect(page.locator('.media-stage.audio')).toBeVisible();
  await page.evaluate(async () => {
    const a = document.querySelector('audio')!;
    const seeked = new Promise((r) => a.addEventListener('seeked', r, { once: true }));
    a.currentTime = 9;
    await seeked;
  });
  await editor(page).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Exemple au tableau');
  const lib = await libraryJson(ctx.vault);
  const audio = Object.values(lib.resources).find((r) => r.title === 'Amphi 3');
  await expect.poll(() => noteText(ctx.vault, 'Électrocinétique')).toContain(`[p. 1] Définition\n[00:09](res:${audio.id}) Exemple au tableau`);
  // The chip carries the resource's number.
  await expect(page.locator('.cm-boo-res', { hasText: '00:09' })).toHaveAttribute('data-badge', '2');

  // Back to the PDF from its page chip.
  await page.locator('.cm-boo-page', { hasText: 'p. 1' }).click();
  await expect(page.locator('.pdf-page[data-page="1"]')).toBeVisible();
});

test('flux par adresse : un audio en ligne se lit et s’annote dans l’app', async ({ ctx }) => {
  const wav = makeWav(30);
  const server = createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      res.writeHead(206, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${wav.length}`, 'Content-Length': end - start + 1 });
      res.end(wav.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': wav.length });
    res.end(wav);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/radio/emission-42.wav`;
  try {
    const { page } = await ctx.launch();
    await page.keyboard.press('Control+Shift+O');
    const sheet = page.getByRole('dialog', { name: 'Ouvrir un flux ou une adresse' });
    await sheet.getByLabel('Adresse').fill(url);
    await sheet.getByLabel('Titre (facultatif)').fill('Émission 42');
    await sheet.getByRole('button', { name: 'Ouvrir' }).click();
    await settled(page);
    await expect(page.locator('.note-title')).toHaveText('Émission 42');
    await expect(page.locator('.media-stage.audio')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.querySelector('audio')?.duration ?? 0)).toBeCloseTo(30, 0);
    await page.evaluate(async () => {
      const a = document.querySelector('audio')!;
      const seeked = new Promise((r) => a.addEventListener('seeked', r, { once: true }));
      a.currentTime = 12;
      await seeked;
    });
    await editor(page).click();
    await page.keyboard.type('Le passage sur la radio libre');
    await expect.poll(() => noteText(ctx.vault, 'Émission 42')).toContain('[00:12] Le passage sur la radio libre');
    const res = Object.values((await libraryJson(ctx.vault)).resources)[0];
    expect(res).toMatchObject({ origin: 'url', kind: 'audio', source: url });
  } finally {
    server.close();
  }
});

async function seedBrain(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const L = window.boo.library;
    const phys = await L.createCourse({ title: 'Physique', emoji: '⚡', hue: 45 });
    const hist = await L.createCourse({ title: 'Histoire', emoji: '🏛️', hue: 262 });
    const snap = await L.snapshot();
    const ch = (id: string) => snap.courses.find((c) => c.id === id)!.chapters[0].id;
    await L.createNote({ title: 'Résistance', placement: { courseId: phys.id, chapterId: ch(phys.id) }, body: 'U = R × I :: loi d’Ohm\n[[Condensateur]]' });
    await L.createNote({ title: 'Condensateur', placement: { courseId: phys.id, chapterId: ch(phys.id) }, body: 'q = C × U :: charge\n[[Machine à vapeur]]' });
    await L.createNote({ title: 'Machine à vapeur', placement: { courseId: hist.id, chapterId: ch(hist.id) }, body: '==1769== James Watt' });
    await L.createNote({ title: 'Vrac', body: '[[Résistance]]' });
  });
}

test('carte mentale : réseau groupé par cours, repli, recherche, carte équilibrée', async ({ ctx }) => {
  const { page } = await ctx.launch();
  await seedBrain(page);
  await page.locator('.nav-item', { hasText: 'Carte mentale' }).click();
  await settled(page);
  const nodes = page.locator('.react-flow__node');
  // 2 courses, 2 chapters, 4 notes.
  await expect(nodes).toHaveCount(8);
  await expect(page.locator('.hull-title')).toHaveCount(3);
  expect((await page.locator('.hull-title').allTextContents()).sort()).toEqual(['Non classées', '⚡ Physique', '🏛️ Histoire'].sort());
  await expect(page.locator('.react-flow__edge')).toHaveCount(5 + 3); // structure, then references

  // Search dims everything but the matches.
  await page.getByLabel('Chercher dans le graphe').fill('conde');
  await expect(page.locator('.gn.is-match')).toHaveCount(1);
  await page.getByLabel('Chercher dans le graphe').fill('');

  // Folding a course: its notes disappear, their links go to the course.
  await page.locator('.hull', { hasText: 'Physique' }).getByRole('button', { name: /Replier/ }).click();
  await expect(nodes).toHaveCount(5);
  await expect(page.locator('.gn-course.is-collapsed')).toContainText('Physique');

  // Selecting a node shows its links; « Ouvrir » goes there.
  await page.locator('.react-flow__node', { hasText: 'Machine à vapeur' }).click();
  const card = page.locator('.graph-card');
  await expect(card).toContainText('Machine à vapeur');
  await expect(card.locator('.graph-link-chip', { hasText: 'Physique' })).toContainText('Référence');

  // Mind map: the whole brain around its root.
  await page.getByRole('radio', { name: 'Carte mentale' }).click();
  await expect(page.locator('.gn-root')).toHaveText('Mon second cerveau');
  await card.getByRole('button', { name: 'Ouvrir' }).click();
  await settled(page);
  await expect(page.locator('.note-title')).toHaveText('Machine à vapeur');
});

test('export : fiches PDF, cartes Anki, JSON et Markdown', async ({ ctx }) => {
  const { page } = await ctx.launch();
  await seedBrain(page);
  await page.keyboard.press('Control+Shift+E');
  const sheet = page.getByRole('dialog', { name: 'Exporter mes cours' });
  await sheet.locator('.check-card', { hasText: 'Dossiers Markdown' }).click();
  await sheet.locator('.check-card', { hasText: 'Données JSON' }).click();
  await expect(sheet.getByRole('checkbox', { name: /Données JSON/ })).toBeChecked();
  await sheet.getByRole('button', { name: /Exporter 4 notes/ }).click();
  await expect(sheet).toContainText('4 notes', { timeout: 20_000 });
  await expect(sheet).toContainText('3 cartes');
  const [folder] = await readdir(join(ctx.dir, 'exports'));
  const files = await readdir(join(ctx.dir, 'exports', folder), { recursive: true });
  expect(files).toEqual(
    expect.arrayContaining(['Fiches de révision.html', 'Fiches de révision.pdf', 'Cartes - questions (Anki).txt', 'Cartes - textes à trous (Anki).txt', 'boo-notes.json', 'README.md']),
  );
  const anki = await readFile(join(ctx.dir, 'exports', folder, 'Cartes - questions (Anki).txt'), 'utf8');
  expect(anki).toContain('#separator:tab');
  expect(anki).toMatch(/U = R × I\tloi d’Ohm\tBoo Notes::Physique\t/);
  const json = JSON.parse(await readFile(join(ctx.dir, 'exports', folder, 'boo-notes.json'), 'utf8'));
  expect(json.courses.map((c: { title: string }) => c.title)).toEqual(['Physique', 'Histoire']);
  await sheet.getByRole('button', { name: 'Terminé' }).click();
  await openNote(page, 'Vrac');
});
