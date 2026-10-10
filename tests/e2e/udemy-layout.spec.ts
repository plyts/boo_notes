import type { Page, Route, Worker } from '@playwright/test';
import { expect, fulfillMedia, runCommand, sampleVideo, test } from './fixtures';

/**
 * A course page laid out like Udemy's lecture view (as measured on users'
 * screenshots): a « Contenu du cours » column fixed to the window's right
 * edge, the lecture leaving room for it; a player letterboxing its picture;
 * the site's fullscreen button putting the whole page fullscreen. Docked
 * notes never leave an empty band beside the video nor cover it; both
 * fullscreens (the site's, Boo Notes') give the same split screen.
 */
const LECTURE = 'https://www.udemy.com/course/deploying-llms/learn/lecture/42';
const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Deploying LLMs | Udemy</title><style>
  :root { --sb: clamp(300px, 25vw, 400px); }
  body { margin: 0; font-family: sans-serif; background: #fff; }
  header[data-purpose="header"] { height: 56px; background: #1c1e1f; color: #fff; display: flex; align-items: center; padding: 0 16px; }
  /* The lecture column leaves room for the course content sidebar, fixed on the window's right edge. */
  .content { margin-right: var(--sb); }
  .player { position: relative; height: 72vh; background: #1c1e1f; }
  .player video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
  .fs { position: absolute; right: 12px; bottom: 12px; z-index: 2; }
  .tabs { display: flex; gap: 24px; padding: 16px 24px; border-bottom: 1px solid #ddd; }
  .sidebar { position: fixed; right: 0; top: 56px; bottom: 0; width: var(--sb); background: #f7f9fa; border-left: 1px solid #d1d7dc; padding: 12px; box-sizing: border-box; }
  /* Udemy's fullscreen: the whole page fullscreen, the player over all of it. */
  html:fullscreen .player { position: fixed; inset: 0; height: auto; z-index: 5; background: #000; }
</style></head><body>
  <header data-purpose="header">udemy · Deploying LLMs: A Practical Guide to LLMOps in Production</header>
  <div class="content">
    <div class="player" data-purpose="video-player"><video src="/__fixtures/sample.webm" muted playsinline preload="auto"></video><button class="fs" id="site-fs">Plein écran (Udemy)</button></div>
    <nav class="tabs"><span>Présentation</span><span>Q&amp;R</span><span>Notes</span><span>Annonces</span></nav>
    <p style="padding:0 24px">Programmer du temps pour apprendre…</p>
  </div>
  <aside class="sidebar">Contenu du cours<br>Section 5 : Performance Optimization</aside>
  <script>document.getElementById('site-fs').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();</script>
</body></html>`;

async function serve(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/course/')) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE });
  if (url.pathname === '/__fixtures/sample.webm') return fulfillMedia(route, await sampleVideo(), 'video/webm');
  return route.fulfill({ status: 404, body: '' });
}

const geometry = (page: Page) =>
  page.evaluate(() => {
    const r = (el: Element | null | undefined) => {
      const b = el?.getBoundingClientRect();
      return b ? { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) } : null;
    };
    const v = document.querySelector('video')!;
    const box = v.getBoundingClientRect();
    const s = Math.min(box.width / v.videoWidth, box.height / v.videoHeight);
    const pic = { l: Math.round(box.left + (box.width - v.videoWidth * s) / 2), t: Math.round(box.top + (box.height - v.videoHeight * s) / 2), w: Math.round(v.videoWidth * s), h: Math.round(v.videoHeight * s) };
    return { vw: innerWidth, vh: innerHeight, picture: pic, notes: r(document.getElementById('boo-notes-drawer')?.shadowRoot?.querySelector('.drawer.open')), sidebar: r(document.querySelector('.sidebar')), fullscreen: document.fullscreenElement?.tagName ?? null };
  });

async function open(page: Page, sw: Worker): Promise<void> {
  await page.goto(LECTURE);
  await page.bringToFront();
  await page.locator('#boo-notes-overlay').waitFor({ state: 'attached' });
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);
  await runCommand(sw, page, 'toggle-sidebar');
  await expect(page.frameLocator('#boo-notes-drawer iframe:not(.retired)').locator('.cm-content')).toBeFocused();
  await page.waitForTimeout(600);
}


type Geo = Awaited<ReturnType<typeof geometry>>;

/** The free part of the screen (beside the notes) and the picture's gaps in it. */
function inFree(g: Geo) {
  const n = g.notes!;
  const free = n.l > 0 ? { l: 0, r: n.l } : { l: n.r, r: g.vw };
  return { free, width: free.r - free.l, top: g.picture.t, bottom: g.vh - (g.picture.t + g.picture.h) };
}

test.beforeEach(async ({ context }) => {
  await context.route(/^https:\/\/www\.udemy\.com\//, serve);
});

test('ancrées à droite : la colonne « Contenu du cours » se range entre la vidéo et les notes, sans bande vide', async ({ page, sw }) => {
  await open(page, sw);
  await expect.poll(async () => (await geometry(page)).sidebar!.r).toBe((await geometry(page)).notes!.l);
  const g = await geometry(page);
  // The lecture ends where the column begins, the column where the notes begin.
  expect(Math.abs(g.picture.l + g.picture.w - g.sidebar!.l)).toBeLessThanOrEqual(1);
  expect(g.sidebar!.w).toBeGreaterThan(200);
  // Notes closed: the column back against the window's edge, its styles as they were.
  await runCommand(sw, page, 'toggle-sidebar');
  await expect.poll(async () => (await geometry(page)).sidebar!.r).toBe(g.vw);
  expect(await page.evaluate(() => (document.querySelector('.sidebar') as HTMLElement).getAttribute('style'))).toBeFalsy();
});

test('ancrées à gauche : la vidéo entre les notes et la colonne, sans rien recouvrir', async ({ page, sw }) => {
  await open(page, sw);
  const p = page.frameLocator('#boo-notes-drawer iframe:not(.retired)');
  await p.getByRole('button', { name: 'Disposition du panneau' }).click();
  await p.getByRole('menuitemradio', { name: 'Ancré à gauche' }).click();
  await expect.poll(async () => (await geometry(page)).notes?.l).toBe(0);
  await expect.poll(async () => {
    const g = await geometry(page);
    return g.picture.l >= g.notes!.r && g.picture.l + g.picture.w <= g.sidebar!.l + 1;
  }).toBe(true);
  // The column stays against the window's right edge (the notes are not there).
  expect((await geometry(page)).sidebar!.r).toBe((await geometry(page)).vw);
});

test('plein écran : celui du site (toute la page) et celui de Boo Notes donnent le même écran partagé, la vidéo centrée', async ({ page, sw }) => {
  await open(page, sw);
  const fill = async () => {
    // The picture takes the whole free width (16:9 in a narrower zone), centred vertically, black around.
    await expect.poll(async () => {
      const f = inFree(await geometry(page));
      return Math.abs((await geometry(page)).picture.w - f.width) <= 2 && Math.abs(f.top - f.bottom) <= 2;
    }).toBe(true);
    return geometry(page);
  };
  await page.locator('#site-fs').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('HTML');
  const site = await fill();
  // The page's other parts are hidden around the player.
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.player')!).boxShadow)).toContain('rgb(0, 0, 0)');
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.player')!).boxShadow)).toBe('none');

  const p = page.frameLocator('#boo-notes-drawer iframe:not(.retired)');
  await p.getByRole('button', { name: 'Plein écran avec les notes' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-purpose'))).toBe('video-player');
  const ours = await fill();
  for (const k of ['l', 't', 'w', 'h'] as const) expect(Math.abs(ours.picture[k] - site.picture[k])).toBeLessThanOrEqual(2);
  await page.evaluate(() => document.exitFullscreen());
});
