import type { Frame, Page, Worker } from '@playwright/test';
import { expect, NOTE_ID, openNotes, openWatch, panel, runCommand, sampleVideo, setVideo, storedNote, test } from './fixtures';

/**
 * Copy and paste « tout compris » in the notes: pictures (screenshots,
 * « Copier l’image », files), videos and audios, formatted text with its
 * pictures, a part of a note pasted into another one, a copy carrying its
 * pictures to other apps, and « Copier l’image » of a card.
 */

const panelFrame = (page: Page): Frame => {
  const f = page.frames().find((x) => x.url().includes('/panel/panel.html'));
  if (!f) throw new Error('panel frame not found');
  return f;
};

type PastedFile = { name: string; type: string; base64?: string; picture?: { width: number; height: number } };

/** Pastes into the notes what the clipboard would hold (a synthetic paste event, as the browser sends it). */
async function paste(page: Page, content: { html?: string; text?: string; files?: PastedFile[] }): Promise<void> {
  await panelFrame(page).evaluate(async (c) => {
    const dt = new DataTransfer();
    if (c.text) dt.setData('text/plain', c.text);
    if (c.html) dt.setData('text/html', c.html);
    for (const f of c.files ?? []) {
      let blob: Blob;
      if (f.picture) {
        const canvas = document.createElement('canvas');
        canvas.width = f.picture.width;
        canvas.height = f.picture.height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#6d5ef0';
        ctx.fillRect(0, 0, f.picture.width, f.picture.height);
        ctx.fillStyle = '#fff';
        ctx.fillRect(10, 10, 20, 20);
        blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      } else blob = new Blob([Uint8Array.from(atob(f.base64!), (ch) => ch.charCodeAt(0))], { type: f.type });
      dt.items.add(new File([blob], f.name, { type: f.type }));
    }
    const content = document.querySelector('.cm-content') as HTMLElement;
    content.focus();
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, content);
}

async function mediaRecords(sw: Worker): Promise<Array<{ path: string; kind: string; name?: string; mime: string; size: number }>> {
  return sw.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('boo-notes-media', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction('media', 'readonly').objectStore('media').getAll();
          all.onsuccess = () => resolve((all.result as Array<Record<string, unknown>>).map(({ path, kind, name, mime, size }) => ({ path, kind, name, mime, size })) as never);
        };
      }),
  );
}

/** A 1×1 PNG. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe('Coller dans les notes', () => {
  test('une image, une vidéo, du texte mis en forme avec ses images', async ({ context, page, sw }) => {
    // A picture of a site that hands it over, and one of a site that refuses it.
    await context.route('https://images.example.test/fig.png', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from(PIXEL, 'base64') }));
    await context.route('https://cdn.elsewhere.example/refused.png', (route) => route.fulfill({ status: 403, body: '' }));
    await openWatch(page);
    await setVideo(page, 2);
    await openNotes(sw, page);
    await page.keyboard.type('Schéma du cours');
    await page.keyboard.press('Enter');
    const p = panel(page);

    // A screenshot from the clipboard: a card at the moment of the video, like a capture.
    await paste(page, { files: [{ name: 'image.png', type: 'image/png', picture: { width: 320, height: 180 } }] });
    await expect
      .poll(async () => (await storedNote(sw))?.markdown)
      .toMatch(/\[00:02\] !\[Image collée 00:02\]\(assets\/youtube-e2eTest0001-00-02-\w+\.png\)/);
    await expect(p.locator('.cm-boo-img img').first()).toHaveAttribute('src', /^data:image\/png;base64,/);

    // A video file: kept with the note, played in the panel, downloadable.
    const video = (await sampleVideo()).toString('base64');
    await paste(page, { files: [{ name: 'intro du cours.webm', type: 'video/webm', base64: video }] });
    await expect
      .poll(async () => (await storedNote(sw))?.markdown)
      .toMatch(/\[00:02\] \[🎬 intro du cours\.webm\]\(media\/youtube-e2eTest0001-file-intro-du-cours-\w+\.webm\)/);
    const media = await mediaRecords(sw);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'file', name: 'intro du cours.webm', mime: 'video/webm' });
    expect(media[0].size).toBe(Buffer.from(video, 'base64').length);
    await p.locator('.cm-content').press('Control+End');
    await page.keyboard.press('Enter');
    await p.locator('.cm-boo-media[data-kind="file"]').click();
    await expect(p.locator('.media-pop video')).toBeVisible();
    await expect(p.locator('.media-pop .mp-title')).toHaveText('intro du cours.webm');
    await expect(p.locator('.media-pop .mp-download')).toHaveAttribute('download', 'intro du cours.webm');
    await page.keyboard.press('Escape');

    // Formatted text (a web page, Notion, Docs…): Markdown, its pictures kept when the site allows it.
    await p.locator('.cm-content').press('Control+End');
    await paste(page, {
      text: 'Définition',
      html: `<meta charset="utf-8"><h2>Définition</h2><p>La <b>circulation</b> le long du bord, <a href="https://fr.wikipedia.org/wiki/Circulation">voir</a>.</p>
        <ul><li>premier point</li><li>second point</li></ul>
        <p><img src="data:image/png;base64,${PIXEL}" alt="Schéma"></p>
        <p><img src="https://images.example.test/fig.png" alt="Figure"></p>
        <p><img src="https://cdn.elsewhere.example/refused.png" alt="En ligne"></p>`,
    });
    await expect(p.locator('.notice')).toContainText('Collé avec 3 images (1 restée en ligne)');
    await expect.poll(async () => (await storedNote(sw))?.markdown).toContain('## Définition');
    const md = (await storedNote(sw))!.markdown;
    expect(md).toContain('## Définition\nLa **circulation** le long du bord, [voir](https://fr.wikipedia.org/wiki/Circulation).\n- premier point\n- second point\n');
    expect(md).toMatch(/!\[Schéma\]\(assets\/youtube-e2eTest0001-00-00-\w+\.png\)\n!\[Figure\]\(assets\/youtube-e2eTest0001-00-00-\w+\.png\)\n!\[En ligne\]\(https:\/\/cdn\.elsewhere\.example\/refused\.png\)/);

    // Plain text is pasted as usual, where the cursor is.
    await paste(page, { text: ' fin' });
    // The cursor is on the line after the pasted content.
    await expect.poll(async () => (await storedNote(sw))?.markdown).toMatch(/refused\.png\)\n fin$/);
  });

  test('glisser-déposer une image dans les notes ; un fichier non pris en charge est signalé', async ({ page, sw }) => {
    await openWatch(page);
    await openNotes(sw, page);
    await page.keyboard.type('Avant');
    // A picture dragged from the desktop onto the notes.
    await panelFrame(page).evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 120;
      canvas.getContext('2d')!.fillRect(0, 0, 200, 120);
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'schéma.png', { type: 'image/png' }));
      const line = document.querySelector('.cm-line') as HTMLElement;
      const r = line.getBoundingClientRect();
      line.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: r.right - 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => (await storedNote(sw))?.markdown).toMatch(/^\[00:00\] Avant\n\[00:00\] !\[schéma 00:00\]\(assets\/youtube-e2eTest0001-00-00-\w+\.png\)\n?$/);

    await paste(page, { files: [{ name: 'cours.pdf', type: 'application/pdf', base64: 'JVBERi0xLjQK' }] });
    await expect(panel(page).locator('.notice')).toContainText('Non collé : cours.pdf');
  });
});

test.describe('Copier depuis les notes', () => {
  test('une partie d’une note : images comprises vers les autres apps, telle quelle dans une autre note', async ({ context, page, sw }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openWatch(page);
    await setVideo(page, 3);
    await openNotes(sw, page);
    await page.keyboard.type('Introduction');
    await runCommand(sw, page, 'capture-screenshot');
    await expect.poll(async () => (await storedNote(sw))?.markdown).toMatch(/!\[Capture 00:03\]\(assets\//);
    const source = (await storedNote(sw))!.markdown;
    const asset = /\((assets\/[^)]+)\)/.exec(source)![1];

    // Copy (Ctrl+C): Markdown and HTML with the picture inside, moments linked to the video.
    const p = panel(page);
    await p.locator('.cm-content').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+C');
    const clip = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return { text: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() };
    });
    expect(clip.text).toContain('[00:03](https://www.youtube.com/watch?v=e2eTest0001#t=3) Introduction');
    expect(clip.text).toMatch(/!\[Capture 00:03\]\(data:image\/jpeg;base64,/);
    expect(clip.text).not.toContain('assets/');
    expect(clip.html).toMatch(/<img src="data:image\/jpeg;base64,/);

    // « Copier l’image » of the card: the picture itself.
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await p.locator('.cm-boo-img').first().hover();
    await p.getByRole('button', { name: 'Copier l’image' }).click();
    await expect(p.locator('.notice')).toContainText('Image copiée');
    const types = await page.evaluate(async () => (await navigator.clipboard.read())[0].types);
    expect(types).toContain('image/png');

    // Copied again, then pasted into the note of another video: same screenshot, moments of the first video.
    await p.locator('.cm-content').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+C');
    await openWatch(page, '', 'e2eOther0002');
    await openNotes(sw, page);
    await page.keyboard.press('Control+V');
    const other = 'youtube:e2eOther0002';
    await expect.poll(async () => (await storedNote(sw, other))?.markdown).toContain('[00:03](https://www.youtube.com/watch?v=e2eTest0001#t=3) Introduction');
    expect((await storedNote(sw, other))!.markdown).toContain(`![Capture 00:03](${asset})`);
    await expect(panel(page).locator('.cm-boo-img img').first()).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    // A moment of the other video opens it.
    const opened = context.waitForEvent('page');
    await panel(page).locator('.cm-content').press('Control+End');
    await panel(page).locator('.cm-boo-ts', { hasText: '00:03' }).first().click();
    expect((await opened).url()).toContain('v=e2eTest0001');
    expect(NOTE_ID).toBe('youtube:e2eTest0001');
  });
});
