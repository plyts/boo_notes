import { expect, test } from './fixtures';

test('démarre et affiche la bibliothèque vide', async ({ ctx }) => {
  const { page } = await ctx.launch();
  await expect(page.locator('.empty-library h2')).toHaveText('Votre bibliothèque de cours');
  await page.screenshot({ path: 'test-results/smoke.png' });
});
