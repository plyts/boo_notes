import type { Frame } from '@playwright/test';
import { expect, NOTE_ID, openNotes, openWatch, panel, test } from './fixtures';

/**
 * A click lands on the line clicked — even far down a long note (timestamped
 * lines, questions, free notes, lists) — and a click during which the mouse
 * moves a little selects nothing. The + stands beside the line hovered.
 */

const MD = [
  '[00:01] Première ligne de notes assez longue pour passer sur deux lignes dans le panneau de notes étroit.',
  '[00:03] Deuxième ligne avec du **gras** et encore du texte pour la faire passer à la ligne suivante.',
  'Troisième ligne sans horodatage, [00:07] avec un horodatage au milieu.',
  '',
  '> [!question] Question 1 · [00:04]',
  '> Pourquoi cette méthode fonctionne-t-elle ?',
  '>',
  '> **Réponse :** Parce que les gradients restent bornés.',
  '',
  '> [!note] Note libre',
  '> Une idée personnelle.',
  '',
  '- une liste',
  '- un **point** important',
  ...Array.from({ length: 24 }, (_, i) => `[00:${String(10 + i).padStart(2, '0')}] Ligne horodatée numéro ${i + 1}.`),
  'Dernière ligne.',
].join('\n');

/** Line (0-based) of the cursor, from the editor itself (a long note is not all drawn). */
function editorLine(frame: Frame): Promise<number> {
  return frame.evaluate(() => {
    type View = { state: { doc: { lineAt(p: number): { number: number }; lines: number }; selection: { main: { head: number } } } };
    // CodeMirror keeps its view on the content element.
    const view = (document.querySelector('.cm-content') as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view;
    return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  });
}

/** Line (0-based) of the editor's cursor, and the text selected, from the DOM. */
function caret(frame: Frame): Promise<{ line: number; selected: string }> {
  return frame.evaluate(() => {
    const sel = getSelection()!;
    const lines = [...document.querySelectorAll('.cm-line')];
    const el = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest('.cm-line');
    return { line: el ? lines.indexOf(el) : -1, selected: sel.toString() };
  });
}

test('un clic place le curseur sur la ligne visée, jusqu’au bas d’une longue note ; un clic qui bouge un peu ne sélectionne rien', async ({ page, sw }) => {
  await sw.evaluate(
    async ({ key, md }) =>
      chrome.storage.local.set({
        [key]: { id: key.slice(5), platform: 'youtube', kind: 'video', url: 'https://www.youtube.com/watch?v=e2eTest0001', title: 'T', markdown: md, rev: 1, updatedAt: Date.now(), createdAt: Date.now() },
      }),
    { key: `note:${NOTE_ID}`, md: MD },
  );
  await openWatch(page);
  await openNotes(sw, page);
  const p = panel(page);
  const frame = page.frames().find((f) => f.url().includes('panel/panel.html'))!;
  const count = await p.locator('.cm-line').count();
  const missed: string[] = [];
  for (let i = 0; i < count; i++) {
    const line = p.locator('.cm-line').nth(i);
    await line.scrollIntoViewIfNeeded();
    const box = (await line.boundingBox())!;
    const text = (await line.innerText()).trim();
    if (!text) continue;
    const x = box.x + box.width - 24;
    const y = box.y + Math.min(box.height / 2, 11);
    // Every other line from the page (the notes not focused yet), the mouse moving a little while pressed.
    if (i % 2) await page.mouse.click(300, 30);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 2, y + 3, { steps: 3 });
    await page.mouse.up();
    const c = await caret(frame);
    if (c.line !== i || c.selected.length > 3) missed.push(`ligne ${i} « ${text.slice(0, 24)} » → ligne ${c.line}${c.selected ? `, « ${c.selected.slice(0, 24)} » sélectionné` : ''}`);
  }
  expect(missed).toEqual([]);

  // The + beside the line hovered (a block: beside its first line).
  await frame.evaluate(() => document.querySelector('.cm-scroller')!.scrollTo(0, 0));
  for (const i of [0, 2, 12, 20, 30]) {
    const line = p.locator('.cm-line').nth(i);
    await line.scrollIntoViewIfNeeded();
    const box = (await line.boundingBox())!;
    await page.mouse.move(box.x + 80, box.y + Math.min(box.height / 2, 11));
    await expect(p.locator('.boo-block-handle.visible')).toBeVisible();
    const at = await frame.evaluate(() => {
      const r = document.querySelector('.boo-block-handle.visible')!.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      return [...document.querySelectorAll('.cm-line')].findIndex((e) => {
        const b = e.getBoundingClientRect();
        return mid >= b.top && mid < b.bottom;
      });
    });
    expect(at).toBe(i);
  }
});

test('↑ et ↓ avancent d’une ligne à la fois, du bas au haut d’une longue note et retour', async ({ page, sw }) => {
  await sw.evaluate(
    async ({ key, md }) =>
      chrome.storage.local.set({
        [key]: { id: key.slice(5), platform: 'youtube', kind: 'video', url: 'https://www.youtube.com/watch?v=e2eTest0001', title: 'T', markdown: md, rev: 1, updatedAt: Date.now(), createdAt: Date.now() },
      }),
    { key: `note:${NOTE_ID}`, md: MD },
  );
  await openWatch(page);
  await openNotes(sw, page);
  const frame = page.frames().find((f) => f.url().includes('panel/panel.html'))!;
  const lines = MD.split('\n');
  const jumps: string[] = [];
  await page.keyboard.press('Control+End');
  let prev = await editorLine(frame);
  expect(prev).toBe(lines.length - 1);
  // A wrapped line takes several presses (one per row it is drawn on): never more than one line at a time.
  for (let k = 0; k < 120 && prev > 0; k++) {
    await page.keyboard.press('ArrowUp');
    const now = await editorLine(frame);
    if (prev - now > 1) jumps.push(`↑ ${prev} « ${lines[prev].slice(0, 24)} » → ${now} « ${lines[now].slice(0, 24)} »`);
    prev = now;
  }
  expect(prev).toBe(0);
  for (let k = 0; k < 120 && prev < lines.length - 1; k++) {
    await page.keyboard.press('ArrowDown');
    const now = await editorLine(frame);
    if (now - prev > 1) jumps.push(`↓ ${prev} « ${lines[prev].slice(0, 24)} » → ${now} « ${lines[now].slice(0, 24)} »`);
    prev = now;
  }
  expect(prev).toBe(lines.length - 1);
  expect(jumps).toEqual([]);
});
