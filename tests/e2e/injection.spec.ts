import { expect, openWatch, runCommand, setVideo, test, videoPaused } from './fixtures';

test('une double injection du script de contenu ne crée qu’une seule instance', async ({ page, sw }) => {
  await openWatch(page);
  // What the install handler does for already-open tabs, racing the declared injection.
  await sw.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    if (tab?.id === undefined) throw new Error('tab not found');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  }, page.url());
  await page.waitForTimeout(500);
  await expect(page.locator('#boo-notes-overlay')).toHaveCount(1);
  // A single instance handles each command: Smart Pause pauses (and does not immediately toggle back).
  await setVideo(page, 5, true);
  await runCommand(sw, page, 'smart-pause');
  await page.waitForTimeout(500);
  expect(await videoPaused(page)).toBe(true);
  await expect(page.locator('#boo-notes-drawer')).toHaveCount(1);
});
