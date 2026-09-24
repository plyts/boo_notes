import { test as base, chromium, expect, type BrowserContext, type FrameLocator, type Page, type Route, type Worker } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = `${ROOT}dist`;
const FIXTURES = `${ROOT}tests/e2e/fixtures`;

/** Answers a media request, honouring Range headers (needed for seeking). */
export async function fulfillMedia(route: Route, buf: Buffer, contentType: string): Promise<void> {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
    await route.fulfill({
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${buf.length}`,
        'Content-Length': String(end - start + 1),
      },
      body: buf.subarray(start, end + 1),
    });
    return;
  }
  await route.fulfill({ status: 200, headers: { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' }, body: buf });
}

export const sampleVideo = () => readFile(`${FIXTURES}/sample.webm`);

/** `seconds` of a quiet 440 Hz tone as an 8 kHz mono 8-bit PCM WAV file. */
export function makeWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) buf[44 + i] = 128 + Math.round(8 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buf;
}

/** Serves the fake YouTube watch page and its video (with Range support for seeking). */
async function serveFakeYouTube(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname === '/watch') {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await readFile(`${FIXTURES}/watch.html`) });
    return;
  }
  if (url.pathname === '/__fixtures/sample.webm') {
    await fulfillMedia(route, await sampleVideo(), 'video/webm');
    return;
  }
  await route.fulfill({ status: 404, body: '' });
}

export const test = base.extend<{ context: BrowserContext; sw: Worker; page: Page }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      // No viewport emulation: Playwright would shrink the real window to the viewport,
      // and headless Chromium draws ~140 px of browser UI inside it. Input below the real
      // content edge is then not routed into cross-process iframes (the notes panel).
      viewport: null,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1400,1040', // ≈ 1400×900 of page content
      ],
    });
    await context.route(/^https:\/\/www\.youtube\.com\//, serveFakeYouTube);
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker');
    // Just created, the worker may still be setting up its global scope (APIs, then its script's test hook).
    for (let i = 0; i < 200; i++) {
      const ready = await sw
        .evaluate(() => Boolean((globalThis as { booNotes?: unknown }).booNotes && (globalThis as { chrome?: { storage?: unknown } }).chrome?.storage))
        .catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 25));
    }
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
