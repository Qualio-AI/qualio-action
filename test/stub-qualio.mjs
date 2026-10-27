// A stand-in for Qualio's CI API, to check tests-source: qualio end to end without a Qualio server.
// The first download serves a test that fails on a renamed button; once the heal is "patched" the
// next download serves the fixed test. A tiny reporter in the bundle writes the run file the way
// Qualio's reporter does. GET /__calls lists the requests received.
//
//   node test/stub-qualio.mjs [port] [propose]     (default 4555; "propose": the project asks first,
//                                                  so the heal ends "proposed" and nothing is fixed)
import http from 'node:http';

const port = Number(process.argv[2] || 4555);
const propose = process.argv[3] === 'propose';
const calls = [];
let healPolls = 0;
let healed = false;

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

http
  .createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/__calls') return res.end(JSON.stringify(calls));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ route: req.url, auth: req.headers.authorization === 'Bearer qk_stub', body });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer qk_stub') return res.writeHead(401).end(JSON.stringify({ error: 'Invalid or revoked API key' }));
    if (req.url === '/v1/tests/bundle') return res.end(JSON.stringify(bundle()));
    if (req.url === '/v1/tests/heal/status') {
      healPolls += 1;
      if (propose) return res.end(JSON.stringify({ status: healPolls >= 2 ? 'proposed' : 'running' }));
      healed = healPolls >= 2;
      return res.end(JSON.stringify({ status: healed ? 'patched' : 'running' }));
    }
    if (req.url === '/v1/tests/promote')
      return res.end(JSON.stringify(body.merged ? { promoted: ['tests/login.spec.ts'], skipped: [], discarded: 0 } : { promoted: [], skipped: [], discarded: 1 }));
    res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
  })
  .listen(port, () => console.log(`Stub Qualio API on http://localhost:${port}`));
