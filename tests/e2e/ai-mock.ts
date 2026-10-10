import type { Worker } from '@playwright/test';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NOTE_ID } from './fixtures';

/**
 * A free-tier AI service speaking the OpenAI API (Groq, OpenRouter, Gemini,
 * Mistral, Cerebras…), stood in for by a local server, and the course it
 * summarises: a lesson's subtitles, a course of three lessons.
 */

export const CUES = [
  { start: 0, text: 'Welcome. Today we look at Delta Lake transactions.' },
  { start: 3, text: 'On a plain data lake, two jobs writing at once can corrupt a table.' },
  { start: 7, text: 'So how do we get database reliability on simple files?' },
  { start: 11, text: 'Delta Lake adds a transaction log next to the Parquet files.' },
  { start: 15, text: 'Every write is a commit, a numbered JSON file.' },
  { start: 19, text: 'Readers only see complete commits, so writes are atomic.' },
  { start: 23, text: 'And with the history you can read any older version: time travel.' },
];

export type Req = { path: string; headers: IncomingMessage['headers']; body: string };


/** A free-tier service speaking the OpenAI API: its models, and replies drawn from what it is shown. */
export async function mockOpenAi(opts: { limitFirst?: boolean; delayMs?: number } = {}): Promise<{ base: string; requests: Req[]; close(): Promise<void> }> {
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
      if (system.includes('lue par parties. Uniquement')) {
        // One part of a long transcript: its outline (a section every few lines) and a key sentence.
        const lines = [...user.matchAll(/^\[(c\d+) [\d:]+\] (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
        const step = Math.max(1, Math.floor(lines.length / 3));
        reply = {
          sections: [0, 1, 2].map((k) => lines[k * step]).filter(Boolean).map((l, k) => ({ title: `Partie ${k + 1} : ${l.text.split(' ').slice(0, 4).join(' ')}`, ref: l.id, intro: 'Ce que cette partie apporte.', points: [{ title: 'Un point clé', detail: 'Ce qu’il faut en retenir.', kind: 'essentiel', ref: l.id }] })),
          ideas: [{ kind: 'problem', text: 'Le problème posé.', ref: lines[0]?.id ?? 'c0' }],
        };
      } else if (system.includes('Voici un cours entier')) {
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
          // Each part: its sentence, and its most important points explained (the essential one, a term, a trap, an example with its command).
          plan: [
            {
              title: 'Les limites d’un data lake',
              ref: ref('Welcome'),
              intro: 'Pourquoi de simples fichiers ne suffisent pas.',
              points: [
                { title: 'Écritures concurrentes', detail: 'Deux jobs qui écrivent en même temps peuvent corrompre une table.', kind: 'essentiel', ref: ref('corrupt') },
                { title: 'Aucune garantie', detail: 'Rien n’empêche un lecteur de voir une écriture à moitié faite.', kind: 'attention', ref: ref('reliability') },
              ],
            },
            {
              title: 'Le journal de transactions',
              ref: ref('transaction log'),
              intro: 'Le cœur de Delta Lake : un registre ordonné de toutes les écritures.',
              points: [
                { title: 'Un commit = un fichier JSON', detail: 'Chaque écriture ajoute un fichier JSON numéroté au journal.', kind: 'essentiel', ref: ref('numbered JSON') },
                { title: 'Journal de transactions', detail: 'Le registre des commits, à côté des fichiers Parquet.', kind: 'definition', ref: ref('transaction log') },
                { title: 'Lectures atomiques', detail: 'Les lecteurs ne voient que des commits complets.', kind: 'point', ref: ref('complete commits') },
              ],
            },
            {
              title: 'Time travel',
              ref: ref('time travel'),
              intro: 'Relire la table telle qu’elle était.',
              points: [
                { title: 'L’historique garde chaque version', detail: 'Chaque commit reste lisible : la table se relit à une version passée.', kind: 'essentiel', ref: ref('time travel') },
                { title: 'Relire la version 3', detail: 'Une requête lit la table telle qu’elle était.', kind: 'exemple', ref: ref('older version'), code: 'SELECT * FROM ventes VERSION AS OF 3' },
              ],
            },
          ],
        };
      }
      const send = () => json(200, { choices: [{ message: { role: 'assistant', content: `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` } }] });
      if (opts.delayMs) setTimeout(send, opts.delayMs);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/openai/v1`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

export const transcriptOf = (cues: ReadonlyArray<{ start: number; text: string }>, duration: number, extra: Record<string, unknown> = {}) => ({
  lang: 'en',
  label: 'Sous-titres du lecteur · English',
  source: 'track',
  target: 'fr',
  complete: true,
  covered: [[0, duration]],
  duration,
  cues: cues.map((c) => ({ id: `q${Math.round(c.start * 1000)}`, start: c.start, end: c.start + 3.5, text: c.text })),
  rev: 1,
  ...extra,
});

export async function useGroq(sw: Worker, base: string): Promise<void> {
  await sw.evaluate(async (base) => chrome.storage.local.set({ 'qa:config': { provider: 'groq', accounts: { groq: { key: 'gsk_test', model: 'llama-3.3-70b-versatile', base } } } }), base);
}

export const chats = (r: Req[]) => r.filter((x) => x.path.endsWith('/chat/completions'));

export async function seedCourse(sw: Worker): Promise<void> {
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

