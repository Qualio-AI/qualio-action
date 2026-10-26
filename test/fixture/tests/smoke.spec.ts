import { expect, test } from '@playwright/test';

test('runs in Chromium and sees the environment the action passes', async ({ page }) => {
  await page.setContent('<main><h1>Qualio action</h1><button type="button">Run</button></main>');
  await expect(page.getByRole('heading', { name: 'Qualio action' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run' })).toBeEnabled();
  expect(process.env.QUALIO_API_URL).toBe('http://qualio.test');
  expect(process.env.QUALIO_COMMIT_SHA).toBeTruthy();
  expect(process.env.E2E_ADMIN_USERNAME).toBe('admin@example.test');
});
