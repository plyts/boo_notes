import type { Page, Worker } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, fulfillMedia, makeWav, NOTE_ID, openNotes, openWatch, panel, runCommand, setVideo, storedNote, test, videoPaused, videoTime } from './fixtures';

/**
 * Transcription: subtitles collected in the background (player track, the
 * platform's captions, the ones displayed on screen), translated and
 * commented in the « Transcription » tab, pinned into the note; passages
 * (02:05 → 06:07) with their card and recorded extract; the sound of the
 * course kept while it plays.
 */

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

type StoredTranscript = {
  source: string;
  lang: string;
  label: string;
  complete: boolean;
  covered: Array<[number, number]>;
  cues: Array<{ id: string; start: number; end: number; text: string; tr?: string; note?: string }>;
};

const transcript = (sw: Worker, noteId = NOTE_ID) =>
  sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], `transcript:${noteId}`) as Promise<StoredTranscript | undefined>;

/** Adds a WebVTT subtitles track to the fixture player. */
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

async function mediaRecords(sw: Worker): Promise<Array<{ path: string; kind: string; mime: string; start: number; end: number; size: number }>> {
  return sw.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('boo-notes-media', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('media', 'readonly');
          const all = tx.objectStore('media').getAll();
          all.onsuccess = () =>
            resolve((all.result as Array<Record<string, unknown>>).map(({ path, kind, mime, start, end, size }) => ({ path, kind, mime, start, end, size })) as never);
        };
      }),
  );
}

test.beforeEach(async ({ context }) => {
  await context.route('https://www.youtube.com/__fixtures/lesson.vtt', (route) =>
    route.fulfill({ contentType: 'text/vtt; charset=utf-8', body: VTT }),
  );
});

test.describe('Transcription', () => {
  test('sous-titres du lecteur : onglet Transcription, suivi, épingler, commenter, traduire à la main', async ({ page, sw }) => {
    await openWatch(page);
    await addTrack(page);
    await setVideo(page, 4);
    await openNotes(sw, page);
    const p = panel(page);

    // Collected in the background: the tab counts the lines, the notes are untouched.
    await expect(p.locator('#tab-transcript .tab-count')).toHaveText('4');
    await expect.poll(async () => (await transcript(sw))?.cues.length).toBe(4);
    const t = (await transcript(sw))!;
    expect(t).toMatchObject({ source: 'track', lang: 'en', complete: true, label: 'Sous-titres du lecteur · English' });
    expect((await storedNote(sw))?.markdown ?? '').toBe('');

    // Live strip under the notes: the line being spoken.
    await expect(p.locator('.live-caption .lc-text')).toHaveText('The circulation of F around the boundary');
    await expect(p.locator('.live-caption .lc-time')).toHaveText('00:03');

    // Ctrl+Maj+K quotes it in the note.
    await p.locator('.cm-content').click();
    await page.keyboard.press('Control+Shift+K');
    await expect.poll(async () => (await storedNote(sw))?.markdown).toContain('> [00:03] « The circulation of F around the boundary »');

    // Alt+T: the transcript, following the playback.
    await page.keyboard.press('Alt+T');
    await expect(p.locator('#tab-transcript')).toHaveAttribute('aria-selected', 'true');
    await expect(p.locator('.cue')).toHaveCount(4);
    await expect(p.locator('.cue.now .cue-text')).toHaveText('The circulation of F around the boundary');

    // A click on a time seeks the video.
    await p.locator('.cue', { hasText: 'Any questions?' }).locator('.cue-time').click();
    await expect.poll(() => videoTime(page)).toBeCloseTo(9, 0);
    await expect(p.locator('.cue.now .cue-text')).toHaveText('Any questions?');

    // Comment a line.
    const row = p.locator('.cue', { hasText: 'equals the flux' });
    await row.hover();
    await row.getByRole('button', { name: 'Commenter' }).click();
    await row.locator('textarea').fill('Stokes : orientation du bord !');
    await row.locator('textarea').press('Enter');
    await expect(row.locator('.cue-note')).toHaveText('Stokes : orientation du bord !');

    // Translate by hand (no on-device translator here).
    await row.hover();
    await row.getByRole('button', { name: 'Traduire' }).click();
    await expect(row.locator('.cue-tr')).toBeFocused();
    await page.keyboard.type('égale le flux de son rotationnel.');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await transcript(sw))?.cues.find((c) => c.text.startsWith('equals'))).toMatchObject({
      tr: 'égale le flux de son rotationnel.',
      note: 'Stokes : orientation du bord !',
    });

    // Pin a translated line: the quote carries the translation.
    await row.getByRole('button', { name: 'Épingler dans la note' }).click();
    await expect
      .poll(async () => (await storedNote(sw))?.markdown)
      .toContain('> [00:06] « equals the flux of its curl. » — *égale le flux de son rotationnel.*');

    // Search.
    await p.getByRole('button', { name: 'Rechercher dans la transcription' }).click();
    await p.getByRole('searchbox', { name: 'Rechercher dans la transcription' }).fill('orientation');
    await expect(p.locator('.cue:visible')).toHaveCount(1);
  });

  test('sous-titres affichés à l’écran : capture en direct pendant la lecture', async ({ page, sw }) => {
    await openWatch(page);
    // A player drawing its own captions (like YouTube), in step with the video.
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.className = 'ytp-caption-window-container';
      box.innerHTML = '<div class="caption-window"><span class="captions-text"><span class="caption-visual-line"></span></span></div>';
      document.getElementById('movie_player')!.append(box);
      const line = box.querySelector('.caption-visual-line') as HTMLElement;
      const script = [
        [0, 2, 'bonjour à tous'],
        [2, 4, 'aujourd’hui le théorème de Stokes'],
        [4, 7, 'la circulation le long du bord'],
      ] as const;
      const v = document.querySelector('video')!;
      setInterval(() => {
        const s = script.find(([a, b]) => v.currentTime >= a && v.currentTime < b);
        line.textContent = s ? s[2] : '';
      }, 100);
    });
    await setVideo(page, 0);
    await openNotes(sw, page);
    await page.evaluate(() => document.querySelector('video')!.play());
    await expect.poll(async () => (await transcript(sw))?.cues.map((c) => c.text), { timeout: 15_000 }).toEqual([
      'bonjour à tous',
      'aujourd’hui le théorème de Stokes',
      'la circulation le long du bord',
    ]);
    const t = (await transcript(sw))!;
    expect(t).toMatchObject({ source: 'live', complete: false });
    expect(t.cues[1].start).toBeGreaterThanOrEqual(1.5);
    expect(t.cues[1].start).toBeLessThan(3);
    await page.evaluate(() => document.querySelector('video')!.pause());
    await expect.poll(async () => (await transcript(sw))?.covered.length ?? 0).toBeGreaterThan(0);
    const p = panel(page);
    await p.locator('#tab-transcript').click();
    await expect(p.locator('.tx-label')).toContainText('capture en direct');
    await expect(p.locator('.tx-cover')).toContainText('% capturé');
  });

  test('sous-titres de la plateforme (YouTube) et traduction sur l’appareil', async ({ context, page, sw }) => {
    const watch = await readFile(fileURLToPath(new URL('./fixtures/watch.html', import.meta.url)), 'utf8');
    const tracks = JSON.stringify([
      { baseUrl: '/api/timedtext?v=e2eTest0001&lang=en&kind=asr', languageCode: 'en', kind: 'asr', name: { simpleText: 'anglais (générés automatiquement)' } },
    ]);
    await context.route(/^https:\/\/www\.youtube\.com\/watch/, (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: watch.replace('</body>', `<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":${tracks}}}};</script></body>`),
      }),
    );
    await context.route(/^https:\/\/www\.youtube\.com\/api\/timedtext/, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          events: [
            { tStartMs: 0, dDurationMs: 30000, id: 1 },
            { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'hello ' }, { utf8: 'everyone' }] },
            { tStartMs: 3000, dDurationMs: 3000, segs: [{ utf8: 'today we study Stokes' }] },
          ],
        }),
      }),
    );
    // Chrome's on-device translator, stubbed in the panel (the real one needs a model download).
    await context.addInitScript(() => {
      if (location.protocol !== 'chrome-extension:') return;
      const fr: Record<string, string> = { 'hello everyone': 'bonjour à tous', 'today we study Stokes': 'aujourd’hui, nous étudions Stokes' };
      Object.assign(globalThis, {
        Translator: {
          availability: async () => 'available',
          create: async () => ({ translate: async (text: string) => fr[text] ?? `[fr] ${text}` }),
        },
      });
    });
    await openWatch(page);
    await setVideo(page, 1.5);
    await openNotes(sw, page);
    await expect.poll(async () => (await transcript(sw))?.cues.length, { timeout: 10_000 }).toBe(2);
    expect(await transcript(sw)).toMatchObject({ source: 'platform', lang: 'en', label: 'Sous-titres YouTube · anglais (générés automatiquement)' });

    const p = panel(page);
    await page.keyboard.press('Alt+T');
    await p.getByRole('switch', { name: /Traduire en français/ }).click();
    await expect(p.getByRole('switch', { name: /Traduire en français/ })).toHaveAttribute('aria-checked', 'true');
    await expect(p.locator('.cue', { hasText: 'hello everyone' }).locator('.cue-tr')).toHaveText('bonjour à tous');
    await expect.poll(async () => (await transcript(sw))?.cues.map((c) => c.tr)).toEqual(['bonjour à tous', 'aujourd’hui, nous étudions Stokes']);
    await expect(p.locator('.tx-label')).toHaveAttribute('title', /anglais → français/);
    // The live strip shows the translation under the line.
    await page.keyboard.press('Alt+T');
    await expect(p.locator('.live-caption .lc-tr')).toHaveText('bonjour à tous');
  });

  test('fin de la vidéo : la transcription est épinglée à la note', async ({ page, sw }) => {
    await openWatch(page);
    await addTrack(page);
    await setVideo(page, 2);
    await openNotes(sw, page);
    await page.keyboard.type('Introduction');
    await expect(panel(page).locator('#tab-transcript .tab-count')).toHaveText('4');
    await setVideo(page, 29, true);
    await expect
      .poll(async () => (await storedNote(sw))?.markdown, { timeout: 10_000 })
      .toMatch(/\n\n📄 \[Transcription — anglais · 4 répliques\]\(transcripts\/youtube-e2eTest0001\.md\)\n?$/);
    // Rendered as an attachment; a click opens the transcript.
    await panel(page).locator('.cm-boo-transcript').click();
    await expect(panel(page).locator('#tab-transcript')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Passages', () => {
  test('Alt+I / Alt+O : carte du passage, extrait enregistré, revoir le passage', async ({ page, sw }) => {
    await openWatch(page);
    await addTrack(page);
    await setVideo(page, 2);
    await openNotes(sw, page);
    await page.keyboard.type('Avant le passage');
    await page.evaluate(() => document.querySelector('video')!.play());
    await page.keyboard.press('Alt+I');
    const p = panel(page);
    await expect(p.locator('.passage-btn')).toHaveAttribute('data-state', 'open');
    await expect(p.locator('.rec-pill')).toBeVisible();
    await expect(p.locator('.tl-pending')).toBeVisible();
    await page.waitForTimeout(3200);
    await page.keyboard.press('Alt+O');
    await expect
      .poll(async () => (await storedNote(sw))?.markdown, { timeout: 15_000 })
      .toMatch(/\n\[00:0[23]–00:0[56]\] !\[Passage 00:0[23]–00:0[56] · [^\]]+\]\(assets\/[^)]+\) \[Extrait\]\(media\/youtube-e2eTest0001-passage-00-0[23]-\w+\.webm\)/);
    const media = await mediaRecords(sw);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'passage', mime: 'video/webm' });
    expect(media[0].size).toBeGreaterThan(1000);

    // The card: range badge; a click replays the passage and stops at its end.
    await p.locator('.cm-content').press('Control+End');
    await page.keyboard.press('Enter');
    const card = p.locator('.cm-boo-img.cm-boo-passage');
    await expect(card.locator('.cm-boo-img-tc')).toHaveText(/00:0[23]–00:0[56]/);
    const end = Number(await card.getAttribute('data-end'));
    await card.click();
    await expect.poll(() => videoPaused(page), { timeout: 8000 }).toBe(true);
    expect(await videoTime(page)).toBeGreaterThanOrEqual(end - 0.1);
    expect(await videoTime(page)).toBeLessThan(end + 1);

    // The extract plays in the panel.
    await p.locator('.cm-boo-media').click();
    await expect(p.locator('.media-pop video')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(p.locator('.media-pop')).toBeHidden();
  });

  test('passage choisi dans la transcription, et intervalle [début–fin] cliquable', async ({ page, sw }) => {
    await openWatch(page);
    await addTrack(page);
    await setVideo(page, 1);
    await openNotes(sw, page);
    await page.keyboard.type('Stokes');
    const p = panel(page);
    await page.keyboard.press('Alt+T');
    await expect(p.locator('.cue')).toHaveCount(4);
    const first = p.locator('.cue', { hasText: 'The circulation' });
    await first.hover();
    await first.getByRole('button', { name: 'Début / fin d’un passage' }).click();
    const last = p.locator('.cue', { hasText: 'equals the flux' });
    await last.hover();
    await last.getByRole('button', { name: 'Début / fin d’un passage' }).click();
    await expect(p.locator('.tx-bar-text')).toHaveText('Passage 00:03–00:09 · 2 répliques');
    await p.getByLabel('Enregistrer l’extrait').uncheck();
    await p.getByRole('button', { name: 'Créer le passage' }).click();
    await expect
      .poll(async () => (await storedNote(sw))?.markdown, { timeout: 10_000 })
      .toContain('[00:03–00:09] ![Passage 00:03–00:09 · The circulation of F around the boundary](assets/');

    // A range typed by hand replays that stretch.
    await page.keyboard.press('Alt+T');
    await p.locator('.cm-content').press('Control+End');
    await page.keyboard.type('\n[00:10–00:12] conclusion');
    await p.locator('.cm-content').press('Control+Home');
    await p.locator('.cm-boo-ts[data-end="12"]').click();
    await expect.poll(() => videoPaused(page), { timeout: 8000 }).toBe(true);
    expect(await videoTime(page)).toBeGreaterThanOrEqual(11.9);
  });
});

test.describe('Copier et télécharger « tout compris »', () => {
  test('passage, capture, horodatages et transcription : dans le presse-papier et le dossier téléchargé', async ({ context, page, sw }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openWatch(page);
    await addTrack(page);
    await setVideo(page, 1);
    await openNotes(sw, page);
    await page.keyboard.type('Introduction');
    await expect(panel(page).locator('#tab-transcript .tab-count')).toHaveText('4');
    await page.evaluate(() => document.querySelector('video')!.play());
    await page.keyboard.press('Alt+I');
    await page.waitForTimeout(2500);
    await page.keyboard.press('Alt+O');
    await expect.poll(async () => (await storedNote(sw))?.markdown, { timeout: 15_000 }).toContain('[Extrait](media/');
    const p = panel(page);
    await p.locator('#tab-transcript').click();
    await p.getByRole('button', { name: 'Épingler la transcription à la note' }).click();
    await p.locator('#tab-notes').click();
    await expect.poll(async () => (await storedNote(sw))?.markdown).toContain('📄 [Transcription');

    await p.getByRole('button', { name: 'Exporter la note' }).click();
    await p.getByRole('menuitem', { name: /Copier la note/ }).click();
    await expect(p.locator('.notice')).toContainText('Note copiée avec 1 image');
    const clip = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return { text: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() };
    });
    // The passage card travels as a picture, its extract as a link replaying it at the source.
    expect(clip.text).toMatch(/\[00:0\d–00:0\d\]\(https:\/\/www\.youtube\.com\/watch\?v=e2eTest0001#t=\d\) !\[Passage [^\]]+\]\(data:image\/jpeg;base64,/);
    expect(clip.text).toMatch(/\[▶ Revoir le passage 00:0\d–00:0\d\]\(https:\/\/www\.youtube\.com\/watch\?v=e2eTest0001#t=\d\)/);
    expect(clip.text).toContain('## Transcription');
    expect(clip.text).toContain('[00:03](https://www.youtube.com/watch?v=e2eTest0001#t=3) The circulation of F around the boundary');
    expect(clip.text).not.toMatch(/\]\((assets|media|transcripts)\//);
    expect(clip.html).toContain('<h3>Transcription</h3>');
    expect(clip.html).toMatch(/<figure><img src="data:image\/jpeg;base64,/);

    // Downloaded: the note, its card, its recorded extract and its transcript (Markdown + WebVTT).
    await sw.evaluate(() => chrome.downloads.erase({}));
    await p.getByRole('button', { name: 'Exporter la note' }).click();
    await p.getByRole('menuitem', { name: /Télécharger/ }).click();
    await expect(p.locator('.notice')).toContainText('Téléchargé dans');
    const files = await sw.evaluate(async () => {
      for (let i = 0; i < 80; i++) {
        const items = await chrome.downloads.search({});
        if (items.length >= 5 && items.every((d) => d.state === 'complete')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return (await chrome.downloads.search({})).map((d) => ({ mime: d.mime, state: d.state, size: d.fileSize }));
    });
    // Playwright renames downloads: their types tell what was saved.
    expect(files.map((f) => f.mime).sort()).toEqual(['image/jpeg', 'text/markdown', 'text/markdown', 'text/vtt', 'video/webm']);
    expect(files.every((f) => f.state === 'complete' && f.size > 0)).toBe(true);
  });
});

test.describe('Piste audio du cours', () => {
  test('« Conserver l’audio » : le son est enregistré pendant la lecture, par segments', async ({ context, page, sw }) => {
    const wav = makeWav(30);
    await context.route(/^https:\/\/podcast\.example\.test\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/ep/2')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Épisode 2</title></head><body><h1>Épisode 2</h1><audio controls preload="auto" src="/ep2.wav"></audio></body></html>',
        });
      if (url.pathname === '/ep2.wav') return fulfillMedia(route, wav, 'audio/wav');
      return route.fulfill({ status: 404, body: '' });
    });
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...(settings as object), keepAudio: true } });
    });
    await page.goto('https://podcast.example.test/ep/2');
    await page.bringToFront();
    await runCommand(sw, page, 'toggle-sidebar');
    await expect(panel(page).locator('.cm-content')).toBeVisible();
    await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 2);
    await page.evaluate(() => document.querySelector('audio')!.play());
    await expect(panel(page).locator('.rec-pill')).toBeVisible();
    await page.waitForTimeout(3500);
    await page.evaluate(() => document.querySelector('audio')!.pause());
    await expect.poll(async () => (await mediaRecords(sw)).filter((m) => m.kind === 'audio').length, { timeout: 10_000 }).toBe(1);
    const [seg] = (await mediaRecords(sw)).filter((m) => m.kind === 'audio');
    expect(seg.path).toMatch(/^media\/web-podcast-example-test-ep-2-audio-00-00-\w+\.webm$/);
    expect(seg.mime).toBe('audio/webm');
    expect(seg.end - seg.start).toBeGreaterThan(2);
    await expect(panel(page).locator('.rec-pill')).toBeHidden();
    await expect(panel(page).locator('.tl-coverage span')).toHaveCount(1);
  });
});
