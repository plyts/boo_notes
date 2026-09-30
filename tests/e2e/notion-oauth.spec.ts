import type { Page, Worker } from '@playwright/test';
import { OAUTH_CLIENT, PARENT_PAGE_ID, startMockNotion, type MockNotion } from '../../tools/mock-notion/server.mjs';
import { startExchange, type Exchange } from '../../tools/notion-oauth/server.mjs';
import { expect, test } from './fixtures';

/**
 * « Se connecter avec Notion »: Notion's consent window (OAuth), the code
 * exchanged by the small server holding the client secret, then the page of
 * the notes table picked among those shared — nothing to copy.
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

test('« Se connecter avec Notion » : la fenêtre Notion, « Autoriser », la page choisie, le tableau créé — sans rien copier', async ({ context, page, sw }) => {
  await openOptions(page, sw);
  await expect(page.getByRole('button', { name: 'Se connecter avec Notion' })).toBeEnabled();
  // The integration secret is only the advanced way now.
  await expect(page.locator('#notion-advanced')).not.toHaveAttribute('open', '');

  // Cancelled in Notion: said so, nothing connected.
  let consent = context.waitForEvent('page', { predicate: (p) => p.url().includes('/v1/oauth/authorize') });
  await page.getByRole('button', { name: 'Se connecter avec Notion' }).click();
  await (await consent).locator('#cancel').click();
  await expect(page.locator('#saved')).toContainText('connexion annulée');
  await expect(page.locator('#notion-badge')).toHaveText('Non connecté');

  // Allowed: the pages shared are offered.
  consent = context.waitForEvent('page', { predicate: (p) => p.url().includes('/v1/oauth/authorize') });
  await page.getByRole('button', { name: 'Se connecter avec Notion' }).click();
  const window = await consent;
  await expect(window.getByRole('heading')).toHaveText('Boo Notes souhaite accéder à votre espace Notion');
  await window.locator('#allow').click();
  const place = page.getByRole('group', { name: 'Où créer le tableau « Boo Notes — Mes notes » ?' });
  await expect(place.getByRole('radio')).toHaveCount(2);
  await place.getByRole('radio', { name: 'Cours de maths' }).check();
  await page.getByRole('button', { name: 'Créer le tableau ici' }).click();
  await expect(page.locator('#notion-badge')).toHaveText('Connecté avec votre compte Notion · Espace de test');
  await expect(page.getByRole('button', { name: 'Se connecter avec Notion' })).toBeHidden();
  // The table, in the page chosen; the access kept by the extension.
  const db = [...notion.state.databases.values()][0];
  expect(db.parent.page_id).toBe('22222222-2222-4222-8222-222222222222');
  expect(db.parent.page_id).not.toBe(PARENT_PAGE_ID);
  const config = await sw.evaluate(async () => (await chrome.storage.local.get('notion:config'))['notion:config']);
  expect(config).toMatchObject({ token: 'secret_test', via: 'oauth', workspace: 'Espace de test' });
});
