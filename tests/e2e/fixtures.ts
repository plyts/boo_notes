import { test as base, chromium, expect, type BrowserContext, type FrameLocator, type Page, type Route, type Worker } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = `${ROOT}dist`;
const FIXTURES = `${ROOT}tests/e2e/fixtures`;

/** Serves the fake YouTube watch page and its video (with Range support for seeking). */
async function serveFakeYouTube(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname === '/watch') {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await readFile(`${FIXTURES}/watch.html`) });
    return;
  }
  if (url.pathname === '/__fixtures/sample.webm') {
    const buf = await readFile(`${FIXTURES}/sample.webm`);
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : buf.length - 1;
      await route.fulfill({
        status: 206,
        headers: {
          'Content-Type': 'video/webm',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${buf.length}`,
          'Content-Length': String(end - start + 1),
        },
        body: buf.subarray(start, end + 1),
      });
      return;
    }
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes' }, body: buf });
    return;
  }
  await route.fulfill({ status: 404, body: '' });
}

export const test = base.extend<{ context: BrowserContext; sw: Worker; page: Page }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      viewport: { width: 1400, height: 900 },
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    await context.route(/^https:\/\/www\.youtube\.com\//, serveFakeYouTube);
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker');
    await use(sw);
  },
  page: async ({ context, sw }, use) => {
    void sw; // make sure the extension is up before opening pages
    const page = await context.newPage();
    await use(page);
  },
});

export { expect };

export const VIDEO_ID = 'e2eTest0001';
export const NOTE_ID = `youtube:${VIDEO_ID}`;

export async function openWatch(page: Page, hash = '', id = VIDEO_ID): Promise<void> {
  await page.goto(`https://www.youtube.com/watch?v=${id}${hash}`);
  // The welcome tab opened on install would otherwise keep the foreground (and keyboard focus).
  await page.bringToFront();
  await page.locator('#boo-notes-overlay').waitFor({ state: 'attached' });
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);
}

/** Pauses the video at `time` (seconds), or plays from there. */
export async function setVideo(page: Page, time: number, play = false): Promise<void> {
  await page.evaluate(
    async ({ time, play }) => {
      const v = document.querySelector('video') as HTMLVideoElement;
      v.pause();
      if (Math.abs(v.currentTime - time) > 0.01) {
        const seeked = new Promise((r) => v.addEventListener('seeked', r, { once: true }));
        v.currentTime = time;
        await seeked;
      }
      if (play) await v.play();
    },
    { time, play },
  );
}

export const videoTime = (page: Page) => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
export const videoPaused = (page: Page) => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).paused);

/** Fires a keyboard command as if its global shortcut had been pressed on `page`. */
export async function runCommand(sw: Worker, page: Page, command: string): Promise<void> {
  await sw.evaluate(
    async ({ command, url }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url);
      await (globalThis as unknown as { booNotes: { runCommand(c: string, id?: number): Promise<void> } }).booNotes.runCommand(
        command,
        tab?.id,
      );
    },
    { command, url: page.url() },
  );
}

export const panel = (page: Page): FrameLocator => page.frameLocator('#boo-notes-drawer iframe');

/** Alt+Shift+N, then waits until the editor has keyboard focus. */
export async function openNotes(sw: Worker, page: Page): Promise<void> {
  await runCommand(sw, page, 'toggle-sidebar');
  await expect(panel(page).locator('.cm-content')).toBeFocused();
}

type StoredNote = { markdown: string; rev: number; title: string };

export async function storedNote(sw: Worker, noteId = NOTE_ID): Promise<StoredNote | undefined> {
  return (await sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], `note:${noteId}`)) as
    | StoredNote
    | undefined;
}
