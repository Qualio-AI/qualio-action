// Live diagnosis: while the job waits for a heal, it hosts a browser on the app for Qualio's Runner.
// Runs `qualio.mjs wait` against test/stub-qualio.mjs ("live") with test/fake-mcp.mjs as Playwright MCP.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appPath } from '../scripts/browser-host.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const children = [];
after(() => children.forEach((c) => c.kill()));

async function stub(mode) {
  const port = 5600 + Math.floor(Math.random() * 300);
  children.push(spawn(process.execPath, [path.join(root, 'test/stub-qualio.mjs'), String(port), mode], { stdio: 'ignore' }));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${url}/__calls`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return url;
}

function waitStep(url, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qualio-live-'));
  const runFile = path.join(dir, 'run.json');
  writeFileSync(runFile, JSON.stringify({ runId: 'run_1', status: 'FAILED', heal: 'queued' }));
  const log = path.join(dir, 'mcp.log');
  const out = execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), 'wait', runFile, '1'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QUALIO_API_URL: url,
      QUALIO_API_KEY: 'qk_stub',
      QUALIO_POLL_MS: '50',
      RUNNER_TEMP: dir,
      QUALIO_BASE_URL: 'http://app.test:3000',
      QUALIO_TESTS_DIR: dir,
      QUALIO_BROWSER_EXECUTABLE: process.execPath,
      QUALIO_MCP_COMMAND: JSON.stringify([process.execPath, path.join(root, 'test/fake-mcp.mjs'), log]),
      E2E_ADMIN_USERNAME: 'admin@school.test',
      E2E_ADMIN_PASSWORD: 's3cret-pw',
      GITHUB_TOKEN: 'ghs_secret',
      ...env,
    },
  });
  let starts = [];
  try {
    starts = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch {}
  return { out, starts };
}

test('appPath takes paths of the application only', () => {
  assert.equal(appPath('/students/new?x=1'), '/students/new?x=1');
  for (const bad of ['https://evil.test/', '//evil.test', 'students', '/a b', null]) assert.equal(appPath(bad), null);
});

test("shows the pages Qualio asks for, signed in by the job, and refuses everything else", async () => {
  const url = await stub('live');
  const { out, starts } = waitStep(url, {});
  const calls = await (await fetch(`${url}/__calls`)).json();
  const answers = Object.fromEntries((await (await fetch(`${url}/__browser`)).json()).map((a) => [a.callId, a]));

  // The job offered a browser, and the heal ended as Qualio said.
  assert.equal(calls.find((c) => c.route === '/v1/tests/heal/status').body.browser, true);
  assert.match(out, /Heal: not_healable/);
  assert.match(out, /Qualio looked at 2 pages of the running app \(4 couldn't be shown\)/);

  // As Admin: signed in by the job (the snapshot shows the user), the page's URL, title and tree.
  assert.match(answers.b1.result, /- Page URL: http:\/\/app\.test:3000\/classes/);
  assert.match(answers.b1.result, /generic: Admin User/);
  assert.doesNotMatch(answers.b1.result, /Ran Playwright code/);
  assert.match(answers.b2.result, /generic: nobody/);
  // Refused: another origin, a redirect away from the app, another tool, an unknown role.
  assert.match(answers.b3.error, /not a path of the application/);
  assert.match(answers.b4.error, /redirected away from the application \(to https:\/\/idp\.example\)/);
  assert.match(answers.b5.error, /tool "evaluate" is not allowed/);
  assert.match(answers.b6.error, /no "Owner" role/);

  // One MCP server per role, started lazily; only the Admin one signs in.
  assert.equal(starts.length, 2);
  const admin = starts.find((s) => s.signedInAs);
  const signedOut = starts.find((s) => !s.signedInAs);
  assert.equal(admin.signedInAs, 'admin@school.test');
  assert.ok(admin.args.includes('--init-page'));
  assert.ok(!signedOut.args.includes('--init-page'));
  for (const s of starts) {
    assert.ok(s.args.includes('--headless') && s.args.includes('--isolated'));
    assert.equal(s.args[s.args.indexOf('--executable-path') + 1], process.execPath);
    // Never the job's other secrets: not Qualio's key, not GitHub's token, not the secrets themselves.
    for (const name of ['QUALIO_API_KEY', 'GITHUB_TOKEN', 'E2E_ADMIN_PASSWORD', 'E2E_ADMIN_USERNAME', 'QUALIO_API_URL']) assert.ok(!s.env.includes(name), `${name} leaked to the MCP server`);
  }
  // The password never travels to Qualio.
  assert.ok(!JSON.stringify(calls).includes('s3cret-pw'));
});

test('hosts nothing when live diagnosis is off', async () => {
  const url = await stub('live');
  const { out, starts } = waitStep(url, { QUALIO_LIVE_DIAGNOSIS: 'false' });
  assert.match(out, /Heal: not_healable/);
  assert.deepEqual(starts, []);
  const calls = await (await fetch(`${url}/__calls`)).json();
  assert.ok(calls.filter((c) => c.route === '/v1/tests/heal/status').every((c) => !c.body.browser));
  assert.ok(!calls.some((c) => c.route === '/v1/browser/next'));
});
