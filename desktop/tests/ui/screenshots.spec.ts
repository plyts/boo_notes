// Documentation screenshots (docs/screenshots/desktop-*.png): SCREENSHOTS=1 npm run test:ui -- screenshots
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { expect, makePdf, makeWav, test } from './fixtures';

const OUT = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));

test.skip(!process.env.SCREENSHOTS, 'SCREENSHOTS=1 pour régénérer les captures');

const clearToasts = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

test('bibliothèque et lecteur PDF', async ({ ctx }) => {
  const pdf = join(ctx.dir, 'Probabilités — Chapitre 3.pdf');
  await writeFile(
    pdf,
    makePdf([
      ['Chapitre 3 : Variables aleatoires', 'Definition', 'Une variable aleatoire X est une application mesurable.', 'Esperance : E[X] = somme des x P(X = x).'],
      ['Loi binomiale', 'X suit B(n, p) si X compte les succes de n epreuves.', 'Esperance np, variance np(1 - p).'],
      ['Loi de Poisson', 'P(X = k) = exp(-l) l^k / k!', 'Approximation de B(n, p) quand n est grand.'],
    ]),
  );
  const wav = join(ctx.dir, 'Podcast — Histoire des sciences.wav');
  await writeFile(wav, makeWav(30));
  const { page } = await ctx.launch();
  await page.evaluate(() => window.boo.settings.set({ theme: 'dark' }));
  await page.evaluate(([a, b]) => window.boo.library.addFiles([a, b]), [pdf, wav]);

  // Courses noted in the browser, with their progress.
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}`, { origin: 'chrome-extension://abcdefghijklmnop' });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'TEST-TOKN-ABCD-EFGH' }));
  const courses = [
    ['youtube:abcdefghijk', 'youtube', 'video', 'React — Les hooks en profondeur', 'https://www.youtube.com/watch?v=abcdefghijk', 1260, 2700],
    ['udemy:ml/42', 'udemy', 'video', 'Machine Learning — Régression linéaire', 'https://www.udemy.com/course/ml/learn/lecture/42', 2400, 2520],
    ['notion:0123456789abcdef0123456789abcdef', 'notion', 'video', 'Cours d’anglais — Semaine 4', 'https://www.notion.so/0123456789abcdef0123456789abcdef', 300, 1500],
  ] as const;
  for (const [id, platform, kind, title, url, pos, dur] of courses) {
    ws.send(
      JSON.stringify({
        type: 'note.upsert',
        note: { id, platform, kind, url, title, markdown: '[00:05] Intro\n[02:10] Idée clé\n[05:42] Exemple', createdAt: 1, updatedAt: Date.now(), rev: 1 },
      }),
    );
    ws.send(JSON.stringify({ type: 'media.progress', noteId: id, position: pos, duration: dur }));
  }
  ws.send(JSON.stringify({ type: 'player.active', player: { noteId: courses[0][0], title: courses[0][3], url: courses[0][4] } }));
  await expect(page.locator('.row')).toHaveCount(5);

  // The PDF: read to page 2, a few notes, a highlight.
  await page.locator('.row-main', { hasText: 'Probabilités' }).click();
  await expect(page.locator('.pdf-page[data-page="1"].rendered')).toBeVisible();
  await page.locator('.notes-editor .cm-content').click();
  await page.keyboard.type('# Variables aléatoires');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Une v.a. est une **application mesurable**');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Espérance = moyenne pondérée par les probabilités');
  const span = page.locator('.pdf-page[data-page="1"] .textLayer span', { hasText: 'Une variable aleatoire' });
  await span.selectText();
  await page.keyboard.press('Alt+Shift+H');
  await span.selectText();
  await page.keyboard.press('Alt+Shift+Q');
  await page.locator('.pdf-scroller').click({ position: { x: 20, y: 400 } });
  await expect(page.locator('.save-state')).toHaveText('Enregistré');
  await page.waitForTimeout(400);
  await clearToasts(page);
  await page.screenshot({ path: `${OUT}desktop-pdf.png` });

  await page.keyboard.press('Escape');
  await page.locator('.nav-item[data-key="all"]').click();
  await page.mouse.move(700, 20);
  await page.waitForTimeout(400);
  await clearToasts(page);
  await page.screenshot({ path: `${OUT}desktop-library.png` });

  await page.evaluate(() => window.boo.settings.set({ theme: 'light' }));
  await page.locator('.row-main', { hasText: 'Podcast' }).click();
  await page.evaluate(async () => {
    const a = document.querySelector('audio')!;
    const seeked = new Promise((r) => a.addEventListener('seeked', r, { once: true }));
    a.currentTime = 12;
    await seeked;
  });
  await page.locator('.notes-editor .cm-content').click();
  await page.keyboard.type('Galilée et la méthode expérimentale');
  await page.locator('.media-stage').click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(700);
  await clearToasts(page);
  await page.screenshot({ path: `${OUT}desktop-audio.png` });
  ws.close();
});
