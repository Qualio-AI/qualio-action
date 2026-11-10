import { expect, test } from '@playwright/test';

test('shard file one runs once, in its own job', async ({ page }) => {
  await page.setContent('<main><h1>one</h1></main>');
  await expect(page.getByRole('heading', { name: 'one' })).toBeVisible();
});
