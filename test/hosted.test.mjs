// The hosted action (projects whose tests Qualio runs): the event is sent to /v1/runs/hosted, the run is followed
// until it is done, and the job fails unless it passed. Runs against test/stub-qualio.mjs.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function job(mode, event) {
  const url = await stub(mode);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qualio-hosted-'));
  dirs.push(dir);
  await writeFile(path.join(dir, 'event.json'), JSON.stringify(event));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'hosted', '1'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      QUALIO_API_URL: url,
      QUALIO_API_KEY: 'qk_stub',
      QUALIO_POLL_MS: '50',
      QUALIO_PREVIEW_URL: 'https://pr-7.preview.example.com',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: path.join(dir, 'event.json'),
      GITHUB_OUTPUT: path.join(dir, 'outputs.txt'),
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    },
  });
  const calls = await (await fetch(`${url}/__calls`)).json();
  const read = (f) => readFile(path.join(dir, f), 'utf8').catch(() => '');
  return { result, calls, outputs: await read('outputs.txt'), summary: await read('summary.md') };
}

const pr = (extra = {}) => ({
  action: 'synchronize',
  pull_request: { number: 7, title: 'SCH-9 Enroll', body: null, html_url: 'https://github.com/acme/app/pull/7', merged: false, head: { ref: 'feat/enroll', sha: 'abc1234' }, base: { ref: 'main' }, user: { login: 'dev' }, ...extra },
});

test("sends the pull request and its preview URL, waits for the run, and passes when Qualio's run passed", async () => {
  const { result, calls, outputs, summary } = await job('hosted', pr());
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const start = calls.find((c) => c.route === '/v1/runs/hosted');
  assert.deepEqual(
    { event: start.body.event, action: start.body.action, branch: start.body.branch, url: start.body.url, number: start.body.pr.number, base: start.body.pr.baseBranch, author: start.body.pr.author },
    { event: 'pull_request', action: 'synchronize', branch: 'feat/enroll', url: 'https://pr-7.preview.example.com', number: 7, base: 'main', author: 'dev' },
  );
  assert.ok(calls.filter((c) => c.route === '/v1/runs/hosted/h1/status').length >= 2);
  assert.match(outputs, /result=passed/);
  assert.match(summary, /the tests passed/);
  assert.match(summary, /Qualio healed the tests and ran them again/);
});

test('fails the job when the run failed, and says what waits for a person', async () => {
  const { result, summary } = await job('hosted-fail', pr());
  assert.equal(result.status, 1);
  assert.match(result.stdout, /The tests failed in Qualio: http:\/\/stub\.test\/runs\/r1/);
  assert.match(summary, /1 change needs a decision in Qualio/);
});

test('a pull request closed without merging runs nothing', async () => {
  const { result, outputs } = await job('hosted', { ...pr(), action: 'closed' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(outputs, /result=skipped/);
});
