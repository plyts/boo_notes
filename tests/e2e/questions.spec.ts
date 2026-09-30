import type { FrameLocator, Page, Worker } from '@playwright/test';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, NOTE_ID, openNotes, openWatch, panel, runCommand, setVideo, storedNote, test, videoPaused, videoTime } from './fixtures';

/**
 * + beside the line under the mouse › Question or Note libre: a question is
 * numbered and answered from the course (its transcript first, the page, the
 * notes), with its sources and clickable moments; a free note is personal
 * (no timestamp, captures and quotes go in it). The video plays on all along.
 */

const CUES = [
  { start: 1, text: 'Welcome to this lesson about deployment.' },
  { start: 5, text: 'Model Serving deploys the agent behind a REST endpoint.' },
  { start: 9, text: 'It scales automatically with the traffic.' },
  { start: 14, text: 'This method works because the gradients stay bounded.' },
  { start: 20, text: 'Monitoring collects every request in an inference table.' },
];

/** The transcript of the video, as collected while it played. */
async function seedTranscript(sw: Worker): Promise<void> {
  await sw.evaluate(
    async ({ key, cues }) => {
      await chrome.storage.local.set({
        [key]: {
          lang: 'en',
          label: 'Sous-titres du lecteur · English',
          source: 'track',
          target: 'fr',
          complete: true,
          covered: [[0, 30]],
          duration: 30,
          cues: cues.map((c) => ({ id: `c${c.start * 1000}`, start: c.start, end: c.start + 3.5, text: c.text })),
          rev: 1,
        },
      });
    },
    { key: `transcript:${NOTE_ID}`, cues: CUES },
  );
}

const line = (p: FrameLocator, text: string) => p.locator('.cm-line', { hasText: text });

/** Mouse over the line, then its + › the menu item. */
async function turnInto(p: FrameLocator, text: string, item: 'Question' | 'Note libre' | 'Note normale' | 'Chercher à nouveau'): Promise<void> {
  await line(p, text).first().hover();
  const handle = p.locator('.boo-block-handle.visible');
  await expect(handle).toBeVisible();
  await handle.click();
  await p.locator('.boo-block-menu').getByRole(item === 'Question' || item === 'Note libre' ? 'menuitemradio' : 'menuitem', { name: new RegExp(`^${item}`) }).click();
}

const markdown = async (sw: Worker) => (await storedNote(sw))?.markdown ?? '';

async function playing(page: Page): Promise<void> {
  await setVideo(page, 1, true);
  await expect.poll(() => videoPaused(page)).toBe(false);
}

test('survol d’une ligne : le + n’apparaît que là, et son menu propose Question ou Note libre', async ({ page, sw }) => {
  await openWatch(page);
  await openNotes(sw, page);
  const p = panel(page);
  await page.keyboard.type('Le professeur explique la différence entre X et Y.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Pourquoi cette méthode fonctionne-t-elle ?');
  // Not there by itself: only under the mouse.
  await expect(p.locator('.boo-block-handle.visible')).toHaveCount(0);
  await line(p, 'Pourquoi cette méthode').hover();
  await expect(p.locator('.boo-block-handle.visible')).toBeVisible();
  const box = await line(p, 'Pourquoi cette méthode').boundingBox();
  const handle = await p.locator('.boo-block-handle').boundingBox();
  // Beside the line hovered.
  expect(Math.abs(handle!.y + handle!.height / 2 - (box!.y + box!.height / 2))).toBeLessThan(12);
  expect(handle!.x).toBeLessThan(box!.x + 12);
  // Typing: it steps aside.
  await page.keyboard.type(' ');
  await expect(p.locator('.boo-block-handle.visible')).toHaveCount(0);
  await line(p, 'Pourquoi cette méthode').hover();
  await p.locator('.boo-block-handle.visible').click();
  const menu = p.locator('.boo-block-menu');
  await expect(menu.getByRole('menuitemradio')).toHaveText([/^Question/, /^Note libre/]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('+ › Question : numérotée, réponse cherchée dans la transcription, horodatage cliquable, la vidéo continue', async ({ page, sw }) => {
  await seedTranscript(sw);
  await openWatch(page);
  await playing(page);
  await openNotes(sw, page);
  const p = panel(page);
  await page.keyboard.type('Pourquoi les gradients restent-ils bornés ?');
  await turnInto(p, 'gradients restent', 'Question');
  // Numbered, the moment it was asked kept in its header.
  await expect.poll(() => markdown(sw)).toMatch(/^> \[!question\] Question 1 · \[00:0\d\]\n> Pourquoi les gradients restent-ils bornés \?/);
  // No AI set: the closest passages of the course, the moment of each one.
  await expect.poll(() => markdown(sw), { timeout: 10_000 }).toContain('> **Réponse — passages du cours les plus proches (sans IA) :**');
  const md = await markdown(sw);
  // The subtitle that says it (and the next one, it is short), not the whole transcript.
  expect(md).toContain('> **Source du cours — [00:14]**\n> « This method works because the gradients stay bounded. Monitoring collects every request in an inference table. »');
  expect(md).not.toContain('Welcome to this lesson');
  expect(await videoPaused(page)).toBe(false);
  // Shown as a block: « Question 1 », the answer, a clickable moment.
  await page.keyboard.press('Control+End');
  await expect(p.locator('.cm-boo-badge-question')).toHaveText('Question 1');
  await p.locator('.cm-boo-ts[data-t="14"]').click();
  await expect.poll(() => videoTime(page)).toBeGreaterThanOrEqual(14);
  await expect.poll(() => videoTime(page)).toBeLessThan(16.5);
});

test('+ › Note libre : ni horodatage ni réponse ; la capture s’y range sans horodatage, la vidéo continue', async ({ page, sw }) => {
  await openWatch(page);
  await playing(page);
  await openNotes(sw, page);
  const p = panel(page);
  await page.keyboard.type('Cette partie me fait penser au cours 2.');
  // Written during the video: stamped, as any line.
  await expect.poll(() => markdown(sw)).toMatch(/^\[00:0\d\] Cette partie/);
  await turnInto(p, 'Cette partie', 'Note libre');
  // Not tied to the video any more.
  await expect.poll(() => markdown(sw)).toBe('> [!note] Note libre\n> Cette partie me fait penser au cours 2.');
  // Writing goes on in the free note, never stamped.
  await page.keyboard.press('Enter');
  await page.keyboard.type('Réflexion personnelle.');
  await expect.poll(() => markdown(sw)).toBe('> [!note] Note libre\n> Cette partie me fait penser au cours 2.\n> Réflexion personnelle.');
  // Enter on its empty last line: out of it, writing goes on as a normal (stamped) note.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Suite du cours.');
  await expect.poll(() => markdown(sw)).toMatch(/^> \[!note\] Note libre\n> Cette partie me fait penser au cours 2\.\n> Réflexion personnelle\.\n\n\[00:\d\d\] Suite du cours\.$/);
  // Back in the free note: a capture goes into it, without the moment of the video.
  await line(p, 'Réflexion personnelle').click();
  await page.keyboard.press('End');
  await runCommand(sw, page, 'capture-screenshot');
  await expect
    .poll(() => markdown(sw))
    .toMatch(/^> \[!note\] Note libre\n> Cette partie me fait penser au cours 2\.\n> Réflexion personnelle\.\n> !\[Capture\]\(assets\/[^)]+\)\n\n\[00:\d\d\] Suite du cours\.$/);
  expect(await videoPaused(page)).toBe(false);
  // Back to a normal note: its text stays.
  await turnInto(p, 'Réflexion personnelle', 'Note normale');
  await expect.poll(() => markdown(sw)).toMatch(/^Cette partie me fait penser au cours 2\.\nRéflexion personnelle\.\n!\[Capture\]\(assets\/[^)]+\)\n\n\[00:\d\d\] Suite du cours\.$/);
});

test('texte de la page cité pendant la lecture, dans la note libre ; la vidéo continue', async ({ page, sw }) => {
  await openWatch(page);
  // The lesson's text beside the video.
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'lesson-text';
    p.textContent = 'Le théorème de Stokes relie la circulation d’un champ le long du bord au flux de son rotationnel.';
    document.querySelector('ytd-watch-metadata')!.append(p);
  });
  await playing(page);
  await openNotes(sw, page);
  const p = panel(page);
  await page.keyboard.type('À relier au cours 2.');
  await turnInto(p, 'relier au cours', 'Note libre');
  // The text selected in the page with the mouse: the « Citer » bubble, then (Alt+Shift+T) the quote in the free note.
  const box = (await page.locator('#lesson-text').boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#boo-notes-overlay .quote-bubble')).toBeVisible();
  await runCommand(sw, page, 'insert-timestamp');
  await expect
    .poll(() => markdown(sw))
    .toMatch(/^> \[!note\] Note libre\n> À relier au cours 2\.\n> > Le théorème de Stokes relie la circulation d’un champ le long du bord au flux de son rotationnel\. \[↗\]\(https:\/\/www\.youtube\.com\/watch\?v=e2eTest0001#:~:text=/);
  expect(await videoPaused(page)).toBe(false);
});

/** A stand-in for the Claude API: answers from the passage that speaks of gradients. */
async function mockClaude(): Promise<{ base: string; requests: Array<{ path: string; headers: IncomingMessage['headers']; body: string }>; close(): Promise<void> }> {
  const requests: Array<{ path: string; headers: IncomingMessage['headers']; body: string }> = [];
  const server = createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      if (req.headers['x-api-key'] !== 'sk-ant-test') {
        res.writeHead(401, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'invalid x-api-key' } }));
        return;
      }
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'model-newest', display_name: 'Modèle récent' }, { id: 'model-older', display_name: 'Modèle ancien' }] }));
        return;
      }
      const prompt = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0].content;
      const id = /\[(T\d+)\][^\n]*gradients/.exec(prompt)?.[1] ?? 'T1';
      const text = JSON.stringify({ answer: 'Parce que les gradients restent bornés : la méthode reste stable.', found: true, sources: [{ id, quote: 'the gradients stay bounded' }] });
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ content: [{ type: 'text', text }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

test('Claude répond : réponse rédigée, sources citées, questions numérotées dans l’ordre de la note', async ({ page, sw }) => {
  const claude = await mockClaude();
  try {
    await seedTranscript(sw);
    await sw.evaluate(async (base) => chrome.storage.local.set({ 'qa:config': { provider: 'claude', key: 'sk-ant-test', model: 'model-newest', base } }), claude.base);
    await openWatch(page);
    // The course's text beside the video: a source too.
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.textContent = 'Model Serving expose un agent derrière un point de terminaison REST, avec mise à l’échelle automatique.';
      document.querySelector('ytd-watch-metadata')!.append(p);
    });
    await playing(page);
    await openNotes(sw, page);
    const p = panel(page);
    await page.keyboard.type('Qu’est-ce que Model Serving ?');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Pourquoi cette méthode fonctionne-t-elle dans ce cas ?');
    await turnInto(p, 'Pourquoi cette méthode', 'Question');
    await expect.poll(() => markdown(sw), { timeout: 10_000 }).toContain('> **Réponse :** Parce que les gradients restent bornés : la méthode reste stable.');
    const md = await markdown(sw);
    expect(md).toMatch(/^\[00:0\d\] Qu’est-ce que Model Serving \?\n\n> \[!question\] Question 1 · \[00:0\d\]\n> Pourquoi cette méthode/);
    expect(md).toContain('> **Source du cours — [00:14]**\n> « the gradients stay bounded »');
    // The key and the question went to the API, with the transcript.
    const [req] = claude.requests.filter((r) => r.path === '/v1/messages');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    const sent = JSON.parse(req.body) as { model: string; messages: Array<{ content: string }> };
    expect(sent.model).toBe('model-newest');
    expect(sent.messages[0].content).toContain('Question : Pourquoi cette méthode fonctionne-t-elle dans ce cas ?');
    expect(sent.messages[0].content).toContain('This method works because the gradients stay bounded.');
    expect(sent.messages[0].content).toMatch(/\[P\d+\][^\n]*Model Serving expose un agent derrière un point de terminaison REST/);
    expect(await videoPaused(page)).toBe(false);

    // The line above made a question from the keyboard (Ctrl + .): it becomes Question 1, the other one Question 2.
    await line(p, 'Model Serving ?').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+.');
    await p.locator('.boo-block-menu').getByRole('menuitemradio', { name: /^Question/ }).click();
    await expect.poll(() => markdown(sw)).toMatch(/^> \[!question\] Question 1 · \[00:0\d\]\n> Qu’est-ce que Model Serving \?\n/);
    // Its answer under it, then the other question — still apart from it (a blank line between the blocks).
    await expect.poll(() => markdown(sw)).toMatch(/> Qu’est-ce que Model Serving \?\n>\n> \*\*Réponse :\*\*[^\n]*\n[\s\S]*»\n\n> \[!question\] Question 2 · \[00:0\d\]\n> Pourquoi cette méthode/);
  } finally {
    await claude.close();
  }
});

test('options › Questions : Claude choisi, sa clé vérifiée, le modèle le plus récent pris, puis la clé retirée', async ({ context, sw }) => {
  const claude = await mockClaude();
  try {
    await sw.evaluate(async (base) => chrome.storage.local.set({ 'qa:config': { provider: 'chrome', key: '', model: '', base } }), claude.base);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html#questions`);
    const qa = () => options.evaluate(async () => (await chrome.storage.local.get('qa:config'))['qa:config'] as { provider: string; key: string; model: string });
    // Chrome's built-in AI by default: its state said (the test browser has the API, not the model).
    await expect(options.getByRole('radio', { name: 'IA de Chrome' })).toBeChecked();
    await expect(options.locator('#chrome-ai-state')).toContainText(/Absente de ce navigateur|Indisponible sur cet ordinateur|pas encore sur cet ordinateur/);
    await expect(options.locator('#qa-claude-card')).toBeHidden();
    // Claude: its key first.
    await options.getByText('Claude', { exact: true }).click();
    await expect(options.locator('#qa-badge')).toHaveText('Claude : ajoutez votre clé');
    expect((await qa()).provider).toBe('chrome');
    // A wrong key: said so, nothing kept.
    await options.locator('#qa-key').fill('sk-ant-wrong');
    await options.getByRole('button', { name: 'Vérifier et activer' }).click();
    await expect(options.locator('#saved')).toContainText('clé API Claude refusée');
    expect((await qa()).provider).toBe('chrome');
    // The right one: the models it may use, the most recent chosen.
    await options.locator('#qa-key').fill('sk-ant-test');
    await options.getByRole('button', { name: 'Vérifier et activer' }).click();
    await expect(options.locator('#qa-badge')).toHaveText('Claude activé');
    await expect(options.locator('#qa-model option')).toHaveText(['Modèle récent', 'Modèle ancien']);
    expect(await qa()).toMatchObject({ provider: 'claude', key: 'sk-ant-test', model: 'model-newest' });
    await options.locator('#qa-model').selectOption('model-older');
    await expect.poll(async () => (await qa()).model).toBe('model-older');
    // « Sans IA », then back to Claude: the key is kept meanwhile.
    await options.getByText('Sans IA', { exact: true }).click();
    await expect.poll(async () => (await qa()).provider).toBe('none');
    await options.getByText('Claude', { exact: true }).click();
    await expect.poll(async () => (await qa()).provider).toBe('claude');
    await options.getByRole('button', { name: 'Retirer' }).click();
    await expect(options.getByRole('radio', { name: 'IA de Chrome' })).toBeChecked();
    expect(await qa()).toMatchObject({ provider: 'chrome', key: '' });
  } finally {
    await claude.close();
  }
});

/**
 * Chrome's built-in AI (the Prompt API), stood in for in the extension's
 * pages: the test browser has no model. `fr`: it writes French (else
 * English, translated by Chrome's translator); `state`: whether its model is
 * already on the computer.
 */
async function stubChromeAi(context: import('@playwright/test').BrowserContext, o: { fr: boolean; state?: 'available' | 'downloadable' }): Promise<void> {
  await context.addInitScript((o) => {
    if (location.protocol !== 'chrome-extension:') return;
    type Opts = { expectedOutputs?: Array<{ languages?: string[] }>; initialPrompts?: Array<{ content: string }>; monitor?(m: EventTarget): void };
    let state = o.state ?? 'available';
    const LanguageModel = {
      async availability(opts?: Opts) {
        if (opts?.expectedOutputs?.[0]?.languages?.[0] === 'fr' && !o.fr) return 'unavailable';
        return state;
      },
      async create(opts?: Opts) {
        if (opts?.monitor) {
          const target = new EventTarget();
          opts.monitor(target);
          for (const loaded of [0, 0.5, 1]) target.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded }));
        }
        state = 'available';
        const system = opts?.initialPrompts?.[0]?.content ?? '';
        return {
          inputQuota: 6000,
          inputUsage: 50,
          async measureInputUsage(t: string) {
            return Math.ceil(t.length / 4);
          },
          async prompt(input: string) {
            const id = /\[(T\d+)\][^\n]*gradients/.exec(input)?.[1] ?? 'T1';
            const answer = system.startsWith('You are') ? 'Because the gradients stay bounded.' : 'Parce que les gradients restent bornés (IA de Chrome).';
            return JSON.stringify({ answer, found: true, sources: [{ id, quote: 'the gradients stay bounded' }] });
          },
          destroy() {},
        };
      },
    };
    Object.defineProperty(globalThis, 'LanguageModel', { value: LanguageModel, configurable: true });
    const Translator = {
      async availability() {
        return 'available';
      },
      async create(opts: { sourceLanguage: string }) {
        return {
          async translate(t: string) {
            return opts.sourceLanguage === 'en' && t === 'Because the gradients stay bounded.' ? 'Parce que les gradients restent bornés (traduit).' : t;
          },
          destroy() {},
        };
      },
    };
    Object.defineProperty(globalThis, 'Translator', { value: Translator, configurable: true });
  }, o);
}

for (const fr of [true, false]) {
  test(`IA intégrée de Chrome (${fr ? 'écrit le français' : 'écrit l’anglais, traduite'}) : réponse rédigée sur l’appareil, sans clé`, async ({ context, page, sw }) => {
    await stubChromeAi(context, { fr });
    await seedTranscript(sw);
    await openWatch(page);
    await playing(page);
    await openNotes(sw, page);
    const p = panel(page);
    await page.keyboard.type('Pourquoi les gradients restent-ils bornés ?');
    await turnInto(p, 'gradients restent', 'Question');
    await expect
      .poll(() => markdown(sw), { timeout: 10_000 })
      .toContain(`> **Réponse :** Parce que les gradients restent bornés (${fr ? 'IA de Chrome' : 'traduit'}).`);
    expect(await markdown(sw)).toContain('> **Source du cours — [00:14]**\n> « the gradients stay bounded »');
    expect(await videoPaused(page)).toBe(false);
  });
}

test('options › Questions : le modèle de l’IA de Chrome téléchargé d’un clic, sa progression affichée', async ({ context, sw }) => {
  await stubChromeAi(context, { fr: true, state: 'downloadable' });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html#questions`);
  await expect(options.locator('#chrome-ai-state')).toContainText('pas encore sur cet ordinateur');
  await options.getByRole('button', { name: 'Télécharger le modèle' }).click();
  await expect(options.locator('#chrome-ai-state')).toContainText('Prête');
  await expect(options.getByRole('button', { name: 'Télécharger le modèle' })).toBeHidden();
});
