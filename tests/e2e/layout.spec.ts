import type { Page } from '@playwright/test';
import { expect, openNotes, openWatch, panel, runCommand, test } from './fixtures';

/**
 * The notes never hide the video: side by side, a player that keeps its
 * width is scaled to end where the notes begin; in fullscreen, the notes stay
 * beside the picture (split screen) — also when the page put the bare <video>
 * fullscreen.
 */

/** On-screen boxes of the video and of the open notes. */
const boxes = (page: Page) =>
  page.evaluate(() => {
    const r = (el: Element | null | undefined) => {
      const b = el?.getBoundingClientRect();
      return b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } : null;
    };
    return { video: r(document.querySelector('video')), notes: r(document.getElementById('boo-notes-drawer')?.shadowRoot?.querySelector('.drawer.open')), w: innerWidth, h: innerHeight };
  });

/** A button of the page putting the bare <video> fullscreen (like its native controls), clicked. */
async function bareVideoFullscreen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'bare-fs';
    b.textContent = 'Plein écran de la vidéo';
    b.onclick = () => void document.querySelector('video')!.requestFullscreen();
    document.querySelector('main')!.prepend(b);
  });
  await page.locator('#bare-fs').click();
}

test('côte à côte : un lecteur large est réduit pour finir où commencent les notes', async ({ page, sw }) => {
  await openWatch(page);
  // A player sized from the window (like YouTube's), which does not follow the page's margin.
  await page.addStyleTag({ content: '#movie_player { width: 100vw !important; height: 56.25vw !important; }' });
  await openNotes(sw, page);
  await expect(page.locator('#movie_player')).toHaveAttribute('data-boo-notes-fit', 'shrink');
  await expect.poll(async () => {
    const { video, notes } = await boxes(page);
    return video!.right <= notes!.left;
  }).toBe(true);
  const { video } = await boxes(page);
  // Its corner stays put, its proportions too.
  expect(video!.left).toBeCloseTo(24, 0);
  expect(video!.width / video!.height).toBeCloseTo(16 / 9, 1);

  // Notes closed: the player as it was.
  await runCommand(sw, page, 'toggle-sidebar');
  await expect(page.locator('#movie_player')).not.toHaveAttribute('data-boo-notes-fit');
  expect(await page.evaluate(() => document.getElementById('movie_player')!.style.transform)).toBe('');
});

test('plein écran du lecteur : les notes restent à côté de la vidéo', async ({ page, sw }) => {
  await openWatch(page);
  await openNotes(sw, page);
  await page.locator('#movie_player').dblclick({ position: { x: 100, y: 100 } });
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('movie_player');
  await expect(page.locator('#boo-notes-drawer .drawer')).toHaveClass(/open/);
  expect(await page.evaluate(() => document.getElementById('boo-notes-drawer')?.parentElement?.id)).toBe('movie_player');
  // The whole player is scaled, its controls too.
  await expect(page.locator('#movie_player')).toHaveAttribute('data-boo-notes-fit', 'fill');
  await expect.poll(async () => {
    const { video, notes } = await boxes(page);
    return video!.right <= notes!.left + 1 && video!.left >= -1;
  }).toBe(true);
  // The picture fills the free part of the screen (width or height); the notes keep their size, at the edge.
  const { video, notes, w, h } = await boxes(page);
  expect(Math.max(video!.width / notes!.left, video!.height / h)).toBeGreaterThan(0.98);
  expect(notes!.width).toBeCloseTo(360, 0);
  expect(notes!.right).toBeCloseTo(w, 0);
  expect(await page.evaluate(() => document.querySelector('.ytp-progress-bar')!.getBoundingClientRect().right)).toBeLessThanOrEqual(notes!.left + 1);
  // Still usable.
  await panel(page).locator('.cm-content').click();
  await page.keyboard.type('En plein écran');
  await expect(panel(page).locator('.cm-content')).toContainText('En plein écran');

  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.locator('#movie_player')).not.toHaveAttribute('data-boo-notes-fit');
  expect(await page.evaluate(() => [document.getElementById('movie_player')!.style.scale, document.getElementById('boo-notes-drawer')!.style.scale])).toEqual(['', '']);
});

test('plein écran natif de la vidéo seule : son conteneur le prend, notes comprises', async ({ page, sw }) => {
  await openWatch(page);
  await openNotes(sw, page);
  // The page (or the video's own controls) puts the bare <video> fullscreen.
  await bareVideoFullscreen(page);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('movie_player');
  await expect(page.locator('#boo-notes-drawer .drawer')).toHaveClass(/open/);
  await expect.poll(async () => {
    const { video, notes } = await boxes(page);
    return !!notes && video!.right <= notes.left + 1;
  }).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test('notes fermées : le plein écran natif de la vidéo reste tel quel', async ({ page }) => {
  await openWatch(page);
  await bareVideoFullscreen(page);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('VIDEO');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.fullscreenElement?.tagName)).toBe('VIDEO');
  await page.evaluate(() => document.exitFullscreen());
});

test('« Plein écran avec les notes » : bouton du panneau, aller et retour', async ({ page, sw }) => {
  await openWatch(page);
  await openNotes(sw, page);
  const button = panel(page).getByRole('button', { name: 'Plein écran avec les notes' });
  await expect(button).toBeVisible();
  await button.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('MAIN');
  await expect(page.locator('#movie_player')).toHaveAttribute('data-boo-notes-fit', 'fill');
  await expect.poll(async () => {
    const { video, notes } = await boxes(page);
    return !!notes && video!.right <= notes.left + 1 && video!.width > 640;
  }).toBe(true);
  await button.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.locator('#movie_player')).not.toHaveAttribute('data-boo-notes-fit');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('main')!).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
});
