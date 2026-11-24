import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillPlaceholders } from '../scripts/host.mjs';
import { exportAccounts } from '../scripts/qualio.mjs';

test('fills the job’s password placeholders in frames to the browser, JSON-escaped, and nothing else', () => {
  const env = { E2E_ADMIN_PASSWORD: 'pa"ss\\word', E2E_EMPTY_PASSWORD: '' };
  const frame = JSON.stringify({ id: 3, method: 'fill', params: { value: '{{E2E_ADMIN_PASSWORD}}' } });
  assert.deepEqual(JSON.parse(fillPlaceholders(frame, env)).params.value, 'pa"ss\\word');
  assert.equal(fillPlaceholders('{"v":"{{E2E_EMPTY_PASSWORD}}"}', env), '{"v":"{{E2E_EMPTY_PASSWORD}}"}');
  assert.equal(fillPlaceholders('{"v":"{{HOME}}"}', { HOME: '/root' }), '{"v":"{{HOME}}"}');
});

test('exports test users’ passwords from the job’s secrets and names the missing ones', () => {
  const target = { ADMIN_PASSWORD: 's3cret' };
  const missing = exportAccounts([{ name: 'Admin', variable: 'E2E_ADMIN_PASSWORD', secret: 'ADMIN_PASSWORD' }, { name: 'Teacher', variable: 'E2E_TEACHER_PASSWORD', secret: 'TEACHER_PASSWORD' }], target);
  assert.equal(target.E2E_ADMIN_PASSWORD, 's3cret');
  assert.deepEqual(missing, ['TEACHER_PASSWORD']);
});

test('finds the customer’s tests from playwright.config’s testDir', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { readTests, testsDir } = await import('../scripts/inventory.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'inv-'));
  await writeFile(path.join(root, 'playwright.config.ts'), "export default { testDir: './e2e' }");
  await mkdir(path.join(root, 'e2e', 'node_modules'), { recursive: true });
  await writeFile(path.join(root, 'e2e', 'students.spec.ts'), "test('adds a student', async () => {})");
  await writeFile(path.join(root, 'e2e', 'node_modules', 'x.spec.ts'), '');
  const dir = await testsDir(root);
  assert.deepEqual((await readTests(root, dir)).map((f) => f.path), ['e2e/students.spec.ts']);
  assert.equal(await testsDir(await mkdtemp(path.join(tmpdir(), 'none-'))), null);
});

test('adds the JSON reporter to the team’s Playwright command and slims the report', async () => {
  const { slimReport, withJsonReporter } = await import('../scripts/tests.mjs');
  assert.equal(withJsonReporter('npx playwright test'), 'npx playwright test --reporter=list,json');
  assert.equal(withJsonReporter('npm run e2e'), 'npm run e2e');
  const slim = slimReport({ suites: [{ title: 'a', specs: [{ title: 't', tests: [{ status: 'unexpected', results: [{ status: 'failed', duration: 3, stdout: ['x'], attachments: [{ name: 'trace', body: 'big' }, { name: 'qualio-signals', body: 'e30=' }] }] }] }] }] });
  assert.deepEqual(slim.suites[0].specs[0].tests[0].results[0].attachments, [{ name: 'qualio-signals', body: 'e30=' }]);
  assert.equal(slim.suites[0].specs[0].tests[0].results[0].stdout, undefined);
});

test('opens the engine Qualio asks for, only one this job runs', async () => {
  const { requestedEngine } = await import('../scripts/host.mjs');
  assert.equal(requestedEngine({ type: 'open' }, ['chromium']), 'chromium');
  assert.equal(requestedEngine({ type: 'open', engine: 'webkit' }, ['chromium', 'webkit']), 'webkit');
  assert.equal(requestedEngine({ type: 'open', engine: 'webkit' }, ['chromium']), null);
  assert.equal(requestedEngine({ type: 'open', engine: 'netscape' }, ['chromium', 'netscape']), null);
});

test('installs the engines Qualio’s profiles need beyond Chromium, and falls back to Chromium', async () => {
  const { installEngines } = await import('../scripts/qualio.mjs');
  const asked = [];
  const quiet = () => undefined;
  assert.deepEqual(await installEngines(undefined, { install: async (e) => (asked.push(e), true), log: quiet }), ['chromium']);
  assert.deepEqual(asked, []);
  assert.deepEqual(await installEngines(['webkit', 'chromium', 'nope'], { install: async (e) => (asked.push(e), true), log: quiet }), ['chromium', 'webkit']);
  assert.deepEqual(asked, [['webkit']]);
  assert.deepEqual(await installEngines(['firefox'], { install: async () => false, log: quiet }), ['chromium']);
});
