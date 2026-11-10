// Qualio's changes to the tests (TEST_CHANGES): the outbox posts a suggestion for the change that fits
// the pull request's diff, and puts the others (a file outside the diff, new tests) in the Qualio pull
// request into the branch, one commit each, pushing only qualio/pr-7. Runs against test/stub-qualio.mjs.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let child;
after(() => child?.kill());

/** Starts the stub in a mode and runs the outbox step against it. */
async function runOutbox(mode) {
  child?.kill();
  const port = await freePort();
  child = spawn(process.execPath, [path.join(root, 'test/stub-qualio.mjs'), String(port), mode], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    try {
      await fetch(`${url}/__calls`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const out = execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'outbox', '0'], {
    encoding: 'utf8',
    env: { ...process.env, QUALIO_API_URL: url, QUALIO_API_KEY: 'qk_stub', GITHUB_API_URL: url, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'acme/app', GITHUB_SERVER_URL: 'https://github.test', QUALIO_POLL_MS: '10' },
  });
  return { out, url };
}

test('suggests what fits the diff and opens the Qualio pull request for the rest', async () => {
  const { out, url } = await runOutbox('changes');
  const json = async (route) => (await fetch(`${url}${route}`)).json();
  const [github, outbox, calls] = await Promise.all([json('/__github'), json('/__outbox'), json('/__calls')]);
  assert.equal(calls.find((c) => c.route === '/v1/pr/outbox').body.changes, true);

  // One review, one suggestion, on line 3 of the page object, at the head commit.
  assert.equal(github.reviews.length, 1);
  const [comment] = github.reviews[0].comments;
  assert.equal(github.reviews[0].commit_id, 'head7');
  assert.equal(comment.path, 'e2e/pages/students.page.ts');
  assert.equal(comment.line, 3);
  assert.match(comment.body, /```suggestion\n {2}add\(\) \{ return this\.page\.getByRole\('button', \{ name: 'Enroll student' \}\); \}\n```/);
  assert.match(comment.body, /<!-- qualio:suggestion fix-in-diff 0 -->/);

  // Two commits on qualio/pr-7 (based on the branch's head), and the pull request into the branch.
  assert.deepEqual(github.commits.map((c) => c.message.split('\n')[0]), ['test(SCH-9): table renamed', 'test(SCH-9): add E2E tests']);
  assert.deepEqual(github.commits[0].parents, ['head7']);
  assert.deepEqual(github.commits[1].parents, ['commit1']);
  assert.deepEqual(github.trees[1].tree, [{ path: 'e2e/tests/sch-9.spec.ts', mode: '100644', type: 'blob', content: "test('adds', () => {});\n" }]);
  assert.deepEqual(github.refs, [{ ref: 'refs/heads/qualio/pr-7', sha: 'commit2' }]);
  assert.deepEqual(
    github.pulls.map((p) => [p.head, p.base]),
    [['qualio/pr-7', 'feature/sch-9']],
  );

  // The ack says how each change went out.
  const ack = outbox.find((i) => i.id === 'c1').ack;
  assert.equal(ack.error, null);
  assert.deepEqual(
    ack.changes.delivered.map((d) => [d.id, d.via]),
    [
      ['fix-in-diff', 'suggestion'],
      ['fix-outside', 'qualio_pr'],
      ['new-tests', 'qualio_pr'],
    ],
  );
  assert.deepEqual(ack.changes.qualioPr, { number: 8, url: 'https://github.test/acme/app/pull/8', headBranch: 'qualio/pr-7', headSha: 'commit2', state: 'open' });
  assert.match(out, /Qualio pull request #8 \(qualio\/pr-7 → feature\/sch-9\): 2 changes/);
});

test("tells Qualio when GitHub won't let the job open the Qualio pull request, with where to allow it", async () => {
  const { out, url } = await runOutbox('changes-refused');
  const json = async (route) => (await fetch(`${url}${route}`)).json();
  const [github, outbox] = await Promise.all([json('/__github'), json('/__outbox')]);
  // The branch is pushed (a person can open the pull request from it); the pull request is refused.
  assert.deepEqual(github.refs, [{ ref: 'refs/heads/qualio/pr-7', sha: 'commit2' }]);
  assert.deepEqual(github.pulls, []);
  const ack = outbox.find((i) => i.id === 'c1').ack;
  assert.deepEqual(
    ack.changes.delivered.map((d) => [d.id, d.via]),
    [
      ['fix-in-diff', 'suggestion'],
      ['fix-outside', 'report'],
      ['new-tests', 'report'],
    ],
  );
  assert.equal(ack.changes.qualioPr, null);
  assert.deepEqual(ack.changes.blocked, {
    reason: 'pull_request',
    status: 403,
    message: 'GitHub Actions is not permitted to create or approve pull requests.',
    qualioBranch: 'qualio/pr-7',
    compareUrl: 'https://github.test/acme/app/compare/feature%2Fsch-9...qualio%2Fpr-7?expand=1',
  });
  assert.match(out, /::warning title=Qualio::Qualio pushed its changes to qualio\/pr-7 but GitHub didn't let it open the pull request/);
  assert.match(out, new RegExp(`${url.replace(/[.]/g, '\\.')}/docs/getting-started#allow-pull-requests`));
});

test('commits a binary test file a person attached as a blob, never as a suggestion', async () => {
  const { url } = await runOutbox('changes-binary');
  const json = async (route) => (await fetch(`${url}${route}`)).json();
  const [github, outbox, calls] = await Promise.all([json('/__github'), json('/__outbox'), json('/__calls')]);
  assert.equal(calls.find((c) => c.route === '/v1/pr/outbox').body.binary, true);
  assert.equal(github.reviews.length, 0);
  // The workbook's bytes go up as a base64 blob; the tree takes the blob's sha, the test file its text.
  assert.deepEqual(github.blobs, [{ content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3, 0xff, 0xfe]).toString('base64'), encoding: 'base64' }]);
  assert.deepEqual(github.trees[0].tree, [
    { path: 'e2e/tests/import.spec.ts', mode: '100644', type: 'blob', content: "test('imports', () => {});\n" },
    { path: 'e2e/fixtures/students.xlsx', mode: '100644', type: 'blob', sha: 'blob1' },
  ]);
  assert.deepEqual(outbox.find((i) => i.id === 'c1').ack.changes.delivered.map((d) => [d.id, d.via]), [['import-tests', 'qualio_pr']]);
});

