import { expect, test } from '@playwright/test';

test('shard file two runs once, in its own job', async ({ page }) => {
  await page.setContent('<main><h1>two</h1></main>');
  await expect(page.getByRole('heading', { name: 'two' })).toBeVisible();
});
