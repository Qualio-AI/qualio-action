// The customer's own Playwright tests, read from the checkout for Qualio (qualio-v2 specs/tickets-pull-requests-and-
// tests.md → Writing the tests): their titles tell Qualio which spec cases are already covered. Read only.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const TEST_FILE = /\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'playwright-report', 'test-results']);
const MAX_FILES = 400;
const MAX_BYTES = 2_500_000;

/** The folder the tests are in: the input, else playwright.config's testDir, else null (no Playwright here). */
export async function testsDir(root, input = '') {
  if (input) return path.resolve(root, input);
  for (const name of ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.mts', 'playwright.config.cjs']) {
    const config = await readFile(path.join(root, name), 'utf8').catch(() => null);
    if (config === null) continue;
    const dir = /testDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(config)?.[1];
    return path.resolve(root, dir ?? '.');
  }
  return null;
}

/** The test files under `dir` (relative to `root`), with their content, within the limits. */
export async function readTests(root, dir) {
  const files = [];
  let bytes = 0;
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) await walk(full);
      } else if (TEST_FILE.test(entry.name)) {
        const size = (await stat(full)).size;
        if (bytes + size > MAX_BYTES) continue;
        bytes += size;
        files.push({ path: path.relative(root, full).split(path.sep).join('/'), content: await readFile(full, 'utf8') });
      }
    }
  };
  await walk(dir);
  return files;
}
