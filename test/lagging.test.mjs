// The download checks the checked-out commit against the merges Qualio lists, and asks for the tests
// from before the ones it lacks. Runs against test/stub-qualio.mjs and a throwaway git repository.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 4600 + Math.floor(Math.random() * 300);
let repo;
let merge;
let stub;

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

before(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'qualio-lagging-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'start');
  gitIn(repo, 'branch', 'old');
  gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'Merge pull request #11');
  merge = gitIn(repo, 'rev-parse', 'HEAD');
  stub = spawn(process.execPath, [path.join(root, 'test/stub-qualio.mjs'), String(port), `lagging=${merge}`], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/__calls`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(async () => {
  stub?.kill();
  await rm(repo, { recursive: true, force: true });
});

async function download(cwd) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qualio-tests-'));
  const before = (await (await fetch(`http://127.0.0.1:${port}/__calls`)).json()).length;
  const out = execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'download', dir, 'feature/x'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, QUALIO_API_URL: `http://127.0.0.1:${port}`, QUALIO_API_KEY: 'qk_stub', GITHUB_WORKSPACE: cwd, GITHUB_OUTPUT: '', GITHUB_EVENT_NAME: 'workflow_dispatch' },
  });
  const calls = (await (await fetch(`http://127.0.0.1:${port}/__calls`)).json()).slice(before).filter((c) => c.route === '/v1/tests/bundle');
  const which = await readFile(path.join(dir, 'tests/which.txt'), 'utf8');
  await rm(dir, { recursive: true, force: true });
  return { out, calls, which };
}

test('a commit that has the merge gets the latest tests with one call', async () => {
  gitIn(repo, 'checkout', '-q', 'main');
  const { calls, which, out } = await download(repo);
  assert.equal(which, 'latest');
  assert.equal(calls.length, 1);
  assert.doesNotMatch(out, /doesn't include/);
});

test('a commit without the merge gets the tests from before it, and says so', async () => {
  gitIn(repo, 'checkout', '-q', 'old');
  const { calls, which, out } = await download(repo);
  assert.equal(which, 'before #11');
  assert.deepEqual(calls.map((c) => c.body.lacking), [undefined, [11]]);
  assert.match(out, /::warning title=Qualio::This branch doesn't include #11 yet/);
});

test('without git history it keeps the latest tests', async () => {
  const plain = await mkdtemp(path.join(os.tmpdir(), 'qualio-nogit-'));
  const { calls, which, out } = await download(plain);
  await rm(plain, { recursive: true, force: true });
  assert.equal(which, 'latest');
  assert.equal(calls.length, 1);
  assert.match(out, /Could not check which merged pull requests/);
});
