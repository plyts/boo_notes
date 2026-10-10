import type { Page } from '@playwright/test';
import { chats, CUES, mockOpenAi, seedCourse, transcriptOf, useGroq } from './ai-mock';
import { expect, NOTE_ID, openNotes, openWatch, panel, storedNote, test, videoTime } from './fixtures';

/**
 * « Résumé »: the lesson's whole transcript, and every lesson of its course,
 * summarised by the AI chosen in the options — here a free-tier service
 * speaking the OpenAI API (Groq, OpenRouter, Gemini, Mistral, Cerebras…),
 * stood in for by a local server: problem, goals, solution and the course
 * as a hierarchy, each moment clickable; inserted at the top of the note;
 * the course's page, large.
 */

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
    // The course's PDF opens with its summary (then its lessons with something in them: the empty one without a transcript is left out).
    await big.getByRole('button', { name: 'PDF' }).click();
    await expect(big.locator('#toast')).toContainText('PDF du cours « Databricks — Data Engineer » téléchargé : son résumé, 2 leçons, 2 transcriptions', { timeout: 20_000 });
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
