import { mkdir } from 'node:fs/promises';
import { expect, openNotes, openWatch, panel, runCommand, setVideo, test } from './fixtures';

// Renders the UI for docs/screenshots (run with SCREENSHOTS=1 npx playwright test screenshots).
test.skip(!process.env.SCREENSHOTS, 'SCREENSHOTS=1 to render the documentation screenshots');

const OUT = process.env.SCREENSHOTS_DIR ?? 'docs/screenshots';

for (const theme of ['dark', 'light'] as const) {
  test(`drawer + HUD (${theme})`, async ({ page, sw }) => {
    await mkdir(OUT, { recursive: true });
    await page.setViewportSize({ width: 1180, height: 640 });
    await openWatch(page, theme === 'dark' ? '&theme=dark' : '');
    await setVideo(page, 64 % 30);
    await openNotes(sw, page);
    const p = panel(page);
    await page.keyboard.type('## Hooks');
    await page.keyboard.press('Enter');
    await setVideo(page, 3);
    await page.waitForTimeout(300);
    await page.keyboard.type('useState retourne **la valeur** et un setter');
    await page.keyboard.press('Enter');
    await setVideo(page, 9);
    await page.waitForTimeout(300);
    await page.keyboard.type('- effets : `useEffect(fn, deps)`');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await setVideo(page, 12);
    await runCommand(sw, page, 'capture-screenshot');
    await expect(p.locator('.cm-boo-img img')).toHaveAttribute('src', /^data:/);
    await page.waitForTimeout(2300); // toast gone
    await setVideo(page, 10);
    await page.mouse.move(200, 200);
    await page.mouse.move(220, 210);
    await p.locator('.cm-boo-ts', { hasText: '00:09' }).hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/drawer-${theme}.png` });
  });
}

test('empty note, shortcuts sheet and export menu', async ({ page, sw }) => {
  await mkdir(OUT, { recursive: true });
  await page.setViewportSize({ width: 1180, height: 700 });
  await openWatch(page, '&theme=dark');
  await setVideo(page, 5);
  await openNotes(sw, page);
  const p = panel(page);
  await expect(p.locator('.empty')).toBeVisible();
  await page.waitForTimeout(300);
  await page.locator('#boo-notes-drawer .drawer').screenshot({ path: `${OUT}/panel-empty.png` });
  await page.keyboard.press('Control+/');
  await expect(p.locator('.sheet')).toBeVisible();
  await page.waitForTimeout(400);
  await page.locator('#boo-notes-drawer .drawer').screenshot({ path: `${OUT}/panel-shortcuts.png` });
  await page.keyboard.press('Escape');
  await p.getByRole('button', { name: 'Exporter la note' }).click();
  await page.waitForTimeout(300);
  await page.locator('#boo-notes-drawer .drawer').screenshot({ path: `${OUT}/panel-export.png` });
});

test('HUD tooltip and floating drawer (overlay layout)', async ({ page, sw }) => {
  await mkdir(OUT, { recursive: true });
  await sw.evaluate(async () => {
    const current = (await chrome.storage.sync.get('settings')).settings ?? {};
    await chrome.storage.sync.set({ settings: { ...current, layout: 'overlay' } });
  });
  await page.setViewportSize({ width: 1100, height: 600 });
  await openWatch(page, '&theme=dark');
  await setVideo(page, 18);
  await openNotes(sw, page);
  await page.keyboard.type('Le panneau flotte au-dessus de la page');
  await page.mouse.move(200, 200);
  await page.mouse.move(220, 210);
  await page.locator('#boo-notes-overlay .hud button[aria-label^="Capturer"]').hover();
  await expect(page.locator('#boo-notes-overlay .tip')).toHaveClass(/visible/);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/hud-floating.png` });
});

test('toast after capture', async ({ page, sw }) => {
  await mkdir(OUT, { recursive: true });
  await page.setViewportSize({ width: 900, height: 560 });
  await openWatch(page, '&theme=dark');
  await setVideo(page, 15);
  await runCommand(sw, page, 'capture-screenshot');
  await expect(page.locator('#boo-notes-overlay .toast')).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/capture-toast.png`, clip: { x: 0, y: 40, width: 700, height: 420 } });
});

test('options page', async ({ context, sw }) => {
  await mkdir(OUT, { recursive: true });
  const id = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`chrome-extension://${id}/options/options.html#bienvenue`);
  await expect(page.locator('#shortcut-rows .row')).toHaveCount(5);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/options.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#panneau').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/options-dark.png` });
});
