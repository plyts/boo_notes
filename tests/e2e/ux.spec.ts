import { expect, openNotes, openWatch, panel, runCommand, setVideo, storedNote, test, videoPaused, videoTime } from './fixtures';

test.describe('UX du panneau', () => {
  test('état vide pédagogique, puis statistiques et enregistrement dans l’en-tête', async ({ page, sw }) => {
    await openWatch(page);
    await setVideo(page, 6);
    await openNotes(sw, page);
    const p = panel(page);
    await expect(p.locator('.empty')).toBeVisible();
    await expect(p.locator('.empty-keys kbd').first()).toBeVisible();
    await page.keyboard.type('Première idée');
    await expect(p.locator('.empty')).toBeHidden();
    await expect(p.locator('.stats')).toHaveText('1 note');
    await expect(p.locator('.save')).toHaveText('Enregistré');
    await runCommand(sw, page, 'capture-screenshot');
    await expect(p.locator('.stats')).toHaveText('1 note · 1 capture');
    // Capture card: the timecode is carried by the thumbnail badge.
    await expect(p.locator('.cm-boo-img-tc')).toHaveText('00:06');
  });

  test('la chronologie montre les notes et permet de naviguer', async ({ page, sw }) => {
    await openWatch(page);
    await setVideo(page, 3);
    await openNotes(sw, page);
    await page.keyboard.type('Début');
    await page.keyboard.press('Enter');
    await setVideo(page, 24);
    await page.waitForTimeout(300);
    await page.keyboard.type('Fin');
    const p = panel(page);
    const timeline = p.locator('.timeline');
    await expect(timeline).toBeVisible();
    await expect(timeline.locator('.tl-tick')).toHaveCount(2);
    // Click at 50 % of the timeline → ~15 s.
    const box = await timeline.boundingBox();
    if (!box) throw new Error('timeline not laid out');
    await timeline.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect.poll(async () => Math.abs((await videoTime(page)) - 15)).toBeLessThan(2);
    // Hovering near a tick snaps to it and previews it on the player.
    const first = await timeline.locator('.tl-tick').first().boundingBox();
    if (!first) throw new Error('tick not laid out');
    await timeline.hover({ position: { x: first.x - box.x + 3, y: box.height / 2 } });
    await expect(timeline.locator('.tl-tip')).toHaveText('00:03 · note');
    await expect(page.locator('#boo-notes-overlay .marker')).toHaveClass(/visible/);
    // Keyboard: arrows move by 5 s.
    await timeline.focus();
    const before = await videoTime(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => videoTime(page)).toBeGreaterThan(before + 4);
  });

  test('Ctrl+/ ouvre l’aide des raccourcis ; Échap la ferme sans fermer le panneau', async ({ page, sw }) => {
    await openWatch(page);
    await openNotes(sw, page);
    const p = panel(page);
    await page.keyboard.press('Control+/');
    const sheet = p.getByRole('dialog', { name: 'Raccourcis clavier' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Capturer l’image')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.locator('#boo-notes-drawer .drawer')).toHaveClass(/open/);
    await expect(p.locator('.cm-content')).toBeFocused();
  });

  test('Smart Pause est une bascule : un second appui reprend la lecture', async ({ page, sw }) => {
    await openWatch(page);
    await setVideo(page, 4, true);
    await runCommand(sw, page, 'smart-pause');
    await expect.poll(() => videoPaused(page)).toBe(true);
    await expect(panel(page).locator('.cm-content')).toBeFocused();
    await runCommand(sw, page, 'smart-pause');
    await expect.poll(() => videoPaused(page)).toBe(false);
    await expect(panel(page).locator('.cm-content')).not.toBeFocused();
  });

  test('disposition superposée : le panneau devient une carte flottante', async ({ page, sw }) => {
    await sw.evaluate(async () => {
      const current = (await chrome.storage.sync.get('settings')).settings ?? {};
      await chrome.storage.sync.set({ settings: { ...current, layout: 'overlay' } });
    });
    await openWatch(page);
    await openNotes(sw, page);
    await expect(page.locator('#boo-notes-drawer .drawer')).toHaveClass(/floating/);
    // The page is not narrowed in this layout.
    expect(await page.evaluate(() => document.documentElement.style.marginRight)).toBe('');
  });

  test('double-clic sur le bord du panneau : largeur par défaut', async ({ page, sw }) => {
    await sw.evaluate(async () => {
      const current = (await chrome.storage.sync.get('settings')).settings ?? {};
      await chrome.storage.sync.set({ settings: { ...current, drawerWidth: 480 } });
    });
    await openWatch(page);
    await openNotes(sw, page);
    const drawer = page.locator('#boo-notes-drawer .drawer');
    await expect.poll(async () => (await drawer.boundingBox())?.width).toBe(480);
    await page.locator('#boo-notes-drawer .resize').dblclick();
    await expect.poll(async () => (await drawer.boundingBox())?.width).toBe(360);
    await expect
      .poll(() =>
        sw.evaluate(async () => ((await chrome.storage.sync.get('settings')).settings as { drawerWidth?: number } | undefined)?.drawerWidth),
      )
      .toBe(360);
    expect(await storedNote(sw)).toBeUndefined();
  });
});
