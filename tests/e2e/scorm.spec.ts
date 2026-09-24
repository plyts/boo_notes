import type { Frame, Page, Worker } from '@playwright/test';
import { expect, openNotes, panel, runCommand, storedNote, test } from './fixtures';

/**
 * A course module (SCORM) in an LMS like Docebo: the lesson page holds the
 * LMS player in a frame, which holds the module (Articulate Rise-like pages)
 * in another frame, and a video hosted elsewhere inside it. Notes are taken
 * on it as on any page: quotes of the module's text, anchors to its
 * headings, captures of the module only, its SCORM progress, its frames to
 * allow.
 */

const LESSON = 'https://academy.example.test/learn/courses/5856/agents-on-databricks/lessons/64272:3565/agents-mcp-and-ai-governance';
const NOTE = `web:academy.example.test/learn/courses/5856/agents-on-databricks/lessons/64272:3565/agents-mcp-and-ai-governance`;

function html(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font:16px/1.6 sans-serif}main{padding:24px 32px}iframe{border:0;display:block}</style>
</head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

test.beforeEach(async ({ context }) => {
  // The LMS page: its header, and the player of the lesson.
  await context.route(/^https:\/\/academy\.example\.test\//, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: html(
        'Agents, MCP, and AI Governance on Databricks',
        '<header style="height:64px;background:#1b3139;color:#fff;padding:0 24px">Databricks Academy (fixture)</header><iframe id="player" src="https://lms-player.example.test/player/3565" style="width:900px;height:620px"></iframe>',
      ),
    }),
  );
  await context.route(/^https:\/\/lms-player\.example\.test\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/player/'))
      // The LMS player: the SCORM 2004 API the module talks to, and the module.
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: html(
          'Player',
          '<iframe id="module" src="/scorm/64272/index.html" style="width:100vw;height:100vh"></iframe>',
          `window.API_1484_11 = {
             data: {},
             Initialize() { return 'true'; },
             Terminate() { return 'true'; },
             GetValue(k) { return this.data[k] ?? ''; },
             SetValue(k, v) { this.data[k] = String(v); return 'true'; },
             Commit() { return 'true'; },
             GetLastError() { return '0'; },
             GetErrorString() { return ''; },
             GetDiagnostic() { return ''; },
           };`,
        ),
      });
    // The module: pages of text, a « Continuer » button, a video hosted elsewhere.
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: html(
        'Agents, MCP, and AI Governance',
        `<main>
           <h1>Agents on Databricks</h1>
           <p id="def">An agent is a system that uses a language model to decide which tools to call.</p>
           <h2>Model Context Protocol</h2>
           <p id="mcp">MCP is an open protocol that standardizes how applications provide context to models.</p>
           <iframe src="https://videos.scorm-cdn.example/embed/42" style="width:640px;height:360px"></iframe>
           <h2>AI Governance</h2>
           <p>Unity Catalog governs data and AI assets.</p>
           <button id="next">Continuer</button>
           <div style="height:1200px"></div>
         </main>`,
        `const api = parent.API_1484_11;
         document.getElementById('next').addEventListener('click', () => {
           api.SetValue('cmi.location', 'page-2');
           api.SetValue('cmi.progress_measure', '0.5');
           api.SetValue('cmi.completion_status', 'incomplete');
           api.Commit('');
         });
         window.finish = () => { api.SetValue('cmi.progress_measure', '1'); api.SetValue('cmi.completion_status', 'completed'); api.SetValue('cmi.score.raw', '90'); };`,
      ),
    });
  });
  // A video host Boo Notes has no access to.
  await context.route(/^https:\/\/videos\.scorm-cdn\.example\//, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: html('Vidéo', '<p>video</p>') }),
  );
});

function frameOf(page: Page, prefix: string): Frame {
  const f = page.frames().find((x) => x.url().startsWith(prefix));
  if (!f) throw new Error(`frame ${prefix} not found`);
  return f;
}

async function openLesson(page: Page, sw: Worker): Promise<Frame> {
  await page.goto(LESSON);
  await page.bringToFront();
  await expect.poll(() => page.frames().some((f) => f.url().includes('/scorm/64272/'))).toBe(true);
  await openNotes(sw, page);
  const module = frameOf(page, 'https://lms-player.example.test/scorm/');
  // The frame agents of the LMS player and of the module are in place.
  await expect.poll(() => module.evaluate(() => document.querySelector('boo-notes-quote') !== null || typeof (window as unknown as { finish?: unknown }).finish === 'function')).toBe(true);
  return module;
}

async function select(frame: Frame, id: string): Promise<void> {
  await frame.evaluate((id) => {
    const p = document.getElementById(id)!;
    p.scrollIntoView({ block: 'center' });
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, id);
}

test.describe('Module de cours SCORM (LMS type Docebo)', () => {
  test('citer le module, s’ancrer à ses titres, capturer le module, suivre sa progression SCORM', async ({ page, sw }) => {
    const module = await openLesson(page, sw);
    const notes = panel(page);
    await expect(notes.locator('.platform')).toHaveText('Web · Lecture');

    // The module reports to the LMS: its progress shows with the notes.
    await module.locator('#next').click();
    await expect(notes.locator('.platform')).toHaveText('Web · Module SCORM · En cours · 50 %');
    await expect(notes.locator('.platform')).toHaveAttribute('title', 'Repère du module : page-2');

    // A selection in the module: its « Citer » bubble quotes it in the note, linked to the lesson.
    await select(module, 'def');
    const bubble = module.locator('boo-notes-quote');
    await expect(bubble).toBeVisible();
    await bubble.getByRole('button', { name: 'Citer dans la note' }).click();
    await expect
      .poll(async () => (await storedNote(sw, NOTE))?.markdown)
      .toContain(`> An agent is a system that uses a language model to decide which tools to call. [↗](${LESSON}#:~:text=`);

    // Alt+Shift+T with a selection in the module: quoted too.
    await select(module, 'mcp');
    await expect.poll(async () => module.evaluate(() => getSelection()!.toString().length)).toBeGreaterThan(10);
    await page.waitForTimeout(300);
    await runCommand(sw, page, 'insert-timestamp');
    await expect.poll(async () => (await storedNote(sw, NOTE))?.markdown).toContain('> MCP is an open protocol that standardizes how applications provide context to models.');

    // The quoted passages are highlighted in the module.
    await expect.poll(() => module.evaluate(() => (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights.get('boo-notes-quote')?.size ?? 0)).toBe(2);

    // Without a selection: a new line anchored to the heading read in the module.
    await module.evaluate(() => getSelection()!.removeAllRanges());
    await module.evaluate(() => document.querySelectorAll('h2')[1].scrollIntoView());
    await page.waitForTimeout(700);
    await runCommand(sw, page, 'insert-timestamp');
    await page.keyboard.type('gouvernance des données');
    await expect.poll(async () => (await storedNote(sw, NOTE))?.markdown).toMatch(/\[↗ AI Governance\]\([^)]+#:~:text=AI%20Governance\) gouvernance des données/);

    // A capture: the module only (not the LMS header), titled with the heading read.
    // (Chrome captures a tab only after a real click or shortcut: its screenshot is stood in for here.)
    const view = await page.evaluate(() => ({ w: Math.round(innerWidth * devicePixelRatio), h: Math.round(innerHeight * devicePixelRatio) }));
    await sw.evaluate(({ w, h }) => {
      Object.defineProperty(chrome.tabs, 'captureVisibleTab', {
        configurable: true,
        value: async () => {
          const canvas = new OffscreenCanvas(w, h);
          canvas.getContext('2d')!.fillRect(0, 0, w, h);
          const blob = await canvas.convertToBlob({ type: 'image/png' });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (const b of bytes) bin += String.fromCharCode(b);
          return `data:image/png;base64,${btoa(bin)}`;
        },
      });
    }, view);
    await runCommand(sw, page, 'capture-screenshot');
    await expect.poll(async () => (await storedNote(sw, NOTE))?.markdown).toMatch(/!\[Capture — AI Governance\]\(assets\/[^)]+\)/);
    const asset = /!\[Capture — AI Governance\]\((assets\/[^)]+)\)/.exec((await storedNote(sw, NOTE))!.markdown)![1];
    const size = await sw.evaluate(async (key) => {
      const a = (await chrome.storage.local.get(key))[key] as { width: number; height: number };
      return { width: a.width, height: a.height };
    }, `asset:${asset}`);
    const dpr = await page.evaluate(() => devicePixelRatio);
    expect(size.width / dpr).toBeGreaterThan(850);
    expect(size.width / dpr).toBeLessThan(960);

    // Note → module: a quote found again and flashed in the module.
    await notes.locator('.cm-boo-frag').first().click();
    await expect.poll(() => module.evaluate(() => (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights.get('boo-notes-flash')?.size ?? 0)).toBe(1);

    // Finished: counted as the lesson's progress.
    await module.evaluate(() => (window as unknown as { finish(): void }).finish());
    await expect(notes.locator('.platform')).toHaveText('Web · Module SCORM · Terminé · score 90');
    await expect.poll(async () => sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], `progress:${NOTE}`)).toMatchObject({ position: 100 });
  });

  test('un cadre d’un autre site dans le module : le panneau propose de l’autoriser', async ({ page, sw }) => {
    await openLesson(page, sw);
    const hint = panel(page).locator('.players-hint');
    await expect(hint).toBeVisible({ timeout: 10_000 });
    await expect(hint).toContainText('videos.scorm-cdn.example');
    await expect(hint.getByRole('button', { name: 'Autoriser' })).toBeVisible();
  });
});

test('« Diagnostic de cette page » : cadres lus, module SCORM suivi, cadre d’un autre site à autoriser', async ({ context, page, sw }) => {
  const module = await openLesson(page, sw);
  await module.locator('#next').click();
  await expect(panel(page).locator('.platform')).toContainText('Module SCORM');
  const opened = context.waitForEvent('page');
  await sw.evaluate(async (url) => {
    const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === url);
    await (globalThis as unknown as { booNotes: { diagnose(id: number): Promise<void> } }).booNotes.diagnose(tab.id!);
  }, page.url());
  const report = await opened;
  await expect(report).toHaveURL(/diagnostic\/diagnostic\.html$/);
  const findings = report.locator('#findings');
  await expect(findings).toContainText('Boo Notes est actif sur cette page, notes ouvertes.');
  await expect(findings).toContainText('Module SCORM 2004 suivi : incomplete · 50 %.');
  // The video host of the module: out of reach, the report says so and offers to allow every site.
  await expect(findings.locator('li.error')).toHaveText(/^✗1 cadre de la page \(videos\.scorm-cdn\.example\)/);
  await expect(report.getByRole('button', { name: 'Autoriser Boo Notes sur tous les sites' })).toBeVisible();
  const details = report.locator('#report');
  await expect(details).toContainText('https://lms-player.example.test/player/3565 · Boo Notes ✓ · SCORM 2004');
  await expect(details).toContainText('https://lms-player.example.test/scorm/64272/index.html · Boo Notes ✓ · SCORM parent');
  // No query string in the report (tokens stay private).
  expect(await details.textContent()).not.toMatch(/\?[\w-]+=/);
  await expect(report.getByRole('button', { name: 'Copier le diagnostic' })).toBeVisible();
});
