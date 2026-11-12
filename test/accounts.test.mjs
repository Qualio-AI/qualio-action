import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
after(() => children.forEach((c) => c.kill()));

async function stub() {
  const port = await freePort();
  children.push(spawn(process.execPath, [path.join(root, 'test/stub-qualio.mjs'), String(port), ''], { stdio: 'ignore' }));
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

test("the accounts step resolves the config's users and api from the job's env, masks secrets and lets the job env win (phase 77)", async () => {
  const url = await stub();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qualio-accounts-'));
  const githubEnv = path.join(dir, 'env');
  await writeFile(githubEnv, '');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'accounts'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_ENV: githubEnv,
      QUALIO_API_URL: url,
      QUALIO_API_KEY: 'qk_stub',
      CONFIG: 'version: 1\nusers:\n  Admin:\n    password: ${ADMIN_PASSWORD}\n',
      ADMIN_PASSWORD: 's3cret',
      TENANT: 'demo "a"',
      // The older secret fills a role the config gives no password; the job's own variable wins over both.
      QUALIO_TEST_PASSWORDS: 'Admin=old\nOther=0ther',
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = await (await fetch(`${url}/__calls`)).json();
  assert.deepEqual(calls.filter((c) => c.route === '/v1/config/resolve').map((c) => c.body.raw), ['version: 1\nusers:\n  Admin:\n    password: ${ADMIN_PASSWORD}\n']);
  assert.match(result.stdout, /::add-mask::s3cret/);
  assert.match(result.stdout, /::add-mask::lit3ral-pass/);
  assert.match(result.stdout, /::warning title=Qualio::TEACHER_PASSWORD is not set in this job, so E2E_TEACHER_PASSWORD is empty/);
  assert.doesNotMatch(result.stdout.replace(/::add-mask::.*\n/g, ''), /s3cret|lit3ral/);
  assert.equal(
    await readFile(githubEnv, 'utf8'),
    [
      'E2E_ADMIN_USERNAME=admin@school.test',
      'E2E_ADMIN_PASSWORD=s3cret',
      'E2E_HEAD_PASSWORD=lit3ral-pass',
      'QUALIO_API_SCHOOL_API_URL=http://localhost:3000/api',
      'QUALIO_API_SCHOOL_API_HEADERS={"X-Tenant":"demo \\"a\\""}',
      'E2E_OTHER_PASSWORD=0ther',
      '',
    ].join('\n'),
  );
});
