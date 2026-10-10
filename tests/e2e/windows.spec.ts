import type { BrowserContext, Locator, Page, Worker } from '@playwright/test';
import { expect, NOTE_ID, openNotes, openWatch, panel, runCommand, setVideo, storedNote, test } from './fixtures';
import { TILING_ENABLED } from '../../src/shared/tiling';

/**
 * Where the notes stand: moved freely by their grip ⠿, docked to any edge of
 * the window (the page beside them, the video whole), floating, resized by
 * their edges; the Mini (the line being said and its translation), always on
 * top in a window of its own; the fullscreen split and its separator;
 * « Côte à côte » (the video's window and the notes' window share the screen).
 */

const ORIGIN = 'https://www.youtube.com';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
Welcome to the lesson.

00:00:03.000 --> 00:00:06.000
The circulation of F around the boundary

00:00:06.000 --> 00:00:09.000
equals the flux of its curl.

00:00:09.000 --> 00:00:14.000
Any questions?
`;

test.beforeEach(async ({ context }) => {
  await context.route(`${ORIGIN}/__fixtures/lesson.vtt`, (route) => route.fulfill({ contentType: 'text/vtt; charset=utf-8', body: VTT }));
});

const drawer = (page: Page) => page.locator('#boo-notes-drawer .drawer');
const grip = (page: Page) => page.locator('#boo-notes-drawer .grip');

async function boxOf(loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await loc.boundingBox();
  if (!b) throw new Error('not on screen');
  return b;
}

const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Presses at `from`, moves to `to` in steps; `before`: checks while still held. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, before?: () => Promise<void>): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await before?.();
  await page.mouse.up();
}

const margin = (page: Page, side: string) => page.evaluate((side) => document.documentElement.style.getPropertyValue(`margin-${side}`), side);

const storedPlace = (sw: Worker) =>
  sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], `place:${ORIGIN}`) as Promise<
    { mode: string; side: string; float: { x: number; y: number; w: number; h: number } | null; mini: { x: number; y: number; w: number; h: number } | null; glass: number } | undefined
  >;

const storedSettings = (sw: Worker) => sw.evaluate(async () => (await chrome.storage.sync.get('settings')).settings) as Promise<Record<string, unknown> | undefined>;

const videoBox = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector('video')!.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, w: innerWidth, h: innerHeight };
  });

/** « Disposition du panneau » › an entry. */
async function chooseLayout(page: Page, name: string): Promise<void> {
  const p = panel(page);
  await p.getByRole('button', { name: 'Disposition du panneau' }).click();
  await p.getByRole('menu', { name: 'Disposition du panneau' }).getByRole('menuitemradio', { name }).click();
}

/** A player sized from the window (like YouTube's), which does not follow the page's margins. */
const widePlayer = (page: Page) => page.addStyleTag({ content: '#movie_player { width: 100vw !important; height: 56.25vw !important; }' });

async function addTrack(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t = document.createElement('track');
    t.kind = 'subtitles';
    t.srclang = 'en';
    t.label = 'English';
    t.src = '/__fixtures/lesson.vtt';
    document.querySelector('video')!.append(t);
  });
}

/** Chrome's on-device translator, stubbed in the panel (the real one needs a model download). */
async function stubTranslator(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:') return;
    Object.assign(globalThis, {
      Translator: {
        availability: async () => 'available',
        create: async (o: { targetLanguage: string }) => ({ translate: async (text: string) => `[${o.targetLanguage}] ${text}` }),
      },
    });
  });
}

test.describe('Fenêtrage du panneau', () => {
  test('poignée ⠿ : le panneau se pose où l’on veut, flotte sur la page, et revient à sa place sur le site', async ({ page, sw }) => {
    await openWatch(page);
    await openNotes(sw, page);
    await expect(drawer(page)).toHaveClass(/dock-right/);
    expect(await margin(page, 'right')).toBe('360px');

    const g = await boxOf(grip(page));
    await drag(page, center(g), { x: 520, y: 300 });
    await expect(drawer(page)).toHaveClass(/floating/);
    // Floating: the page has its whole width back.
    expect(await margin(page, 'right')).toBe('');
    const b = await boxOf(drawer(page));
    // The grip stays under the pointer.
    expect(b.x).toBeLessThan(520);
    expect(b.x + 40).toBeGreaterThan(520);
    expect(b.y).toBeLessThan(300);
    await expect.poll(async () => (await storedPlace(sw))?.mode).toBe('float');
    const saved = (await storedPlace(sw))!;
    expect(Math.abs(saved.float!.x - b.x)).toBeLessThanOrEqual(1);
    // Still the notes: writable.
    await panel(page).locator('.cm-content').click();
    await page.keyboard.type('Panneau déplacé');
    await expect.poll(async () => (await storedNote(sw))?.markdown ?? '').toContain('Panneau déplacé');

    // Another visit of the site: the panel where it was left.
    await openWatch(page);
    await openNotes(sw, page);
    await expect(drawer(page)).toHaveClass(/floating/);
    const again = await boxOf(drawer(page));
    expect(Math.abs(again.x - b.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(again.y - b.y)).toBeLessThanOrEqual(1);
  });

  test('contre un bord, la zone d’ancrage s’allume ; relâché, le panneau s’ancre à gauche et la vidéo reste entière', async ({ page, sw }) => {
    await openWatch(page);
    await widePlayer(page);
    await openNotes(sw, page);
    const g = await boxOf(grip(page));
    await drag(page, center(g), { x: 12, y: 420 }, async () => {
      await expect(page.locator('#boo-notes-drawer .zone')).toHaveClass(/(^|\s)on(\s|$)/);
      await expect(page.locator('#boo-notes-drawer .zone')).toHaveText('Relâchez : ancré à gauche');
    });
    await expect(page.locator('#boo-notes-drawer .zone')).not.toHaveClass(/(^|\s)on(\s|$)/);
    await expect(drawer(page)).toHaveClass(/dock-left/);
    expect(await margin(page, 'left')).toBe('360px');
    expect(await margin(page, 'right')).toBe('');
    const notes = await boxOf(drawer(page));
    expect(notes.x).toBeCloseTo(0, 0);
    // The page beside the notes: the player starts after them and ends within the window, 16:9 kept.
    await expect(page.locator('#movie_player')).toHaveAttribute('data-boo-notes-fit', 'shrink');
    await expect.poll(async () => {
      const v = await videoBox(page);
      return v.left >= notes.x + notes.width - 1 && v.right <= v.w + 1;
    }).toBe(true);
    const v = await videoBox(page);
    expect(v.width / v.height).toBeCloseTo(16 / 9, 1);
    await expect.poll(async () => (await storedPlace(sw))?.side).toBe('left');

    // Its separator (on the right now) widens the notes towards the page.
    const handle = await boxOf(page.locator('#boo-notes-drawer .resize'));
    await drag(page, center(handle), { x: center(handle).x + 100, y: center(handle).y });
    await expect.poll(async () => (await storedSettings(sw))?.drawerWidth).toBe(460);
    expect(await margin(page, 'left')).toBe('460px');
  });

  test('carte flottante : ses bords la redimensionnent ; double-clic sur la poignée : ancrée de nouveau', async ({ page, sw }) => {
    await openWatch(page);
    await openNotes(sw, page);
    await chooseLayout(page, 'Flottant, où vous le posez');
    await expect(drawer(page)).toHaveClass(/floating/);
    const before = await boxOf(drawer(page));
    const edge = await boxOf(page.locator('#boo-notes-drawer .edge.w'));
    await drag(page, center(edge), { x: center(edge).x - 120, y: center(edge).y });
    await expect.poll(async () => Math.round((await boxOf(drawer(page))).width)).toBe(Math.round(before.width) + 120);
    // The right edge stays put.
    const after = await boxOf(drawer(page));
    expect(after.x + after.width).toBeCloseTo(before.x + before.width, 0);
    await expect.poll(async () => (await storedPlace(sw))?.float?.w).toBe(Math.round(after.width));

    await grip(page).dblclick();
    await expect(drawer(page)).toHaveClass(/dock-right/);
    expect(await margin(page, 'right')).toBe('360px');
  });

  test('ancré en bas : une bande sur toute la largeur, la vidéo au-dessus, entière', async ({ page, sw }) => {
    await openWatch(page);
    await widePlayer(page);
    await openNotes(sw, page);
    await chooseLayout(page, 'Ancré en bas');
    await expect(drawer(page)).toHaveClass(/dock-bottom/);
    await expect(panel(page).locator('html')).toHaveAttribute('data-place', 'dock-bottom');
    expect(await margin(page, 'bottom')).toBe('300px');
    expect(await margin(page, 'right')).toBe('');
    const notes = await boxOf(drawer(page));
    const { w, h } = await videoBox(page);
    expect(notes.width).toBeCloseTo(w, 0);
    expect(notes.y + notes.height).toBeCloseTo(h, 0);
    expect(notes.height).toBeCloseTo(300, 0);
    await expect.poll(async () => (await videoBox(page)).bottom <= notes.y + 1).toBe(true);
    const v = await videoBox(page);
    expect(v.width / v.height).toBeCloseTo(16 / 9, 1);

    // Its top edge sets its height.
    const handle = await boxOf(page.locator('#boo-notes-drawer .resize'));
    await drag(page, center(handle), { x: center(handle).x, y: center(handle).y - 100 });
    await expect.poll(async () => (await storedSettings(sw))?.stripHeight).toBe(400);
    expect(await margin(page, 'bottom')).toBe('400px');
    await expect.poll(async () => (await videoBox(page)).bottom <= (await boxOf(drawer(page))).y + 1).toBe(true);

    // Back on the right, the strip's margin goes.
    await chooseLayout(page, 'Ancré à droite');
    await expect(drawer(page)).toHaveClass(/dock-right/);
    expect(await margin(page, 'bottom')).toBe('');
    expect(await margin(page, 'right')).toBe('360px');
  });
});

test.describe('Mini (paroles)', () => {
  test('Mini : la réplique en cours, sa traduction et les voisines ; ⤢ : le panneau complet, prêt à écrire', async ({ context, page, sw }) => {
    await stubTranslator(context);
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...(settings ?? {}), autoTranslate: true, translateTo: 'fr' } });
    });
    await openWatch(page);
    await addTrack(page);
    await setVideo(page, 4);
    await openNotes(sw, page);
    const p = panel(page);
    await page.keyboard.type('Première idée');

    await p.getByRole('button', { name: 'Mode Mini' }).click();
    await expect(drawer(page)).toHaveClass(/mini/);
    await expect(p.locator('html')).toHaveAttribute('data-mini', 'true');
    const mini = p.getByRole('region', { name: 'Mini : paroles en direct' });
    await expect(mini).toBeVisible();
    await expect(mini.locator('.mini-now')).toHaveText('The circulation of F around the boundary');
    await expect(mini.locator('.mini-prev')).toHaveText('Welcome to the lesson.');
    // The next lines, one after the other.
    await expect(mini.locator('.mini-next')).toHaveText(['equals the flux of its curl.', 'Any questions?']);
    await expect(mini.locator('.mini-tr')).toHaveText('[fr] The circulation of F around the boundary');
    await expect(mini.locator('.mini-clock')).toHaveText('EN DIRECT · 00:04');
    // Small and see-through, over the video: the page keeps its whole width.
    const box = await boxOf(drawer(page));
    expect(box.height).toBeLessThan(260);
    expect(await margin(page, 'right')).toBe('');
    expect(await drawer(page).evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur');

    // Its glass: more or less opaque.
    await mini.getByRole('slider', { name: 'Opacité du fond' }).fill('80');
    await expect.poll(() => drawer(page).evaluate((el) => (el as HTMLElement).style.getPropertyValue('--glass'))).toBe('0.8');
    // Moved by its grip.
    const g = await boxOf(grip(page));
    await drag(page, center(g), { x: center(g).x + 120, y: center(g).y - 150 });
    await expect.poll(async () => (await storedPlace(sw))?.mini?.x).toBe(Math.round(box.x + 120));
    expect((await storedPlace(sw))?.glass).toBe(0.8);
    // The video plays on: the lines follow it.
    await setVideo(page, 7);
    await expect(mini.locator('.mini-now')).toHaveText('equals the flux of its curl.');

    // ⤢: the full panel at its place, the cursor at the end of the note.
    await mini.getByRole('button', { name: 'Agrandir : panneau complet (double-clic)' }).click();
    await expect(drawer(page)).toHaveClass(/dock-right/);
    await expect(drawer(page)).not.toHaveClass(/mini/);
    await expect(p.locator('html')).toHaveAttribute('data-mini', 'false');
    // Ready to write: a new line at the end of the note, stamped with the moment of the video.
    await expect(p.locator('.cm-content')).toBeFocused();
    await page.keyboard.type('suite');
    await expect.poll(async () => (await storedNote(sw, NOTE_ID))?.markdown ?? '').toBe('[00:04] Première idée\n[00:07] suite');

    // Alt+Maj+M: the Mini again, where it was left; again: the panel.
    await runCommand(sw, page, 'toggle-mini');
    await expect(drawer(page)).toHaveClass(/mini/);
    expect(Math.round((await boxOf(drawer(page))).x)).toBe(Math.round(box.x + 120));
    await runCommand(sw, page, 'toggle-mini');
    await expect(drawer(page)).not.toHaveClass(/mini/);
  });

  test('Mini : la taille du texte se règle (A− / A+, Ctrl + molette, + / −), retenue ; le widget grandit pour la suivre', async ({ page, sw }) => {
    await openWatch(page);
    await addTrack(page);
    await setVideo(page, 4);
    await openNotes(sw, page);
    const p = panel(page);
    await p.getByRole('button', { name: 'Mode Mini' }).click();
    const mini = p.getByRole('region', { name: 'Mini : paroles en direct' });
    await expect(mini.locator('.mini-now')).toHaveText('The circulation of F around the boundary');
    const size = () => mini.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--mini-size'));
    const font = () => mini.locator('.mini-now').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(await size()).toBe('18px');
    const before = await boxOf(drawer(page));

    // A+ up to the largest: larger lines, kept in the settings; the widget grows so the line still fits.
    const larger = mini.getByRole('button', { name: 'Texte plus grand' });
    for (let i = 0; i < 20 && !(await larger.isDisabled()); i++) await larger.click();
    expect(await size()).toBe('48px');
    expect(await font()).toBe(48);
    await expect.poll(async () => (await storedSettings(sw))?.miniTextSize).toBe(48);
    await expect.poll(async () => (await boxOf(drawer(page))).height).toBeGreaterThan(before.height);
    // The next lines follow the size (smaller than the line being said).
    const next = await mini.locator('.mini-next').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(next).toBeGreaterThan(18);
    expect(next).toBeLessThan(48);

    // Ctrl + molette over the widget (a pinch on a touchpad): one step smaller; the page is not zoomed.
    const b = await boxOf(drawer(page));
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 120);
    await page.keyboard.up('Control');
    await expect.poll(size).toBe('46px');
    // + / − on the widget.
    await mini.getByRole('button', { name: 'Texte plus petit' }).focus();
    await page.keyboard.press('-');
    await expect.poll(size).toBe('44px');
    await expect.poll(async () => (await storedSettings(sw))?.miniTextSize).toBe(44);

    // Kept: the Mini of another page opens at that size.
    await openWatch(page);
    await openNotes(sw, page);
    await panel(page).getByRole('button', { name: 'Mode Mini' }).click();
    await expect.poll(() => panel(page).getByRole('region', { name: 'Mini : paroles en direct' }).evaluate((el) => (el as HTMLElement).style.getPropertyValue('--mini-size'))).toBe('44px');
  });

  test('épingle : le Mini dans sa fenêtre toujours au-dessus ; fermée, il revient dans la page', async ({ page, sw }) => {
    await openWatch(page);
    await addTrack(page);
    await setVideo(page, 4);
    await openNotes(sw, page);
    const p = panel(page);
    await p.getByRole('button', { name: 'Mode Mini' }).click();
    await expect(drawer(page)).toHaveClass(/mini/);
    await p.getByRole('button', { name: 'Toujours au-dessus' }).click();
    // A window of its own (Document Picture-in-Picture), with the Mini's panel; the page's widget gives way.
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { documentPictureInPicture: { window: Window | null } }).documentPictureInPicture.window))).toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as { documentPictureInPicture: { window: Window } }).documentPictureInPicture.window.document.querySelector('iframe')?.src),
    ).toContain('mode=pip');
    await expect(drawer(page)).not.toHaveClass(/open/);

    // Closed by its ×: the Mini back in the page.
    await page.evaluate(() => (window as unknown as { documentPictureInPicture: { window: Window } }).documentPictureInPicture.window.close());
    await expect(drawer(page)).toHaveClass(/open/);
    await expect(drawer(page)).toHaveClass(/mini/);
  });
});

test.describe('Partage de l’écran', () => {
  test('plein écran : 70 / 30, le séparateur règle le partage ; ancrées à gauche, les notes passent à gauche', async ({ page, sw }) => {
    await openWatch(page);
    await openNotes(sw, page);
    await page.locator('#movie_player').dblclick({ position: { x: 100, y: 100 } });
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('movie_player');
    await expect(panel(page).locator('.fs-hint')).toHaveText('Échap : quitter le plein écran');
    await expect(panel(page).locator('.fs-hint')).toBeVisible();
    const w = await page.evaluate(() => innerWidth);
    await expect.poll(async () => Math.round((await boxOf(drawer(page))).width)).toBe(Math.round(w * 0.3));

    // The separator: the notes take 40 %, the video the rest (whole).
    const handle = await boxOf(page.locator('#boo-notes-drawer .resize'));
    await drag(page, center(handle), { x: center(handle).x - Math.round(w * 0.1), y: center(handle).y });
    await expect.poll(async () => (await storedSettings(sw))?.splitRatio).toBe(0.6);
    await expect.poll(async () => {
      const notes = await boxOf(drawer(page));
      const v = await page.evaluate(() => document.querySelector('.ytp-progress-bar')!.getBoundingClientRect().right);
      return Math.abs(notes.width - w * 0.4) <= 1 && v <= notes.x + 1;
    }).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(drawer(page)).toHaveClass(/dock-right/);
    expect(await margin(page, 'right')).toBe('360px');

    // Docked on the left: in fullscreen, the notes on the left, the video on the right.
    await chooseLayout(page, 'Ancré à gauche');
    await page.locator('#movie_player').dblclick({ position: { x: 100, y: 100 } });
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('movie_player');
    await expect.poll(async () => {
      const notes = await boxOf(drawer(page));
      const bar = await page.evaluate(() => document.querySelector('.ytp-progress-bar')!.getBoundingClientRect().left);
      return notes.x <= 1 && bar >= notes.x + notes.width - 1;
    }).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
  });

  test('« Côte à côte » désactivé : ni dans « Disposition du panneau », ni dans la fenêtre des notes ; aucune fenêtre n’est surveillée ni déplacée', async ({ context, page, sw }) => {
    test.skip(TILING_ENABLED, '« Côte à côte » activé');
    await openWatch(page);
    await openNotes(sw, page);
    const p = panel(page);
    await p.getByRole('button', { name: 'Disposition du panneau' }).click();
    const menu = p.getByRole('menu', { name: 'Disposition du panneau' });
    // The panel's places and the Mini, nothing else.
    await expect(menu.getByRole('menuitemradio')).toHaveText(['Ancré à droite', 'Ancré à gauche', 'Ancré en haut', 'Ancré en bas', 'Flottant, où vous le posez']);
    await expect(menu.getByRole('menuitem', { name: /Mode Mini/ })).toBeVisible();
    await expect(menu).not.toContainText('Côte à côte');
    await page.keyboard.press('Escape');
    // The service worker no longer watches the windows' bounds.
    expect(await sw.evaluate(() => chrome.windows.onBoundsChanged.hasListeners())).toBe(false);
    // Detached, the notes' window has no « Côte à côte » chip; the video window keeps its size.
    const windows = () => sw.evaluate(async () => (await chrome.windows.getAll()).filter((w) => w.type === 'normal').map((w) => [w.id, w.left, w.top, w.width, w.height]));
    const before = await windows();
    const opened = context.waitForEvent('page', { predicate: (w) => w.url().includes('mode=popout') });
    await p.getByRole('button', { name: 'Détacher dans une fenêtre' }).click();
    const popup = await opened;
    await expect(popup.locator('.cm-content')).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Rattacher au lecteur (panneau latéral)' })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Côte à côte' })).toHaveCount(0);
    await popup.waitForTimeout(1500);
    expect(await windows()).toEqual(before);
  });

  test('« Côte à côte » : la fenêtre de la vidéo et celle des notes se partagent l’écran, frontière commune, retour à l’état d’avant', async ({ context, page, sw }) => {
    test.skip(!TILING_ENABLED, '« Côte à côte » désactivé (TILING_ENABLED)');
    await openWatch(page);
    await openNotes(sw, page);
    const windows = () =>
      sw.evaluate(async () => (await chrome.windows.getAll()).map((w) => ({ id: w.id!, type: w.type, left: w.left!, top: w.top!, width: w.width!, height: w.height!, state: w.state })));
    const before = (await windows()).find((w) => w.type === 'normal')!;
    const area = await page.evaluate(() => ({ left: (screen as Screen & { availLeft: number }).availLeft, top: (screen as Screen & { availTop: number }).availTop, width: screen.availWidth, height: screen.availHeight }));

    const opened = context.waitForEvent('page', { predicate: (w) => w.url().includes('mode=popout') });
    const p = panel(page);
    await p.getByRole('button', { name: 'Disposition du panneau' }).click();
    await p.getByRole('menuitemradio', { name: /^2\/3 · 1\/3/ }).click();
    const popup = await opened;
    // The notes moved to their window; the page's panel gave way.
    await expect(drawer(page)).not.toHaveClass(/open/);
    const tiles = () => sw.evaluate(async () => (await chrome.storage.session.get('tiles')).tiles as Record<string, { tile: string; videoWindow: number; notesWindow: number; expect: { video: { left: number; width: number }; notes: { left: number; width: number } } }>);
    await expect.poll(async () => Object.values((await tiles()) ?? {})[0]?.tile).toBe('2/3');
    const t = Object.values(await tiles())[0];
    // The video on the left, the notes on the right, together the whole work area.
    expect(t.expect.video.left).toBe(area.left);
    expect(t.expect.notes.left).toBe(t.expect.video.left + t.expect.video.width);
    expect(t.expect.video.width + t.expect.notes.width).toBe(area.width);
    await expect.poll(async () => (await windows()).find((w) => w.id === t.videoWindow)?.width).toBe(t.expect.video.width);
    // In the notes' window, « Côte à côte » is on.
    await expect(popup.getByRole('button', { name: 'Côte à côte' })).toHaveClass(/on/);

    // The user narrows the video window by its inner edge (once the windows have settled): the notes' window
    // follows the common border, once.
    await page.waitForTimeout(1000);
    await sw.evaluate(async (id) => {
      await chrome.windows.update(id, { width: 420 });
    }, t.videoWindow);
    await expect.poll(async () => Object.values(await tiles())[0]?.expect.notes.left).toBe(area.left + 420);
    expect(Object.values(await tiles())[0]?.expect.notes.width).toBe(area.width - 420);

    // « Quitter côte à côte »: the video window as it was (as far as the screen allows: headless Chromium's
    // screen is smaller than its window), the notes back in the page.
    await popup.getByRole('button', { name: 'Côte à côte' }).click();
    await popup.getByRole('menuitem', { name: 'Quitter côte à côte' }).click();
    const width = Math.min(before.width, area.width);
    const height = Math.min(before.height, area.height);
    const expected = {
      left: Math.max(area.left, Math.min(before.left, area.left + area.width - width)),
      top: Math.max(area.top, Math.min(before.top, area.top + area.height - height)),
      width,
      height,
    };
    await expect.poll(async () => {
      const w = (await windows()).find((x) => x.id === t.videoWindow);
      return w && { left: w.left, top: w.top, width: w.width, height: w.height };
    }).toEqual(expected);
    await expect.poll(async () => Object.keys((await tiles()) ?? {}).length).toBe(0);
    await expect(drawer(page)).toHaveClass(/open/);
  });
});
