import type { Page, Worker } from '@playwright/test';
import { OAUTH_CLIENT, PARENT_PAGE_ID, startMockNotion, type MockNotion } from '../../tools/mock-notion/server.mjs';
import { startExchange, type Exchange } from '../../tools/notion-oauth/server.mjs';
import { expect, openNotes, openWatch, panel, setVideo, storedNote, test } from './fixtures';

/**
 * « Se connecter à… › Notion »: Notion's consent window (OAuth), the code
 * exchanged by the small server holding the client secret, then the name of
 * the vault (« Boo Notes » by default, or one already there) — and the rest
 * by itself: the table, a page per course, the notes. « Déconnecter »
 * withdraws the access in Notion too; an expired access is renewed.
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

test('options : « Se connecter à Notion », la fenêtre Notion, le nom du coffre — fait seul, puis « Déconnecter Notion » retire l’accès', async ({ context, page, sw }) => {
  await openOptions(page, sw);
  const connect = page.getByRole('button', { name: 'Se connecter à Notion', exact: true });
  await expect(connect).toBeEnabled();
  // The integration secret is only the advanced way now.
  await expect(page.locator('#notion-advanced')).not.toHaveAttribute('open', '');

  // Cancelled in Notion: said so, nothing connected.
  let consent = context.waitForEvent('page', { predicate: (p) => p.url().includes('/v1/oauth/authorize') });
  await connect.click();
  await (await consent).locator('#cancel').click();
  await expect(page.locator('#saved')).toContainText('connexion annulée');
  await expect(page.locator('#notion-badge')).toHaveText('Non connecté');

  // Allowed: the vault to name, « Boo Notes » offered; made in the page speaking of courses.
  consent = context.waitForEvent('page', { predicate: (p) => p.url().includes('/v1/oauth/authorize') });
  await connect.click();
  const window = await consent;
  await expect(window.getByRole('heading')).toHaveText('Boo Notes souhaite accéder à votre espace Notion');
  await window.locator('#allow').click();
  const vault = page.getByRole('group', { name: 'Votre coffre Notion' });
  await expect(vault.getByRole('textbox', { name: 'Nom du coffre' })).toHaveValue('Boo Notes');
  await page.getByRole('button', { name: 'Valider' }).click();
  await expect(page.locator('#notion-badge')).toHaveText('Connecté à Notion · coffre « Boo Notes »');
  await expect(connect).toBeHidden();
  const made = [...notion.state.pages.values()].find((p) => notion.titleOf(p.id) === 'Boo Notes')!;
  expect(made.parent.page_id).toBe(PARENT_PAGE_ID);
  expect([...notion.state.databases.values()][0].parent.page_id).toBe(made.id);
  await expect(page.locator('#notion-open')).toHaveAttribute('href', made.url);
  expect(await storedConfig(sw)).toMatchObject({ token: 'secret_test', via: 'oauth', workspace: 'Espace de test', refreshToken: 'refresh-1', vaultName: 'Boo Notes' });

  // Disconnected: forgotten here, and the access withdrawn in Notion.
  await page.getByRole('button', { name: 'Déconnecter Notion' }).click();
  await expect(page.locator('#notion-badge')).toHaveText('Non connecté');
  expect(notion.state.revoked).toEqual(['secret_test']);
  expect(await storedConfig(sw)).toBeUndefined();
  await expect(connect).toBeVisible();

  // Connected again: the vault found again, offered first — not a second one.
  consent = context.waitForEvent('page', { predicate: (p) => p.url().includes('/v1/oauth/authorize') });
  await connect.click();
  await (await consent).locator('#allow').click();
  await expect(vault.getByRole('radio', { name: '👻 Boo Notes' })).toBeChecked();
  await page.getByRole('button', { name: 'Valider' }).click();
  await expect(page.locator('#notion-badge')).toHaveText('Connecté à Notion · coffre « Boo Notes »');
  expect(notion.state.databases.size).toBe(1);
});

test('panneau de notes : « Se connecter à… » › Notion › nom du coffre › Valider ; notes rangées par cours, accès renouvelé, puis « Déconnecter »', async ({ context, page, sw }) => {
  await openWatch(page);
  await setVideo(page, 4);
  await openNotes(sw, page);
  await page.keyboard.type('Idée à garder');
  const p = panel(page);
  // No « Hors-ligne », no « Notion » badge: one button.
  await expect(p.locator('.status')).toHaveCount(0);
  const button = p.getByRole('button', { name: 'Se connecter à…' });
  await expect(button).toHaveText('Se connecter à…');
  await button.click();
  const pop = p.getByRole('dialog', { name: 'Se connecter à' });
  await expect(pop.getByRole('button', { name: /^Notion/ })).toBeVisible();
  await expect(pop.getByRole('button', { name: /^Boo Notes Desktop/ })).toContainText('Non détectée');

  // Notion: its window, « Utiliser le modèle »; then the vault, named.
  const consent = context.waitForEvent('page', { predicate: (w) => w.url().includes('/v1/oauth/authorize') });
  await pop.getByRole('button', { name: /^Notion/ }).click();
  await (await consent).locator('#template').click();
  const name = pop.getByRole('textbox', { name: 'Nom du coffre' });
  await expect(name).toHaveValue('Boo Notes');
  await name.fill('Coursera notes');
  await pop.getByRole('button', { name: 'Valider' }).click();
  await expect(p.locator('.notice')).toContainText('Notion connecté : vos notes vont dans le coffre « Coursera notes »');
  const connected = p.getByRole('button', { name: 'Connecté à Notion · coffre « Coursera notes »' });
  await expect(connected).toHaveAttribute('data-state', 'on');
  await expect(connected).toHaveText('Coursera notes');
  // The vault is the page copied from Boo Notes' template, named; its table inside.
  const vault = [...notion.state.pages.values()].find((pg) => notion.titleOf(pg.id) === 'Coursera notes')!;
  expect([...notion.state.databases.values()][0].parent.page_id).toBe(vault.id);
  // The notes already taken go to Notion by themselves (filed nowhere yet: « Notes à ranger »).
  await flush(sw);
  await expect.poll(() => notePages().map((n) => n.text).join()).toContain('Idée à garder');
  expect(notion.pageContent(vault.id)!.filter((b) => b.type === 'child_page').map((b) => b.text)).toEqual(['Notes à ranger']);

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

  // Its window: the vault, open it, sync, disconnect.
  await connected.click();
  await expect(pop).toContainText('Coursera notes');
  await expect(pop.getByRole('button', { name: 'Ouvrir le coffre dans Notion' })).toBeVisible();
  await pop.getByRole('button', { name: 'Déconnecter' }).click();
  await expect(p.locator('.notice')).toContainText('Notion déconnecté');
  await expect(p.getByRole('button', { name: 'Se connecter à…' })).toBeVisible();
  expect(notion.state.revoked).toHaveLength(1);
  expect(await storedConfig(sw)).toBeUndefined();
});
