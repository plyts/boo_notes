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

  test('cours › chapitre au titre très long : coupé par « … », le panneau garde sa largeur et tous ses boutons', async ({ page, sw }) => {
    const course = 'ai-orchestration-from-llm-to-running-agents';
    const chapter = 'HookToolset : Transformer les hooks de flux d’air en outils d’agent';
    await sw.evaluate((c) => chrome.storage.local.set({ 'desktop:courses': [{ title: c.course, emoji: '', chapters: [c.chapter] }] }), { course, chapter });
    await openWatch(page);
    await openNotes(sw, page);
    const p = panel(page);
    await p.locator('.place').click();
    const menu = p.getByRole('menu', { name: 'Ranger dans un cours' });
    await menu.getByRole('menuitemradio', { name: chapter }).click();
    await expect(p.locator('.place')).toHaveAttribute('title', `Rangée dans ${course} › ${chapter} (changer)`);
    const frame = page.frames().find((f) => f.url().includes('panel/panel.html'))!;
    const layout = () =>
      frame.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        // Both parts cut short (« … »), neither hidden.
        cut: [...document.querySelectorAll<HTMLElement>('.place-part')].map((el) => el.scrollWidth > el.clientWidth && el.clientWidth > 20),
      }));
    expect(await layout()).toEqual({ overflow: 0, cut: [true, true] });
    // Every button of the toolbar still inside the notes.
    const drawer = (await page.locator('#boo-notes-drawer .drawer').boundingBox())!;
    for (const name of ['Réduire le panneau', 'Exporter la note', 'Détacher dans une fenêtre']) {
      const box = (await p.getByRole('button', { name: new RegExp(`^${name}`) }).first().boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(drawer.x + drawer.width + 1);
    }
    // The menu fits in too, its long names cut short.
    await p.locator('.place').click();
    const m = (await menu.boundingBox())!;
    expect(m.x + m.width).toBeLessThanOrEqual(drawer.x + drawer.width + 1);
    expect(await layout()).toMatchObject({ overflow: 0 });
  });

  test('titre très long dans la fenêtre détachée : « … » à toute largeur, en entier quand la fenêtre est assez large', async ({ context, page, sw }) => {
    const course = 'ai-orchestration-from-llm-to-running-agents';
    const chapter = 'HookToolset : Transformer les hooks de flux d’air en outils d’agent';
    await sw.evaluate((c) => chrome.storage.local.set({ 'desktop:courses': [{ title: c.course, emoji: '', chapters: [c.chapter] }] }), { course, chapter });
    await openWatch(page);
    await openNotes(sw, page);
    const p = panel(page);
    await p.locator('.place').click();
    await p.getByRole('menu', { name: 'Ranger dans un cours' }).getByRole('menuitemradio', { name: chapter }).click();
    const opened = context.waitForEvent('page', { predicate: (w) => w.url().includes('mode=popout') });
    await p.getByRole('button', { name: 'Détacher dans une fenêtre' }).click();
    const popup = await opened;
    await expect(popup.locator('.place')).toHaveAttribute('title', `Rangée dans ${course} › ${chapter} (changer)`);
    const layout = () =>
      popup.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cut: [...document.querySelectorAll<HTMLElement>('.place-part')].map((el) => el.scrollWidth > el.clientWidth),
      }));
    const toolbarInside = async () => {
      const width = await popup.evaluate(() => innerWidth);
      for (const name of ['Rattacher', 'Exporter la note']) {
        const box = (await popup.getByRole('button', { name: new RegExp(`^${name}`) }).first().boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      }
    };
    // (Headless Chromium ignores the size asked for the window: each width is set here.)
    // Widened by hand: the whole title.
    await popup.setViewportSize({ width: 1400, height: 700 });
    await expect.poll(layout).toEqual({ overflow: 0, cut: [false, false] });
    await toolbarInside();
    // As opened (the width of the notes + 40), then narrowed: cut short, nothing out of view.
    for (const width of [400, 320]) {
      await popup.setViewportSize({ width, height: 700 });
      await expect.poll(layout).toEqual({ overflow: 0, cut: [true, true] });
      await toolbarInside();
    }
  });

  test('les notes s’élargissent au-delà de 500 px : poignée visible, souris ou clavier', async ({ page, sw }) => {
    await openWatch(page);
    await openNotes(sw, page);
    const drawer = page.locator('#boo-notes-drawer .drawer');
    const width = async () => Math.round((await drawer.boundingBox())!.width);
    await expect.poll(width).toBe(360);
    const grip = page.locator('#boo-notes-drawer .resize');
    await expect(grip).toHaveAttribute('role', 'separator');
    // Dragged to the left: wider.
    const g = (await grip.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 - 400, g.y + g.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(width).toBe(760);
    // The page makes room beside it.
    expect(await page.evaluate(() => document.documentElement.style.marginRight)).toBe('760px');
    // From the keyboard: ← wider, Maj+← by more, Fin: as wide as allowed.
    await grip.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(width).toBe(780);
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(width).toBe(860);
    await page.keyboard.press('End');
    const inner = await page.evaluate(() => innerWidth);
    await expect.poll(width).toBe(Math.min(960, inner - 160));
    await expect
      .poll(() => sw.evaluate(async () => ((await chrome.storage.sync.get('settings')).settings as { drawerWidth?: number } | undefined)?.drawerWidth))
      .toBe(960);
    await page.keyboard.press('Enter');
    await expect.poll(width).toBe(360);
  });
});
