// Preparing the tests: the folder qualio.yml names is sent as a snapshot (hashes first, contents when
// Qualio asks), the changes Qualio offers are written on top with the run manifest, and a project whose
// tests Qualio still keeps gets the whole folder when the checkout has none. Runs against test/stub-qualio.mjs.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const children = [];
const dirs = [];
after(async () => {
  children.forEach((c) => c.kill());
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function stub(mode) {
  const port = await freePort();
  children.push(spawn(process.execPath, [path.join(root, 'test/stub-qualio.mjs'), String(port), mode], { stdio: 'ignore' }));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qualio-prepare-'));
  dirs.push(dir);
  return dir;
}

const run = (url, ws, args) => {
  const outputs = path.join(ws, 'outputs.txt');
  const log = execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, QUALIO_API_URL: url, QUALIO_API_KEY: 'qk_stub', GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: outputs, QUALIO_RUN_MANIFEST: path.join(ws, 'manifest.json'), QUALIO_COMMIT_SHA: 'abc1234' },
  });
  return { log, outputs };
};

test('sends the tests folder and writes the changes Qualio offers on top', async () => {
  const url = await stub('healed');
  const ws = await workspace();
  const tests = path.join(ws, 'test/heal-fixture');
  await mkdir(path.join(tests, 'tests'), { recursive: true });
  await mkdir(path.join(tests, 'node_modules/x'), { recursive: true });
  await writeFile(path.join(tests, 'package.json'), '{}');
  await writeFile(path.join(tests, 'playwright.config.ts'), 'export default {};');
  await writeFile(path.join(tests, 'tests/login.spec.ts'), 'old');
  await writeFile(path.join(tests, 'node_modules/x/index.js'), 'not a test');

  const { log, outputs } = run(url, ws, ['prepare', 'feature/sch-9']);
  const calls = await (await fetch(`${url}/__calls`)).json();
  const snapshots = calls.filter((c) => c.route === '/v1/tests/snapshot');
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0].body.files.map((f) => [f.path, 'content' in f]), [
    ['package.json', false],
    ['playwright.config.ts', false],
    ['tests/login.spec.ts', false],
  ]);
  assert.equal(snapshots[1].body.files.find((f) => f.path === 'tests/login.spec.ts').content, 'old');
  assert.equal(snapshots[0].body.testsDir, 'test/heal-fixture');
  assert.equal(snapshots[0].body.headSha, 'abc1234');
  // The stub's snapshot answer has no changes; the changes route has the fix (healed).
  assert.match(await readFile(outputs, 'utf8'), /run=true\ndir=.*test\/heal-fixture/);
  // The team's own config doesn't list Qualio's reporter: the run adds it (with list and HTML).
  assert.match(await readFile(outputs, 'utf8'), new RegExp(`reporter-args=--reporter=list,html,${tests.replace(/[/\\.]/g, '\\$&')}/\\.qualio/qualio-reporter\\.ts`));
  assert.match(log, /doesn't list Qualio's reporter/);
  assert.match(await readFile(path.join(tests, '.qualio/qualio-reporter.ts'), 'utf8'), /class QualioReporter/);
  assert.deepEqual(JSON.parse(await readFile(path.join(ws, 'manifest.json'), 'utf8')), { bundleId: 'repo', revisionIds: [] });
  assert.doesNotMatch(log, /Applied/);

  run(url, ws, ['apply', tests, 'feature/sch-9', 'repo']);
  assert.match(await readFile(path.join(tests, 'tests/login.spec.ts'), 'utf8'), /name: 'Log in'/);
  assert.deepEqual(JSON.parse(await readFile(path.join(ws, 'manifest.json'), 'utf8')), { bundleId: 'repo', revisionIds: ['r2'] });
});

test('a project whose tests Qualio still keeps runs them from Qualio while the move waits', async () => {
  const url = await stub('move');
  const ws = await workspace();
  const { log, outputs } = run(url, ws, ['prepare', 'main']);
  assert.match(log, /now live in your repository/);
  assert.match(await readFile(outputs, 'utf8'), /mode=move/);
  assert.match(await readFile(path.join(ws, 'e2e-moving/tests/moved.spec.ts'), 'utf8'), /Log in/);
  assert.deepEqual(JSON.parse(await readFile(path.join(ws, 'manifest.json'), 'utf8')), { bundleId: 'move', revisionIds: ['m1'] });
});

test('no tests yet: the job has nothing to run, with a notice instead of a failure', async () => {
  const url = await stub('empty');
  const ws = await workspace();
  const { log, outputs } = run(url, ws, ['prepare', 'main']);
  assert.match(log, /::notice title=Qualio::There are no tests in 'e2e-none-yet' yet/);
  assert.match(await readFile(outputs, 'utf8'), /run=false/);
});

test('without Qualio (no api-key), a missing tests folder fails with the path', async () => {
  const ws = await workspace();
  assert.throws(
    () =>
      execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'prepare', 'main', 'does-not-exist'], {
        encoding: 'utf8',
        env: { ...process.env, QUALIO_API_URL: '', QUALIO_API_KEY: '', GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: path.join(ws, 'outputs.txt') },
      }),
    (error) => /The tests folder 'does-not-exist' does not exist/.test(error.stdout),
  );
});

test('maps nothing when Qualio has a map, or is older than the map step', async () => {
  const url = await stub('');
  const ws = await workspace();
  const { outputs } = run(url, ws, ['map', path.join(ws, 'map'), 'main', '1']);
  assert.match(await readFile(outputs, 'utf8'), /state=skipped/);
  const calls = await (await fetch(`${url}/__calls`)).json();
  assert.deepEqual(calls.filter((c) => c.route.startsWith('/v1/map/')).map((c) => [c.route, c.body.branch]), [['/v1/map/start', 'main']]);
  // `setup` is the map step's name in workflows written before phase 54.
  const legacy = run(url, ws, ['setup', path.join(ws, 'map'), 'main', '1']);
  assert.match(await readFile(legacy.outputs, 'utf8'), /state=skipped/);
});
