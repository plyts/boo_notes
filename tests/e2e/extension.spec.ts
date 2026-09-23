import { expect, NOTE_ID, openNotes, openWatch, panel, runCommand, setVideo, storedNote, test, videoPaused, videoTime } from './fixtures';

test.describe('Flow 1 — prise de note rapide', () => {
  test('Alt+Shift+N ouvre le panneau côte à côte et horodate chaque nouvelle ligne', async ({ page, sw }) => {
    await openWatch(page);
    await setVideo(page, 12);
    // Nothing is injected besides the overlay until the notes are opened (passive viewing).
    await expect(page.locator('#boo-notes-drawer')).toHaveCount(0);

    await runCommand(sw, page, 'toggle-sidebar');
    const drawer = page.locator('#boo-notes-drawer .drawer');
    await expect(drawer).toHaveClass(/open/);
    await expect.poll(() => page.evaluate(() => document.documentElement.style.marginRight)).toBe('360px');

    const p = panel(page);
    await expect(p.locator('h1.title')).toHaveText('Vidéo de test E2E');
    await expect(p.locator('.cm-content')).toBeFocused();
    await page.keyboard.type('Hooks et état local');
    await page.keyboard.press('Enter');
    await setVideo(page, 15);
    await page.waitForTimeout(300); // let the panel clock catch up
    await page.keyboard.type('- useEffect');

    await expect.poll(async () => (await storedNote(sw))?.markdown).toBe('[00:12] Hooks et état local\n- [00:15] useEffect');
    expect((await storedNote(sw))?.title).toBe('Vidéo de test E2E');

    // Esc closes the (unpinned) drawer and restores the page layout.
    await page.keyboard.press('Escape');
    await expect(drawer).not.toHaveClass(/open/);
    await expect.poll(() => page.evaluate(() => document.documentElement.style.marginRight)).toBe('');
  });

  test('Alt+Shift+T insère [MM:SS] sans interrompre la lecture', async ({ page, sw }) => {
    await openWatch(page);
    await setVideo(page, 20, true);
    await runCommand(sw, page, 'insert-timestamp');
    const p = panel(page);
    await expect(p.locator('.cm-content')).toBeFocused();
    await expect(p.locator('.cm-content')).toContainText(/\[00:2[01]\]/);
    expect(await videoPaused(page)).toBe(false);
  });

  test('Alt+Shift+T fonctionne même si Chrome a refusé le raccourci global (page et panneau)', async ({ page, sw }) => {
    const registered = await sw.evaluate(async () =>
      (await chrome.commands.getAll()).find((c) => c.name === 'insert-timestamp')?.shortcut,
    );
    test.skip(Boolean(registered), 'Alt+Shift+T is registered globally on this platform');
    await openWatch(page);
    await setVideo(page, 14);
    await page.locator('h1').click();
    await page.keyboard.press('Alt+Shift+T');
    const p = panel(page);
    await expect(p.locator('.cm-content')).toBeFocused();
    await page.keyboard.type('depuis la page');
    await setVideo(page, 16);
    await page.waitForTimeout(300);
    // Inside the notes panel too.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Alt+Shift+T');
    await page.keyboard.type('depuis le panneau');
    await expect.poll(async () => (await storedNote(sw))?.markdown).toBe('[00:14] depuis la page\n[00:16] depuis le panneau');
  });

  test('Smart Pause met en pause et donne le focus à l’éditeur', async ({ page, sw }) => {
    await openWatch(page);
    await setVideo(page, 5, true);
    await runCommand(sw, page, 'smart-pause');
    await expect.poll(() => videoPaused(page)).toBe(true);
    await expect(panel(page).locator('.cm-content')).toBeFocused();
  });
});

test.describe('Flow 2 — capture', () => {
  test('Alt+Shift+S capture la frame, flashe, affiche un toast et insère la vignette', async ({ page, sw }) => {
    await openWatch(page);
    await setVideo(page, 20);
    await runCommand(sw, page, 'capture-screenshot');

    await expect(page.locator('#boo-notes-overlay .toast')).toHaveText('00:20 - Capture sauvegardée');
    // Drawer closed: the capture is appended to the stored note by the background.
    await expect.poll(async () => (await storedNote(sw))?.markdown ?? '').toMatch(
      /^\[00:20\] !\[Capture 00:20\]\(assets\/youtube-e2eTest0001-00-20-\w+\.jpg\)\n$/,
    );
    const path = /\((assets\/[^)]+)\)/.exec((await storedNote(sw))?.markdown ?? '')?.[1];
    const asset = await sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], `asset:${path}`);
    expect(asset).toMatchObject({ width: 320, height: 180, mime: 'image/jpeg', time: 20 });

    // The thumbnail shows up in the editor.
    await runCommand(sw, page, 'toggle-sidebar');
    await expect(panel(page).locator('.cm-boo-img img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  });
});

test.describe('Lecteur & HUD', () => {
  test('Alt+← recule de 5 secondes', async ({ page }) => {
    await openWatch(page);
    await setVideo(page, 20);
    await page.locator('h1').click();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(() => videoTime(page)).toBeCloseTo(15, 0);
    expect(page.url()).toContain('watch?v=');
    await expect(page.locator('#boo-notes-overlay .toast')).toHaveText('00:15 - Retour de 5 s');
  });

  test('Alt+← reste une touche normale dans un champ de saisie', async ({ page }) => {
    await openWatch(page);
    await setVideo(page, 20);
    await page.locator('#comment').click();
    await page.keyboard.press('Alt+ArrowLeft');
    expect(await videoTime(page)).toBe(20);
  });

  test('le HUD apparaît au survol et copie le lien horodaté', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.youtube.com' });
    await openWatch(page);
    await setVideo(page, 15);
    const hud = page.locator('#boo-notes-overlay .hud');
    await expect(hud).not.toHaveClass(/visible/);
    await page.mouse.move(300, 300);
    await page.mouse.move(320, 310);
    await expect(hud).toHaveClass(/visible/);
    await expect(hud.locator('.tc')).toHaveText('00:15');
    await hud.locator('.tc').click();
    await expect(page.locator('#boo-notes-overlay .toast')).toHaveText('00:15 - Lien horodaté copié');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      '[00:15](https://www.youtube.com/watch?v=e2eTest0001#t=15)',
    );
  });

  test('épingler depuis le HUD ouvre le panneau et Échap ne le ferme plus', async ({ page }) => {
    await openWatch(page);
    await page.mouse.move(300, 300);
    await page.mouse.move(320, 310);
    await page.locator('#boo-notes-overlay .hud button[aria-pressed]').click();
    const drawer = page.locator('#boo-notes-drawer .drawer');
    await expect(drawer).toHaveClass(/open/);
    const p = panel(page);
    await expect(p.locator('button[aria-pressed="true"]')).toHaveCount(1);
    await p.locator('.cm-content').click();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveClass(/open/);
    // Still open after a reload of the page.
    await page.reload();
    await expect(page.locator('#boo-notes-drawer .drawer')).toHaveClass(/open/);
  });

  test('plein écran : HUD et panneau épinglé suivent le lecteur, puis reviennent', async ({ page }) => {
    await openWatch(page);
    await page.mouse.move(300, 300);
    await page.mouse.move(320, 310);
    await page.locator('#boo-notes-overlay .hud button[aria-pressed]').click(); // pin → drawer opens
    await expect(page.locator('#boo-notes-drawer .drawer')).toHaveClass(/open/);

    await page.locator('#movie_player').dblclick({ position: { x: 100, y: 100 } });
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('movie_player');
    const parents = () =>
      page.evaluate(() => [
        document.getElementById('boo-notes-overlay')?.parentElement?.tagName,
        document.getElementById('boo-notes-drawer')?.parentElement?.tagName,
      ]);
    await expect.poll(parents).toEqual(['DIV', 'DIV']);
    await expect(page.locator('#boo-notes-drawer .drawer')).toHaveClass(/open/);
    // No page margin in fullscreen: the drawer floats over the video.
    expect(await page.evaluate(() => document.documentElement.style.marginRight)).toBe('');

    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(parents).toEqual(['HTML', 'HTML']);
    await expect.poll(() => page.evaluate(() => document.documentElement.style.marginRight)).toBe('360px');
    // The editor iframe survived the moves (state-preserving move) or reloaded: it is still usable.
    await expect(panel(page).locator('.cm-content')).toBeVisible();
  });

  test('un lien URL#t= ouvre la vidéo au bon moment', async ({ page }) => {
    await openWatch(page, '#t=7');
    await expect.poll(() => videoTime(page)).toBeGreaterThanOrEqual(7);
    expect(await videoTime(page)).toBeLessThan(9);
  });
});

test.describe('Surbrillance bidirectionnelle', () => {
  test('survoler un horodatage place un marqueur sur la barre de progression, cliquer y saute', async ({ page, sw }) => {
    await openWatch(page);
    await setVideo(page, 8);
    await openNotes(sw, page);
    const p = panel(page);
    await page.keyboard.type('Définition');
    await page.keyboard.press('Enter');
    await setVideo(page, 25);
    await page.waitForTimeout(300);
    await page.keyboard.type('Exemple');
    await page.keyboard.press('Enter');

    const chip = p.locator('.cm-boo-ts', { hasText: '00:08' });
    await chip.hover();
    const marker = page.locator('#boo-notes-overlay .marker');
    await expect(marker).toHaveClass(/visible/);
    await expect(marker.locator('.label')).toHaveText('00:08');
    const bar = await page.locator('.ytp-progress-bar').boundingBox();
    const box = await marker.boundingBox();
    expect(box && bar).toBeTruthy();
    // 8 s of 30 s → ~27 % along the bar.
    expect((box!.x - bar!.x) / bar!.width).toBeCloseTo(8 / 30, 1);

    await chip.click();
    await expect.poll(() => videoTime(page)).toBeCloseTo(8, 0);
    // Video → note: the line of the last reached timestamp is highlighted.
    await expect(p.locator('.cm-boo-now')).toContainText('Définition');
  });
});

test.describe('Pop-out', () => {
  test('détacher puis rattacher la note', async ({ page, sw, context }) => {
    await openWatch(page);
    await setVideo(page, 3);
    await openNotes(sw, page);
    await page.keyboard.type('Avant pop-out');
    const popupPromise = context.waitForEvent('page');
    await panel(page).getByRole('button', { name: 'Détacher dans une fenêtre' }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toContain('mode=popout');
    await expect(page.locator('#boo-notes-drawer iframe')).toHaveCount(0);
    await expect(popup.locator('.cm-content')).toContainText('Avant pop-out');

    await popup.locator('.cm-content').click();
    await popup.keyboard.press('End');
    await popup.keyboard.press('Enter');
    await setVideo(page, 9);
    await popup.waitForTimeout(300);
    await popup.keyboard.type('Depuis la fenêtre');
    await expect.poll(async () => (await storedNote(sw))?.markdown).toBe('[00:03] Avant pop-out\n[00:09] Depuis la fenêtre');

    // Captures go to the detached editor.
    await runCommand(sw, page, 'capture-screenshot');
    await expect(popup.locator('.cm-boo-img img')).toHaveAttribute('src', /^data:image/);

    const closed = popup.waitForEvent('close');
    await popup.getByRole('button', { name: /Rattacher/ }).click();
    await closed;
    await expect(page.locator('#boo-notes-drawer .drawer')).toHaveClass(/open/);
    await expect(panel(page).locator('.cm-content')).toContainText('Depuis la fenêtre');
  });
});

test.describe('Export hors-ligne', () => {
  test('télécharger la note (.md + captures) et copier le Markdown', async ({ page, sw, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openWatch(page);
    await setVideo(page, 7);
    await openNotes(sw, page);
    await page.keyboard.type('Point clé');
    await runCommand(sw, page, 'capture-screenshot');
    const p = panel(page);
    await expect(p.locator('.cm-boo-img img')).toHaveAttribute('src', /^data:/);

    await p.getByRole('button', { name: 'Exporter la note' }).click();
    // Desktop targets are disabled while the app is offline.
    await expect(p.getByRole('menuitem', { name: /Notion/ })).toBeDisabled();
    await p.getByRole('menuitem', { name: /Télécharger/ }).click();
    // Accented name, or its ASCII fallback on systems refusing Unicode file names.
    await expect(p.locator('.notice')).toHaveText(/^Téléchargé dans « Boo Notes\/Vid[ée]o de test E2E »$/);
    // Playwright stores downloads under random names: check what was downloaded instead.
    const downloads = await sw.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        const items = await chrome.downloads.search({});
        if (items.length >= 2 && items.every((d) => d.state === 'complete')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return (await chrome.downloads.search({})).map((d) => ({ mime: d.mime, state: d.state, size: d.fileSize }));
    });
    expect(downloads.map((d) => d.mime).sort()).toEqual(['image/jpeg', 'text/markdown']);
    expect(downloads.every((d) => d.state === 'complete' && d.size > 0)).toBe(true);

    await p.getByRole('button', { name: 'Exporter la note' }).click();
    await p.getByRole('menuitem', { name: /Copier/ }).click();
    await expect(p.locator('.notice')).toHaveText('Markdown copié dans le presse-papier');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('title: "Vidéo de test E2E"');
    expect(clip).toContain('[00:07](https://www.youtube.com/watch?v=e2eTest0001#t=7) Point clé');
    expect(clip).toMatch(/!\[Capture 00:07\]\(assets\/youtube-e2eTest0001-00-07-\w+\.jpg\)/);
  });
});

test.describe('Stockage', () => {
  test('la note est restaurée après rechargement', async ({ page, sw }) => {
    await openWatch(page);
    await setVideo(page, 4);
    await openNotes(sw, page);
    await page.keyboard.type('Persistant');
    await expect.poll(async () => (await storedNote(sw))?.markdown).toBe('[00:04] Persistant');
    await page.reload();
    await page.locator('#boo-notes-overlay').waitFor({ state: 'attached' });
    await runCommand(sw, page, 'toggle-sidebar');
    await expect(panel(page).locator('.cm-content')).toContainText('Persistant');
    expect(NOTE_ID).toBe('youtube:e2eTest0001');
  });
});
