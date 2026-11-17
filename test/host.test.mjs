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
