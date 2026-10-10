import { readFile } from 'node:fs/promises';
import type { Page, Worker } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { PARENT_PAGE_ID, startMockNotion } from '../../tools/mock-notion/server.mjs';
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

/** The PDF downloaded since `chrome.downloads.erase`: its title and the links it holds. */
async function lastPdf(sw: Worker): Promise<{ title: string; pages: number; uris: string[] }> {
  const file = await sw.evaluate(async () => {
    for (let i = 0; i < 150; i++) {
      const [d] = await chrome.downloads.search({ mime: 'application/pdf' });
      if (d?.state === 'complete') return d.filename;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });
  expect(file).toBeTruthy();
  const doc = await PDFDocument.load(await readFile(file!));
  const uris: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const action = annots!.lookup(i, PDFDict).lookupMaybe(PDFName.of('A'), PDFDict);
      if (action) uris.push((action.lookup(PDFName.of('URI'), PDFString) as PDFString).decodeText());
    }
  }
  return { title: doc.getTitle() ?? '', pages: doc.getPageCount(), uris };
}

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
    // The plan, « Détaillé »: each part with its sentence, and its most important points explained, each with its moment.
    const plan = p.getByRole('region', { name: 'Plan du cours' });
    await expect(plan.locator('.sum-lvl1 > .sum-node .sum-title')).toHaveText(['Les limites d’un data lake', 'Le journal de transactions', 'Time travel']);
    await expect(plan.getByRole('button', { name: 'Détaillé' })).toHaveAttribute('aria-pressed', 'true');
    await expect(plan.locator('.sum-count-line')).toHaveText('3 parties · 7 points importants');
    await expect(plan.locator('.sum-intro').first()).toHaveText('Pourquoi de simples fichiers ne suffisent pas.');
    // One essential point per part, lit; a term defined, a trap, an example with its command.
    await expect(plan.locator('.sum-pt.k-key')).toHaveCount(3);
    await expect(plan.locator('.sum-pt.k-key').first()).toHaveText(/^Essentiel\s*Écritures concurrentes — Deux jobs qui écrivent en même temps peuvent corrompre une table\.\s*00:00$/);
    await expect(plan.locator('.sum-pt.k-definition')).toContainText('DéfinitionJournal de transactions — Le registre des commits');
    await expect(plan.locator('.sum-pt.k-warning')).toContainText('AttentionAucune garantie');
    await expect(plan.locator('.sum-pt.k-example .sum-code')).toHaveText('SELECT * FROM ventes VERSION AS OF 3');
    await expect(plan.locator('.sum-pt.k-example .sum-ts')).toHaveText('00:23');
    // « Titres »: the short plan (the essential points starred); the choice kept.
    await plan.getByRole('button', { name: 'Titres' }).click();
    await expect(plan.locator('.sum-intro')).toHaveCount(0);
    await expect(plan.locator('.sum-lvl2 > .sum-node .sum-num')).toHaveText(['1.1', '1.2', '2.1', '2.2', '2.3', '3.1', '3.2']);
    await expect(plan.locator('.sum-star')).toHaveCount(3);
    expect(await p.locator('body').evaluate(() => localStorage.getItem('boo:summary-plan-view'))).toBe('titles');
    await plan.getByRole('button', { name: 'Détaillé' }).click();
    await expect(plan.locator('.sum-pt')).toHaveCount(7);
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

    // « PDF »: the summary alone (no cover), each moment a link to the video there.
    await sw.evaluate(() => chrome.downloads.erase({}));
    await p.getByRole('button', { name: 'PDF', exact: true }).click();
    await expect(p.locator('.notice')).toContainText('PDF du résumé de « Vidéo de test E2E » téléchargé', { timeout: 15_000 });
    const lessonPdf = await lastPdf(sw);
    expect(lessonPdf.title).toBe('Boo Notes — Résumé — Vidéo de test E2E');
    expect(lessonPdf.pages).toBe(1);
    for (const t of [0, 7, 15, 23]) expect(lessonPdf.uris).toContain(`https://www.youtube.com/watch?v=e2eTest0001#t=${t}`);

    // « Insérer dans la note »: a block at the top, the notes after it; inserted again, replaced.
    await p.getByRole('button', { name: 'Insérer dans la note' }).click();
    await expect(p.locator('.cm-content')).toContainText('Résumé de la leçon');
    await expect.poll(async () => (await storedNote(sw))?.markdown ?? '').toMatch(/^> \[!summary\] Résumé de la leçon · IA d’après la transcription, à vérifier\n> \*\*Problématique —\*\* [^\n]+ \[00:00\]\n/);
    const md = (await storedNote(sw))!.markdown;
    expect(md).toContain('> **Objectifs**\n> - Expliquer le rôle du journal de transactions [00:07]');
    // The plan detailed in the note too: each part's sentence, its points explained and marked.
    expect(md).toContain('> **Plan**\n> 1. Les limites d’un data lake [00:00]\n>    *Pourquoi de simples fichiers ne suffisent pas.*\n>    - ★ **Essentiel — Écritures concurrentes :** Deux jobs qui écrivent en même temps peuvent corrompre une table. [00:00]\n>    - ⚠️ **Attention — Aucune garantie :**');
    expect(md).toContain('>    - 📘 **Définition — Journal de transactions :** Le registre des commits, à côté des fichiers Parquet. [00:07]\n>    - **Lectures atomiques :** Les lecteurs ne voient que des commits complets. [00:15]');
    expect(md).toContain('>    - 💡 **Exemple — Relire la version 3 :** Une requête lit la table telle qu’elle était. [00:23]\n>      `SELECT * FROM ventes VERSION AS OF 3`');
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
    // « PDF du résumé »: the course's summary alone, each lesson's moments links to it.
    await sw.evaluate(() => chrome.downloads.erase({}));
    await big.getByRole('button', { name: 'PDF du résumé' }).click();
    await expect(big.locator('#toast')).toContainText('PDF du résumé du cours « Databricks — Data Engineer » téléchargé', { timeout: 20_000 });
    const summaryPdf = await lastPdf(sw);
    expect(summaryPdf.title).toBe('Boo Notes — Résumé du cours — Databricks — Data Engineer');
    expect(summaryPdf.uris).toContain('https://www.youtube.com/watch?v=e2eTest0001#t=23');
    // The course's PDF opens with its summary (then its lessons with something in them: the empty one without a transcript is left out).
    await big.getByRole('button', { name: 'PDF du cours' }).click();
    await expect(big.locator('#toast')).toContainText('PDF du cours « Databricks — Data Engineer » téléchargé : son résumé, 2 leçons, 2 transcriptions', { timeout: 20_000 });

    // « Modifier » the course: its problem, a lesson's sentence, a point of a lesson's plan; « Annuler » drops nothing saved.
    await big.getByRole('button', { name: 'Modifier' }).click();
    await big.getByRole('textbox', { name: 'Problématique du cours' }).fill('Comment bâtir des pipelines fiables sur un lakehouse ?');
    await big.getByRole('textbox', { name: 'Phrase de la leçon « Les transactions ACID »' }).fill('Le journal rend chaque écriture atomique.');
    const acidPlan = big.locator(`#lesson-${NOTE_ID.replace(':', '\\:')} + .parts`);
    await acidPlan.locator('.ed-part-title').first().fill('Pourquoi un data lake ne suffit pas');
    await big.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(big.locator('#toast')).toContainText('Résumé enregistré');
    const courseKept = await sw.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).find(([k]) => k.startsWith('course-summary:'))![1]) as { edited?: number; problem: string; chapters: Array<{ lessons: Array<{ synthesis: string }> }> };
    expect(courseKept.edited).toBeGreaterThan(0);
    expect(courseKept.problem).toBe('Comment bâtir des pipelines fiables sur un lakehouse ?');
    expect(courseKept.chapters[1].lessons[0].synthesis).toBe('Le journal rend chaque écriture atomique.');
    expect(((await sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], `summary:${NOTE_ID}`)) as { plan: Array<{ title: string }> }).plan[0].title).toBe('Pourquoi un data lake ne suffit pas');
    await expect(big.getByRole('region', { name: 'Problématique du cours' })).toContainText('Comment bâtir des pipelines fiables');
    await expect(big.locator('.meta .sum-ai')).toHaveText('IA · modifié');
  } finally {
    await ai.close();
  }
});

test('« En grand » : le résumé modifié à ma convenance — textes, sortes de points, ajouts, suppressions —, enregistré : la note, le PDF et Notion suivent', async ({ context, page, sw }) => {
  const ai = await mockOpenAi();
  const notion = startMockNotion();
  await notion.ready;
  try {
    // Notion connected (the extension writes there itself).
    await sw.evaluate((url) => {
      (globalThis as unknown as { booNotes: { notion: { apiBase?: string } } }).booNotes.notion.apiBase = url;
    }, notion.url);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html#notion`);
    await options.locator('#notion-token').fill('secret_test');
    await options.locator('#notion-page').fill(`https://www.notion.so/Mes-cours-${PARENT_PAGE_ID.replace(/-/g, '')}`);
    await options.locator('#notion-connect').click();
    await expect(options.locator('#notion-badge')).toHaveText(/^Connecté/);
    await options.close();

    await useGroq(sw, ai.base);
    await sw.evaluate(async ({ key, t }) => chrome.storage.local.set({ [key]: t }), { key: `transcript:${NOTE_ID}`, t: transcriptOf(CUES, 30) });
    await openWatch(page);
    await openNotes(sw, page);
    const p = panel(page);
    await page.keyboard.type('Ma première note');
    await p.getByRole('tab', { name: 'Résumé' }).click();
    await p.getByRole('button', { name: 'Générer le résumé' }).click();
    await expect(p.getByRole('region', { name: 'Problématique' })).toBeVisible({ timeout: 15_000 });
    await p.getByRole('button', { name: 'Insérer dans la note' }).click();
    await expect.poll(async () => (await storedNote(sw))?.markdown ?? '').toContain('[!summary]');
    await p.getByRole('tab', { name: 'Résumé' }).click();

    // The small button: the summary, large.
    const opened = context.waitForEvent('page', { predicate: (x) => x.url().includes(`/summary/summary.html?note=`) });
    await p.getByRole('button', { name: 'En grand : modifier, PDF' }).click();
    const big: Page = await opened;
    await big.setViewportSize({ width: 1400, height: 1000 });
    await expect(big.getByRole('heading', { level: 1 })).toHaveText('Vidéo de test E2E');
    await expect(big.getByRole('region', { name: 'Plan du cours' }).locator('.sum-pt')).toHaveCount(7);

    // « Modifier »: a text, a point's kind and explanation, a point removed, one added with its moment, a goal added.
    await big.getByRole('button', { name: 'Modifier' }).click();
    await expect(big.locator('.ed-banner')).toContainText('Vous modifiez le résumé');
    await big.getByRole('textbox', { name: 'Problématique' }).fill('Comment écrire sur un data lake sans corrompre la table ?');
    const garantie = big.locator('.ed-pt', { hasText: 'Aucune garantie' });
    await garantie.locator('.ed-kind').selectOption('definition');
    await big.locator('.ed-pt', { hasText: 'Aucune garantie' }).locator('.ed-detail').fill('Aucune règle n’empêche deux écritures de se mêler.');
    await big.locator('.ed-pt', { hasText: 'Lectures atomiques' }).getByRole('button', { name: 'Supprimer le point' }).click();
    const travel = big.locator('.ed-part').nth(2);
    await travel.getByRole('button', { name: 'Ajouter un point' }).click();
    const added = travel.locator('.ed-pt').last();
    await added.locator('.ed-pt-title').fill('VACUUM');
    await added.locator('.ed-detail').fill('Efface les vieux fichiers : le time travel ne remonte plus avant.');
    await added.locator('.ed-kind').selectOption('warning');
    await travel.locator('.ed-pt').last().locator('.ed-time').fill('00:19');
    await big.getByRole('button', { name: 'Ajouter un objectif' }).click();
    await big.getByRole('textbox', { name: 'Objectif 3' }).fill('Nettoyer une table avec VACUUM');
    await big.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(big.locator('#toast')).toContainText('Résumé enregistré — mis à jour dans la note et Notion');

    // Kept as edited, said so.
    const kept = await sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], `summary:${NOTE_ID}`) as { edited?: number; problem: { text: string }; goals: Array<{ text: string }>; plan: Array<{ children: Array<{ title: string; kind?: string; detail?: string; at: number | null }> }> };
    expect(kept.edited).toBeGreaterThan(0);
    expect(kept.problem.text).toBe('Comment écrire sur un data lake sans corrompre la table ?');
    expect(kept.goals.map((g) => g.text)).toContain('Nettoyer une table avec VACUUM');
    expect(kept.plan[0].children[1]).toMatchObject({ title: 'Aucune garantie', kind: 'definition', detail: 'Aucune règle n’empêche deux écritures de se mêler.' });
    expect(kept.plan[1].children.map((c) => c.title)).not.toContain('Lectures atomiques');
    expect(kept.plan[2].children.at(-1)).toMatchObject({ title: 'VACUUM', kind: 'warning', at: 19 });
    await expect(big.locator('.sum-ai')).toHaveText('IA · modifié');
    await expect(big.locator('.sum-pt.k-warning')).toContainText('VACUUM — Efface les vieux fichiers');
    await expect(p.locator('.sum-ai')).toHaveText('IA · modifié');

    // The note's summary block follows.
    await expect.poll(async () => (await storedNote(sw))?.markdown ?? '').toContain('> **Problématique —** Comment écrire sur un data lake sans corrompre la table ?');
    const md = (await storedNote(sw))!.markdown;
    expect(md).toMatch(/^> \[!summary\] Résumé de la leçon · IA d’après la transcription, modifié par vous\n/);
    expect(md).toContain('>    - ⚠️ **Attention — VACUUM :** Efface les vieux fichiers : le time travel ne remonte plus avant. [00:19]');
    expect(md).not.toContain('Lectures atomiques');
    expect(md).toMatch(/\[00:\d\d\] Ma première note$/);

    // The PDF: the summary as saved (its new moment a link to the video there).
    await sw.evaluate(() => chrome.downloads.erase({}));
    await big.getByRole('button', { name: 'PDF du résumé' }).click();
    const pdf = await lastPdf(sw);
    expect(pdf.uris).toContain('https://www.youtube.com/watch?v=e2eTest0001#t=19');

    // Notion: the lesson's page written again, as edited.
    await expect
      .poll(async () => {
        const pages = [...notion.state.pages.values()].filter((x) => x.parent?.database_id);
        return pages.length ? JSON.stringify(notion.pageContent(pages[0].id)) : '';
      }, { timeout: 30_000 })
      .toContain('Comment écrire sur un data lake sans corrompre la table ?');
    const content = JSON.stringify(notion.pageContent([...notion.state.pages.values()].find((x) => x.parent?.database_id)!.id));
    expect(content).toContain('modifié par vous le');
    expect(content).toContain('⚠️ Attention — VACUUM : Efface les vieux fichiers');
    expect(content).not.toContain('Lectures atomiques');
  } finally {
    await ai.close();
    await notion.close();
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
