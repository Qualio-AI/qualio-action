// Preparing the tests (phase 84): the tests Qualio keeps for the branch are written into a folder of the job's
// own with the run manifest and Qualio's reporter; the checkout is never read or changed. Runs against
// test/stub-qualio.mjs.
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

const run = (url, ws, args, extra = {}) => {
  const outputs = path.join(ws, 'outputs.txt');
  const log = execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, QUALIO_API_URL: url, QUALIO_API_KEY: 'qk_stub', GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: outputs, RUNNER_TEMP: ws, QUALIO_RUN_MANIFEST: path.join(ws, 'manifest.json'), QUALIO_COMMIT_SHA: 'abc1234', ...extra },
  });
  return { log, outputs };
};

test("writes the tests Qualio keeps into a folder of the job's own, never the checkout", async () => {
  const url = await stub('binary');
  const ws = await workspace();
  const { log, outputs } = run(url, ws, ['prepare', 'feature/sch-9']);
  const dir = path.join(ws, 'qualio-tests');
  const out = await readFile(outputs, 'utf8');
  assert.ok(out.includes(`run=true\ndir=${dir}\n`), out);
  assert.match(out, /mode=bundle/);
  assert.match(await readFile(path.join(dir, 'tests/login.spec.ts'), 'utf8'), /name: 'Sign in'/);
  // An attached binary test file is written as its bytes.
  assert.deepEqual([...(await readFile(path.join(dir, 'fixtures/attached.xlsx')))], [0x50, 0x4b, 3, 4, 0, 0xff]);
  // Qualio's reporter goes next to the tests; the manifest says which revisions ran.
  assert.ok(out.includes(`reporter=${path.join(dir, '.qualio/qualio-reporter.ts')}`), out);
  assert.deepEqual(JSON.parse(await readFile(path.join(ws, 'manifest.json'), 'utf8')), { bundleId: 'b_1', revisionIds: ['m1'] });
  assert.match(log, /of the tests Qualio keeps for feature\/sch-9/);
  // Nothing is read from or sent about the repository.
  const calls = await (await fetch(`${url}/__calls`)).json();
  assert.deepEqual(calls.map((c) => c.route), ['/v1/tests/prepare', '/v1/tests/bundle']);
  assert.equal(calls[1].body.binary, true);
});

test('after a heal, gets the tests again with the fix and keeps the installed dependencies', async () => {
  const url = await stub('healed');
  const ws = await workspace();
  run(url, ws, ['prepare', 'main']);
  const dir = path.join(ws, 'qualio-tests');
  await mkdir(path.join(dir, 'node_modules/x'), { recursive: true });
  await writeFile(path.join(dir, 'node_modules/x/index.js'), 'kept');
  run(url, ws, ['apply', dir, 'main']);
  assert.match(await readFile(path.join(dir, 'tests/login.spec.ts'), 'utf8'), /name: 'Log in'/);
  assert.equal(await readFile(path.join(dir, 'node_modules/x/index.js'), 'utf8'), 'kept');
  assert.deepEqual(JSON.parse(await readFile(path.join(ws, 'manifest.json'), 'utf8')).revisionIds, ['m1', 'r2']);
});

test('no tests yet: the job has nothing to run, with a notice instead of a failure', async () => {
  const url = await stub('empty');
  const ws = await workspace();
  const { log, outputs } = run(url, ws, ['prepare', 'main']);
  assert.match(await readFile(outputs, 'utf8'), /run=false/);
  assert.match(log, /::notice title=Qualio::Qualio has no tests for this project yet/);
});

test('says when it cannot check which merged pull requests the commit includes', async () => {
  const url = await stub('lacking');
  const ws = await workspace();
  const { log } = run(url, ws, ['prepare', 'feature/x']);
  // No git history in this folder: the latest tests are used.
  assert.match(log, /Could not check which merged pull requests this commit includes/);
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

test("exports the email setup Qualio answers for the steps that run the tests, never anything else", async () => {
  const url = await stub('email');
  const ws = await workspace();
  const tests = path.join(ws, 'test/heal-fixture');
  await mkdir(path.join(tests, 'tests'), { recursive: true });
  await writeFile(path.join(tests, 'package.json'), '{}');
  await writeFile(path.join(tests, 'playwright.config.ts'), 'export default {};');
  await writeFile(path.join(tests, 'tests/login.spec.ts'), 'old');
  const envFile = path.join(ws, 'env.txt');
  const log = execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'prepare', 'main'], {
    encoding: 'utf8',
    env: { ...process.env, QUALIO_API_URL: url, QUALIO_API_KEY: 'qk_stub', GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: path.join(ws, 'outputs.txt'), GITHUB_ENV: envFile, RUNNER_TEMP: ws, QUALIO_RUN_MANIFEST: path.join(ws, 'manifest.json'), QUALIO_COMMIT_SHA: 'abc1234', QUALIO_MAIL_DOMAIN: 'mine.test' },
  });
  // The job's own QUALIO_MAIL_DOMAIN wins; an API key or PATH from Qualio is never exported.
  assert.equal(await readFile(envFile, 'utf8'), 'QUALIO_MAIL=mailpit\nQUALIO_MAIL_URL=http://localhost:8025\n');
  assert.match(log, /The tests read email from mailpit \(http:\/\/localhost:8025\)/);
});

test("exports the app URL Qualio answers as QUALIO_BASE_URL, unless the job (the base-url input) set one", async () => {
  const url = await stub('app-url');
  const ws = await workspace();
  const tests = path.join(ws, 'test/heal-fixture');
  await mkdir(path.join(tests, 'tests'), { recursive: true });
  await writeFile(path.join(tests, 'package.json'), '{}');
  await writeFile(path.join(tests, 'playwright.config.ts'), 'export default {};');
  await writeFile(path.join(tests, 'tests/login.spec.ts'), 'old');
  const prepare = (envFile, extra = {}) =>
    execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'prepare', 'main'], {
      encoding: 'utf8',
      env: { ...process.env, QUALIO_BASE_URL: '', QUALIO_API_URL: url, QUALIO_API_KEY: 'qk_stub', GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: path.join(ws, 'outputs.txt'), GITHUB_ENV: envFile, RUNNER_TEMP: ws, QUALIO_RUN_MANIFEST: path.join(ws, 'manifest.json'), QUALIO_COMMIT_SHA: 'abc1234', ...extra },
    });
  const fromConfig = path.join(ws, 'env-config.txt');
  assert.match(prepare(fromConfig), /The app's URL in this job: http:\/\/localhost:8080\/app/);
  assert.equal(await readFile(fromConfig, 'utf8'), 'QUALIO_BASE_URL=http://localhost:8080/app\n');
  const fromInput = path.join(ws, 'env-input.txt');
  prepare(fromInput, { QUALIO_BASE_URL: 'https://pr-7.preview.example.com' });
  assert.equal(await readFile(fromInput, 'utf8').catch(() => ''), '');
});

test("the map step exports the app URL Qualio answers before mapping", async () => {
  const url = await stub('app-url');
  const ws = await workspace();
  const envFile = path.join(ws, 'env.txt');
  execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'map', path.join(ws, 'map'), 'main', '1'], {
    encoding: 'utf8',
    env: { ...process.env, QUALIO_BASE_URL: '', QUALIO_API_URL: url, QUALIO_API_KEY: 'qk_stub', GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: path.join(ws, 'outputs.txt'), GITHUB_ENV: envFile },
  });
  assert.equal(await readFile(envFile, 'utf8'), 'QUALIO_BASE_URL=http://localhost:8080/app\n');
});
