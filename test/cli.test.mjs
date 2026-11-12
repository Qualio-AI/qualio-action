// The qualio CLI (cli/bin/qualio.mjs): asks Qualio for a feature's tests from a developer's checkout,
// answers the Analyst's question and writes the new tests into the tests folder, uncommitted. Runs
// against test/stub-qualio.mjs (mode "cli").
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { answerQuestions, parseArgs, parseDotEnv, repository } from '../cli/bin/qualio.mjs';
import { freePort } from './free-port.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'cli/bin/qualio.mjs');
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

/** A developer's checkout on branch feat/archive, with the tests folder the stub names (test/heal-fixture). */
async function checkout() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qualio-cli-'));
  dirs.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'feat/archive');
  const tests = path.join(dir, 'test/heal-fixture');
  await mkdir(path.join(tests, 'tests'), { recursive: true });
  await writeFile(path.join(tests, 'package.json'), '{}');
  await writeFile(path.join(tests, 'playwright.config.ts'), "export default { reporter: process.env.QUALIO_REPORTER };\n");
  await writeFile(path.join(tests, 'tests/login.spec.ts'), "// the team's own test\n");
  git('add', '.');
  git('-c', 'user.name=Dev', '-c', 'user.email=dev@example.test', 'commit', '-qm', 'tests');
  return { dir, tests };
}

const runCli = (args, { cwd, url, env = {} }) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, QUALIO_API_URL: url, QUALIO_API_KEY: 'qk_stub', QUALIO_CLI_POLL_MS: '50', NO_COLOR: '1', XDG_CONFIG_HOME: cwd, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });

test('generate: answers the Analyst with its recommendation, then writes the new tests into the folder, uncommitted', async () => {
  const url = await stub('cli');
  const { dir, tests } = await checkout();
  const { code, out } = await runCli(['generate', 'sch-42', '--yes', '--no-run'], { cwd: dir, url });
  assert.equal(code, 0, out);
  assert.match(out, /School · feat\/archive/);
  assert.match(out, /Can students still see an archived class\? → Yes, read-only \(recommended\)/);
  assert.match(out, /Spec approved: SCH-42 "Archive a class" \(3 test cases\)/);
  assert.match(out, /\+ test\/heal-fixture\/tests\/archive\.spec\.ts/);
  assert.match(out, /uncommitted/);

  // The new test is in the folder, not committed; the team's test is untouched.
  assert.match(await readFile(path.join(tests, 'tests/archive.spec.ts'), 'utf8'), /Archive/);
  assert.equal(await readFile(path.join(tests, 'tests/login.spec.ts'), 'utf8'), "// the team's own test\n");
  // Only the new test is left in the checkout (not Qualio's reporter, copied there for the run).
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }), '?? test/heal-fixture/tests/archive.spec.ts\n');

  // Everything happened on the developer's local branch; only the tests folder was sent.
  const calls = await (await fetch(`${url}/__calls`)).json();
  const posted = (route) => calls.filter((c) => c.route === route).map((c) => c.body);
  assert.deepEqual(posted('/v1/features/generate'), [{ key: 'sch-42', branch: 'local:feat/archive' }]);
  assert.ok(posted('/v1/features/status').every((b) => b.key === 'SCH-42' && b.branch === 'local:feat/archive'));
  assert.equal(posted('/v1/tests/snapshot')[0].branch, 'local:feat/archive');
  assert.deepEqual(posted('/v1/tests/snapshot')[0].files.map((f) => f.path).sort(), ['package.json', 'playwright.config.ts', 'tests/login.spec.ts']);
  assert.deepEqual(posted('/v1/tests/changes').at(-1), { branch: 'local:feat/archive', binary: true });
  // No config sync, no GitHub: a laptop never changes the project's config or posts to the outbox.
  assert.ok(!calls.some((c) => c.route === '/v1/config/sync' || c.route.startsWith('/v1/pr/')));
  assert.deepEqual(await (await fetch(`${url}/__replies`)).json(), ['Can students still see an archived class?\nYes, read-only']);
});

test('generate without a terminal or --yes points to Qualio for the questions', async () => {
  const url = await stub('cli');
  const { dir } = await checkout();
  const { code, out } = await runCli(['generate', 'SCH-42', '--no-run'], { cwd: dir, url });
  assert.equal(code, 1);
  assert.match(out, /The Analyst has 1 question\(s\) for SCH-42\. Answer them in Qualio \(http:\/\/qualio\.test\/w\/acme\/p\/school\/work\/42\)/);
});

test('login saves the key only once Qualio accepts it; a wrong key is refused', async () => {
  const url = await stub('cli');
  const { dir } = await checkout();
  const bad = await runCli(['login', '--key', 'qk_wrong', '--api-url', url], { cwd: dir, url, env: { QUALIO_API_KEY: '' } });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /invalid or was revoked/);
  const good = await runCli(['login', '--key', 'qk_stub', '--api-url', url], { cwd: dir, url, env: { QUALIO_API_KEY: '' } });
  assert.equal(good.code, 0, good.out);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'qualio/credentials.json'), 'utf8')), { apiKey: 'qk_stub', apiUrl: url });
  const who = await runCli(['whoami'], { cwd: dir, url: '', env: { QUALIO_API_KEY: '', QUALIO_API_URL: '' } });
  assert.match(who.out, /School/);
});

test('outside a git repository, and without a key, it says what to do', async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'qualio-cli-nogit-'));
  dirs.push(outside);
  const noRepo = await runCli(['status', 'SCH-1'], { cwd: outside, url: 'http://127.0.0.1:9' });
  assert.match(noRepo.out, /inside the git repository/);
  const { dir } = await checkout();
  const noKey = await runCli(['status', 'SCH-1'], { cwd: dir, url: 'http://127.0.0.1:9', env: { QUALIO_API_KEY: '' } });
  assert.match(noKey.out, /qualio login --key/);
});

test("the local branch is the git branch's, also before the first commit and on a detached HEAD", async () => {
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'qualio-cli-fresh-'));
  dirs.push(fresh);
  execFileSync('git', ['init', '-q', '-b', 'feat/new'], { cwd: fresh });
  assert.equal(repository(fresh).branch, 'local:feat/new');
  const { dir } = await checkout();
  execFileSync('git', ['checkout', '-q', '--detach'], { cwd: dir });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(repository(dir).branch, `local:detached-${sha.slice(0, 7)}`);
});

test('arguments, .qualio/.env and the answers to the Analyst', async () => {
  assert.deepEqual(parseArgs(['generate', 'SCH-1', '--base-url=http://localhost:3000', '-y', '--describe', 'x y']), {
    command: 'generate',
    args: ['SCH-1'],
    flags: { 'base-url': 'http://localhost:3000', yes: true, describe: 'x y' },
  });
  assert.throws(() => parseArgs(['run', '--nope']), /Unknown option --nope/);
  assert.throws(() => parseArgs(['run', '--config']), /needs a value/);
  assert.deepEqual(parseDotEnv('# passwords\nADMIN_PASSWORD="s3cret # not a comment"\nexport TEACHER_PASSWORD=t1 # comment\nnot a line\n'), {
    ADMIN_PASSWORD: 's3cret # not a comment',
    TEACHER_PASSWORD: 't1',
  });
  const questions = [
    { question: 'Read-only?', reason: 'r', options: ['Yes', 'No'], recommended: 'Yes' },
    { question: 'How many?', reason: 'r', options: [], recommended: null },
  ];
  const typed = ['2', '', '30'];
  assert.equal(await answerQuestions(questions, { prompt: async () => typed.shift() }), 'Read-only?\nNo\n\nHow many?\n30');
  await assert.rejects(answerQuestions(questions, { yes: true }), /recommends no answer/);
});
