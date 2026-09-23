import type { Page, Worker } from '@playwright/test';
import { expect, fulfillMedia, makeWav, openNotes, panel, runCommand, sampleVideo, storedNote, test } from './fixtures';

const NOTION_PAGE = '0123456789abcdef0123456789abcdef';
const PODCAST_NOTE = 'web:podcast.example.test/ep/1';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font-family:sans-serif}main{padding:24px}video{width:640px;height:360px;background:#000}</style>
</head><body><main>${body}</main></body></html>`;
}

test.beforeEach(async ({ context }) => {
  const wav = makeWav(30);
  await context.route(/^https:\/\/[\w.-]+\.example\.test\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/ep/1')
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: page('Épisode 1 — Le podcast', '<h1>Épisode 1</h1><audio controls preload="auto" src="/ep1.wav"></audio>'),
      });
    if (url.pathname === '/ep1.wav') return fulfillMedia(route, wav, 'audio/wav');
    if (url.pathname === '/article')
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: page('Article', '<p>Pas de média ici.</p>') });
    return route.fulfill({ status: 404, body: '' });
  });
  await context.route(/^https:\/\/www\.notion\.so\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(NOTION_PAGE))
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: page(
          'Cours React — Hooks | Notion',
          `<h1>Cours React — Hooks</h1>
           <div class="notion-video-block"><video controls muted preload="auto" src="/f/lesson.webm"></video></div>`,
        ),
      });
    if (url.pathname === '/f/lesson.webm') return fulfillMedia(route, await sampleVideo(), 'video/webm');
    return route.fulfill({ status: 404, body: '' });
  });
});

async function setMedia(page: Page, time: number): Promise<void> {
  await page.evaluate(async (time) => {
    const m = document.querySelector('audio, video') as HTMLMediaElement;
    m.pause();
    const seeked = new Promise((r) => m.addEventListener('seeked', r, { once: true }));
    m.currentTime = time;
    await seeked;
  }, time);
}

async function stored(sw: Worker, key: string): Promise<Record<string, unknown> | undefined> {
  return (await sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key)) as
    | Record<string, unknown>
    | undefined;
}

test.describe('Audio, Notion et autres sites', () => {
  test('podcast sur un site quelconque : activation au raccourci, horodatage, suivi de progression', async ({
    page,
    sw,
  }) => {
    await page.goto('https://podcast.example.test/ep/1?utm_source=newsletter');
    await page.bringToFront();
    await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 2);
    // Not a declared site: nothing is injected until the user asks for it.
    await expect(page.locator('#boo-notes-overlay')).toHaveCount(0);
    await setMedia(page, 7);

    await openNotes(sw, page);
    const notes = panel(page);
    await expect(notes.locator('.platform')).toHaveText('Web · Audio');
    await expect(notes.locator('.action', { hasText: 'Capturer' })).toBeDisabled();
    await expect(notes.locator('.site-hint')).toContainText('Actif sur podcast.example.test pour cet onglet.');

    await page.keyboard.type('Idée clé');
    await expect.poll(async () => (await storedNote(sw, PODCAST_NOTE))?.markdown).toBe('[00:07] Idée clé');
    expect(await storedNote(sw, PODCAST_NOTE)).toMatchObject({
      title: 'Épisode 1 — Le podcast',
      kind: 'audio',
      platform: 'web',
      url: 'https://podcast.example.test/ep/1',
    });

    // A screenshot of an audio track makes no sense: explained, not silently ignored.
    await runCommand(sw, page, 'capture-screenshot');
    await expect(page.locator('#boo-notes-overlay .toast')).toHaveText('Capture indisponible : ce média est audio');

    // Pausing records where the lesson was left (course tracking).
    await setMedia(page, 12);
    await page.evaluate(() => document.querySelector('audio')?.dispatchEvent(new Event('pause')));
    await expect
      .poll(async () => (await stored(sw, `progress:${PODCAST_NOTE}`))?.position)
      .toBeCloseTo(12, 0);
    const index = (await stored(sw, 'notes:index')) as Record<string, { progress?: { duration: number } }>;
    expect(index[PODCAST_NOTE].progress?.duration).toBeCloseTo(30, 0);
  });

  test('« Toujours activer ici » réinjecte Boo Notes à chaque visite', async ({ page, sw, context }) => {
    await page.goto('https://podcast.example.test/ep/1');
    await page.bringToFront();
    await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 2);
    await openNotes(sw, page);
    await panel(page).getByRole('button', { name: 'Toujours activer ici' }).click();
    await expect(panel(page).locator('.site-hint')).toBeHidden();
    await expect.poll(() => stored(sw, 'sites:enabled')).toEqual(['https://podcast.example.test']);

    const again = await context.newPage();
    await again.goto('https://podcast.example.test/ep/1');
    await expect(again.locator('#boo-notes-overlay')).toHaveCount(1);

    // Listed (and removable) in the options page.
    const options = await context.newPage();
    const extId = new URL(sw.url()).host;
    await options.goto(`chrome-extension://${extId}/options/options.html#sites`);
    const row = options.locator('#site-list li', { hasText: 'podcast.example.test' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Retirer' }).click();
    await expect.poll(() => stored(sw, 'sites:enabled')).toEqual([]);
    await expect(options.locator('#site-empty')).toBeVisible();
  });

  test('page sans média : les notes s’ouvrent en mode lecture', async ({ page, sw }) => {
    await page.goto('https://blog.example.test/article');
    await page.bringToFront();
    await runCommand(sw, page, 'toggle-sidebar');
    await expect(panel(page).locator('.platform')).toHaveText('Web · Lecture');
    await expect(panel(page).locator('.controls .action').first()).toHaveText('Citer');
    // Nothing is recorded until something is written.
    expect(await storedNote(sw, 'web:blog.example.test/article')).toBeUndefined();
  });

  test('vidéo déposée dans une page Notion : notes et captures liées à la page', async ({ page, sw }) => {
    await page.goto(`https://www.notion.so/acme/Cours-React-Hooks-${NOTION_PAGE}?pvs=4`);
    await page.bringToFront();
    await page.locator('#boo-notes-overlay').waitFor({ state: 'attached' });
    await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);
    await setMedia(page, 3);

    await openNotes(sw, page);
    await expect(panel(page).locator('.platform')).toHaveText('Notion');
    await expect(panel(page).locator('.site-hint')).toBeHidden();
    await page.keyboard.type('useEffect');
    const noteId = `notion:${NOTION_PAGE}`;
    await expect.poll(async () => (await storedNote(sw, noteId))?.markdown).toBe('[00:03] useEffect');
    expect(await storedNote(sw, noteId)).toMatchObject({
      title: 'Cours React — Hooks',
      url: `https://www.notion.so/${NOTION_PAGE}`,
    });

    await runCommand(sw, page, 'capture-screenshot');
    await expect(page.locator('#boo-notes-overlay .toast')).toHaveText('00:03 - Capture sauvegardée');
    await expect.poll(async () => (await storedNote(sw, noteId))?.markdown).toMatch(/!\[Capture 00:03\]\(assets\//);
  });
});
