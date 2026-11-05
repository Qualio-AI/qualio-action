// A tests folder in the repository whose test fails on a renamed button until Qualio's fix (from the
// stub's /v1/tests/changes) is written on top of it. Its reporter writes the run file the way Qualio's does.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ['./support/stub-reporter.mjs']],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
