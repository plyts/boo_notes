import type { Page, Worker } from '@playwright/test';
import { PARENT_PAGE_ID, startMockNotion, type MockNotion } from '../../desktop/tools/mock-notion.mjs';
import { expect, panel, runCommand, storedNote, test } from './fixtures';

const ARTICLE = 'https://cours.example.test/ohm';
const NOTE = 'web:cours.example.test/ohm';
const FILLER = Array.from({ length: 14 }, (_, i) => `<p>Paragraphe de remplissage ${i + 1} : des électrons, des volts et des ampères.</p>`).join('');

const ARTICLE_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>La loi d’Ohm — Cours</title>
<style>body{margin:0;font:18px/1.6 sans-serif}main{max-width:640px;padding:24px}</style></head>
<body><main>
  <h1>Électricité</h1>
  <h2>La loi d’Ohm</h2>
  <p id="p1">La tension <b>U</b> aux bornes d’un conducteur ohmique est proportionnelle à l’intensité du courant qui le traverse.</p>
  ${FILLER}
  <h2>Les résistances</h2>
  <p id="p2">En série, les résistances s’additionnent.</p>
  ${FILLER}
</main></body></html>`;

test.beforeEach(async ({ context }) => {
  await context.route(/^https:\/\/cours\.example\.test\//, (route) =>
    new URL(route.request().url()).pathname === '/ohm'
      ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE_HTML })
      : route.fulfill({ status: 404, body: '' }),
  );
});

async function openArticle(page: Page, sw: Worker): Promise<void> {
  await page.goto(ARTICLE);
  await page.bringToFront();
  await runCommand(sw, page, 'toggle-sidebar');
  await expect(panel(page).locator('.platform')).toHaveText('Web · Lecture');
}

/** Selects the text of `#id` (or its first `words` words). */
async function select(page: Page, id: string, words?: number): Promise<string> {
  return page.evaluate(
    ({ id, words }) => {
      const el = document.getElementById(id) as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection() as Selection;
      sel.removeAllRanges();
      sel.addRange(range);
      if (words) {
        // Shrink to the first words.
        const text = el.textContent ?? '';
        const cut = text.split(' ').slice(0, words).join(' ').length;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let left = cut;
        for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
          if (left <= n.data.length) {
            range.setEnd(n, left);
            break;
          }
          left -= n.data.length;
        }
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.dispatchEvent(new Event('selectionchange'));
      return sel.toString().replace(/\s+/g, ' ').trim();
    },
    { id, words },
  );
}

const highlighted = (page: Page, name: string) =>
  page.evaluate((name) => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(name);
    return h ? [...h].map((r) => r.toString().replace(/\s+/g, ' ').trim()) : [];
  }, name);

test.describe('Mode lecture : prendre des notes sur une page web', () => {
  test('citer un passage : lien vers le passage, surlignage dans la page, retour au passage', async ({ page, sw }) => {
    await openArticle(page, sw);
    const quote = await select(page, 'p1');
    await runCommand(sw, page, 'insert-timestamp');
    await expect.poll(async () => (await storedNote(sw, NOTE))?.markdown ?? '').toContain(`> ${quote} [↗](${ARTICLE}#:~:text=`);
    const note = await storedNote(sw, NOTE);
    expect(note).toMatchObject({ title: 'La loi d’Ohm — Cours', kind: 'page' });

    // Page → note: the quoted passage is highlighted in the page.
    await expect.poll(() => highlighted(page, 'boo-notes-quote')).toEqual([quote]);
    await expect(panel(page).locator('.stats')).toHaveText('1 passage');

    // Note → page: the passage link scrolls back to it.
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await panel(page).locator('.cm-content').press('Enter');
    await panel(page).locator('.cm-boo-frag').first().click();
    await expect.poll(() => page.evaluate(() => document.getElementById('p1')!.getBoundingClientRect().top)).toBeLessThan(700);
    await expect.poll(() => highlighted(page, 'boo-notes-flash')).toEqual([quote]);
  });

  test('bulle « Citer » sur la sélection, repère de section sans sélection, progression de lecture', async ({ page, sw }) => {
    await openArticle(page, sw);
    // No selection: the line is anchored to the section being read.
    await runCommand(sw, page, 'insert-timestamp');
    await page.waitForTimeout(150);
    await panel(page).locator('.cm-content').pressSequentially('à revoir');
    await expect
      .poll(async () => (await storedNote(sw, NOTE))?.markdown)
      .toBe(`[↗ La loi d’Ohm](${ARTICLE}#:~:text=La%20loi%20d%E2%80%99Ohm) à revoir`);

    await page.evaluate(() => document.getElementById('p2')!.scrollIntoView({ block: 'center' }));
    const quote = await select(page, 'p2', 4);
    const bubble = page.locator('#boo-notes-overlay .quote-bubble');
    await expect(bubble).toBeVisible();
    await bubble.click();
    await expect.poll(async () => (await storedNote(sw, NOTE))?.markdown ?? '').toContain(`> ${quote} [↗]`);
    await expect(bubble).toBeHidden();

    // Reading progress: the furthest point reached.
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await expect
      .poll(async () => ((await sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], `progress:${NOTE}`)) as { position?: number } | undefined)?.position ?? 0)
      .toBeGreaterThan(95);
    await expect(panel(page).locator('.clock-now')).toHaveText('100 %');
  });

  test('[[liens]] : les titres des autres notes sont proposés, un clic ouvre la note liée', async ({ page, sw }) => {
    await sw.evaluate(async () => {
      const g = globalThis as unknown as { booNotes: { store: { saveNote(id: string, meta: object, md: string): Promise<unknown> } } };
      await g.booNotes.store.saveNote(
        'youtube:e2eTest0001',
        { platform: 'youtube', url: 'https://www.youtube.com/watch?v=e2eTest0001', title: 'Électricité — la vidéo', kind: 'video' },
        '[00:10] intro',
      );
    });
    await openArticle(page, sw);
    const editor = panel(page).locator('.cm-content');
    await editor.click();
    await editor.pressSequentially('Voir [[elec');
    await expect(panel(page).locator('.cm-tooltip-autocomplete')).toContainText('Électricité — la vidéo');
    await page.waitForTimeout(150);
    await editor.press('Enter');
    await editor.press('End');
    await editor.press('Enter');
    await expect.poll(async () => (await storedNote(sw, NOTE))?.markdown ?? '').toContain('Voir [[Électricité — la vidéo]]');
    await expect(panel(page).locator('.stats')).toHaveText('1 lien');

    await panel(page).locator('.cm-boo-wiki').click();
    await expect(panel(page).locator('.notice')).toContainText('ouvert dans un nouvel onglet');
    // (The tab itself may not load in the test sandbox: its requested URL is checked.)
    await expect
      .poll(() => sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.pendingUrl ?? t.url ?? '')))
      .toContainEqual(expect.stringContaining('youtube.com/watch?v=e2eTest0001'));
  });
});

test.describe('Notion sans l’app Desktop', () => {
  let mock: MockNotion;

  test.beforeEach(async () => {
    mock = startMockNotion();
    await mock.ready;
    mock.seedPage(PARENT_PAGE_ID, 'Mes cours');
  });

  test.afterEach(async () => {
    await mock.close();
  });

  test('connexion dans les options, puis « Envoyer vers Notion » écrit la note dans le tableau', async ({ page, sw, context }) => {
    await sw.evaluate((url) => {
      (globalThis as unknown as { booNotes: { notion: { apiBase?: string } } }).booNotes.notion.apiBase = url;
    }, mock.url);
    const extId = new URL(sw.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extId}/options/options.html#notion`);
    await options.locator('#notion-token').fill('secret_test');
    await options.locator('#notion-page').fill(`https://www.notion.so/Mes-cours-${PARENT_PAGE_ID.replace(/-/g, '')}`);
    await options.locator('#notion-connect').click();
    await expect(options.locator('#notion-badge')).toHaveText(/^Connecté/);
    await expect(options.locator('#notion-open')).toBeVisible();
    await options.close();

    await openArticle(page, sw);
    await select(page, 'p1');
    await runCommand(sw, page, 'insert-timestamp');
    await expect.poll(async () => (await storedNote(sw, NOTE))?.markdown ?? '').toContain('> La tension');

    await panel(page).getByRole('button', { name: 'Exporter la note' }).click();
    const item = panel(page).locator('.menu [data-target="notion"]');
    await expect(item).toBeEnabled();
    await expect(item.locator('small')).toHaveText('Directement (app Desktop fermée)');
    await item.click();
    await expect(panel(page).locator('.notice')).toContainText('Envoyé vers Notion');

    const pages = [...mock.state.pages.values()].filter((p) => p.parent?.database_id);
    expect(pages.map((p) => mock.titleOf(p.id))).toEqual(['La loi d’Ohm — Cours']);
    expect(JSON.stringify(mock.pageContent(pages[0].id))).toContain('La tension U aux bornes');
  });
});
