import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseShard } from '../scripts/qualio.mjs';
import { runQualioTask, slimReport, testEnv, writeFiles } from '../scripts/qualio-tests.mjs';
import { shardCommand } from '../scripts/tests.mjs';

test('reads the shard the workflow gives', () => {
  assert.deepEqual(parseShard(''), { index: 1, total: 1 });
  assert.deepEqual(parseShard('2/4'), { index: 2, total: 4 });
  assert.throws(() => parseShard('5/4'), /shard is i\/n/);
  assert.throws(() => parseShard('1/9'), /at most 8/);
});

test('runs this shard’s part of the team’s own tests', () => {
  assert.equal(shardCommand('npx playwright test', { current: 2, total: 3 }), 'npx playwright test --shard=2/3');
  assert.equal(shardCommand('npx playwright test', null), 'npx playwright test');
  assert.equal(shardCommand('npm run e2e', { current: 1, total: 3 }), 'npm run e2e');
  assert.equal(shardCommand('npm run e2e', { current: 2, total: 3 }), null);
});

test('keeps where a failure’s evidence is, never attachment bodies but Qualio’s signals', () => {
  const report = { suites: [{ title: 'f-1.spec.ts', specs: [{ title: 'TC-1: Saves', tests: [{ results: [{ status: 'failed', duration: 5, stdout: ['noise'], attachments: [{ name: 'video', contentType: 'video/webm', path: '/tmp/x/video.webm' }, { name: 'screenshot', contentType: 'image/png', path: '/tmp/x/s.png', body: 'AAAA' }, { name: 'qualio-signals', contentType: 'application/json', body: 'W10=' }, { name: 'trace', path: '/tmp/x/trace.zip' }] }] }] }] }] };
  const attachments = slimReport(report).suites[0].specs[0].tests[0].results[0].attachments;
  assert.deepEqual(attachments.map((a) => a.name), ['video', 'screenshot', 'qualio-signals']);
  assert.equal(attachments[1].body, undefined);
  assert.equal(attachments[2].body, 'W10=');
});

test('never writes outside the tests folder, and never hands the tests Qualio’s key or the job’s token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qt-'));
  await assert.rejects(writeFiles(root, [{ path: '../escape.ts', content: '' }]), /unsafe path/);
  const env = testEnv({ QUALIO_API_KEY: 'qk_x', GITHUB_TOKEN: 'ghs_x', E2E_ADMIN_PASSWORD: 'pw', PATH: '/bin' }, { E2E_ADMIN_USERNAME: 'admin' });
  assert.deepEqual(env, { E2E_ADMIN_PASSWORD: 'pw', PATH: '/bin', E2E_ADMIN_USERNAME: 'admin' });
});

test('downloads a task’s tests, runs only its files with the job’s secrets, posts the report and cleans up', async () => {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), 'runner-'));
  const config = "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', reporter: [['json', { outputFile: process.env.QUALIO_RESULTS_FILE }]] });\n";
  const spec = (title, body) => `import { test, expect } from '@playwright/test';\ntest.describe('F-1 Items', { tag: '@F-1' }, () => {\n  test('${title}', async () => {\n${body}\n  });\n});\n`;
  const calls = [];
  const call = async (route, body) => {
    calls.push({ route, body });
    if (route.endsWith('/tests'))
      return {
        status: 200,
        body: {
          files: [
            { path: 'playwright.config.ts', content: config },
            { path: 'tests/f-1.spec.ts', content: spec('TC-1: Signs in', "    expect(process.env.E2E_ADMIN_USERNAME).toBe('admin@school.test');\n    expect(process.env.E2E_ADMIN_PASSWORD).toBe('from-the-job');\n    expect(process.env.QUALIO_API_KEY).toBeUndefined();") },
            { path: 'tests/f-2.spec.ts', content: spec('TC-1: Not this shard', "    throw new Error('ran a file another shard runs');") },
          ],
          only: ['tests/f-1.spec.ts'],
          repeatEach: 2,
          env: { E2E_ADMIN_USERNAME: 'admin@school.test' },
        },
      };
    return { status: 200, body: { ok: true, uploads: [] } };
  };
  await runQualioTask({ kind: 'qualio-tests', taskId: 't1' }, { jobId: 'j1', call, upload: async () => 200, env: { ...process.env, RUNNER_TEMP: runnerTemp, QUALIO_API_KEY: 'qk_secret', E2E_ADMIN_PASSWORD: 'from-the-job' }, log: () => undefined });
  const posted = calls.find((c) => c.route === '/v1/runs/j1/results');
  const specs = posted.body.report.suites.flatMap(function all(s) { return [...(s.specs ?? []), ...(s.suites ?? []).flatMap(all)]; });
  assert.deepEqual([...new Set(specs.map((s) => s.title))], ['TC-1: Signs in']);
  assert.equal(specs.length, 2, 'run twice: --repeat-each');
  assert.ok(specs.every((s) => s.tests[0].results[0].status === 'passed'));
  assert.deepEqual(await readdir(runnerTemp), [], 'the tests folder is gone');
});
