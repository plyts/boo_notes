import type { Page, Worker } from '@playwright/test';
import { execSync } from 'node:child_process';
import { CUES, mockOpenAi, seedCourse, transcriptOf, useGroq } from './ai-mock';
import { expect, NOTE_ID, openNotes, openWatch, panel, setVideo, test } from './fixtures';

/**
 * Every screen of the summary, photographed (opt-in):
 *
 *   SUMMARY_SHOTS=<folder> npx playwright test summary-shots
 *
 * The lesson's states (before, partial transcript, no AI, reading by parts,
 * a free tier's wait, the result and its plan with the part being watched,
 * « à mettre à jour », inserted in the note, dark), the course's (in the
 * panel, its page before and after, dark, its PDF), and options › IA.
 */

const SHOTS = process.env.SUMMARY_SHOTS ?? '';
test.skip(!SHOTS, 'SUMMARY_SHOTS=<folder> to photograph the summary screens');

/** The PDF just downloaded (since `chrome.downloads.erase`), its first pages as pictures. */
async function pdfShots(sw: Worker, name: string, pages = 2): Promise<void> {
  const file = await sw.evaluate(async () => {
    for (let i = 0; i < 150; i++) {
      const [d] = await chrome.downloads.search({ mime: 'application/pdf' });
      if (d?.state === 'complete') return d.filename;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });
  expect(file).toBeTruthy();
  execSync(`gs -q -dNOPAUSE -dBATCH -sDEVICE=png16m -r90 -dFirstPage=1 -dLastPage=${pages} -sOutputFile=${SHOTS}/${name}-%d.png "${file}"`);
}

/** The panel alone (the drawer at the page's edge). */
async function panelShot(page: Page, name: string): Promise<void> {
  // A notice (« Résumé prêt ») gone first: it would hide the buttons under it.
  await expect(panel(page).locator('.notice.show')).toHaveCount(0, { timeout: 6000 });
  const box = await page.locator('#boo-notes-drawer .drawer').boundingBox();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, ...(box ? { clip: box } : {}) });
}

const setTheme = (sw: Worker, theme: 'dark' | 'light' | 'auto') =>
  sw.evaluate(async (theme) => {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...(settings ?? {}), theme } });
  }, theme);

/** A long lesson (about 14 min): read in parts by a free tier. */
const LONG = Array.from({ length: 280 }, (_, i) => ({
  start: i * 3,
  text: [
    'Delta Lake keeps a transaction log beside the Parquet data files of every table.',
    'Each commit is written as a numbered JSON file in the delta log directory.',
    'Readers reconstruct the table state from the latest checkpoint and later commits.',
    'Concurrent writers use optimistic concurrency and retry when they conflict.',
  ][i % 4],
}));

test('rendus : l’onglet Résumé d’une leçon, tous ses états', async ({ page, sw }) => {
  test.setTimeout(180_000);
  const ai = await mockOpenAi({ limitFirst: true });
  try {
    await useGroq(sw, ai.base);
    // A transcript caught while watching (8 s of 30): the partial state first.
    await sw.evaluate(async ({ key, t }) => chrome.storage.local.set({ [key]: t }), { key: `transcript:${NOTE_ID}`, t: transcriptOf(CUES.slice(0, 3), 30, { complete: false, covered: [[0, 9]] }) });
    await openWatch(page);
    await openNotes(sw, page);
    const p = panel(page);
    await page.keyboard.type('Le _delta_log est dans le dossier de la table');
    await p.getByRole('tab', { name: 'Résumé' }).click();
    await expect(p.locator('.sum-warn')).toBeVisible();
    await panelShot(page, '02-lecon-transcription-partielle');

    // No AI: said why, and where to choose one.
    await sw.evaluate(async () => chrome.storage.local.set({ 'qa:config': { provider: 'none', accounts: {} } }));
    await p.getByRole('button', { name: /Résumer ces/ }).click();
    await expect(p.locator('.sum-error')).toBeVisible();
    await panelShot(page, '03-lecon-sans-ia');

    // The whole transcript, then « before ».
    await useGroq(sw, ai.base);
    await page.reload();
    await sw.evaluate(async ({ key, t }) => chrome.storage.local.set({ [key]: t }), { key: `transcript:${NOTE_ID}`, t: transcriptOf(CUES, 30) });
    await page.locator('#boo-notes-overlay').waitFor({ state: 'attached' });
    await openNotes(sw, page);
    await panel(page).getByRole('tab', { name: 'Résumé' }).click();
    await expect(panel(page).getByRole('heading', { name: 'Résumer cette leçon' })).toBeVisible();
    await expect(panel(page).locator('.sum-provider')).toContainText('Groq');
    await panelShot(page, '01-lecon-avant');

    // Generating: the free tier's limit reached, waited out.
    await panel(page).getByRole('button', { name: 'Générer le résumé' }).click();
    await expect(panel(page).locator('.sum-step')).toContainText('Limite du palier gratuit');
    await panelShot(page, '05-lecon-attente-palier-gratuit');
    await expect(panel(page).getByRole('region', { name: 'Problématique' })).toBeVisible({ timeout: 15_000 });
    await panelShot(page, '06-lecon-resultat');
    // « PDF »: the summary alone.
    await sw.evaluate(() => chrome.downloads.erase({}));
    await panel(page).getByRole('button', { name: 'PDF', exact: true }).click();
    await pdfShots(sw, '06b-pdf-resume-lecon', 1);
    // The plan, the part being watched lit.
    await setVideo(page, 16);
    await panel(page).getByRole('region', { name: 'Plan du cours' }).scrollIntoViewIfNeeded();
    await expect(panel(page).locator('.sum-node.now')).toBeVisible();
    await panelShot(page, '07-lecon-plan-partie-en-cours');
    // « Titres »: the short plan; back to « Détaillé ».
    await panel(page).getByRole('button', { name: 'Titres', exact: true }).click();
    await panel(page).getByRole('region', { name: 'Plan du cours' }).scrollIntoViewIfNeeded();
    await panelShot(page, '07b-lecon-plan-titres');
    await panel(page).getByRole('button', { name: 'Détaillé', exact: true }).click();

    // The transcript changed since: « à mettre à jour ».
    await sw.evaluate(async (key) => {
      const s = (await chrome.storage.local.get(key))[key] as { basis: { cues: number; covered: number } };
      await chrome.storage.local.set({ [key]: { ...s, basis: { ...s.basis, cues: 3, covered: 9, until: 11 } } });
    }, `summary:${NOTE_ID}`);
    await expect(panel(page).locator('.sum-stale')).toBeVisible();
    await panel(page).locator('.sum-body').evaluate((el) => (el.scrollTop = 0));
    await panelShot(page, '08-lecon-a-mettre-a-jour');

    // Inserted at the top of the note.
    await panel(page).getByRole('button', { name: 'Insérer dans la note' }).click();
    await expect(panel(page).locator('.cm-content')).toContainText('Résumé de la leçon');
    await panelShot(page, '09-note-avec-le-resume');

    // Dark.
    await setTheme(sw, 'dark');
    await panel(page).getByRole('tab', { name: 'Résumé' }).click();
    await panel(page).locator('.sum-body').evaluate((el) => (el.scrollTop = 0));
    await panelShot(page, '10-lecon-resultat-sombre');
    await setTheme(sw, 'auto');
  } finally {
    await ai.close();
  }
});

test('rendus : une longue leçon lue par parties (le plan grandit)', async ({ page, sw }) => {
  test.setTimeout(120_000);
  const ai = await mockOpenAi({ delayMs: 1800 });
  try {
    await useGroq(sw, ai.base);
    await sw.evaluate(async ({ key, t }) => chrome.storage.local.set({ [key]: t }), { key: `transcript:${NOTE_ID}`, t: transcriptOf(LONG, 840) });
    await openWatch(page);
    await openNotes(sw, page);
    const p = panel(page);
    await p.getByRole('tab', { name: 'Résumé' }).click();
    await p.getByRole('button', { name: 'Générer le résumé' }).click();
    await expect(p.locator('.sum-growing')).toBeVisible({ timeout: 20_000 });
    await panelShot(page, '04-lecon-lue-par-parties');
    await expect(p.getByRole('region', { name: 'Problématique' })).toBeVisible({ timeout: 30_000 });
  } finally {
    await ai.close();
  }
});

test('rendus : le résumé du cours (panneau, page en grand, PDF)', async ({ context, page, sw }) => {
  test.setTimeout(180_000);
  const ai = await mockOpenAi({ delayMs: 900 });
  try {
    await useGroq(sw, ai.base);
    await seedCourse(sw);
    const host = new URL(sw.url()).host;
    // The course's page before its summary.
    const before = await context.newPage();
    await before.setViewportSize({ width: 1400, height: 820 });
    await before.goto(`chrome-extension://${host}/summary/summary.html?course=${encodeURIComponent('Databricks — Data Engineer')}`);
    await expect(before.getByRole('button', { name: 'Générer le résumé du cours' })).toBeVisible();
    await before.screenshot({ path: `${SHOTS}/14-cours-page-avant.png` });
    await before.close();

    await openWatch(page);
    await openNotes(sw, page);
    const p = panel(page);
    await p.getByRole('tab', { name: 'Résumé' }).click();
    await p.getByRole('tab', { name: 'Tout le cours' }).click();
    await expect(p.getByRole('button', { name: 'Générer le résumé du cours' })).toBeVisible();
    await panelShot(page, '11-cours-panneau-avant');
    await p.getByRole('button', { name: 'Générer le résumé du cours' }).click();
    await expect(p.locator('.sum-step')).toContainText('Leçon');
    await panelShot(page, '12-cours-panneau-en-cours');
    await expect(p.getByRole('region', { name: 'Problématique du cours' })).toBeVisible({ timeout: 20_000 });
    await panelShot(page, '13-cours-panneau-resultat');
    await p.getByRole('region', { name: 'Plan du cours' }).scrollIntoViewIfNeeded();
    await panelShot(page, '13b-cours-panneau-plan');

    const opened = context.waitForEvent('page', { predicate: (x) => x.url().includes('/summary/summary.html') });
    await p.getByRole('button', { name: 'Ouvrir en grand' }).click();
    const big = await opened;
    await big.setViewportSize({ width: 1400, height: 1000 });
    await expect(big.getByRole('region', { name: 'Plan du cours' })).toBeVisible();
    await big.screenshot({ path: `${SHOTS}/15-cours-page.png`, fullPage: true });
    await big.emulateMedia({ colorScheme: 'dark' });
    await big.waitForTimeout(300);
    await big.screenshot({ path: `${SHOTS}/16-cours-page-sombre.png`, fullPage: true });
    await big.emulateMedia({ colorScheme: 'light' });

    // A lesson's transcript grows: « Mettre à jour (1) », only it read again (in progress).
    await sw.evaluate(async (t) => chrome.storage.local.set({ 'transcript:youtube:lessonIntro1': t }), transcriptOf([{ start: 0, text: 'A lakehouse keeps files in object storage.' }, { start: 4, text: 'And adds warehouse features.' }, { start: 9, text: 'Like transactions.' }], 12));
    await big.getByRole('button', { name: 'Mettre à jour (1)' }).click();
    await expect(big.locator('.sum-progress')).toBeVisible();
    await big.screenshot({ path: `${SHOTS}/15b-cours-page-mise-a-jour.png` });
    await expect(big.getByRole('button', { name: 'Régénérer' })).toBeVisible({ timeout: 20_000 });

    // « PDF du résumé »: the course's summary alone.
    await sw.evaluate(() => chrome.downloads.erase({}));
    await big.getByRole('button', { name: 'PDF du résumé' }).click();
    await expect(big.locator('#toast')).toContainText('téléchargé', { timeout: 30_000 });
    await pdfShots(sw, '17r-pdf-resume-cours', 2);
    // « PDF du cours »: the summary first, then the lessons — its first pages as pictures.
    await sw.evaluate(() => chrome.downloads.erase({}));
    await big.getByRole('button', { name: 'PDF du cours' }).click();
    await expect(big.locator('#toast')).toContainText('téléchargé', { timeout: 30_000 });
    await pdfShots(sw, '17-pdf-page', 4);
  } finally {
    await ai.close();
  }
});

test('rendus : options › IA', async ({ context, sw }) => {
  const ai = await mockOpenAi();
  try {
    const options = await context.newPage();
    await options.setViewportSize({ width: 1200, height: 1500 });
    await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html#questions`);
    const section = options.locator('#questions');
    await expect(options.locator('.provider')).toHaveCount(10);
    await section.screenshot({ path: `${SHOTS}/18-options-ia-chrome.png` });
    await options.getByText('Groq', { exact: true }).click();
    await expect(options.locator('#qa-badge')).toHaveText('Groq : ajoutez votre clé');
    await section.screenshot({ path: `${SHOTS}/19-options-ia-groq-cle.png` });
    await options.getByText('Ollama (sur cet ordinateur)', { exact: true }).click();
    await section.screenshot({ path: `${SHOTS}/20-options-ia-ollama.png` });
    await options.getByText('Compatible OpenAI', { exact: true }).click();
    await options.locator('#qa-base').fill(ai.base);
    await options.locator('#qa-key').fill('gsk_test');
    await options.getByRole('button', { name: 'Vérifier et activer' }).click();
    await expect(options.locator('#qa-badge')).toHaveText('Compatible OpenAI activé');
    await options.waitForTimeout(400);
    await section.screenshot({ path: `${SHOTS}/21-options-ia-activee.png` });
  } finally {
    await ai.close();
  }
});
