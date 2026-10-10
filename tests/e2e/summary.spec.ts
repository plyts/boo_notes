import type { Page, Worker } from '@playwright/test';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, NOTE_ID, openNotes, openWatch, panel, storedNote, test, videoTime } from './fixtures';

/**
 * « Résumé »: the lesson's whole transcript, and every lesson of its course,
 * summarised by the AI chosen in the options — here a free-tier service
 * speaking the OpenAI API (Groq, OpenRouter, Gemini, Mistral, Cerebras…),
 * stood in for by a local server: problem, goals, solution and the course
 * as a hierarchy, each moment clickable; inserted at the top of the note;
 * the course's page, large.
 */

const CUES = [
  { start: 0, text: 'Welcome. Today we look at Delta Lake transactions.' },
  { start: 3, text: 'On a plain data lake, two jobs writing at once can corrupt a table.' },
  { start: 7, text: 'So how do we get database reliability on simple files?' },
  { start: 11, text: 'Delta Lake adds a transaction log next to the Parquet files.' },
  { start: 15, text: 'Every write is a commit, a numbered JSON file.' },
  { start: 19, text: 'Readers only see complete commits, so writes are atomic.' },
  { start: 23, text: 'And with the history you can read any older version: time travel.' },
];

type Req = { path: string; headers: IncomingMessage['headers']; body: string };

/** A free-tier service speaking the OpenAI API: its models, and replies drawn from what it is shown. */
async function mockOpenAi(opts: { limitFirst?: boolean } = {}): Promise<{ base: string; requests: Req[]; close(): Promise<void> }> {
  const requests: Req[] = [];
  let chats = 0;
  const server = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      const json = (status: number, data: unknown, extra: Record<string, string> = {}) => res.writeHead(status, { ...cors, 'content-type': 'application/json', ...extra }).end(JSON.stringify(data));
      if (req.headers.authorization !== 'Bearer gsk_test') return json(401, { error: { message: 'Invalid API Key' } });
      if (req.url?.endsWith('/models')) return json(200, { data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.1-8b-instant' }, { id: 'llama-3.3-70b-versatile' }] });
      if (opts.limitFirst && chats++ === 0) return json(429, { error: { message: 'Rate limit reached for model on tokens per minute (TPM). Please try again in 1s.' } });
      const { messages } = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const system = messages[0].content;
      const user = messages[1].content;
      let reply: unknown;
      if (system.includes('Voici un cours entier')) {
        const ids = [...user.matchAll(/^### (L\d+) · /gm)].map((m) => m[1]);
        reply = {
          problem: 'Les données arrivent en masse : comment construire des pipelines fiables sans empiler un data lake et un entrepôt ?',
          goals: [
            { text: 'Comprendre le lakehouse', chapter: '1' },
            { text: 'Fiabiliser les tables avec Delta Lake', chapter: '2' },
          ],
          solution: 'Un lakehouse : le stockage objet, plus Delta Lake pour les transactions et l’historique.',
          chapters: [
            { id: '1', synthesis: 'Pourquoi un lakehouse.' },
            { id: '2', synthesis: 'Rendre un stockage de fichiers aussi sûr qu’une base de données.' },
          ],
          lessons: ids.map((id) => ({ id, synthesis: `Synthèse de ${id}.` })),
        };
      } else {
        // Cites the line that says it (the transcript's lines: `[c2 00:15] …`).
        const lines = [...user.matchAll(/^\[(c\d+) \d\d:\d\d\] (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
        const ref = (words: string) => lines.find((l) => l.text.includes(words))?.id ?? 'c0';
        reply = {
          problem: { text: 'Deux écritures simultanées peuvent corrompre une table : comment obtenir la fiabilité d’une base de données sur de simples fichiers ?', refs: [ref('corrupt'), ref('reliability'), 'c999'] },
          goals: [
            { text: 'Expliquer le rôle du journal de transactions', refs: [ref('transaction log')] },
            { text: 'Relire une version antérieure (time travel)', refs: [ref('time travel')] },
          ],
          solution: { text: 'Un journal de transactions ordonné : chaque écriture est un commit JSON, les lecteurs ne voient que des commits complets.', refs: [ref('transaction log'), ref('complete commits')] },
          plan: [
            { title: 'Les limites d’un data lake', ref: ref('Welcome'), children: [{ title: 'Écritures concurrentes', ref: ref('corrupt'), children: [] }] },
            { title: 'Le journal de transactions', ref: ref('transaction log'), children: [{ title: 'Un commit = un fichier JSON', ref: ref('numbered JSON'), children: [{ title: 'Numérotés dans l’ordre', ref: ref('numbered JSON') }] }] },
            { title: 'Time travel', ref: ref('time travel'), children: [] },
          ],
        };
      }
      json(200, { choices: [{ message: { role: 'assistant', content: `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` } }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/openai/v1`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

const transcriptOf = (cues: typeof CUES, duration: number) => ({
  lang: 'en',
  label: 'Sous-titres du lecteur · English',
  source: 'track',
  target: 'fr',
  complete: true,
  covered: [[0, duration]],
  duration,
  cues: cues.map((c) => ({ id: `q${c.start * 1000}`, start: c.start, end: c.start + 3.5, text: c.text })),
  rev: 1,
});

async function useGroq(sw: Worker, base: string): Promise<void> {
  await sw.evaluate(async (base) => chrome.storage.local.set({ 'qa:config': { provider: 'groq', accounts: { groq: { key: 'gsk_test', model: 'llama-3.3-70b-versatile', base } } } }), base);
}

const chats = (r: Req[]) => r.filter((x) => x.path.endsWith('/chat/completions'));

test('Résumé d’une leçon : toute la transcription lue par une IA gratuite (compatible OpenAI) — problématique, objectifs, solution, plan ; un instant cliqué ; inséré en tête de la note', async ({ page, sw }) => {
  const ai = await mockOpenAi({ limitFirst: true });
  try {
    await useGroq(sw, ai.base);
    await sw.evaluate(async ({ key, t }) => chrome.storage.local.set({ [key]: t }), { key: `transcript:${NOTE_ID}`, t: transcriptOf(CUES, 30) });
    await openWatch(page);
    await openNotes(sw, page);
    const p = panel(page);
    await page.keyboard.type('Ma première note');
    await p.getByRole('tab', { name: 'Résumé' }).click();
    // Before: what it will do, from what, with which AI.
    await expect(p.getByRole('heading', { name: 'Résumer cette leçon' })).toBeVisible();
    await expect(p.locator('.sum-ok')).toContainText('Transcription complète · 7 répliques');
    await expect(p.locator('.sum-provider')).toContainText('IA : Groq · llama-3.3-70b-versatile');
    await p.getByRole('button', { name: 'Générer le résumé' }).click();
    // The free tier's limit reached once: waited out, said so.
    await expect(p.locator('.sum-step')).toContainText('Limite du palier gratuit atteinte : reprise dans 1 s');
    await expect(p.getByRole('region', { name: 'Problématique' })).toContainText('comment obtenir la fiabilité d’une base de données sur de simples fichiers ?', { timeout: 15_000 });
    await expect(p.getByRole('region', { name: 'Objectifs' }).locator('li')).toHaveText([/Expliquer le rôle du journal de transactions\s*00:07/, /Relire une version antérieure \(time travel\)\s*00:23/]);
    await expect(p.getByRole('region', { name: 'Solution' })).toContainText('Un journal de transactions ordonné');
    // Subtitles read as sentences (00:00, 00:07, 00:15, 00:23); the moment that does not exist (c999) is not shown.
    await expect(p.getByRole('region', { name: 'Problématique' }).locator('.sum-ts')).toHaveText(['00:00', '00:07']);
    // The plan, as a hierarchy: parts › points › details, numbered, each with its moment.
    const plan = p.getByRole('region', { name: 'Plan du cours' });
    await expect(plan.locator('.sum-lvl1 > .sum-node .sum-title')).toHaveText(['Les limites d’un data lake', 'Le journal de transactions', 'Time travel']);
    await expect(plan.locator('.sum-lvl2 > .sum-node .sum-num')).toHaveText(['1.1', '2.1']);
    await expect(plan.locator('.sum-lvl3 > .sum-node')).toContainText('Numérotés dans l’ordre');
    await expect(plan.locator('.sum-count')).toHaveText('3 parties · 3 points');
    await expect(p.locator('.sum-ai')).toHaveText('IA · à vérifier');

    // What was sent: the key, the whole transcript, the rules — in one request (it fits).
    const sent = chats(ai.requests);
    expect(sent).toHaveLength(2);
    expect(sent[1].headers.authorization).toBe('Bearer gsk_test');
    const body = JSON.parse(sent[1].body) as { model: string; messages: Array<{ content: string }> };
    expect(body.model).toBe('llama-3.3-70b-versatile');
    expect(body.messages[0].content).toContain('Problématique');
    for (const c of CUES) expect(body.messages[1].content).toContain(c.text);

    // A moment of the plan: the video there.
    await plan.getByRole('button', { name: /Aller à « Time travel »/ }).click();
    await expect.poll(() => videoTime(page)).toBeGreaterThanOrEqual(22.5);
    // Kept: shown again with the note.
    expect(await sw.evaluate(async (k) => Boolean((await chrome.storage.local.get(k))[k]), `summary:${NOTE_ID}`)).toBe(true);

    // « Insérer dans la note »: a block at the top, the notes after it; inserted again, replaced.
    await p.getByRole('button', { name: 'Insérer dans la note' }).click();
    await expect(p.locator('.cm-content')).toContainText('Résumé de la leçon');
    await expect.poll(async () => (await storedNote(sw))?.markdown ?? '').toMatch(/^> \[!summary\] Résumé de la leçon · IA d’après la transcription, à vérifier\n> \*\*Problématique —\*\* [^\n]+ \[00:00\]\n/);
    const md = (await storedNote(sw))!.markdown;
    expect(md).toContain('> **Objectifs**\n> - Expliquer le rôle du journal de transactions [00:07]');
    expect(md).toContain('> **Plan**\n> 1. Les limites d’un data lake [00:00]\n>    1. Écritures concurrentes [00:00]\n> 2. Le journal de transactions [00:07]\n>    1. Un commit = un fichier JSON [00:15]');
    expect(md).toMatch(/\n\n\[00:\d\d\] Ma première note$/);
    await p.getByRole('tab', { name: 'Résumé' }).click();
    await p.getByRole('button', { name: 'Insérer dans la note' }).click();
    await expect.poll(async () => ((await storedNote(sw))?.markdown.match(/\[!summary\]/g) ?? []).length).toBe(1);
  } finally {
    await ai.close();
  }
});

async function seedCourse(sw: Worker): Promise<void> {
  await sw.evaluate(
    async ({ noteId, acid, intro }) => {
      const note = (id: string, title: string, chapter: string, createdAt: number) => ({
        id,
        platform: 'youtube',
        kind: 'video',
        url: `https://www.youtube.com/watch?v=${id.split(':')[1]}`,
        title,
        markdown: '',
        createdAt,
        updatedAt: createdAt,
        rev: 1,
        course: 'Databricks — Data Engineer',
        chapter,
      });
      const lessons = [note('youtube:lessonIntro1', 'Qu’est-ce qu’un lakehouse ?', 'Lakehouse', 10), note(noteId, 'Les transactions ACID', 'Delta Lake', 20), note('youtube:lessonOptim1', 'OPTIMIZE et Z-ORDER', 'Delta Lake', 30)];
      const index = Object.fromEntries(lessons.map((n) => [n.id, { platform: n.platform, url: n.url, title: n.title, kind: 'video', updatedAt: n.updatedAt, course: n.course, chapter: n.chapter }]));
      await chrome.storage.local.set({
        'notes:index': index,
        ...Object.fromEntries(lessons.map((n) => [`note:${n.id}`, n])),
        [`transcript:${noteId}`]: acid,
        'transcript:youtube:lessonIntro1': intro,
      });
    },
    {
      noteId: NOTE_ID,
      acid: transcriptOf(CUES, 30),
      intro: transcriptOf(
        [
          { start: 0, text: 'A lakehouse keeps files in object storage.' },
          { start: 4, text: 'And adds warehouse features on top of them.' },
        ],
        8,
      ),
    },
  );
}

test('Résumé du cours : chaque leçon lue en entier, puis le cours d’après toutes ses transcriptions ; la page en grand', async ({ context, page, sw }) => {
  const ai = await mockOpenAi();
  try {
    await useGroq(sw, ai.base);
    await seedCourse(sw);
    await openWatch(page);
    await openNotes(sw, page);
    const p = panel(page);
    await p.getByRole('tab', { name: 'Résumé' }).click();
    await p.getByRole('tab', { name: 'Tout le cours' }).click();
    await expect(p.locator('.sum-empty')).toContainText('2 chapitres · 3 leçons · 2 avec transcription');
    await p.getByRole('button', { name: 'Générer le résumé du cours' }).click();
    await expect(p.getByRole('region', { name: 'Problématique du cours' })).toContainText('comment construire des pipelines fiables', { timeout: 15_000 });
    await expect(p.getByRole('region', { name: 'Objectifs du cours' }).locator('li')).toHaveText([/Comprendre le lakehouse\s*ch\. 1/, /Fiabiliser les tables avec Delta Lake\s*ch\. 2/]);
    const plan = p.getByRole('region', { name: 'Plan du cours' });
    await expect(plan.locator('.sum-chapter-head b')).toHaveText(['1 · Lakehouse', '2 · Delta Lake']);
    await expect(plan.locator('.sum-lessons li')).toHaveText([/Qu’est-ce qu’un lakehouse \?Synthèse de L1\./, /Les transactions ACIDSynthèse de L2\./, /OPTIMIZE et Z-ORDERpas de transcription/]);
    // Two lessons read in full (one request each, they fit), then the course with all its transcripts.
    const sent = chats(ai.requests).map((r) => JSON.parse(r.body) as { messages: Array<{ content: string }> });
    expect(sent).toHaveLength(3);
    const course = sent[2].messages;
    expect(course[0].content).toContain('puis sa transcription complète');
    expect(course[1].content).toContain('## Chapitre 1 · Lakehouse');
    expect(course[1].content).toContain('A lakehouse keeps files in object storage.');
    expect(course[1].content).toContain('Every write is a commit, a numbered JSON file.');
    expect(course[1].content).toContain('### L3 · OPTIMIZE et Z-ORDER\n(pas de transcription)');
    // This lesson's own summary was made on the way: « Cette leçon » shows it.
    await p.getByRole('tab', { name: 'Cette leçon' }).click();
    await expect(p.getByRole('region', { name: 'Problématique' })).toBeVisible();

    // « Ouvrir en grand »: the course's page.
    await p.getByRole('tab', { name: 'Tout le cours' }).click();
    const opened = context.waitForEvent('page', { predicate: (x) => x.url().includes('/summary/summary.html') });
    await p.getByRole('button', { name: 'Ouvrir en grand' }).click();
    const big: Page = await opened;
    await expect(big.getByRole('heading', { level: 1 })).toHaveText('Databricks — Data Engineer');
    await expect(big.locator('.side .progress')).toHaveText('2 leçons résumées sur 3');
    await expect(big.locator('.side .ls[data-state="none"]')).toContainText('OPTIMIZE et Z-ORDER');
    await expect(big.getByRole('region', { name: 'Solution — la démarche' })).toContainText('Un lakehouse');
    // The lesson's parts, each moment a link that opens the lesson there.
    const acid = big.locator(`#lesson-${NOTE_ID.replace(':', '\\:')} + .parts`);
    await expect(acid.locator('.sum-lvl1 .sum-title').first()).toHaveText('Les limites d’un data lake');
    await expect(acid.locator('a.sum-ts').last()).toHaveAttribute('href', 'https://www.youtube.com/watch?v=e2eTest0001#t=23');
    await expect(big.locator('.sum-hint').last()).toContainText('d’après toutes les transcriptions, lues ensemble');
    // A lesson's transcript grows: « à mettre à jour », only it read again.
    await sw.evaluate(async (t) => chrome.storage.local.set({ 'transcript:youtube:lessonIntro1': t }), transcriptOf([{ start: 0, text: 'A lakehouse keeps files in object storage.' }, { start: 4, text: 'And adds warehouse features.' }, { start: 9, text: 'Like transactions.' }], 12));
    await expect(big.getByRole('button', { name: 'Mettre à jour (1)' })).toBeVisible();
    await big.getByRole('button', { name: 'Mettre à jour (1)' }).click();
    await expect(big.locator('.side .progress')).toHaveText('2 leçons résumées sur 3', { timeout: 15_000 });
    await expect(big.getByRole('button', { name: 'Régénérer' })).toBeVisible();
    expect(chats(ai.requests)).toHaveLength(5);
  } finally {
    await ai.close();
  }
});

test('options › IA : une adresse compatible OpenAI vérifiée (ses modèles listés, sans ceux qui n’écrivent pas) ; les paliers gratuits disent où créer une clé', async ({ context, sw }) => {
  const ai = await mockOpenAi();
  try {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html#questions`);
    const qa = () => options.evaluate(async () => (await chrome.storage.local.get('qa:config'))['qa:config'] as { provider: string; accounts: Record<string, { model: string; base?: string }> });
    // The free tiers first, each with where to get a key.
    await expect(options.locator('.provider .p-name')).toHaveText(['IA de Chrome', 'Groq', 'OpenRouter', 'Google Gemini', 'Mistral', 'Cerebras', 'Ollama (sur cet ordinateur)', 'Claude', 'Compatible OpenAI', 'Sans IA']);
    await options.getByText('OpenRouter', { exact: true }).click();
    await expect(options.locator('#qa-badge')).toHaveText('OpenRouter : ajoutez votre clé');
    await expect(options.locator('#qa-key-link')).toHaveText('Créer une clé gratuite');
    await expect(options.locator('#qa-key-link')).toHaveAttribute('href', 'https://openrouter.ai/settings/keys');
    await expect(options.locator('#qa-terms')).toContainText('« :free »');
    expect((await qa())?.provider ?? 'chrome').toBe('chrome');
    // One's own address (here the stand-in): its models, the writing ones.
    await options.getByText('Compatible OpenAI', { exact: true }).click();
    await options.locator('#qa-base').fill(ai.base);
    await options.locator('#qa-key').fill('gsk_test');
    await options.getByRole('button', { name: 'Vérifier et activer' }).click();
    await expect(options.locator('#qa-badge')).toHaveText('Compatible OpenAI activé');
    await expect(options.locator('#qa-model option')).toHaveText(['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']);
    await expect.poll(async () => (await qa()).provider).toBe('custom');
    expect((await qa()).accounts.custom).toMatchObject({ base: ai.base, model: 'llama-3.1-8b-instant' });
    await options.locator('#qa-model').selectOption('llama-3.3-70b-versatile');
    await expect.poll(async () => (await qa()).accounts.custom.model).toBe('llama-3.3-70b-versatile');
    // A wrong key: said so.
    await options.getByRole('button', { name: 'Retirer' }).click();
    await options.getByText('Compatible OpenAI', { exact: true }).click();
    await options.locator('#qa-base').fill(ai.base);
    await options.locator('#qa-key').fill('mauvaise');
    await options.getByRole('button', { name: 'Vérifier et activer' }).click();
    await expect(options.locator('#saved')).toContainText('clé Compatible OpenAI refusée');
  } finally {
    await ai.close();
  }
});
