import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskSecrets, PATCH_MAX, pullRequestChanges } from '../scripts/changes.mjs';

const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'acme/app' };
const pr = { number: 9, state: 'open', head: { sha: 'abcdef12' }, base: { sha: 'fedcba98' } };

test('reads the changed files with the job’s token, without lockfile or secret-file patches', async () => {
  const calls = [];
  const fake = async (method, route) => {
    calls.push(`${method} ${route}`);
    return {
      status: 200,
      data: [
        { filename: 'app/pupils/page.tsx', status: 'modified', additions: 1, deletions: 1, patch: '@@\n-<h1>Students</h1>\n+<h1>Pupils</h1>\n+const apiKey = "sk_live_abcdefgh";' },
        { filename: 'pnpm-lock.yaml', status: 'modified', additions: 900, deletions: 20, patch: 'lots' },
        { filename: 'config/.env.production', status: 'modified', additions: 1, deletions: 0, patch: '+SECRET=1' },
        { filename: 'big.ts', status: 'added', additions: 9000, deletions: 0, patch: 'x'.repeat(PATCH_MAX + 1) },
      ],
    };
  };
  const changes = await pullRequestChanges(pr, env, fake);
  assert.deepEqual(calls, ['GET /repos/acme/app/pulls/9/files?per_page=100&page=1']);
  assert.equal(changes.headSha, 'abcdef12');
  assert.equal(changes.baseSha, 'fedcba98');
  assert.match(changes.files[0].patch, /\+<h1>Pupils<\/h1>/);
  assert.match(changes.files[0].patch, /apiKey = "\*\*\*"/);
  assert.equal(changes.files[1].patch, null);
  assert.equal(changes.files[2].patch, null);
  assert.ok(changes.files[3].patch.endsWith('… (cut)'));
  assert.equal(changes.truncated, true);
});

test('sends nothing for a closed pull request, without a token, or when GitHub refuses', async () => {
  assert.equal(await pullRequestChanges({ ...pr, state: 'closed' }, env, async () => ({ status: 200, data: [] })), null);
  assert.equal(await pullRequestChanges(pr, {}, async () => ({ status: 200, data: [] })), null);
  assert.equal(await pullRequestChanges(pr, env, async () => ({ status: 403, data: null })), null);
});

test('masks values that look like secrets', () => {
  assert.equal(maskSecrets('+PASSWORD="hunter2hunter2"'), '+PASSWORD="***"');
  assert.equal(maskSecrets('+const name = "Ada Lovelace"'), '+const name = "Ada Lovelace"');
});
