import type { BrowserContext, Page, Worker } from '@playwright/test';
import { expect, openNotes, openWatch, panel, runCommand, storedNote, test } from './fixtures';

/**
 * The extension reloaded or updated while a page keeps its notes open: the
 * copy of the script left in the page (cut off: « Extension context
 * invalidated ») gives the page back — no dead panel left on screen, no
 * error — and the new version takes over: notes open again where it may
 * run, a « reload the page » card elsewhere. And a course module launched
 * into a frame whose address is hidden (a form posted into it).
 */

/** « Recharger » in chrome://extensions, as after an update. */
async function reloadExtension(context: BrowserContext, sw: Worker): Promise<Page> {
  const id = new URL(sw.url()).host;
  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions');
  await extensions.evaluate(
    () => new Promise((r) => (chrome as unknown as { developerPrivate: { updateProfileConfiguration(c: object, cb: () => void): void } }).developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => r(null))),
  );
  await extensions.evaluate(
    (id) =>
      new Promise((r) =>
        (chrome as unknown as { developerPrivate: { reload(id: string, o: object, cb: () => void): void } }).developerPrivate.reload(id, { failQuietly: true }, () => r(null)),
      ),
    id,
  );
  return extensions;
}

/** Errors the extension's scripts raised in pages (the « Erreurs » list of chrome://extensions). */
async function scriptErrors(extensions: Page): Promise<string[]> {
  type Info = { runtimeErrors?: Array<{ message: string; source: string }> };
  const list = await extensions.evaluate(
    () =>
      new Promise<Info[]>((r) =>
        (chrome as unknown as { developerPrivate: { getExtensionsInfo(o: object, cb: (l: Info[]) => void): void } }).developerPrivate.getExtensionsInfo({ includeDisabled: true }, r),
      ),
  );
  return list.flatMap((e) => e.runtimeErrors ?? []).filter((e) => /\/(content|frame|panel\/panel)\.js$/.test(e.source)).map((e) => e.message);
}

const drawers = (page: Page) => page.evaluate(() => document.querySelectorAll('#boo-notes-drawer').length);

test('mise à jour, notes ouvertes : l’ancienne copie rend la page, la nouvelle rouvre les notes', async ({ context, page, sw }) => {
  await openWatch(page);
  await openNotes(sw, page);
  await page.keyboard.type('Avant la mise à jour');
  await expect.poll(async () => (await storedNote(sw))?.markdown).toContain('Avant la mise à jour');
  await expect.poll(() => page.evaluate(() => document.documentElement.style.marginRight)).toBe('360px');

  const extensions = await reloadExtension(context, sw);
  await page.bringToFront();
  // The new version (re-injected in the open tab) opens the notes again, alone; the old one left nothing.
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('#boo-notes-overlay').length), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => drawers(page)).toBe(1);
  const notes = panel(page).locator('.cm-content');
  await expect(notes).toContainText('Avant la mise à jour', { timeout: 10_000 });
  expect(await page.evaluate(() => document.documentElement.style.marginRight)).toBe('360px');
  // A live panel: what is written now is saved.
  await notes.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' puis après');
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html`);
  await expect
    .poll(() => options.evaluate(async () => ((await chrome.storage.local.get('note:youtube:e2eTest0001'))['note:youtube:e2eTest0001'] as { markdown: string } | undefined)?.markdown))
    .toContain('Avant la mise à jour puis après');
  expect(await scriptErrors(extensions)).toEqual([]);
});

test('mise à jour sur un site activé d’un clic : panneau mort retiré, invitation à recharger', async ({ context, page, sw }) => {
  await context.route(/^https:\/\/course\.example\.test\//, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Leçon</title></head><body><main><h1>Leçon 1</h1><p>Un texte de cours assez long pour une note de lecture.</p></main></body></html>',
    }),
  );
  await page.goto('https://course.example.test/lesson/1');
  await page.bringToFront();
  await runCommand(sw, page, 'toggle-sidebar');
  await expect(panel(page).locator('.cm-content')).toBeVisible();

  const extensions = await reloadExtension(context, sw);
  await page.bringToFront();
  // The user comes back to the page: the copy cut off from the extension notices it at once.
  await page.mouse.click(200, 300);
  await expect.poll(() => drawers(page)).toBe(0);
  expect(await page.evaluate(() => document.querySelectorAll('#boo-notes-overlay').length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.style.marginRight)).toBe('');
  // « Boo Notes a été mis à jour — Rechargez la page » (a closed shadow tree: only its host is visible to tests).
  await expect(page.locator('#boo-notes-reload-notice')).toBeAttached();
  expect(await scriptErrors(extensions)).toEqual([]);
});

test('module lancé dans un cadre à l’adresse masquée : le panneau propose d’autoriser tous les sites', async ({ context, page, sw }) => {
  await context.route(/^https:\/\/lms\.example\.test\//, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      // Like some LMS: an empty frame, then a form posted into it to launch the module.
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Course project overview</title></head><body>
        <h1>Course project and dataset types overview</h1>
        <iframe name="course" style="width:900px;height:560px;border:0"></iframe>
        <form method="post" action="https://content.scorm-host.example/launch/4384" target="course"><input type="hidden" name="token" value="abc"></form>
        <script>document.forms[0].submit();</script></body></html>`,
    }),
  );
  await context.route(/^https:\/\/content\.scorm-host\.example\//, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body><h2>Module</h2><p>Declarative pipelines.</p></body></html>' }),
  );
  await page.goto('https://lms.example.test/learn/courses/2971/lessons/63328:4384/overview');
  await page.bringToFront();
  await expect.poll(() => page.frames().some((f) => f.url().startsWith('https://content.scorm-host.example/'))).toBe(true);
  await openNotes(sw, page);
  const hint = panel(page).locator('.players-hint');
  await expect(hint).toBeVisible({ timeout: 8000 });
  await expect(hint).toContainText('adresse est masquée');
  await expect(hint.getByRole('button', { name: 'Autoriser' })).toBeVisible();
});
