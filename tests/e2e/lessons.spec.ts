import type { Frame, Page, Worker } from '@playwright/test';
import { expect, openNotes, panel, storedNote, test } from './fixtures';

/**
 * A course module (Articulate Rise-like) shown in a frame of the LMS page:
 * its lessons change inside the frame (`#/lessons/…`), the page's address
 * stays the same. Each lesson is its own note: filing one never moves
 * another, and every lesson filed in a chapter is found again from the menu.
 */

const MODULE = 'https://academy.example.test/learn/courses/77/ai-orchestration';
const PAGE_NOTE = 'web:academy.example.test/learn/courses/77/ai-orchestration';
const INTRO = `${PAGE_NOTE}#lesson/lessons/intro`;
const HOOKS = `${PAGE_NOTE}#lesson/lessons/hooks`;

function html(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font:16px/1.6 sans-serif}main{padding:24px 32px}iframe{border:0;display:block}</style>
</head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

test.beforeEach(async ({ context }) => {
  await context.route(/^https:\/\/academy\.example\.test\//, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: html(
        'AI Orchestration — Academy',
        '<header style="height:60px">Academy (fixture)</header><iframe id="module" src="https://rise.example.test/course/index.html#/lessons/intro" style="width:900px;height:620px"></iframe>',
      ),
    }),
  );
  // The module: one page, its lessons behind `#/lessons/…`, each with its heading.
  await context.route(/^https:\/\/rise\.example\.test\//, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: html(
        'AI Orchestration: From LLM to Running Agents',
        `<main><h1 class="lesson-header__title"></h1><p id="body"></p>
           <nav><a href="#/lessons/intro">Introduction</a> <a href="#/lessons/hooks">Hooks</a></nav></main>`,
        `const lessons = {
           '#/lessons/intro': ['Introduction to Airflow', 'Airflow orchestrates tasks as a graph of dependencies.'],
           '#/lessons/hooks': ['HookToolset: turning Airflow hooks into agent tools', 'A hook wraps the connection to an external system.'],
         };
         const show = () => {
           const [title, text] = lessons[location.hash] ?? ['', ''];
           document.querySelector('h1').textContent = title;
           document.getElementById('body').textContent = text;
         };
         addEventListener('hashchange', show);
         show();`,
      ),
    }),
  );
});

function moduleFrame(page: Page): Frame {
  const f = page.frames().find((x) => x.url().startsWith('https://rise.example.test/'));
  if (!f) throw new Error('module frame not found');
  return f;
}

async function lessonTo(page: Page, hash: string): Promise<void> {
  await moduleFrame(page).evaluate((h) => {
    location.hash = h;
  }, hash);
}

async function placeIn(page: Page, course: string | null, chapter: string): Promise<void> {
  const p = panel(page);
  await p.locator('.place').click();
  const menu = p.getByRole('menu', { name: 'Ranger dans un cours' });
  if (course) {
    await menu.getByLabel('Cours', { exact: true }).fill(course);
    await menu.getByLabel('Chapitre', { exact: true }).fill(chapter);
    await menu.getByRole('button', { name: 'Ranger', exact: true }).click();
  } else {
    await menu.getByRole('menuitemradio', { name: chapter }).click();
  }
}

const filed = async (sw: Worker, id: string) => {
  const n = (await storedNote(sw, id)) as { course?: string; chapter?: string } | undefined;
  return n ? `${n.course} › ${n.chapter}` : null;
};

test('module de cours en cadre : une note par leçon, ranger la seconde n’écrase pas la première, chacune retrouvée depuis le menu', async ({ context, page, sw }) => {
  await page.goto(MODULE);
  await page.bringToFront();
  await expect.poll(() => page.frames().some((f) => f.url().startsWith('https://rise.example.test/'))).toBe(true);
  await openNotes(sw, page);
  const p = panel(page);

  // Lesson 1: its own note, under its own title.
  await expect(p.locator('.title')).toHaveText('Introduction to Airflow');
  await p.locator('.cm-content').click();
  await page.keyboard.type('Les DAG décrivent les dépendances');
  await expect.poll(async () => (await storedNote(sw, INTRO))?.markdown ?? '').toContain('Les DAG décrivent les dépendances');
  await placeIn(page, 'AI Orchestration', 'Hooks et outils');
  await expect.poll(() => filed(sw, INTRO)).toBe('AI Orchestration › Hooks et outils');

  // Lesson 2 of the same module: another note, empty, its own title.
  await lessonTo(page, '#/lessons/hooks');
  await expect(p.locator('.title')).toHaveText('HookToolset: turning Airflow hooks into agent tools');
  await expect(p.locator('.cm-content')).not.toContainText('Les DAG');
  await p.locator('.cm-content').click();
  await page.keyboard.type('Un hook enveloppe une connexion');
  await expect.poll(async () => (await storedNote(sw, HOOKS))?.markdown ?? '').toContain('Un hook enveloppe une connexion');
  // Filed in the same chapter: the first lesson stays where it was.
  await placeIn(page, null, 'Hooks et outils');
  await expect.poll(() => filed(sw, HOOKS)).toBe('AI Orchestration › Hooks et outils');
  expect(await filed(sw, INTRO)).toBe('AI Orchestration › Hooks et outils');
  expect((await storedNote(sw, INTRO))?.markdown).toContain('Les DAG décrivent les dépendances');
  expect(await storedNote(sw, PAGE_NOTE)).toBeUndefined();

  // The menu: both lessons under the chapter, this one marked, the other reopened in a click.
  await p.locator('.place').click();
  const menu = p.getByRole('menu', { name: 'Ranger dans un cours' });
  const lessons = menu.locator('.place-note');
  await expect(lessons).toHaveCount(2);
  await expect(menu.locator('.place-note[disabled]')).toContainText('HookToolset');
  const tabsOnModule = () => sw.evaluate(async (url) => (await chrome.tabs.query({})).filter((t) => (t.pendingUrl || t.url) === url).length, MODULE);
  expect(await tabsOnModule()).toBe(1);
  const opened = context.waitForEvent('page');
  await menu.getByRole('menuitem', { name: /Introduction to Airflow/ }).click();
  // A new tab on the module (the page the lesson is in: the course resumes there).
  const reopened = await opened;
  await expect.poll(tabsOnModule).toBe(2);
  await expect(p.locator('.notice')).toContainText('« Introduction to Airflow » rouverte');
  await reopened.close();
  await page.bringToFront();

  // Back to lesson 1 in this tab: its note comes back.
  await lessonTo(page, '#/lessons/intro');
  await expect(p.locator('.title')).toHaveText('Introduction to Airflow');
  await expect(p.locator('.cm-content')).toContainText('Les DAG décrivent les dépendances');
});
