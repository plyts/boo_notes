// Documentation screenshots (docs/screenshots/desktop-*.png): SCREENSHOTS=1 npm run test:ui -- screenshots
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { WebSocket } from 'ws';
import { editor, expect, makePdf, makeWav, openNote, settled, test } from './fixtures';

const OUT = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));

test.skip(!process.env.SCREENSHOTS, 'SCREENSHOTS=1 pour régénérer les captures');

const clearToasts = (page: Page) => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(640, 5);
  await page.waitForTimeout(700);
  await clearToasts(page);
  await page.screenshot({ path: `${OUT}${name}.png` });
}

test('le second cerveau : accueil, cours, note, carte mentale, révisions', async ({ ctx }) => {
  test.setTimeout(180_000);
  const pdf = join(ctx.dir, 'Électrocinétique — Chapitre 2.pdf');
  await writeFile(
    pdf,
    makePdf([
      ['Chapitre 2 : La loi d Ohm', 'Definition', 'La tension aux bornes d un resistor est proportionnelle au courant.', 'U = R I'],
      ['Association de resistances', 'En serie : R = R1 + R2', 'En parallele : 1/R = 1/R1 + 1/R2'],
      ['Puissance', 'P = U I = R I^2'],
    ]),
  );
  const wav = join(ctx.dir, 'Amphi 3 — enregistrement.wav');
  await writeFile(wav, makeWav(40));
  const { app, page } = await ctx.launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await page.evaluate(() => window.boo.settings.set({ theme: 'dark' }));

  // A small library: two courses, chapters, notes linked to each other, resources.
  const ids = await page.evaluate(
    async ([pdf, wav]) => {
      const L = window.boo.library;
      const phys = await L.createCourse({ title: 'Physique — Électricité', emoji: '⚡', hue: 45 });
      const hist = await L.createCourse({ title: 'Histoire des sciences', emoji: '🏛️', hue: 262 });
      const bio = await L.createCourse({ title: 'Biologie cellulaire', emoji: '🧬', hue: 152 });
      const rc = await L.addChapter(phys.id, 'Circuits RC');
      let snap = await L.snapshot();
      const first = (id: string) => snap.courses.find((c) => c.id === id)!.chapters[0].id;
      await L.updateChapter(phys.id, first(phys.id), { title: 'La loi d’Ohm' });
      await L.updateChapter(hist.id, first(hist.id), { title: 'La révolution industrielle' });
      await L.updateChapter(bio.id, first(bio.id), { title: 'La membrane' });
      const ohm = { courseId: phys.id, chapterId: first(phys.id) };
      const { notes } = await L.importFiles([pdf], ohm);
      const audio = (await L.importFiles([wav], ohm)).notes[0];
      await L.linkResource(notes[0].id, audio.resources[0]);
      await L.saveNote(
        notes[0].id,
        '# La loi d’Ohm\n\n[p. 1] U = R × I :: tension, résistance, intensité\n[p. 1] La ==résistance== se mesure en ohms (Ω)\n' +
          `[00:12](res:${audio.resources[0]}) Exemple au tableau : 2 résistances en série\n[p. 2] En parallèle, les inverses s’ajoutent\n\nVoir [[Condensateur]] et [[Énergie électrique]].\n`,
      );
      const cond = await L.createNote({ title: 'Condensateur', placement: { courseId: phys.id, chapterId: rc.id }, body: 'q = C × U :: charge d’un condensateur\nτ = R × C :: constante de temps\n[[Électrocinétique — Chapitre 2]]' });
      const energy = await L.createNote({ title: 'Énergie électrique', placement: ohm, body: 'E = P × t :: énergie\n[[Machine à vapeur]]' });
      await L.createNote({ title: 'Machine à vapeur', placement: { courseId: hist.id, chapterId: first(hist.id) }, body: '==1769== : brevet de James Watt\n[[Énergie électrique]]' });
      await L.createNote({ title: 'Potentiel de membrane', placement: { courseId: bio.id, chapterId: first(bio.id) }, body: 'Pompe Na/K :: 3 Na+ sortent, 2 K+ entrent\n[[Électrocinétique — Chapitre 2]]' });
      await L.createNote({ title: 'Idées en vrac', body: '[[Condensateur]] et la photo du tableau' });
      for (const id of [notes[0].id, cond.id, energy.id]) await L.review(id, 'start');
      await L.setProgress(notes[0].resources[0], 2, 3);
      snap = await L.snapshot();
      return { pdfNote: notes[0].id, phys: phys.id };
    },
    [pdf, wav],
  );

  // Browser notes, filed from the extension.
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}`, { origin: 'chrome-extension://abcdefghijklmnop' });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'TEST-TOKN-ABCD-EFGH' }));
  ws.send(
    JSON.stringify({
      type: 'note.upsert',
      note: {
        id: 'youtube:abcdefghijk',
        platform: 'youtube',
        kind: 'video',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        title: 'Loi d’Ohm — expérience en vidéo',
        markdown: '[00:05] Montage\n[02:10] Mesures\n[05:42] [[Électrocinétique — Chapitre 2]]',
        createdAt: 1,
        updatedAt: Date.now(),
        rev: 1,
        course: 'Physique — Électricité',
        chapter: 'La loi d’Ohm',
        placedAt: Date.now(),
      },
    }),
  );
  ws.send(JSON.stringify({ type: 'media.progress', noteId: 'youtube:abcdefghijk', position: 610, duration: 960 }));
  await page.waitForTimeout(800);

  await page.locator('.nav-item', { hasText: 'Accueil' }).click();
  await settled(page);
  await shot(page, 'desktop-today');

  await page.locator('.tree-item', { hasText: 'Physique' }).first().click();
  await settled(page);
  await shot(page, 'desktop-course');

  await openNote(page, 'Électrocinétique — Chapitre 2');
  await expect(page.locator('.pdf-page[data-page="1"].rendered')).toBeVisible();
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.locator('.pdf-scroller').click({ position: { x: 20, y: 300 } });
  await shot(page, 'desktop-note');

  await page.locator('.nav-item', { hasText: 'Carte mentale' }).click();
  await settled(page);
  await page.waitForTimeout(2500);
  await shot(page, 'desktop-graph');
  await page.locator('.segment', { hasText: 'Carte mentale' }).click();
  await page.waitForTimeout(1500);
  await page.locator('.react-flow__node', { hasText: 'Condensateur' }).first().click();
  await shot(page, 'desktop-mindmap');

  await page.evaluate(() => window.boo.settings.set({ theme: 'light' }));
  await page.locator('.nav-item', { hasText: 'À réviser' }).click();
  await settled(page);
  await page.getByRole('button', { name: /Réviser \(/ }).click();
  await page.keyboard.press('Space');
  await shot(page, 'desktop-review');

  await page.keyboard.press('Control+Shift+E');
  await shot(page, 'desktop-export');
  ws.close();
  void ids;
});

test('transcription d’une vidéo locale, passage et extrait', async ({ ctx }) => {
  const { copyFile } = await import('node:fs/promises');
  const video = join(ctx.dir, 'Théorème de Stokes — Cours 7.webm');
  await copyFile(fileURLToPath(new URL('../../../tests/e2e/fixtures/sample.webm', import.meta.url)), video);
  const cues = [
    ['So today we look at Stokes’ theorem.', 'Aujourd’hui, nous étudions le théorème de Stokes.'],
    ['The circulation of F around the boundary…', 'La circulation de F le long du bord…'],
    ['…equals the flux of its curl through S.', '…est égale au flux de son rotationnel à travers S.'],
    ['Mind the orientation of the boundary.', 'Attention à l’orientation du bord.'],
    ['Let’s check it on an example.', 'Vérifions-le sur un exemple.'],
    ['Take the upper half-sphere.', 'Prenons la demi-sphère supérieure.'],
    ['Its boundary is the unit circle.', 'Son bord est le cercle unité.'],
    ['Both sides give two pi.', 'Les deux membres valent deux pi.'],
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  await writeFile(
    join(ctx.dir, 'Théorème de Stokes — Cours 7.en.vtt'),
    `WEBVTT\n\n${cues.map(([en], i) => `00:00:${pad(i * 3)}.000 --> 00:00:${pad(i * 3 + 3)}.000\n${en}`).join('\n\n')}\n`,
  );
  const { app, page } = await ctx.launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await page.evaluate(() => window.boo.settings.set({ theme: 'dark' }));
  const { notes } = await page.evaluate((p) => window.boo.library.importFiles(p), [video]);
  const id = notes[0].id;
  const t = await page.evaluate((id) => window.boo.library.transcript(id), id);
  await page.evaluate(
    ([id, patches]) => window.boo.library.annotateTranscript(id, patches as never),
    [id, t!.cues.map((c, i) => ({ id: c.id, tr: cues[i][1], ...(i === 3 ? { note: 'Règle de la main droite : normale sortante' } : {}) }))] as const,
  );
  await openNote(page, 'Théorème de Stokes — Cours 7');
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);
  await editor(page).click();
  await page.keyboard.type('## Théorème de Stokes');
  await page.keyboard.press('Enter');
  await page.evaluate(async () => {
    const v = document.querySelector('video') as HTMLVideoElement;
    v.currentTime = 3.5;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
  });
  await page.keyboard.type('Circulation = flux du rotationnel');
  await page.keyboard.press('Enter');
  await page.evaluate(() => void (document.querySelector('video') as HTMLVideoElement).play());
  await page.keyboard.press('Alt+I');
  await page.waitForTimeout(4200);
  await page.keyboard.press('Alt+O');
  await expect(page.locator('.cm-boo-img.cm-boo-passage img')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(async () => {
    const v = document.querySelector('video') as HTMLVideoElement;
    v.pause();
    v.currentTime = 10;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
  });
  await shot(page, 'desktop-passage');
  await page.getByRole('tab', { name: /Transcription/ }).click();
  await page.waitForTimeout(800);
  await shot(page, 'desktop-transcript');
});
