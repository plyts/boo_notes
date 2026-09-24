import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain JS module shared with `npm run mock:desktop`
import { startMockDesktop } from '../../tools/mock-desktop/server.mjs';
import { expect, openNotes, openWatch, panel, runCommand, setVideo, storedNote, test } from './fixtures';

type Mock = {
  port: number;
  ready: Promise<void>;
  close(): Promise<void>;
  received: { notes: Map<string, { rev: number; markdown: string }>; assets: Map<string, unknown>; exports: Array<{ target: string }> };
};

async function pointExtensionAt(sw: import('@playwright/test').Worker, url: string, token = ''): Promise<void> {
  await sw.evaluate(
    async ({ url, token }) => {
      const current = (await chrome.storage.sync.get('settings')).settings ?? {};
      await chrome.storage.sync.set({ settings: { ...current, desktopUrl: url, desktopToken: token } });
    },
    { url, token },
  );
}

test.describe('Synchronisation Desktop', () => {
  test('hors-ligne : notes locales + badge orange, puis envoi à la connexion (badge vert)', async ({ page, sw }) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'boo-desktop-'));
    // Reserve a free port, then keep the app "not launched" for now.
    const probe = startMockDesktop({ port: 0, dataDir }) as Mock;
    await probe.ready;
    const port = probe.port;
    await probe.close();
    await pointExtensionAt(sw, `ws://127.0.0.1:${port}`, 'jeton-secret');

    await openWatch(page);
    await setVideo(page, 6);
    await openNotes(sw, page);
    const badge = panel(page).locator('.status');
    await expect(badge).toHaveAttribute('data-state', 'offline');
    await expect(badge).toContainText('Hors-ligne');
    await page.keyboard.type('Notes hors-ligne');
    await runCommand(sw, page, 'capture-screenshot');
    await expect.poll(async () => (await storedNote(sw))?.markdown ?? '').toContain('![Capture 00:06]');
    await expect
      .poll(() => sw.evaluate(async () => Object.keys((await chrome.storage.local.get('sync:outbox'))['sync:outbox'] ?? {}).length))
      .toBe(1);

    // The desktop app starts: the badge turns green and the outbox is flushed.
    const desktop = startMockDesktop({ port, token: 'jeton-secret', dataDir }) as Mock;
    await desktop.ready;
    try {
      await badge.click(); // "retry now"
      await expect(badge).toHaveAttribute('data-state', 'connected');
      await expect(badge).toContainText('Connecté');
      await expect.poll(() => desktop.received.notes.get('youtube:e2eTest0001')?.markdown ?? '').toContain('[00:06] Notes hors-ligne');
      expect(desktop.received.assets.size).toBe(1);

      const files = await readdir(dataDir, { recursive: true });
      expect(files).toContain('youtube-e2eTest0001.md');
      expect(files.some((f) => String(f).startsWith('assets/') || String(f).startsWith('assets\\'))).toBe(true);
      const md = await readFile(join(dataDir, 'youtube-e2eTest0001.md'), 'utf8');
      expect(md).toContain('[00:06](https://www.youtube.com/watch?v=e2eTest0001#t=6) Notes hors-ligne');

      // Live edits keep flowing while connected.
      await panel(page).locator('.cm-line').last().click();
      await page.keyboard.type('Suite en direct');
      await expect
        .poll(() => desktop.received.notes.get('youtube:e2eTest0001')?.markdown ?? '')
        .toMatch(/\[00:0\d\] Suite en direct$/);

      // Export to Notion goes through the desktop app.
      await panel(page).getByRole('button', { name: 'Exporter la note' }).click();
      await panel(page).getByRole('menuitem', { name: /Envoyer vers Notion/ }).click();
      await expect(panel(page).locator('.notice')).toHaveText('Envoyé vers Notion (simulé)');
      expect(desktop.received.exports.at(-1)?.target).toBe('notion');
    } finally {
      await desktop.close();
    }
  });

  test('un jeton refusé laisse le badge hors-ligne avec la raison', async ({ page, sw }) => {
    const desktop = startMockDesktop({ port: 0, token: 'bon-jeton', dataDir: await mkdtemp(join(tmpdir(), 'boo-')) }) as Mock;
    await desktop.ready;
    try {
      await pointExtensionAt(sw, `ws://127.0.0.1:${desktop.port}`, 'mauvais-jeton');
      await openWatch(page);
      await openNotes(sw, page);
      const badge = panel(page).locator('.status');
      await badge.click();
      await expect(badge).toHaveAttribute('data-state', 'offline');
      await expect(badge).toHaveAttribute('title', /Jeton de connexion refusé/);
    } finally {
      await desktop.close();
    }
  });
});

test.describe('Micro-interactions', () => {
  test('pause automatique pendant la saisie puis reprise', async ({ page, sw }) => {
    await sw.evaluate(async () => {
      const current = (await chrome.storage.sync.get('settings')).settings ?? {};
      await chrome.storage.sync.set({ settings: { ...current, autoPause: true } });
    });
    await openWatch(page);
    await setVideo(page, 2, true);
    await openNotes(sw, page);
    // ~2 s of continuous typing (one key every 100 ms).
    await page.keyboard.type('Une phrase assez longue pour déclencher la pause', { delay: 100 });
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(true);
    // Resumes ~1 s after the last key.
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused), { timeout: 3000 }).toBe(false);
  });
});

test.describe('Multi-onglets', () => {
  test('les raccourcis pilotent le dernier lecteur ayant reçu une interaction', async ({ context, page, sw }) => {
    await openWatch(page, '', 'videoAAAAAA');
    const other = await context.newPage();
    await openWatch(other, '', 'videoBBBBBB');
    await setVideo(page, 10);
    await setVideo(other, 20);

    // Interact with the first tab, then fire the shortcut from an unrelated page.
    await page.bringToFront();
    await page.locator('h1').click();
    const blank = await context.newPage();
    await blank.goto('about:blank');
    await blank.bringToFront();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'about:blank' });
      await (globalThis as unknown as { booNotes: { runCommand(c: string, id?: number): Promise<void> } }).booNotes.runCommand(
        'capture-screenshot',
        tab?.id,
      );
    });
    await expect.poll(async () => (await storedNote(sw, 'youtube:videoAAAAAA'))?.markdown ?? '').toContain('[00:10]');
    expect(await storedNote(sw, 'youtube:videoBBBBBB')).toBeUndefined();
  });
});
