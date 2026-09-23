import { expect, openNotes, openWatch, panel, storedNote, test } from './fixtures';

test('ranger la note dans un cours › chapitre depuis le panneau', async ({ page, sw }) => {
  // Courses of the desktop library, as the app shares them.
  await sw.evaluate(() =>
    chrome.storage.local.set({
      'desktop:courses': [
        { title: 'Physique — Électricité', emoji: '⚡', chapters: ['La loi d’Ohm', 'Circuits RC'] },
        { title: 'Histoire moderne', emoji: '🏛️', chapters: [] },
      ],
    }),
  );
  await openWatch(page);
  await openNotes(sw, page);
  const p = panel(page);
  await page.keyboard.type('Résistance');
  await expect.poll(async () => (await storedNote(sw))?.markdown).toMatch(/Résistance$/);

  const place = p.locator('.place');
  await expect(place).toHaveText('Ranger dans un cours');
  await place.click();
  const menu = p.getByRole('menu', { name: 'Ranger dans un cours' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('.place-course')).toHaveText(['⚡ Physique — Électricité', '🏛️ Histoire moderne']);
  await menu.getByRole('menuitemradio', { name: 'Circuits RC' }).click();
  await expect(place).toHaveText('Physique — Électricité › Circuits RC');
  await expect.poll(async () => (await storedNote(sw)) as unknown).toMatchObject({ course: 'Physique — Électricité', chapter: 'Circuits RC' });

  // A course that only exists here: typed, then offered next time.
  await place.click();
  // Inputs with suggestions (datalist) are comboboxes.
  await menu.getByRole('combobox', { name: 'Cours' }).fill('Maths');
  await menu.getByRole('combobox', { name: 'Chapitre' }).fill('Intégrales');
  await menu.getByRole('button', { name: 'Ranger' }).click();
  await expect(place).toHaveText('Maths › Intégrales');
  await place.click();
  await expect(menu.getByRole('menuitemradio', { name: 'Intégrales' })).toHaveAttribute('aria-checked', 'true');

  // Unfiled: the note keeps its text.
  await menu.getByRole('menuitem', { name: 'Retirer du cours' }).click();
  await expect(place).toHaveText('Ranger dans un cours');
  const note = (await storedNote(sw)) as unknown as { course?: string; markdown: string; placedAt?: number };
  expect(note.course).toBeUndefined();
  expect(note.placedAt).toBeGreaterThan(0);
  expect(note.markdown).toMatch(/Résistance$/);
});
