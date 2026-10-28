// A stand-in for Qualio's CI API, to check tests-source: qualio end to end without a Qualio server.
// The first download serves a test that fails on a renamed button; once the heal is "patched" the
// next download serves the fixed test. A tiny reporter in the bundle writes the run file the way
// Qualio's reporter does. GET /__calls lists the requests received.
//
// It also answers the pull request sync and the GitHub outbox (empty unless "outbox"), and stands in
// for the GitHub REST calls the outbox makes (/repos/...), for local runs with GITHUB_API_URL set to it.
//
//   node test/stub-qualio.mjs [port] [propose|setup|outbox]
//     (default 4555; "propose": the project asks first, so the heal ends "proposed" and nothing is
//     fixed; "setup": the project has no first test suite yet, so the job maps the app with the stub's
//     mapper, and checks the suite twice: the first check fails, the "repaired" second one passes)
import http from 'node:http';

const port = Number(process.argv[2] || 4555);
const propose = process.argv[3] === 'propose';
const setupMode = process.argv[3] === 'setup';
// "outbox": a comment, a status, a dispatch and a label change wait for the job to send them.
const outbox =
  process.argv[3] === 'outbox'
    ? [
        { id: 'o1', kind: 'COMMENT', prNumber: 7, sha: null, payload: { prNumber: 7, body: 'Qualio AI: the tests pass.' } },
        { id: 'o2', kind: 'STATUS', prNumber: null, sha: 'abc1234', payload: { sha: 'abc1234', state: 'failure', context: 'qualio/regression', description: 'Possible regression' } },
        { id: 'o3', kind: 'DISPATCH', prNumber: null, sha: null, payload: { ref: 'feature/sch-9' } },
        { id: 'o4', kind: 'LABEL', prNumber: 7, sha: null, payload: { prNumber: 7, add: ['qualio: tests passing'], remove: ['qualio: regression'] } },
      ]
    : [];
const calls = [];
let healPolls = 0;
let healed = false;
// Setup mode: map → wait → check 1 (fails) → wait → check 2 (passes) → done.
const setup = { mapped: false, round: 0, reported: 0, passed: false, polls: 0 };

const spec = (name) => `import { expect, test } from '@playwright/test';

test('signs in', async ({ page }) => {
  await page.setContent('<main><button type="button">Log in</button></main>');
  await expect(page.getByRole('button', { name: '${name}' })).toBeVisible({ timeout: 2000 });
});
`;

const reporter = `import { writeFileSync } from 'node:fs';

export default class StubReporter {
  onEnd(result) {
    const status = result.status === 'passed' ? 'PASSED' : 'FAILED';
    console.log('[qualio] Results reported: http://stub.test/runs/run_' + (process.env.QUALIO_RUN_ROUND || '1'));
    if (status === 'FAILED') console.log('[qualio] Self-healing requested: Qualio will diagnose the failures and fix the tests if they are healable.');
    if (process.env.QUALIO_RUN_FILE)
      writeFileSync(process.env.QUALIO_RUN_FILE, JSON.stringify({ runId: 'run_1', status, url: 'http://stub.test/runs/run_1', heal: status === 'FAILED' ? 'queued' : null }));
  }
}
`;

const bundle = () => ({
  bundleId: healed ? 'b_healed' : 'b_main',
  revisionIds: healed ? ['r1', 'r2'] : ['r1'],
  files: [
    { path: 'package.json', content: JSON.stringify({ name: 'qualio-e2e', private: true, devDependencies: { '@playwright/test': '1.64.1' } }, null, 2) },
    {
      path: 'playwright.config.ts',
      content: "import { defineConfig, devices } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', reporter: [['list'], ['html', { open: 'never' }], ['./support/stub-reporter.mjs']], projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }] });\n",
    },
    { path: 'support/stub-reporter.mjs', content: reporter },
    { path: 'tests/login.spec.ts', content: spec(healed ? 'Log in' : 'Sign in') },
    { path: '.qualio-bundle.json', content: JSON.stringify({ bundleId: healed ? 'b_healed' : 'b_main', revisionIds: [] }) },
  ],
});

const pkg = { path: 'package.json', content: JSON.stringify({ name: 'qualio-e2e', private: true, devDependencies: { '@playwright/test': '1.64.1' } }, null, 2) };

// The mapper the action runs: one test that "maps" a page and tells the stub it's done.
const mapper = () => [
  pkg,
  { path: 'qualio-map.config.ts', content: "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './map', reporter: [['list']] });\n" },
  {
    path: 'map/map.spec.ts',
    content: `import { test } from '@playwright/test';

test('map the application for Qualio', async ({ page }) => {
  await page.setContent('<main><h1>Home</h1></main>');
  const res = await fetch(process.env.QUALIO_API_URL + '/v1/setup/s1/mapped', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.QUALIO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ crawlId: 'c1', pages: [{ role: null, url: 'http://app.test/', pattern: '/', title: 'Home', headings: ['Home'], landmarks: ['main'], controls: [] }], signedIn: [] }),
  });
  if (!res.ok) throw new Error('mapped: ' + res.status);
});
`,
  },
];

// The suite's checks report their round like Qualio's reporter (QUALIO_RUN_ROUND).
const setupReporter = `export default class SetupReporter {
  async onEnd(result) {
    await fetch(process.env.QUALIO_API_URL + '/v1/runs', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.QUALIO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ round: Number(process.env.QUALIO_RUN_ROUND), status: result.status }),
    });
  }
}
`;

const suiteBundle = () => ({
  bundleId: `b_check${setup.round}`,
  revisionIds: ['r1'],
  files: [
    pkg,
    { path: 'playwright.config.ts', content: "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', reporter: [['list'], ['./support/setup-reporter.mjs']] });\n" },
    { path: 'support/setup-reporter.mjs', content: setupReporter },
    { path: 'tests/login.spec.ts', content: spec(setup.round >= 2 ? 'Log in' : 'Sign in') },
  ],
});

function setupStatus() {
  if (!setup.mapped) return { state: 'map', suiteId: 's1', round: 0, files: mapper() };
  if (setup.passed) return { state: 'done', round: setup.round, result: { features: 1, tests: 1, dropped: [] }, url: 'http://stub.test/setup' };
  // A check whose results arrived: "repair", then the next check.
  if (setup.reported === setup.round && setup.polls++ >= 1) {
    setup.round += 1;
    setup.polls = 0;
  }
  return setup.reported < setup.round ? { state: 'validate', round: setup.round, message: `Running the generated tests (check ${setup.round}).` } : { state: 'wait', round: setup.round, message: 'Writing the tests.' };
}

http
  .createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/__calls') return res.end(JSON.stringify(calls));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ route: req.url, method: req.method, auth: req.headers.authorization === 'Bearer qk_stub', body });
    res.setHeader('content-type', 'application/json');
    // GitHub's REST API, as the outbox uses it (any token).
    if (req.url.startsWith('/repos/')) {
      if (req.method === 'DELETE') return res.writeHead(404).end(JSON.stringify({ message: 'Label does not exist' }));
      return res.writeHead(req.url.endsWith('/dispatches') ? 204 : 201).end(req.url.endsWith('/dispatches') ? '' : JSON.stringify({ id: 1 }));
    }
    if (req.headers.authorization !== 'Bearer qk_stub') return res.writeHead(401).end(JSON.stringify({ error: 'Invalid or revoked API key' }));
    if (req.url === '/v1/setup/start') return res.end(JSON.stringify(setupMode ? setupStatus() : { state: 'done', suiteId: 's0' }));
    if (req.url === '/v1/setup/s1/mapped') {
      setup.mapped = true;
      return res.end(JSON.stringify({ state: 'wait' }));
    }
    if (req.url === '/v1/setup/s1/status') return res.end(JSON.stringify(setupStatus()));
    if (req.url === '/v1/runs') {
      setup.reported = body.round;
      setup.passed = body.status === 'passed';
      return res.writeHead(201).end(JSON.stringify({ runId: `run_${body.round}` }));
    }
    if (req.url === '/v1/tests/bundle') return res.end(JSON.stringify(body.suiteId ? suiteBundle() : bundle()));
    if (req.url === '/v1/tests/heal/status') {
      healPolls += 1;
      if (propose) return res.end(JSON.stringify({ status: healPolls >= 2 ? 'proposed' : 'running' }));
      healed = healPolls >= 2;
      return res.end(JSON.stringify({ status: healed ? 'patched' : 'running' }));
    }
    if (req.url === '/v1/pr/sync') return res.end(JSON.stringify({ ok: true }));
    if (req.url === '/v1/pr/outbox') return res.end(JSON.stringify({ items: outbox.filter((i) => !i.sent) }));
    const ack = /^\/v1\/pr\/outbox\/(\w+)\/ack$/.exec(req.url);
    if (ack) {
      const item = outbox.find((i) => i.id === ack[1] && !i.sent);
      if (!item) return res.writeHead(404).end(JSON.stringify({ error: 'No pending outbox item with this id' }));
      item.sent = true;
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === '/v1/runs/errored') return res.end(JSON.stringify({ ok: true }));
    if (req.url === '/v1/tests/promote')
      return res.end(JSON.stringify(body.merged ? { promoted: ['tests/login.spec.ts'], skipped: [], discarded: 0 } : { promoted: [], skipped: [], discarded: 1 }));
    res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
  })
  .listen(port, () => console.log(`Stub Qualio API on http://localhost:${port}`));
