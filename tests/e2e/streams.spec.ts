import type { Frame, Page, Worker } from '@playwright/test';
import { expect, fulfillMedia, makeWav, openNotes, panel, runCommand, sampleVideo, storedNote, test } from './fixtures';

/**
 * « Any stream, on any platform »: media hidden in closed shadow trees,
 * `new Audio()` players never inserted in the page, players embedded in
 * cross-origin frames, frames Boo Notes may not read yet, and the stopwatch
 * for streams no script can read.
 */

function html(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font-family:sans-serif}main{padding:24px}video,iframe{width:640px;height:360px;background:#000;border:0}</style>
</head><body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

test.beforeEach(async ({ context }) => {
  const video = await sampleVideo();
  const wav = makeWav(40);
  await context.route(/^https:\/\/[\w.-]+\.example\.test\//, async (route) => {
    const url = new URL(route.request().url());
    const host = url.hostname;
    if (url.pathname.endsWith('.webm')) return fulfillMedia(route, video, 'video/webm');
    if (url.pathname.endsWith('.wav')) return fulfillMedia(route, wav, 'audio/wav');
    const page = (title: string, body: string, script = '') =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: html(title, body, script) });
    if (host === 'school.example.test' && url.pathname === '/shadow')
      return page(
        'Leçon 3 — Web components',
        '<h1>Leçon 3</h1><fancy-player></fancy-player>',
        `customElements.define('fancy-player', class extends HTMLElement {
           constructor() {
             super();
             const root = this.attachShadow({ mode: 'closed' });
             root.innerHTML = '<video muted preload="auto" src="/f/lesson.webm" style="width:640px;height:360px"></video>';
             // For the test only: a closed tree is otherwise out of reach.
             window.lessonVideo = root.querySelector('video');
           }
         });`,
      );
    if (host === 'school.example.test' && url.pathname === '/radio')
      return page(
        'Radio Campus — Direct',
        '<h1>Radio Campus</h1><button id="listen">Écouter</button>',
        // The audio element is never inserted in the page.
        `const audio = new Audio('/live/stream.wav');
         document.getElementById('listen').onclick = () => audio.play();`,
      );
    if (host === 'school.example.test' && url.pathname === '/course')
      return page(
        'Cours 7 — Les intégrales',
        '<h1>Cours 7</h1><iframe src="https://player.example.test/embed/42" allow="autoplay; fullscreen"></iframe>',
      );
    if (host === 'player.example.test' && url.pathname === '/embed/42')
      return page('Vidéo 42', '<video muted preload="auto" src="/v/42.webm" style="position:fixed;inset:0;width:100%;height:100%"></video>');
    if (host === 'school.example.test' && url.pathname === '/blocked')
      return page(
        'Cours 8 — Hébergé ailleurs',
        '<h1>Cours 8</h1><iframe src="https://player.vimeo.com/video/123" allow="autoplay; fullscreen"></iframe>',
      );
    if (host === 'school.example.test' && url.pathname === '/live')
      return page('Amphi en direct', '<h1>Amphi en direct</h1><canvas width="640" height="360"></canvas>');
    return route.fulfill({ status: 404, body: '' });
  });
  // A host the extension has no access to (no permission granted).
  await context.route(/^https:\/\/player\.vimeo\.com\//, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: html('Vimeo', '<video muted src="/v.webm"></video>') }),
  );
});

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`https://school.example.test${path}`);
  await page.bringToFront();
}

function playerFrame(page: Page): Frame {
  const f = page.frames().find((x) => x.url().startsWith('https://player.example.test/'));
  if (!f) throw new Error('player frame not found');
  return f;
}

async function seekFrame(frame: Frame, time: number): Promise<void> {
  await frame.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);
  await frame.evaluate(async (time) => {
    const v = document.querySelector('video') as HTMLVideoElement;
    v.pause();
    const seeked = new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    v.currentTime = time;
    await seeked;
  }, time);
}

const stored = (sw: Worker, path: string) => storedNote(sw, `web:school.example.test${path}`);

test.describe('Tout flux, toute plateforme', () => {
  test('vidéo dans un shadow DOM fermé (web component)', async ({ page, sw }) => {
    await open(page, '/shadow');
    await openNotes(sw, page);
    const notes = panel(page);
    await expect(notes.locator('.platform')).toHaveText('Web');
    await page.waitForFunction(() => ((window as unknown as { lessonVideo: HTMLVideoElement }).lessonVideo.readyState ?? 0) >= 2);
    await page.evaluate(async () => {
      const v = (window as unknown as { lessonVideo: HTMLVideoElement }).lessonVideo;
      const seeked = new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      v.currentTime = 9;
      await seeked;
    });
    await expect.poll(async () => notes.locator('.clock-now').textContent()).toBe('00:09');
    await notes.locator('.cm-content').click();
    await page.keyboard.type('Slot et template');
    await expect.poll(async () => (await stored(sw, '/shadow'))?.markdown).toBe('[00:09] Slot et template');
    expect(await stored(sw, '/shadow')).toMatchObject({ kind: 'video', title: 'Leçon 3 — Web components' });
  });

  test('audio « new Audio() » jamais inséré dans la page (radio, podcast)', async ({ page, sw }) => {
    await open(page, '/radio');
    await openNotes(sw, page);
    const notes = panel(page);
    // Nothing plays yet: a page to read.
    await expect(notes.locator('.platform')).toHaveText('Web · Lecture');
    await page.getByRole('button', { name: 'Écouter' }).click();
    await expect(notes.locator('.platform')).toHaveText('Web · Audio');
    // The player was docked by the main-world bridge, untouched otherwise.
    expect(await page.evaluate(() => document.querySelector('boo-media-dock audio') !== null)).toBe(true);
    await page.evaluate(async () => {
      const a = document.querySelector('boo-media-dock audio') as HTMLAudioElement;
      a.pause();
      const seeked = new Promise((r) => a.addEventListener('seeked', r, { once: true }));
      a.currentTime = 11;
      await seeked;
    });
    await notes.locator('.cm-content').click();
    await page.keyboard.type('Invité : la chercheuse');
    await expect.poll(async () => (await stored(sw, '/radio'))?.markdown).toBe('[00:11] Invité : la chercheuse');
  });

  test('lecteur intégré dans une iframe d’un autre domaine : horodatage, saut, capture', async ({ page, sw }) => {
    await open(page, '/course');
    await openNotes(sw, page);
    const notes = panel(page);
    await expect(notes.locator('.platform')).toHaveText('Web · Lecteur intégré');
    const frame = playerFrame(page);
    await seekFrame(frame, 6);
    await expect.poll(async () => notes.locator('.clock-now').textContent()).toBe('00:06');

    await notes.locator('.cm-content').click();
    await page.keyboard.type('Primitive');
    await page.keyboard.press('Enter');
    await seekFrame(frame, 21);
    await page.waitForTimeout(400);
    await page.keyboard.type('Changement de variable');
    await expect.poll(async () => (await stored(sw, '/course'))?.markdown).toBe('[00:06] Primitive\n[00:21] Changement de variable');
    expect(await stored(sw, '/course')).toMatchObject({ kind: 'video', title: 'Cours 7 — Les intégrales' });

    // Note → media: the timestamp drives the player inside the frame.
    await notes.locator('.cm-boo-ts', { hasText: '00:06' }).click();
    await expect.poll(() => frame.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime)).toBeCloseTo(6, 0);

    // The picture comes from the frame's agent.
    await runCommand(sw, page, 'capture-screenshot');
    await expect(page.locator('#boo-notes-overlay .toast')).toContainText('Capture sauvegardée');
    await expect.poll(async () => (await stored(sw, '/course'))?.markdown).toMatch(/!\[.*\]\(assets\/[^)]+\)/);
  });

  test('lecteur d’un site non autorisé : le panneau propose de l’autoriser', async ({ page, sw }) => {
    await open(page, '/blocked');
    await openNotes(sw, page);
    const hint = panel(page).locator('.players-hint');
    await expect(hint).toBeVisible({ timeout: 8000 });
    await expect(hint).toContainText('player.vimeo.com');
    await expect(hint.getByRole('button', { name: 'Autoriser' })).toBeVisible();
  });

  test('flux illisible (direct, lecteur protégé) : chronomètre', async ({ page, sw }) => {
    await open(page, '/live');
    await openNotes(sw, page);
    const notes = panel(page);
    await expect(notes.locator('.platform')).toHaveText('Web · Lecture');
    await notes.getByRole('button', { name: 'Chronomètre' }).click();
    await expect(notes.locator('.platform')).toHaveText(/Chronomètre$/);
    await expect(notes.locator('.stopwatch')).toBeVisible();
    await page.waitForTimeout(2300);
    await notes.locator('.cm-content').click();
    await page.keyboard.type('Question du public');
    await expect.poll(async () => (await stored(sw, '/live'))?.markdown).toMatch(/^\[00:0[23]\] Question du public$/);
    // Paused, the clock stays put.
    await notes.getByRole('button', { name: 'Mettre le chronomètre en pause' }).click();
    const t1 = await notes.locator('.clock-now').textContent();
    await page.waitForTimeout(1300);
    await expect(notes.locator('.clock-now')).toHaveText(t1 ?? '');
  });
});
