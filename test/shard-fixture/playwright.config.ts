// Two test files the Test workflow's sharded jobs split between them (one each).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ...(process.env.QUALIO_REPORTER ? [[process.env.QUALIO_REPORTER] as [string]] : [])],
});
