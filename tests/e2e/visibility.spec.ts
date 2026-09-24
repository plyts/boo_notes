import type { Page } from '@playwright/test';
import { expect, panel, runCommand, test } from './fixtures';

/**
 * The notes open and the page does not show them — seen on SCORM lessons
 * (Databricks Academy on Docebo): the lesson's frame fullscreen by itself,
 * the lesson shown in a modal dialog (top layer), or the page covering the
 * notes. Each time the notes must end up on screen.
 */

const LESSON = 'https://course.example.test/learn/courses/5855/lessons/63960:3559/agent-deployment';

function lessonPage(body: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent Deployment on Databricks</title>
<style>body{margin:0;font:16px sans-serif}iframe{border:0;display:block}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

test.beforeEach(async ({ context }) => {
  await context.route(/^https:\/\/course\.example\.test\/module/, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: lessonPage('<main style="padding:40px"><h1>Agent Deployment</h1><p>Model Serving deploys agents behind a REST endpoint.</p></main>') }),
  );
});

async function openLesson(page: Page, body: string, script = ''): Promise<void> {
  await page.route(LESSON, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: lessonPage(body, script) }));
  await page.goto(LESSON);
  await page.bringToFront();
}

/** The notes panel is what the page shows at its centre. */
const panelSeen = (page: Page) =>
  page.evaluate(() => {
    const host = document.getElementById('boo-notes-drawer');
    const drawer = host?.shadowRoot?.querySelector('.drawer.open');
    if (!host || !drawer) return false;
    const r = drawer.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 220)) === host;
  });

test('cadre sans Boo Notes seul en plein écran : il cède la place, les notes s’ouvrent à l’écran', async ({ context, page, sw }) => {
  // A frame of a site Boo Notes may not read: no agent in it to show the notes.
  await context.route(/^https:\/\/player\.noaccess\.example\//, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: lessonPage('<p>Course</p>') }));
  await openLesson(
    page,
    '<div id="player"><button id="fs">Plein écran</button><iframe id="course" src="https://player.noaccess.example/module" style="width:900px;height:560px"></iframe></div>',
    "document.getElementById('fs').onclick = () => document.getElementById('course').requestFullscreen();",
  );
  // Docebo's fullscreen button: the course frame alone fills the screen.
  await page.locator('#fs').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('course');
  await runCommand(sw, page, 'toggle-sidebar');
  await expect(panel(page).locator('.cm-content')).toBeVisible();
  // The frame alone cannot show them: it left its fullscreen (for its container, when Chrome allows it).
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).not.toBe('course');
  await expect.poll(() => panelSeen(page)).toBe(true);
});

test('leçon affichée dans une boîte de dialogue modale (top layer) : les notes s’y placent et restent utilisables', async ({ page, sw }) => {
  await openLesson(
    page,
    '<h1>Course</h1><dialog id="player" style="width:95vw;height:92vh;padding:0;border:0"><iframe src="/module" style="width:100%;height:100%"></iframe></dialog>',
    "document.getElementById('player').showModal();",
  );
  await expect.poll(() => page.evaluate(() => document.querySelector('dialog')!.matches(':modal'))).toBe(true);
  await runCommand(sw, page, 'toggle-sidebar');
  await expect(panel(page).locator('.cm-content')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.getElementById('boo-notes-drawer')?.parentElement?.id)).toBe('player');
  await expect.poll(() => panelSeen(page)).toBe(true);
  // Not inert: the note takes what is typed.
  await panel(page).locator('.cm-content').click();
  await page.keyboard.type('Model Serving');
  await expect(panel(page).locator('.cm-content')).toContainText('Model Serving');
});

test('la page recouvre les notes (calque au-dessus de tout) : premier plan, sinon fenêtre à part', async ({ context, page, sw }) => {
  // A page layer above everything, put back on top whenever something is added after it.
  await openLesson(
    page,
    '<iframe src="/module" style="width:100vw;height:100vh"></iframe>',
    `const cover = document.createElement('div');
     cover.id = 'cover';
     cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(255,255,255,0.01)';
     setInterval(() => { if (document.documentElement.lastElementChild !== cover) document.documentElement.append(cover); }, 100);`,
  );
  const popout = context.waitForEvent('page', { predicate: (p) => p.url().includes('panel/panel.html') && p.url().includes('mode=popout'), timeout: 15_000 });
  await runCommand(sw, page, 'toggle-sidebar');
  // Covered for good: the notes open in a window of their own, which no page can hide.
  const notes = await popout;
  await expect(notes.locator('.cm-content')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector('#boo-notes-drawer .drawer.open'))).toBeNull();
});

test('« Développer la vue de la leçon » (Databricks) : le cours reste en plein écran, les notes s’affichent dedans, puis reviennent', async ({ context, page, sw }) => {
  // The LMS: the course frame (SCORM launcher → driver → Rise content) and its « expand » button.
  await context.route(/^https:\/\/cdn5\.example\.test\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    const pages: Record<string, string> = {
      '/dcd/scormapi_v60/launcher.html': lessonPage('<iframe src="/scorm/abc/scormdriver/indexAPI.html" style="width:100%;height:100vh"></iframe>'),
      '/scorm/abc/scormdriver/indexAPI.html': lessonPage('<iframe src="/scorm/abc/scormcontent/index.html" style="width:100%;height:100vh"></iframe>'),
      '/scorm/abc/scormcontent/index.html': lessonPage('<main style="padding:40px"><h1>Agent Deployment</h1><p id="p1">Model Serving deploys agents behind a REST endpoint with autoscaling and monitoring.</p></main>'),
    };
    return pages[path] ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: pages[path] }) : route.fulfill({ status: 404, body: '' });
  });
  await openLesson(
    page,
    '<header>Databricks Learning <button id="expand" aria-label="Développer la vue de la leçon">⤢</button></header><iframe id="lo" src="https://cdn5.example.test/dcd/scormapi_v60/launcher.html" allow="autoplay" style="width:900px;height:560px"></iframe>',
    "document.getElementById('expand').onclick = () => document.getElementById('lo').requestFullscreen();",
  );
  await expect.poll(() => page.frames().some((f) => f.url().endsWith('/scormcontent/index.html'))).toBe(true);
  await runCommand(sw, page, 'toggle-sidebar');
  await expect(panel(page).locator('.cm-content')).toBeVisible();

  // Expanded: the course frame alone fills the screen — and stays so.
  await page.locator('#expand').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('lo');
  const launcher = page.frameLocator('#lo');
  // The notes show inside the course frame, open, usable.
  await expect(launcher.locator('#boo-notes-drawer .drawer.open')).toBeAttached({ timeout: 10_000 });
  const inFrame = launcher.frameLocator('#boo-notes-drawer iframe');
  await expect(inFrame.locator('.cm-content')).toBeVisible();
  await inFrame.locator('.cm-content').click();
  await page.keyboard.type('Model Serving en plein écran');
  await expect(inFrame.locator('.cm-content')).toContainText('Model Serving en plein écran');
  expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('lo');
  // Only one panel: the page's is gone meanwhile.
  expect(await page.evaluate(() => document.querySelector('#boo-notes-drawer iframe'))).toBeNull();

  // Collapsed again: the notes come back in the page, with what was written.
  await page.evaluate(() => document.exitFullscreen());
  await expect(panel(page).locator('.cm-content')).toContainText('Model Serving en plein écran', { timeout: 10_000 });
  await expect(launcher.locator('#boo-notes-drawer .drawer.open')).toHaveCount(0);
});

test('leçon déjà développée, puis Alt+Maj+N : les notes s’ouvrent dans le cours en plein écran', async ({ context, page, sw }) => {
  await context.route(/^https:\/\/cdn5\.example\.test\//, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: lessonPage('<main style="padding:40px"><h1>Agent Deployment</h1><p>Model Serving deploys agents behind a REST endpoint.</p></main>') }),
  );
  await openLesson(
    page,
    '<button id="expand">Développer la vue de la leçon</button><iframe id="lo" src="https://cdn5.example.test/dcd/launcher.html" style="width:900px;height:560px"></iframe>',
    "document.getElementById('expand').onclick = () => document.getElementById('lo').requestFullscreen();",
  );
  // Boo Notes started on the page (its agents in the frames), notes closed.
  await runCommand(sw, page, 'toggle-sidebar');
  await expect(panel(page).locator('.cm-content')).toBeVisible();
  await runCommand(sw, page, 'toggle-sidebar');
  await expect(page.locator('#boo-notes-drawer .drawer.open')).toHaveCount(0);
  await page.locator('#expand').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('lo');
  await page.waitForTimeout(500);
  await runCommand(sw, page, 'toggle-sidebar');
  const launcher = page.frameLocator('#lo');
  await expect(launcher.locator('#boo-notes-drawer .drawer.open')).toBeAttached({ timeout: 10_000 });
  await expect(launcher.frameLocator('#boo-notes-drawer iframe').locator('.cm-content')).toBeVisible();
  expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('lo');
});
