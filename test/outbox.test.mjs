// The outbox step sends what Qualio queued for GitHub: the pull request's one report comment is posted
// once and edited after that (found by its marker when its id is lost), and commands get reactions.
// Runs against test/stub-qualio.mjs, which stands in for both Qualio and GitHub.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stubs = [];

async function stub(mode) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'test/stub-qualio.mjs'), String(port), mode], { stdio: 'ignore' });
  child.unref();
  stubs.push(child);
  for (let i = 0; i < 300; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/__calls`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const url = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'outbox', '0'], {
    encoding: 'utf8',
    env: { ...process.env, QUALIO_API_URL: url, QUALIO_API_KEY: 'qk_stub', GITHUB_API_URL: url, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'acme/app', QUALIO_POLL_MS: '10' },
  });
  const json = async (route) => (await fetch(`${url}${route}`)).json();
  return { calls: await json('/__calls'), outbox: await json('/__outbox') };
}

after(() => stubs.forEach((s) => s.kill()));

test('posts the first report, keeps its id, and reacts to a command', async () => {
  const { calls, outbox } = await stub('outbox');
  assert.equal(calls.find((c) => c.route === '/v1/pr/outbox').body.report, true);
  const github = calls.filter((c) => c.route.startsWith('/repos/')).map((c) => `${c.method} ${c.route.replace(/\?.*/, '')}`);
  assert.ok(github.includes('GET /repos/acme/app/issues/7/comments'));
  assert.ok(github.includes('POST /repos/acme/app/issues/7/comments'));
  assert.ok(github.includes('POST /repos/acme/app/issues/comments/55/reactions'));
  assert.ok(outbox.every((i) => i.sent));
  assert.deepEqual(outbox.find((i) => i.kind === 'REPORT').ack, { error: null, commentId: 1 });
});

test('edits the report found by its marker when the stored comment is gone', async () => {
  const { calls, outbox } = await stub('report-lost');
  const github = calls.filter((c) => c.route.startsWith('/repos/')).map((c) => `${c.method} ${c.route.replace(/\?.*/, '')}`);
  assert.deepEqual(github, ['PATCH /repos/acme/app/issues/comments/404', 'GET /repos/acme/app/issues/7/comments', 'PATCH /repos/acme/app/issues/comments/77']);
  assert.deepEqual(outbox[0].ack, { error: null, commentId: 77 });
});
