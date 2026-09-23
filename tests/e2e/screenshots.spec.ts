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
  await page.setViewportSize({ width: 900, height: 1400 });
  await page.goto(`chrome-extension://${id}/options/options.html`);
  await expect(page.locator('#shortcut-rows tr')).toHaveCount(5);
  await page.screenshot({ path: `${OUT}/options.png`, fullPage: true });
});
