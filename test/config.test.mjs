// The config step sends qualio.yml's config (inline or config-file) and the overview documents it names,
// and fails the job on an invalid config. Runs against test/stub-qualio.mjs.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let port;
let repo;
let stub;

before(async () => {
  port = await freePort();
  repo = await mkdtemp(path.join(os.tmpdir(), 'qualio-config-'));
  await mkdir(path.join(repo, 'docs/qualio/skills'), { recursive: true });
  await writeFile(path.join(repo, 'docs/qualio/domain.md'), '# Classes\n- At most 30 students\n');
  await writeFile(path.join(repo, 'docs/qualio/skills/roles.md'), '# Roles\n');
  await writeFile(path.join(repo, 'docs/qualio/logo.png'), 'not text');
  await mkdir(path.join(repo, '.qualio'));
  await writeFile(path.join(repo, '.qualio/config.yml'), 'version: 1\ntests:\n  suggestions: review\n');
  stub = spawn(process.execPath, [path.join(root, 'test/stub-qualio.mjs'), String(port)], { stdio: 'ignore' });
  for (let i = 0; i < 300; i++) {
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

async function config(env) {
  const before = (await (await fetch(`http://127.0.0.1:${port}/__calls`)).json()).length;
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'config', 'main'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, QUALIO_API_URL: `http://127.0.0.1:${port}`, QUALIO_API_KEY: 'qk_stub', GITHUB_WORKSPACE: repo, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'abc1234', CONFIG: '', CONFIG_FILE: '', ...env },
  });
  const calls = (await (await fetch(`http://127.0.0.1:${port}/__calls`)).json()).slice(before).filter((c) => c.route === '/v1/config/sync');
  return { ...result, calls };
}

test('sends the inline config, then the overview documents it names', async () => {
  const { status, stdout, calls } = await config({ CONFIG: 'version: 1\noverview: docs/qualio/\n' });
  assert.equal(status, 0, stdout);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.source, 'inline');
  assert.equal(calls[0].body.overview, undefined);
  assert.deepEqual(
    calls[1].body.overview.map((f) => f.path),
    ['docs/qualio/domain.md', 'docs/qualio/skills/roles.md'],
  );
  assert.match(calls[1].body.overview[0].content, /At most 30 students/);
  assert.match(stdout, /scope=project/);
});

test('reads config-file from the checkout', async () => {
  const { status, calls } = await config({ CONFIG_FILE: '.qualio/config.yml' });
  assert.equal(status, 0);
  assert.equal(calls[0].body.source, '.qualio/config.yml');
  assert.match(calls[0].body.raw, /suggestions: review/);
});

test('fails the job on an invalid config, both inputs, or a missing file', async () => {
  const invalid = await config({ CONFIG: 'version: 1\nself-healing:\n  rules:\n    bug: heal\n' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /::error title=Qualio config::self-healing\.rules\.bug/);
  const both = await config({ CONFIG: 'version: 1', CONFIG_FILE: '.qualio/config.yml' });
  assert.equal(both.status, 1);
  assert.match(both.stdout, /either the config input or config-file/);
  const missing = await config({ CONFIG_FILE: '.qualio/nope.yml' });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /does not exist/);
  const outside = await config({ CONFIG: 'version: 1\noverview: ../etc/\n' });
  assert.equal(outside.status, 1);
  assert.match(outside.stdout, /outside the repository/);
});

test("says when the workflow's base-url input overrides the config's app.url", async () => {
  const overridden = await config({ CONFIG: 'version: 1\napp:\n  url: http://localhost:4000\n', BASE_URL_INPUT: 'https://pr-7.preview.example.com' });
  assert.equal(overridden.status, 0, overridden.stdout);
  assert.match(overridden.stdout, /::notice title=Qualio config::The workflow's base-url input \(https:\/\/pr-7\.preview\.example\.com\) overrides the config's app\.url \(http:\/\/localhost:4000\)/);
  const same = await config({ CONFIG: 'version: 1\napp:\n  url: http://localhost:4000\n', BASE_URL_INPUT: 'http://localhost:4000/' });
  assert.doesNotMatch(same.stdout, /overrides the config's app\.url/);
  const none = await config({ CONFIG: 'version: 1\n' });
  assert.doesNotMatch(none.stdout, /overrides/);
});
