import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { editor, expect, importAndOpen, libraryJson, noteText, openNote, test } from './fixtures';

/**
 * Transcription in the app: subtitles next to a video become its
 * transcript (translated by hand, commented, pinned); passages of the video
 * (Alt+I / Alt+O, or chosen in the transcript) with their card and recorded
 * extract; a browser note's transcript, read-only.
 */

const SAMPLE = fileURLToPath(new URL('../../../tests/e2e/fixtures/sample.webm', import.meta.url));
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

async function setVideo(page: import('@playwright/test').Page, time: number, play = false): Promise<void> {
  await page.evaluate(
    async ({ time, play }) => {
      const v = document.querySelector('video') as HTMLVideoElement;
      v.pause();
      if (Math.abs(v.currentTime - time) > 0.01) {
        const seeked = new Promise((r) => v.addEventListener('seeked', r, { once: true }));
        v.currentTime = time;
        await seeked;
      }
      if (play) await v.play();
    },
    { time, play },
  );
}

const videoTime = (page: import('@playwright/test').Page) => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);

test('sous-titres à côté de la vidéo : transcription, commentaire, épingle, passages', async ({ ctx }) => {
  const video = join(ctx.dir, 'Cours 7.webm');
  await copyFile(SAMPLE, video);
  await writeFile(join(ctx.dir, 'Cours 7.en.vtt'), VTT);
  const { app, page } = await ctx.launch();
  await importAndOpen(page, [video], 'Cours 7');
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);

  // The subtitles file became the transcript.
  const tab = page.getByRole('tab', { name: /Transcription/ });
  await expect(tab.locator('.tab-count')).toHaveText('4');
  await setVideo(page, 4);
  await tab.click();
  await expect(page.locator('.cue')).toHaveCount(4);
  await expect(page.locator('.tx-label')).toHaveText('Fichier de sous-titres · Cours 7.en.vtt');
  await expect(page.locator('.cue.now .cue-text')).toHaveText('The circulation of F around the boundary');

  // A click on a time seeks the video.
  await page.locator('.cue', { hasText: 'Any questions?' }).locator('.cue-time').click();
  await expect.poll(() => videoTime(page)).toBeGreaterThanOrEqual(8.9);

  // Translate by hand and comment.
  const row = page.locator('.cue', { hasText: 'equals the flux' });
  await row.hover();
  await row.getByRole('button', { name: 'Traduire' }).click();
  await page.keyboard.type('égale le flux de son rotationnel.');
  await page.keyboard.press('Enter');
  await row.hover();
  await row.getByRole('button', { name: 'Commenter' }).click();
  await row.locator('textarea').fill('Orientation du bord !');
  await row.locator('textarea').press('Enter');
  await expect
    .poll(async () => readFile(join(ctx.vault, 'transcripts', (await readdir(join(ctx.vault, 'transcripts'))).find((f) => f.endsWith('.md'))!), 'utf8'))
    .toContain('[00:06] equals the flux of its curl.\n*égale le flux de son rotationnel.*\n💬 Orientation du bord !');

  // Pin the line into the note: its translation comes along.
  await row.hover();
  await row.getByRole('button', { name: 'Épingler dans la note' }).click();
  await expect.poll(() => noteText(ctx.vault, 'Cours 7')).toContain('> [00:06] « equals the flux of its curl. » — *égale le flux de son rotationnel.*');

  // A passage chosen in the transcript (no recording): card in the note.
  const first = page.locator('.cue', { hasText: 'The circulation' });
  await first.hover();
  await first.getByRole('button', { name: 'Début / fin d’un passage' }).click();
  await row.hover();
  await row.getByRole('button', { name: 'Début / fin d’un passage' }).click();
  await expect(page.locator('.tx-bar-text')).toHaveText('Passage 00:03–00:09 · 2 répliques · 1 note');
  await page.getByLabel('Enregistrer l’extrait').uncheck();
  await page.getByRole('button', { name: 'Créer le passage' }).click();
  await expect
    .poll(() => noteText(ctx.vault, 'Cours 7'))
    .toMatch(/\[00:03–00:09\] !\[Passage 00:03–00:09 · The circulation of F around the boundary\]\(assets\/[^)]+\.jpg\)/);

  // Pin the whole transcript at the end of the note.
  await page.getByRole('button', { name: 'Épingler la transcription à la note' }).click();
  await expect.poll(() => noteText(ctx.vault, 'Cours 7')).toMatch(/📄 \[Transcription — anglais → français · 4 répliques\]\(transcripts\/[^)]+\.md\)\n?$/);

  // Alt+I / Alt+O while the video plays: the passage and its recorded extract.
  await page.getByRole('tab', { name: 'Notes' }).click();
  await editor(page).click();
  await setVideo(page, 12, true);
  // The line being said, under the notes (as in the browser panel).
  await expect(page.locator('.live-caption .lc-text')).toHaveText('Any questions?');
  await page.keyboard.press('Alt+I');
  await expect(page.getByRole('button', { name: /Terminer le passage/ })).toBeVisible();
  await page.waitForTimeout(3000);
  await page.keyboard.press('Alt+O');
  await expect.poll(() => noteText(ctx.vault, 'Cours 7'), { timeout: 15_000 }).toMatch(/\[00:1[23]–00:1[56]\] !\[Passage [^\]]+\]\(assets\/[^)]+\) \[Extrait\]\(media\/[^)]+\.webm\)/);
  // Both passages on the player's scrubber, and in the note's counters.
  await expect(page.locator('.scrub-range')).toHaveCount(2);
  await expect(page.locator('.notes-stats')).toContainText('2 passages');
  const lib = await libraryJson(ctx.vault);
  const noteId = Object.values(lib.notes).find((n) => n.title === 'Cours 7').id;
  const media = (lib as unknown as { media: Record<string, Array<{ path: string; size: number; kind: string }>> }).media[noteId];
  expect(media).toHaveLength(1);
  expect(media[0].kind).toBe('passage');
  expect((await readFile(join(ctx.vault, media[0].path))).length).toBe(media[0].size);

  // The card replays the passage and stops at its end; the extract plays over the notes.
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  const card = page.locator('.cm-boo-img.cm-boo-passage').last();
  const end = Number(await card.getAttribute('data-end'));
  await card.click();
  await expect.poll(() => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).paused), { timeout: 8000 }).toBe(true);
  expect(await videoTime(page)).toBeGreaterThanOrEqual(end - 0.1);
  await page.locator('.cm-boo-media').click();
  await expect(page.locator('.media-pop video')).toBeVisible();
  await page.getByRole('button', { name: 'Fermer l’extrait' }).click();
  await expect(page.locator('.media-pop')).toHaveCount(0);

  // « Copier la note »: Markdown and HTML, pictures embedded, transcript included.
  await page.getByRole('button', { name: /^Copier la note/ }).click();
  await expect(page.locator('.toast').last()).toContainText('Note copiée avec 2 images');
  const clip = await app.evaluate(async ({ clipboard }) => {
    const [item] = await clipboard.read();
    const read = async (type: string) => ((await item.getType(type)) as Blob).text();
    return { text: await read('text/plain'), html: await read('text/html') };
  });
  expect(clip.text).toMatch(/^# Cours 7\n/);
  expect(clip.text).toMatch(/!\[Passage 00:03–00:09 · The circulation of F around the boundary\]\(data:image\/jpeg;base64,/);
  expect(clip.text).toContain('> [00:06] « equals the flux of its curl. » — *égale le flux de son rotationnel.*');
  expect(clip.text).toContain('## Transcription');
  expect(clip.text).toContain('💬 Orientation du bord !');
  expect(clip.text).not.toMatch(/\]\((assets|media|transcripts)\//);
  expect(clip.html).toMatch(/<img src="data:image\/jpeg;base64,/);
  expect(clip.html).toContain('<h3>Transcription</h3>');
});

test('note du navigateur : la transcription synchronisée se lit dans l’app', async ({ ctx }) => {
  const { page } = await ctx.launch();
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}`, { origin: 'chrome-extension://abcdefghijklmnop' });
  await new Promise((r) => ws.once('open', r));
  const acks: Array<Record<string, unknown>> = [];
  ws.on('message', (raw) => acks.push(JSON.parse(String(raw))));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'TEST-TOKN-ABCD-EFGH' }));
  ws.send(
    JSON.stringify({
      type: 'note.upsert',
      note: {
        id: 'youtube:stokes00001',
        platform: 'youtube',
        kind: 'video',
        url: 'https://www.youtube.com/watch?v=stokes00001',
        title: 'Théorème de Stokes',
        markdown: '[00:05] Définition\n\n📄 [Transcription — anglais → français · 2 répliques](transcripts/youtube-stokes00001.md)',
        createdAt: 1,
        updatedAt: Date.now(),
        rev: 1,
      },
    }),
  );
  ws.send(
    JSON.stringify({
      type: 'transcript.put',
      transcript: {
        noteId: 'youtube:stokes00001',
        lang: 'en',
        label: 'Sous-titres YouTube · anglais',
        source: 'platform',
        target: 'fr',
        complete: true,
        covered: [],
        duration: 600,
        cues: [
          { id: 'c500', start: 5, end: 8, text: 'Stokes’ theorem', tr: 'Le théorème de Stokes' },
          { id: 'c800', start: 8, end: 12, text: 'relates circulation and flux', note: 'À savoir par cœur' },
        ],
        updatedAt: Date.now(),
        rev: 3,
      },
    }),
  );
  await expect.poll(() => acks.some((m) => m.type === 'transcript.ack')).toBe(true);
  await openNote(page, 'Théorème de Stokes');
  // The attachment line opens the transcript.
  await page.locator('.cm-boo-transcript').click();
  await expect(page.locator('.transcript[data-readonly="true"] .cue')).toHaveCount(2);
  await expect(page.locator('.cue', { hasText: 'Stokes’ theorem' }).locator('.cue-tr')).toHaveText('Le théorème de Stokes');
  await expect(page.locator('.cue', { hasText: 'relates' }).locator('.cue-note')).toHaveText('À savoir par cœur');
  // Browser notes are annotated in the extension: no editing here.
  await expect(page.locator('.cue-act[data-act="comment"]').first()).toBeHidden();
  ws.close();
});

test('fin de la vidéo : la transcription est épinglée à la note', async ({ ctx }) => {
  const video = join(ctx.dir, 'Cours 9.webm');
  await copyFile(SAMPLE, video);
  await writeFile(join(ctx.dir, 'Cours 9.vtt'), VTT);
  const { page } = await ctx.launch();
  await importAndOpen(page, [video], 'Cours 9');
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);
  await editor(page).click();
  await page.keyboard.type('Introduction');
  await expect(page.getByRole('tab', { name: /Transcription/ }).locator('.tab-count')).toHaveText('4');
  await setVideo(page, 29, true);
  await expect.poll(() => noteText(ctx.vault, 'Cours 9'), { timeout: 10_000 }).toMatch(/📄 \[Transcription — sous-titres · 4 répliques\]\(transcripts\/[^)]+\.md\)\n?$/);
});

