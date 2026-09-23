import { expect, test } from './fixtures';

test('démarre sur l’accueil, bibliothèque vide', async ({ ctx }) => {
  const { page } = await ctx.launch();
  await expect(page.locator('.welcome h2')).toHaveText('Votre second cerveau commence ici');
  await expect(page.locator('.nav-item')).toHaveCount(6);
  await page.screenshot({ path: 'test-results/smoke.png' });
});
