import type { Page, Worker } from '@playwright/test';
import { OAUTH_CLIENT, PARENT_PAGE_ID, startMockNotion, type MockNotion } from '../../tools/mock-notion/server.mjs';
import { startExchange, type Exchange } from '../../tools/notion-oauth/server.mjs';
import { expect, openNotes, openWatch, panel, setVideo, storedNote, test } from './fixtures';

/**
 * « Connecter Notion »: one button. Notion's consent window (OAuth), the code
 * exchanged by the small server holding the client secret, then everything
 * without asking: the page of the table, the table, the notes. « Déconnecter
 * Notion » withdraws the access in Notion too; an expired access is renewed.
 */

let notion: MockNotion;
let exchange: Exchange;

test.beforeEach(async ({ sw }) => {
  notion = startMockNotion();
  await notion.ready;
  notion.seedPage('22222222-2222-4222-8222-222222222222', 'Cours de maths');
  exchange = startExchange({ env: { NOTION_CLIENT_ID: OAUTH_CLIENT.clientId, NOTION_CLIENT_SECRET: OAUTH_CLIENT.clientSecret, NOTION_API: notion.url } });
  await exchange.ready;
  await sw.evaluate(
    ({ api, token, authorize }) => {
      const hook = (globalThis as unknown as { booNotes: { notion: { apiBase?: string }; notionOAuth: unknown } }).booNotes;
      hook.notion.apiBase = api;
      hook.notionOAuth = { clientId: 'client-test', exchangeUrl: token, authorizeUrl: authorize };
    },
    { api: notion.url, token: `${exchange.url}/token`, authorize: `${notion.url}/v1/oauth/authorize` },
  );
});

test.afterEach(async () => {
  await exchange.close();
  await notion.close();
});

async function openOptions(page: Page, sw: Worker): Promise<void> {
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html#notion`);
}

const flush = (sw: Worker) => sw.evaluate(() => (globalThis as unknown as { booNotes: { notion: { flush(): Promise<void> } } }).booNotes.notion.flush());
const storedConfig = (sw: Worker) => sw.evaluate(async () => (await chrome.storage.local.get('notion:config'))['notion:config'] as Record<string, unknown> | undefined);
/** The Notion pages written for notes (rows of the table), with their text. */
const notePages = () =>
  [...notion.state.pages.values()].filter((p) => p.parent?.database_id).map((p) => ({ title: notion.titleOf(p.id), text: JSON.stringify(notion.pageContent(p.id)) }));

test('options : « Connecter Notion », la fenêtre Notion, « Autoriser » — le reste se fait seul ; « Déconnecter Notion » retire l’accès', async ({ context, page, sw }) => {
  await openOptions(page, sw);
  const connect = page.getByRole('button', { name: 'Connecter Notion', exact: true });
  await expect(connect).toBeEnabled();
  // The integration secret is only the advanced way now.
  await expect(page.locator('#notion-advanced')).not.toHaveAttribute('open', '');

  // Cancelled in Notion: said so, nothing connected.
  let consent = context.waitForEvent('page', { predicate: (p) => p.url().includes('/v1/oauth/authorize') });
  await connect.click();
  await (await consent).locator('#cancel').click();
  await expect(page.locator('#saved')).toContainText('connexion annulée');
  await expect(page.locator('#notion-badge')).toHaveText('Non connecté');

  // Allowed: no question asked — the page speaking of courses receives the table.
  consent = context.waitForEvent('page', { predicate: (p) => p.url().includes('/v1/oauth/authorize') });
  await connect.click();
  const window = await consent;
  await expect(window.getByRole('heading')).toHaveText('Boo Notes souhaite accéder à votre espace Notion');
  await window.locator('#allow').click();
  await expect(page.locator('#notion-badge')).toHaveText('Connecté avec votre compte Notion · Espace de test');
  await expect(page.locator('#saved')).toContainText('page « Mes cours »');
  await expect(connect).toBeHidden();
  const db = [...notion.state.databases.values()][0];
  expect(db.parent.page_id).toBe(PARENT_PAGE_ID);
  expect(await storedConfig(sw)).toMatchObject({ token: 'secret_test', via: 'oauth', workspace: 'Espace de test', refreshToken: 'refresh-1' });

  // Disconnected: forgotten here, and the access withdrawn in Notion.
  await page.getByRole('button', { name: 'Déconnecter Notion' }).click();
  await expect(page.locator('#notion-badge')).toHaveText('Non connecté');
  expect(notion.state.revoked).toEqual(['secret_test']);
  expect(await storedConfig(sw)).toBeUndefined();
  await expect(connect).toBeVisible();
});

test('panneau de notes : « Connecter Notion » en un clic (modèle Boo Notes), notes envoyées, accès renouvelé, puis « Déconnecter Notion »', async ({ context, page, sw }) => {
  await openWatch(page);
  await setVideo(page, 4);
  await openNotes(sw, page);
  await page.keyboard.type('Idée à garder');
  const p = panel(page);
  const chip = p.getByRole('button', { name: 'Connecter Notion', exact: true });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('Connecter Notion', { useInnerText: true });

  // One click: Notion's window, « Utiliser le modèle », and that's all.
  const consent = context.waitForEvent('page', { predicate: (w) => w.url().includes('/v1/oauth/authorize') });
  await chip.click();
  await (await consent).locator('#template').click();
  await expect(p.locator('.notice')).toContainText('Notion connecté : vos notes vont dans « Boo Notes — Mes notes » (page « Boo Notes »)');
  const connected = p.getByRole('button', { name: 'Notion connecté (Espace de test)' });
  await expect(connected).toHaveAttribute('data-state', 'on');
  // The table is in the page copied from Boo Notes' template.
  const template = [...notion.state.pages.values()].find((pg) => notion.titleOf(pg.id) === 'Boo Notes')!;
  expect([...notion.state.databases.values()][0].parent.page_id).toBe(template.id);
  // The notes already taken go to Notion by themselves.
  await flush(sw);
  await expect.poll(() => notePages().map((n) => n.text).join()).toContain('Idée à garder');

  // Notion stops taking the access: renewed without the user, the sync goes on.
  notion.expireToken();
  await p.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' — et la suite');
  await expect.poll(async () => (await storedNote(sw))?.markdown ?? '').toContain('et la suite');
  await flush(sw);
  await expect.poll(() => notePages().map((n) => n.text).join()).toContain('et la suite');
  expect(await storedConfig(sw)).toMatchObject({ token: notion.token, refreshToken: 'refresh-2' });
  await expect(connected).toHaveAttribute('data-state', 'on');

  // Its menu: the table, and « Déconnecter Notion ».
  await connected.click();
  const menu = p.getByRole('menu', { name: 'Notion' });
  await expect(menu.getByRole('menuitem', { name: /Ouvrir mon tableau Notion/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: /Déconnecter Notion/ }).click();
  await expect(p.locator('.notice')).toContainText('Notion déconnecté');
  await expect(p.getByRole('button', { name: 'Connecter Notion', exact: true })).toBeVisible();
  expect(notion.state.revoked).toHaveLength(1);
  expect(await storedConfig(sw)).toBeUndefined();
});
