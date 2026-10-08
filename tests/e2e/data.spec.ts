import type { Worker } from '@playwright/test';
import { PARENT_PAGE_ID, startMockNotion } from '../../tools/mock-notion/server.mjs';
import { expect, test } from './fixtures';

/**
 * Options › Données: each note — the lesson (a click reopens it), where it
 * is filed, whether it is in Notion (its page a click away) or a « Sync »
 * button that writes it there now, in its course's page; notes deleted by
 * hand — one, or a selection. No progress bars.
 */

const NOTES = [
  { id: 'youtube:aaaaaaaaaaa', title: 'Leçon synchronisée', updatedAt: 3 },
  { id: 'youtube:bbbbbbbbbbb', title: 'Leçon en attente', updatedAt: 2 },
  { id: 'youtube:ccccccccccc', title: 'Leçon en erreur', updatedAt: 1 },
];

async function seed(sw: Worker): Promise<void> {
  await sw.evaluate(async (notes) => {
    const items: Record<string, unknown> = {};
    const index: Record<string, unknown> = {};
    for (const n of notes) {
      const url = `https://www.youtube.com/watch?v=${n.id.slice(8)}`;
      items[`note:${n.id}`] = { id: n.id, platform: 'youtube', kind: 'video', url, title: n.title, markdown: `[00:01] ${n.title}\n![Capture](assets/${n.id.replace(':', '-')}-00-01-ab12.png)`, rev: 2, createdAt: n.updatedAt, updatedAt: n.updatedAt };
      items[`asset:assets/${n.id.replace(':', '-')}-00-01-ab12.png`] = { path: `assets/${n.id.replace(':', '-')}-00-01-ab12.png`, noteId: n.id, mime: 'image/png', dataUrl: 'data:image/png;base64,AA', width: 2, height: 2, time: 1, createdAt: 1 };
      index[n.id] = { platform: 'youtube', kind: 'video', url, title: n.title, updatedAt: Date.UTC(2026, 8, 20 + n.updatedAt) };
    }
    const current = (await chrome.storage.sync.get('settings')).settings ?? {};
    await chrome.storage.sync.set({ settings: { ...current, desktopToken: 'jeton' } });
    await chrome.storage.local.set({
      ...items,
      'notes:index': index,
      // Only the second one still waits for the desktop app.
      'sync:outbox': { 'youtube:bbbbbbbbbbb': 2 },
      'notion:config': { token: 'secret_test', databaseId: 'db1', databaseUrl: 'https://www.notion.so/db1', parentId: 'p1', workspace: 'Cours', origin: 'extension' },
      'notion:link:youtube:aaaaaaaaaaa': { pageId: 'page-a', url: 'https://www.notion.so/page-a', blocks: [], syncedAt: 1, syncedRev: 2 },
      'notion:link:youtube:ccccccccccc': { pageId: 'page-c', blocks: [], syncedAt: 1, syncedRev: 1, error: 'body failed validation' },
      'notion:pending': { 'youtube:bbbbbbbbbbb': { kind: 'content', at: 1 } },
    });
  }, NOTES);
}

test('Données : chaque note dit si elle est synchronisée (app Desktop, Notion) ; une note, puis une sélection, supprimées', async ({ context, sw }) => {
  await seed(sw);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html#donnees`);
  const row = (title: string) => options.locator('#note-list li', { hasText: title });
  await expect(options.locator('#note-list li')).toHaveCount(3);
  // The summary says what waits, where.
  await expect(options.locator('#data-sync')).toHaveText(/App Desktop : 1 note en attente.* · Notion : 1 en erreur, 1 en attente/);
  // Note by note: in Notion (its page a click away), or a « Sync » button; the app's pill beside.
  await expect(row('Leçon synchronisée').locator('.sync-pill[data-state="synced"]')).toHaveText(['Desktop', 'Dans Notion']);
  await expect(row('Leçon synchronisée').getByRole('link', { name: /^Dans Notion/ })).toHaveAttribute('href', 'https://www.notion.so/page-a');
  await expect(row('Leçon en attente').locator('.sync-pill[data-state="pending"]')).toHaveText(['Desktop']);
  await expect(row('Leçon en attente').getByRole('button', { name: /^Notion : en attente\. Envoyer « Leçon en attente » maintenant/ })).toHaveText('Sync');
  await expect(row('Leçon en erreur').getByRole('button', { name: /^Notion : erreur — body failed validation\./ })).toHaveText('Sync');
  // No progress bars; where each one is filed instead.
  await expect(options.locator('#note-list .progress-bar')).toHaveCount(0);
  await expect(row('Leçon synchronisée').locator('.note-place')).toHaveText('Non rangée');

  // One note deleted (after confirming): gone from the list and from the browser, its picture too.
  options.once('dialog', (d) => void d.accept());
  await row('Leçon en attente').getByRole('button', { name: 'Supprimer « Leçon en attente »' }).click();
  await expect(options.locator('#note-list li')).toHaveCount(2);
  const stored = () =>
    options.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return Object.keys(all).filter((k) => k.startsWith('note:') || k.startsWith('asset:') || k.startsWith('notion:link:')).sort();
    });
  expect(await stored()).toEqual([
    'asset:assets/youtube-aaaaaaaaaaa-00-01-ab12.png',
    'asset:assets/youtube-ccccccccccc-00-01-ab12.png',
    'note:youtube:aaaaaaaaaaa',
    'note:youtube:ccccccccccc',
    'notion:link:youtube:aaaaaaaaaaa',
    'notion:link:youtube:ccccccccccc',
  ]);
  expect(await options.evaluate(async () => (await chrome.storage.local.get('notion:pending'))['notion:pending'])).toEqual({});

  // Cancelled: nothing deleted.
  options.once('dialog', (d) => void d.dismiss());
  await row('Leçon en erreur').getByRole('button', { name: /^Supprimer/ }).click();
  await expect(options.locator('#note-list li')).toHaveCount(2);

  // A selection: all of them.
  await options.getByRole('checkbox', { name: 'Tout sélectionner' }).check();
  await expect(options.locator('#data-selected')).toHaveText('2 notes sélectionnées');
  options.once('dialog', (d) => void d.accept());
  await options.getByRole('button', { name: 'Supprimer la sélection' }).click();
  await expect(options.locator('#data-summary')).toHaveText('Aucune note pour l’instant.');
  expect(await stored()).toEqual([]);
});

test('Données : « Sync » écrit la note dans Notion, dans la page de son cours — puis elle y est, sa page à un clic', async ({ context, sw }) => {
  const notion = startMockNotion();
  await notion.ready;
  try {
    notion.seedPage(PARENT_PAGE_ID, 'Mes cours');
    await sw.evaluate(async ({ api, parent }) => {
      const id = 'web:academy.test/airflow/hooks';
      const url = 'https://academy.test/airflow/hooks';
      await chrome.storage.local.set({
        [`note:${id}`]: { id, platform: 'web', kind: 'page', url, title: 'HookToolset', markdown: 'Un hook enveloppe une connexion', rev: 1, createdAt: 1, updatedAt: 1, course: 'AI Orchestration', chapter: 'Hooks', placedAt: 1 },
        'notes:index': { [id]: { platform: 'web', kind: 'page', url, title: 'HookToolset', updatedAt: 1, course: 'AI Orchestration', chapter: 'Hooks' } },
      });
      const hook = (globalThis as unknown as { booNotes: { notion: { apiBase?: string; connect(t: string, p: string): Promise<unknown> } } }).booNotes;
      hook.notion.apiBase = api;
      await hook.notion.connect('secret_test', parent);
    }, { api: notion.url, parent: PARENT_PAGE_ID });
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html#donnees`);
    const row = options.locator('#note-list li', { hasText: 'HookToolset' });
    await expect(row.locator('.note-place')).toHaveText('AI Orchestration › Hooks');
    await expect(row.getByRole('link', { name: /HookToolset/ })).toHaveAttribute('href', 'https://academy.test/airflow/hooks');
    await row.getByRole('button', { name: /Envoyer « HookToolset » maintenant, dans AI Orchestration › Hooks/ }).click();
    await expect(options.locator('#saved')).toContainText('« HookToolset » est dans Notion (AI Orchestration › Hooks)');
    const page = [...notion.state.pages.values()].find((p) => p.parent?.database_id)!;
    await expect(row.getByRole('link', { name: /^Dans Notion · AI Orchestration › Hooks/ })).toHaveAttribute('href', page.url);
    // In its course's page, under its chapter.
    const course = [...notion.state.pages.values()].find((p) => notion.titleOf(p.id) === 'AI Orchestration')!;
    expect(notion.pageContent(course.id)!.map((b) => b.text)).toEqual(['1 leçon · 1 chapitre · 0 terminée · 0 % du cours', 'Hooks', '@HookToolset  À commencer']);
    // Again: nothing made twice.
    await expect(row.getByRole('button', { name: /Sync/ })).toHaveCount(0);
    expect([...notion.state.pages.values()].filter((p) => p.parent?.database_id)).toHaveLength(1);
  } finally {
    await notion.close();
  }
});
