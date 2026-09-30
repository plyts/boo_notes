import type { Worker } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Options › Données: whether each note is synced (desktop app, Notion) or
 * waits, and notes deleted by hand — one, or a selection.
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
  // Note by note: green synced, orange waiting, red failed.
  await expect(row('Leçon synchronisée').locator('.sync-pill[data-state="synced"]')).toHaveText(['Desktop', 'Notion']);
  await expect(row('Leçon synchronisée').getByRole('link', { name: /Notion : synchronisée/ })).toHaveAttribute('href', 'https://www.notion.so/page-a');
  await expect(row('Leçon en attente').locator('.sync-pill[data-state="pending"]')).toHaveText(['Desktop', 'Notion']);
  await expect(row('Leçon en erreur').locator('.sync-pill[data-state="error"]')).toHaveAttribute('title', 'Notion : erreur — body failed validation');

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
