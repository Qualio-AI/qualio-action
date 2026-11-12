import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePasswords, roleEnvKey } from '../scripts/accounts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('roleEnvKey matches the webapp: "Head teacher" → HEAD_TEACHER', () => {
  assert.equal(roleEnvKey('Admin'), 'ADMIN');
  assert.equal(roleEnvKey('Head teacher'), 'HEAD_TEACHER');
  assert.equal(roleEnvKey('Head-teacher'), 'HEAD_TEACHER');
});

test('parsePasswords reads Role=password lines, keeps = in passwords, and reports only line numbers', () => {
  const { passwords, unreadable } = parsePasswords('# test accounts\nAdmin=s3cret\n\nHead teacher = a=b=c\nno equals sign\n=orphan\n');
  assert.deepEqual(passwords, [
    { role: 'Admin', name: 'E2E_ADMIN_PASSWORD', password: 's3cret' },
    { role: 'Head teacher', name: 'E2E_HEAD_TEACHER_PASSWORD', password: ' a=b=c' },
  ]);
  assert.deepEqual(unreadable, [5, 6]);
});

test('the passwords step masks each password, exports it, and lets the job env win', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qualio-passwords-'));
  const githubEnv = path.join(dir, 'env');
  await writeFile(githubEnv, '');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'passwords'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_ENV: githubEnv, QUALIO_TEST_PASSWORDS: 'Admin=s3cret\nTeacher=0ther\nbroken', E2E_TEACHER_PASSWORD: 'from-the-job' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /::add-mask::s3cret/);
  assert.match(result.stdout, /::add-mask::0ther/);
  assert.match(result.stdout, /line 3 isn't Role=password/);
  assert.doesNotMatch(result.stdout.replace(/::add-mask::.*\n/g, ''), /s3cret|0ther|broken/);
  assert.equal(await readFile(githubEnv, 'utf8'), 'E2E_ADMIN_PASSWORD=s3cret\n');
});
