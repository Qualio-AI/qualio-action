// Qualio's changes to the tests (TEST_CHANGES): the outbox posts a suggestion for the change that fits
// the pull request's diff, and puts the others (a file outside the diff, new tests) in the Qualio pull
// request into the branch, one commit each, pushing only qualio/pr-7. Runs against test/stub-qualio.mjs.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let child;
after(() => child?.kill());

test('suggests what fits the diff and opens the Qualio pull request for the rest', async () => {
  const port = 5300 + Math.floor(Math.random() * 300);
  child = spawn(process.execPath, [path.join(root, 'test/stub-qualio.mjs'), String(port), 'changes'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${url}/__calls`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const out = execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'outbox', '0'], {
    encoding: 'utf8',
    env: { ...process.env, QUALIO_API_URL: url, QUALIO_API_KEY: 'qk_stub', GITHUB_API_URL: url, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'acme/app', QUALIO_POLL_MS: '10' },
  });
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
