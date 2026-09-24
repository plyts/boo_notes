import { copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editor, expect, importAndOpen, libraryJson, noteText, test } from './fixtures';

/**
 * Copy and paste « tout compris » in the app's notes, as in the browser
 * panel: a picture, a video and formatted text pasted into a note are saved
 * in the notes folder; a copied part of a note carries its pictures.
 */

const SAMPLE = fileURLToPath(new URL('../../../tests/e2e/fixtures/sample.webm', import.meta.url));
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type PastedFile = { name: string; type: string; base64?: string; picture?: boolean };

async function paste(page: import('@playwright/test').Page, content: { html?: string; text?: string; files?: PastedFile[] }): Promise<void> {
  await page.evaluate(async (c) => {
    const dt = new DataTransfer();
    if (c.text) dt.setData('text/plain', c.text);
    if (c.html) dt.setData('text/html', c.html);
    for (const f of c.files ?? []) {
      let blob: Blob;
      if (f.picture) {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        canvas.getContext('2d')!.fillRect(0, 0, 320, 180);
        blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      } else blob = new Blob([Uint8Array.from(atob(f.base64!), (ch) => ch.charCodeAt(0))], { type: f.type });
      dt.items.add(new File([blob], f.name, { type: f.type }));
    }
    const content = document.querySelector('.note-editor .cm-content') as HTMLElement;
    content.focus();
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, content);
}

test('coller une image, une vidéo et du texte mis en forme ; copier une partie avec ses images', async ({ ctx }) => {
  const video = join(ctx.dir, 'Cours 12.webm');
  await copyFile(SAMPLE, video);
  const { app, page } = await ctx.launch();
  await importAndOpen(page, [video], 'Cours 12');
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);
  await page.evaluate(async () => {
    const v = document.querySelector('video') as HTMLVideoElement;
    const seeked = new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    v.currentTime = 4;
    await seeked;
  });
  await editor(page).click();
  await page.keyboard.type('Schéma');
  await page.keyboard.press('Enter');

  // A picture: at the moment of the video, saved in the notes folder.
  await paste(page, { files: [{ name: 'image.png', type: 'image/png', picture: true }] });
  await expect.poll(() => noteText(ctx.vault, 'Cours 12')).toMatch(/\[00:04\] !\[Image collée 00:04\]\(assets\/Cours-12-image-\w+\.png\)/);
  const image = /\((assets\/[^)]+\.png)\)/.exec(await noteText(ctx.vault, 'Cours 12'))![1];
  expect((await stat(join(ctx.vault, image))).size).toBeGreaterThan(100);

  // A video file: in `media/`, listed with the note, played over the notes.
  const bytes = (await readFile(SAMPLE)).toString('base64');
  await paste(page, { files: [{ name: 'démo.webm', type: 'video/webm', base64: bytes }] });
  await expect.poll(() => noteText(ctx.vault, 'Cours 12')).toMatch(/\[00:04\] \[🎬 démo\.webm\]\(media\/[\w-]+-file-demo-\w+\.webm\)/);
  const lib = await libraryJson(ctx.vault);
  const noteId = Object.values(lib.notes).find((n) => n.title === 'Cours 12')!.id;
  const media = (lib as unknown as { media: Record<string, Array<{ path: string; kind: string; name?: string; size: number }>> }).media[noteId];
  expect(media).toHaveLength(1);
  expect(media[0]).toMatchObject({ kind: 'file', name: 'démo.webm' });
  expect((await readFile(join(ctx.vault, media[0].path))).length).toBe(media[0].size);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.locator('.cm-boo-media[data-kind="file"]').click();
  await expect(page.locator('.media-pop video')).toBeVisible();
  await expect(page.locator('.media-pop .mp-title')).toHaveText('démo.webm');
  await page.getByRole('button', { name: 'Fermer l’extrait' }).click();

  // Formatted text with a picture.
  await paste(page, { text: 'Définition', html: `<h2>Définition</h2><p>Le <b>flux</b> du rotationnel</p><p><img src="data:image/png;base64,${PIXEL}" alt="Figure"></p>` });
  await expect.poll(() => noteText(ctx.vault, 'Cours 12')).toMatch(/## Définition\nLe \*\*flux\*\* du rotationnel\n!\[Figure\]\(assets\/Cours-12-image-\w+\.png\)/);

  // Copy of the whole note: its pictures inside, for other apps.
  await editor(page).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+C');
  const clip = await app.evaluate(async ({ clipboard }) => {
    const [item] = await clipboard.read();
    const read = async (type: string) => ((await item.getType(type)) as Blob).text();
    return { text: await read('text/plain'), html: await read('text/html') };
  });
  expect(clip.text).toMatch(/!\[Image collée 00:04\]\(data:image\/png;base64,/);
  expect(clip.text).toContain('🎬 démo.webm');
  expect(clip.text).not.toMatch(/\]\((assets|media)\//);
  expect(clip.html).toMatch(/<img src="data:image\/png;base64,/);
});
