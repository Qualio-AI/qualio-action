import { expect, test } from '@playwright/test';

test('signs in', async ({ page }) => {
  await page.setContent('<main><button type="button">Log in</button></main>');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 2000 });
});
