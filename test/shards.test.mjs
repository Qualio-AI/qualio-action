// Auto-sharding (specs/auto-sharding.md): the plan job lists the tests with Playwright and asks Qualio
// how many jobs run them; each shard job turns its files into exact Playwright filters; a shard that
// failed before reporting tells Qualio which shard it was; a sharded job claims the outbox items it sends.
// Runs against test/stub-qualio.mjs.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const children = [];
const dirs = [];
after(async () => {
  children.forEach((c) => c.kill());
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function stub(mode) {
  const port = 5900 + Math.floor(Math.random() * 300);
  children.push(spawn(process.execPath, [path.join(root, 'test/stub-qualio.mjs'), String(port), mode], { stdio: 'ignore' }));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${url}/__calls`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return url;
}

async function workspace() {
  // Real path: Playwright's file paths start from the job's working directory, never a symlink.
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'qualio-shards-')));
  dirs.push(dir);
  return dir;
}

const run = (url, ws, args, env = {}) => {
  const outputs = path.join(ws, 'outputs.txt');
  const log = execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), ...args], {
    encoding: 'utf8',
    cwd: ws,
    env: { ...process.env, QUALIO_API_URL: url, QUALIO_API_KEY: 'qk_stub', GITHUB_OUTPUT: outputs, GITHUB_RUN_ID: '901', GITHUB_RUN_ATTEMPT: '1', QUALIO_COMMIT_SHA: 'abc1234', ...env },
  });
  return { log, outputs };
};

const outputsOf = async (file) => Object.fromEntries((await readFile(file, 'utf8')).trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const calls = async (url) => (await (await fetch(`${url}/__calls`)).json()).map((c) => ({ ...c, url: c.route }));

/** Playwright's --list --reporter=json for three files under tests/ (rootDir is the config's testDir). */
async function listing(ws) {
  const file = path.join(ws, 'list.json');
  const suite = (name, tests) => ({ title: name, file: name, specs: Array.from({ length: tests }, () => ({ tests: [{}] })), suites: [] });
  await writeFile(file, JSON.stringify({ config: { rootDir: path.join(ws, 'tests') }, suites: [suite('a.spec.ts', 2), suite('b.spec.ts', 1), { title: 'nested', suites: [suite('c.spec.ts', 3)] }] }));
  return file;
}

test('the plan job sends the listed files and outputs the matrix', async () => {
  const url = await stub('shards');
  const ws = await workspace();
  const { log, outputs } = run(url, ws, ['plan', 'feature/x', '.'], { QUALIO_PLAYWRIGHT_LIST: await listing(ws) });
  assert.match(log, /Qualio splits 3 test files across 2 jobs \(about 4 min, instead of 7 min in one job\)/);
  assert.deepEqual(await outputsOf(outputs), { run: 'true', shards: '[1,2]', 'plan-id': 'p1' });
  const plan = (await calls(url)).find((c) => c.url === '/v1/tests/plan');
  assert.deepEqual(plan.body, {
    branch: 'feature/x',
    commitSha: 'abc1234',
    ghRunId: '901',
    ghRunAttempt: 1,
    files: [
      { path: 'tests/a.spec.ts', tests: 2 },
      { path: 'tests/b.spec.ts', tests: 1 },
      { path: 'tests/c.spec.ts', tests: 3 },
    ],
  });
});

test('one job runs everything when one is enough, or when Playwright cannot list the tests', async () => {
  const url = await stub('');
  const ws = await workspace();
  const one = run(url, ws, ['plan', 'main', '.'], { QUALIO_PLAYWRIGHT_LIST: await listing(ws) });
  assert.match(one.log, /One job runs the 3 test files/);
  assert.deepEqual(await outputsOf(one.outputs), { run: 'true', shards: '[1]', 'plan-id': '' });

  const broken = path.join(ws, 'broken');
  await writeFile(path.join(ws, 'broken.json'), 'not json');
  await rm(one.outputs);
  const failed = run(url, ws, ['plan', 'main', broken], { QUALIO_PLAYWRIGHT_LIST: '', PATH: '' });
  assert.match(failed.log, /Playwright could not list the tests/);
  assert.deepEqual(await outputsOf(failed.outputs), { run: 'true', shards: '[1]', 'plan-id': '' });
});

test("a shard job runs exactly its files, and fails rather than run another shard's", async () => {
  const url = await stub('');
  const ws = await workspace();
  const args = path.join(ws, 'args.txt');
  const { outputs } = run(url, ws, ['shard', 'p1', '1', '.', args]);
  assert.deepEqual(await outputsOf(outputs), { total: '2' });
  const filters = (await readFile(args, 'utf8')).trim().split('\n');
  const escaped = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.deepEqual(filters, [`^${escaped(path.join(ws, 'tests/a.spec.ts'))}$`, `^${escaped(path.join(ws, 'tests/c.spec.ts'))}$`]);
  // The filter is the whole path: another file whose name ends the same doesn't match.
  assert.ok(new RegExp(filters[0]).test(path.join(ws, 'tests/a.spec.ts')));
  assert.ok(!new RegExp(filters[0]).test(path.join(ws, 'tests/data.spec.ts')));

  // Without a plan, the job runs every test.
  await rm(outputs);
  run(url, ws, ['shard', '', '1', '.', args]);
  assert.equal(await readFile(args, 'utf8'), '');
  assert.throws(() => run(url, ws, ['shard', 'gone', '2', '.', args]), (error) => /could not say which tests shard 2 runs \(404\)/.test(error.stdout));
});

test('a shard that failed before reporting says which shard it was; sharded jobs lease the outbox', async () => {
  const url = await stub('');
  const ws = await workspace();
  run(url, ws, ['errored', 'failure'], { GITHUB_REPOSITORY: 'acme/app', GITHUB_REF_NAME: 'main', QUALIO_SHARD_INDEX: '2', QUALIO_SHARD_TOTAL: '3', QUALIO_SHARD_PLAN: 'p1' });
  run(url, ws, ['errored', 'failure'], { GITHUB_REPOSITORY: 'acme/app', GITHUB_REF_NAME: 'main', QUALIO_SHARD_INDEX: '2', QUALIO_SHARD_TOTAL: '', QUALIO_SHARD_PLAN: 'p1' });
  run(url, ws, ['errored', 'failure'], { GITHUB_REPOSITORY: 'acme/app', GITHUB_REF_NAME: 'main', QUALIO_SHARD_INDEX: '', QUALIO_SHARD_TOTAL: '', QUALIO_SHARD_PLAN: '' });
  run(url, ws, ['outbox'], { GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', QUALIO_SHARDED: 'true', GITHUB_API_URL: url });
  const sent = await calls(url);
  const errored = sent.filter((c) => c.url === '/v1/runs/errored').map((c) => c.body.shard);
  assert.deepEqual(errored, [{ index: 2, total: 3, planId: 'p1' }, { index: 2, planId: 'p1' }, undefined]);
  assert.equal(sent.find((c) => c.url === '/v1/pr/outbox').body.lease, true);
});
