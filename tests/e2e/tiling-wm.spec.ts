import { test as base, chromium, expect, type BrowserContext, type Page, type Route, type Worker } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fulfillMedia, sampleVideo } from './fixtures';
import { TILING_ENABLED } from '../../src/shared/tiling';

/**
 * « Côte à côte » in a real, headed Chrome under a window manager — the
 * windows must never shake or move on their own. Needs a display and a window
 * manager, so it only runs on demand:
 *
 *   Xvfb :99 -screen 0 1920x1080x24 & DISPLAY=:99 openbox &
 *   DISPLAY=:99 TILING_WM=1 npx playwright test tiling-wm
 *
 * (apt: xvfb openbox xdotool wmctrl x11-apps imagemagick). The emulated
 * system snap (B) is what Windows does with snapped windows: their visible
 * edges touch, their rects overlapping by the 2 × 7 px invisible borders.
 * D and E are the user's clip (Windows 11): the video window snapped to the
 * left half, held there by Windows (D), flipping 1/2 ↔ 2/3 on its own (E).
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.env.REPRO_OUT ?? '';

async function serve(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname === '/watch') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await readFile(`${ROOT}tests/e2e/fixtures/watch.html`) });
  if (url.pathname === '/__fixtures/sample.webm') return fulfillMedia(route, await sampleVideo(), 'video/webm');
  return route.fulfill({ status: 404, body: '' });
}

const test = base.extend<{ context: BrowserContext; sw: Worker; page: Page }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: false,
      viewport: null,
      args: [`--disable-extensions-except=${ROOT}dist`, `--load-extension=${ROOT}dist`, '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900', '--window-position=60,60'],
    });
    await context.route(/^https:\/\/www\.youtube\.com\//, serve);
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker');
    for (let i = 0; i < 200; i++) {
      if (await sw.evaluate(() => Boolean((globalThis as { booNotes?: unknown }).booNotes)).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await use(sw);
  },
  page: async ({ context, sw }, use) => {
    void sw;
    await use(await context.newPage());
  },
});

type Entry = { t: number; kind: string; id: number; b?: number[]; info?: string };

async function instrument(sw: Worker): Promise<void> {
  await sw.evaluate(() => {
    const g = globalThis as unknown as { __log: unknown[]; __t0: number; __wrapped?: boolean; __hold?: { id: number; b: chrome.windows.UpdateInfo } | null };
    g.__log = [];
    g.__t0 = Date.now();
    if (g.__wrapped) return;
    g.__wrapped = true;
    const w = chrome.windows as unknown as Record<string, unknown>;
    const orig = chrome.windows.update.bind(chrome.windows);
    (globalThis as unknown as { __osUpdate: typeof orig }).__osUpdate = orig;
    Object.defineProperty(w, 'update', {
      configurable: true,
      writable: true,
      value: (id: number, info: chrome.windows.UpdateInfo) => {
        g.__log.push({ t: Date.now() - g.__t0, kind: 'update', id, info: JSON.stringify(info) });
        const out = orig(id, info);
        // A window the system holds (Windows' snap): resized by Boo Notes, put back a moment later.
        const hold = g.__hold;
        if (hold && hold.id === id && info.width !== undefined)
          setTimeout(() => {
            g.__log.push({ t: Date.now() - g.__t0, kind: 'OS', id, info: `held: back to ${JSON.stringify(hold.b)}` });
            void orig(id, hold.b);
          }, 40);
        return out;
      },
    });
    chrome.windows.onBoundsChanged.addListener((win) => g.__log.push({ t: Date.now() - g.__t0, kind: 'bounds', id: win.id, b: [win.left, win.top, win.width, win.height] }));
  });
}

const log = (sw: Worker) => sw.evaluate(() => (globalThis as unknown as { __log: Entry[] }).__log) as Promise<Entry[]>;
const wm = () => execSync('wmctrl -lG', { env: { ...process.env } }).toString().trim().split('\n').map((l) => l.replace(/\s+/g, ' '));

async function watch(sw: Worker, label: string, ms: number): Promise<{ updates: number; bounds: number; lastAt: number; samples: string[] }> {
  const samples: string[] = [];
  const end = Date.now() + ms;
  let shot = 0;
  while (Date.now() < end) {
    samples.push(`${Date.now() % 100000} ${wm().filter((l) => /YouTube|Boo Notes|Vidéo/.test(l)).join(' | ')}`);
    if (OUT && shot < 3 && samples.length % 6 === 1) execSync(`import -window root ${OUT}/${label}-${shot++}.png`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const entries = await log(sw);
  const lastAt = entries.length ? entries[entries.length - 1].t : 0;
  return { updates: entries.filter((e) => e.kind === 'update').length, bounds: entries.filter((e) => e.kind === 'bounds').length, lastAt, samples };
}


async function tiled(context: BrowserContext, page: Page, sw: Worker, tile: RegExp, before?: () => Promise<void>): Promise<Page> {
  await page.goto('https://www.youtube.com/watch?v=e2eTest0001');
  await before?.();
  await page.bringToFront();
  await page.locator('#boo-notes-overlay').waitFor({ state: 'attached' });
  await sw.evaluate(async (url) => {
    const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === url);
    await (globalThis as unknown as { booNotes: { runCommand(c: string, id?: number): Promise<void> } }).booNotes.runCommand('toggle-sidebar', tab?.id);
  }, page.url());
  const panel = page.frameLocator('#boo-notes-drawer iframe:not(.retired)');
  await panel.locator('.cm-content').waitFor();
  const opened = context.waitForEvent('page', { predicate: (p) => p.url().includes('mode=popout') });
  await panel.getByRole('button', { name: 'Disposition du panneau' }).click();
  await panel.getByRole('menuitemradio', { name: tile }).click();
  const popup = await opened;
  await new Promise((r) => setTimeout(r, 1500));
  return popup;
}

const ids = (sw: Worker) =>
  sw.evaluate(async () => Object.values(((await chrome.storage.session.get('tiles')).tiles ?? {}) as Record<string, { videoWindow: number; notesWindow: number }>)[0]);

const fmt = (e: Entry) => `  ${String(e.t).padStart(5)}ms ${e.kind.padEnd(6)} #${e.id} ${e.b ? e.b.join(',') : e.info}`;

test.skip(!process.env.TILING_WM || !process.env.DISPLAY, 'TILING_WM=1 and a display with a window manager (see above)');
test.skip(!TILING_ENABLED, '« Côte à côte » switched off (TILING_ENABLED)');

test('A: the video window dragged aside (room for another app): the notes window stays put, Boo Notes lets go', async ({ context, page, sw }) => {
  test.setTimeout(120_000);
  execSync('(command -v xclock >/dev/null && xclock -geometry 300x300+1550+600 >/dev/null 2>&1 &) || true');
  const popup = await tiled(context, page, sw, /^2\/3 · 1\/3/);
  const t = await ids(sw);
  const notesBefore = await sw.evaluate((id) => chrome.windows.get(id), t.notesWindow);
  await instrument(sw);
  // A title-bar drag through the window manager (Alt+drag), 400 px to the right, in steps.
  execSync('xdotool mousemove --sync 400 300 keydown alt mousedown 1');
  for (let i = 1; i <= 20; i++) execSync(`xdotool mousemove --sync ${400 + i * 20} 300 && sleep 0.03`);
  execSync('xdotool mouseup 1 keyup alt');
  // Said in the notes' window.
  await expect(popup.locator('.notice')).toContainText('Côte à côte arrêté');
  const r = await watch(sw, 'drag-video', 3000);
  console.log(`A) video window dragged 400 px: ${r.updates} move(s) by Boo Notes, ${r.bounds} bounds events`);
  expect(r.updates).toBe(0);
  const notesAfter = await sw.evaluate((id) => chrome.windows.get(id), t.notesWindow);
  expect([notesAfter.left, notesAfter.width]).toEqual([notesBefore.left, notesBefore.width]);
  expect(await ids(sw)).toBeUndefined();
});

test('B: the system snaps the windows too (Windows-like invisible borders): no ping-pong', async ({ context, page, sw }) => {
  test.setTimeout(120_000);
  await tiled(context, page, sw, /^1\/2 · 1\/2/);
  const t = await ids(sw);
  await instrument(sw);
  const agent = setInterval(() => {
    void sw.evaluate(async ({ v, n }) => {
      const g = globalThis as unknown as { __osUpdate: typeof chrome.windows.update; __log: unknown[]; __t0: number };
      const [vb, nb] = [await chrome.windows.get(v), await chrome.windows.get(n)];
      const want = nb.left! + 14 - vb.left!;
      if (Math.abs(vb.width! - want) > 1) {
        g.__log.push({ t: Date.now() - g.__t0, kind: 'OS', id: v, info: `snap group: video width ${vb.width} -> ${want}` });
        await g.__osUpdate(v, { width: want });
      }
    }, { v: t.videoWindow, n: t.notesWindow }).catch(() => undefined);
  }, 120);
  // The user drags the common border once.
  await sw.evaluate(async (n) => {
    const g = globalThis as unknown as { __osUpdate: typeof chrome.windows.update };
    const b = await chrome.windows.get(n);
    await g.__osUpdate(n, { left: b.left! + 100, width: b.width! - 100 });
  }, t.notesWindow);
  const r = await watch(sw, 'snap-group', 5000);
  clearInterval(agent);
  const entries = await log(sw);
  console.log(`B) one border drag with a system snap: ${r.updates} move(s) by Boo Notes, ${entries.filter((e) => e.kind === 'OS').length} by the system, last at ${r.lastAt} ms`);
  console.log(entries.map(fmt).join('\n'));
  expect(r.updates).toBeLessThanOrEqual(6);
  // Quiet well before the end of the 5 s.
  expect(r.lastAt).toBeLessThan(2000);
});

test('C: the common border dragged (notes on the left, then on the right): the other window follows once', async ({ context, page, sw }) => {
  test.setTimeout(120_000);
  for (const [tile, left] of [[/^Notes à gauche/, true], [/^2\/3 · 1\/3/, false]] as const) {
    const popup = await tiled(context, page, sw, tile);
    const t = await ids(sw);
    await instrument(sw);
    // A live resize of the notes window by its inner edge, in steps.
    await sw.evaluate(async ({ n, left }) => {
      const g = globalThis as unknown as { __osUpdate: typeof chrome.windows.update };
      for (let i = 1; i <= 10; i++) {
        const b = await chrome.windows.get(n);
        if (left) await g.__osUpdate(n, { width: b.width! + 15 });
        else await g.__osUpdate(n, { left: b.left! - 15, width: b.width! + 15 });
        await new Promise((r) => setTimeout(r, 30));
      }
    }, { n: t.notesWindow, left });
    const r = await watch(sw, `border-${left ? 'left' : 'right'}`, 3000);
    const v = await sw.evaluate((id) => chrome.windows.get(id), t.videoWindow);
    const n = await sw.evaluate((id) => chrome.windows.get(id), t.notesWindow);
    console.log(`C) ${left ? 'notes à gauche' : '2/3 · 1/3'}: border dragged 150 px: ${r.updates} move(s) by Boo Notes; video ${v.left},${v.width} notes ${n.left},${n.width}`);
    expect(r.updates).toBe(1);
    expect(left ? n.left! + n.width! : v.left! + v.width!).toBe(left ? v.left : n.left);
    expect(await ids(sw)).toBeTruthy();
    await popup.getByRole('button', { name: 'Côte à côte' }).click();
    await popup.getByRole('menuitem', { name: 'Quitter côte à côte' }).click();
    await expect.poll(() => ids(sw)).toBeUndefined();
  }
});

const videoWindowOf = (sw: Worker, url: string) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)!.windowId, url);
const area = { left: 0, top: 0, width: 1920, height: 1080 };

test('D: the video window snapped to the left half and held there (Windows): the notes go beside it, once, then nothing moves', async ({ context, page, sw }) => {
  test.setTimeout(120_000);
  const popup = await tiled(context, page, sw, /^2\/3 · 1\/3/, async () => {
    await instrument(sw);
    const v = await videoWindowOf(sw, 'https://www.youtube.com/watch?v=e2eTest0001');
    await sw.evaluate(async ({ v, b }) => {
      const g = globalThis as unknown as { __osUpdate: typeof chrome.windows.update; __hold: unknown };
      await g.__osUpdate(v, b);
      g.__hold = { id: v, b };
    }, { v, b: { left: area.left, top: area.top, width: area.width / 2, height: area.height } });
    await new Promise((r) => setTimeout(r, 800));
  });
  if (OUT) {
    // Proof: the screen once settled.
    await new Promise((r) => setTimeout(r, 2500));
    execSync(`import -window root ${OUT}/held-settled.png`);
  }
  await expect(popup.locator('.notice')).toContainText('aimantée à sa place', { timeout: 5000 });
  const r = await watch(sw, 'held', 4000);
  const t = await ids(sw);
  const v = await sw.evaluate((id) => chrome.windows.get(id), t.videoWindow);
  const n = await sw.evaluate((id) => chrome.windows.get(id), t.notesWindow);
  const entries = await log(sw);
  console.log(`D) video held at 1/2: ${r.updates} move(s) by Boo Notes in all, the last at ${r.lastAt} ms; video ${v.left},${v.width} notes ${n.left},${n.width}`);
  console.log(entries.map(fmt).join('\n'));
  // The notes beside the video where Windows kept it: no gap where another window shows through, no overlap.
  expect(Math.abs(n.left! - (v.left! + v.width!))).toBeLessThanOrEqual(24);
  expect(v.width).toBe(area.width / 2);
  // The video (refused), the new notes window placed, the notes beside the video: nothing more.
  expect(r.updates).toBeLessThanOrEqual(3);
  // All of it within the placement and its check (≈ 1 s), long before the end of the watch.
  const lastUpdate = Math.max(...entries.filter((e) => e.kind === 'update').map((e) => e.t));
  expect(lastUpdate).toBeLessThan(3500);
  await sw.evaluate(() => ((globalThis as unknown as { __hold: unknown }).__hold = null));
});

test('E: the video window flips 1/2 ↔ 2/3 on its own (the user\'s clip): the notes no longer follow it, Boo Notes lets go', async ({ context, page, sw }) => {
  test.setTimeout(120_000);
  const popup = await tiled(context, page, sw, /^2\/3 · 1\/3/);
  const t = await ids(sw);
  await new Promise((r) => setTimeout(r, 1000));
  await instrument(sw);
  // 3 s of flips, every 200 to 450 ms, as in the clip.
  for (const [i, ms] of [300, 250, 400, 200, 450, 300, 250, 350, 300, 200].entries()) {
    await sw.evaluate(async ({ v, width }) => {
      const g = globalThis as unknown as { __osUpdate: typeof chrome.windows.update; __log: unknown[]; __t0: number };
      g.__log.push({ t: Date.now() - g.__t0, kind: 'OS', id: v, info: `flip: video width -> ${width}` });
      await g.__osUpdate(v, { width });
    }, { v: t.videoWindow, width: i % 2 === 0 ? area.width / 2 : Math.round((area.width * 2) / 3) });
    await new Promise((r) => setTimeout(r, ms));
  }
  await expect(popup.locator('.notice')).toContainText('Côte à côte arrêté');
  const r = await watch(sw, 'flip', 2000);
  const entries = await log(sw);
  console.log(`E) 10 flips of the video window: ${r.updates} move(s) by Boo Notes`);
  console.log(entries.map(fmt).join('\n'));
  expect(r.updates).toBeLessThanOrEqual(1);
  expect(await ids(sw)).toBeUndefined();
});
