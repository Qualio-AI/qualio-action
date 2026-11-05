// A stand-in for Qualio's CI API, to check the action end to end without a Qualio server.
// The tests live in the repository: test/heal-fixture has a test that fails on a renamed button; once
// the heal is "patched", /v1/tests/changes serves the fixed test, which the action writes on top of the
// checkout for the re-run. GET /__calls lists the requests received.
//
// It also answers the pull request sync and the GitHub outbox (empty unless "outbox" or "changes"), and
// stands in for the GitHub REST calls the outbox makes (/repos/...), for local runs with GITHUB_API_URL set to it.
//
//   node test/stub-qualio.mjs [port] [propose|setup|outbox|report-lost|changes|move]
//     (default 4555; "propose": the project asks first, so the heal ends "proposed" and nothing is
//     fixed; "setup": the project has no first test suite yet, so the job maps the app with the stub's
//     mapper, and checks the suite twice: the first check fails, the "repaired" second one passes;
//     "changes": Qualio offers three changes on pull request #7 (one fits a suggestion, one is outside
//     the diff, one adds a file); "move": the project's tests are still in Qualio, so a job without the
//     tests folder gets the whole folder; "live": the heal looks at the running app through the job's
//     browser host (live diagnosis): five calls, two fine and three the host must refuse, then the heal
//     ends not_healable; GET /__browser lists the host's answers)
import { createHash } from 'node:crypto';
import http from 'node:http';

const port = Number(process.argv[2] || 4555);
const propose = process.argv[3] === 'propose';
const setupMode = process.argv[3] === 'setup';
const mode = process.argv[3] ?? '';
const healedNow = mode === 'healed';
// "outbox": a comment, a status, a dispatch, a label change, the pull request's report (posted, as no
// report exists yet) and a reaction wait for the job to send them. "report-lost": the report's stored
// comment is gone (404), so the job finds it by its marker and edits that one.
const reportLost = process.argv[3] === 'report-lost';
const REPORT = '<!-- qualio:report -->\n\n### ✅ Qualio: Ready to merge';
const outbox =
  reportLost
    ? [{ id: 'r1', kind: 'REPORT', prNumber: 7, sha: null, payload: { prNumber: 7, body: REPORT, commentId: 404 } }]
    : mode === 'changes'
    ? [{ id: 'c1', kind: 'TEST_CHANGES', prNumber: 7, sha: null, payload: null }]
    : process.argv[3] === 'outbox'
    ? [
        { id: 'o1', kind: 'COMMENT', prNumber: 7, sha: null, payload: { prNumber: 7, body: 'Qualio AI: the tests pass.' } },
        { id: 'o2', kind: 'STATUS', prNumber: null, sha: 'abc1234', payload: { sha: 'abc1234', state: 'failure', context: 'qualio/regression', description: 'Possible regression' } },
        { id: 'o3', kind: 'DISPATCH', prNumber: null, sha: null, payload: { ref: 'feature/sch-9' } },
        { id: 'o4', kind: 'LABEL', prNumber: 7, sha: null, payload: { prNumber: 7, add: ['qualio: tests passing'], remove: ['qualio: regression'] } },
        { id: 'o5', kind: 'REPORT', prNumber: 7, sha: null, payload: { prNumber: 7, body: REPORT, commentId: null } },
        { id: 'o6', kind: 'REACTION', prNumber: 7, sha: null, payload: { prNumber: 7, commentId: 55, content: '+1' } },
      ]
    : [];
const calls = [];
let healPolls = 0;
// "live": what the Runner asks the job's browser to show, and what the host answered.
const LIVE_ROLES = [{ role: 'Admin', usernameEnv: 'E2E_ADMIN_USERNAME', passwordEnv: 'E2E_ADMIN_PASSWORD' }];
const browserQueue = [
  { id: 'b1', tool: 'open', args: { path: '/classes', role: 'Admin' } },
  { id: 'b2', tool: 'open', args: { path: '/login', role: null } },
  { id: 'b3', tool: 'open', args: { path: 'https://evil.test/', role: null } },
  { id: 'b4', tool: 'open', args: { path: '/away', role: null } },
  { id: 'b5', tool: 'evaluate', args: { code: 'document.cookie' } },
  { id: 'b6', tool: 'open', args: { path: '/x', role: 'Owner' } },
  // The Healer's check of its locators (one found, two found, none, one that isn't a locator).
  { id: 'b7', tool: 'check', args: { path: '/login', role: null, locators: ["getByRole('button', { name: 'Log in' })", "getByRole('link')", "getByRole('button', { name: 'Gone' })", 'page.evaluate(() => document.cookie)'] } },
];
const browserAnswers = [];
let healed = false;
// Setup mode: map → wait → check 1 (fails) → wait → check 2 (passes) → done.
const setup = { mapped: false, round: 0, reported: 0, passed: false, polls: 0 };

const spec = (name) => `import { expect, test } from '@playwright/test';

test('signs in', async ({ page }) => {
  await page.setContent('<main><button type="button">Log in</button></main>');
  await expect(page.getByRole('button', { name: '${name}' })).toBeVisible({ timeout: 2000 });
});
`;

// "changes": what the repository has on pull request #7's head (feature/sch-9), and Qualio's three changes.
const PAGE = "export class StudentsPage {\n  constructor(page) { this.page = page; }\n  add() { return this.page.getByRole('button', { name: 'Add student' }); }\n  search() { return this.page.getByRole('searchbox', { name: 'Search' }); }\n}\n";
const LIST = "export const list = (page) => page.getByRole('table', { name: 'Students' });\n";
const repoFiles = { 'e2e/pages/students.page.ts': PAGE, 'e2e/pages/list.page.ts': LIST };
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const testChanges = () => ({
  branch: 'feature/sch-9',
  prNumber: 7,
  testsDir: 'e2e',
  mode: 'REVIEW',
  qualioBranch: 'qualio/pr-7',
  qualioPr: null,
  close: false,
  title: 'Qualio: test changes for #7',
  body: 'Qualio body',
  pageUrl: 'http://stub.test/pull-requests/7',
  changes: [
    // In the diff (line 3 of the page object): a suggestion.
    { id: 'fix-in-diff', kind: 'fix', featureKey: 'SCH-9', title: 'SCH-9: renamed button', message: 'test(SCH-9): renamed button', body: 'Renamed', suggest: true, via: null, files: [{ path: 'pages/students.page.ts', content: PAGE.replace('Add student', 'Enroll student'), baseSha256: sha256(PAGE) }] },
    // A file the pull request didn't touch: the Qualio pull request.
    { id: 'fix-outside', kind: 'fix', featureKey: 'SCH-9', title: 'SCH-9: table renamed', message: 'test(SCH-9): table renamed', body: 'Table', suggest: true, via: null, files: [{ path: 'pages/list.page.ts', content: LIST.replace('Students', 'Roster'), baseSha256: sha256(LIST) }] },
    // New tests: the Qualio pull request.
    { id: 'new-tests', kind: 'tests', featureKey: 'SCH-9', title: 'SCH-9: E2E tests', message: 'test(SCH-9): add E2E tests', body: 'New', suggest: false, via: null, files: [{ path: 'tests/sch-9.spec.ts', content: "test('adds', () => {});\n", baseSha256: null }] },
  ],
});
const github = { reviews: [], trees: [], commits: [], refs: [], pulls: [] };

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
  revisionIds: ['r1'],
  replace: false,
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
    if (req.method === 'GET' && req.url === '/__browser') return res.end(JSON.stringify(browserAnswers));
    if (req.method === 'GET' && req.url === '/__outbox') return res.end(JSON.stringify(outbox));
    if (req.method === 'GET' && req.url === '/__github') return res.end(JSON.stringify(github));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ route: req.url, method: req.method, auth: req.headers.authorization === 'Bearer qk_stub', body });
    res.setHeader('content-type', 'application/json');
    // GitHub's REST API, as the outbox uses it (any token).
    if (req.url.startsWith('/repos/acme/app/') && mode === 'changes') {
      const route = req.url.slice('/repos/acme/app'.length);
      if (req.method === 'GET' && route === '/pulls/7') return res.end(JSON.stringify({ number: 7, state: 'open', head: { sha: 'head7' } }));
      if (req.method === 'GET' && route.startsWith('/pulls/7/files'))
        return res.end(JSON.stringify([{ filename: 'e2e/pages/students.page.ts', patch: "@@ -1,4 +1,4 @@\n export class StudentsPage {\n   constructor(page) { this.page = page; }\n-  add() { return this.page.getByRole('button', { name: 'Add' }); }\n+  add() { return this.page.getByRole('button', { name: 'Add student' }); }\n   search() { return this.page.getByRole('searchbox', { name: 'Search' }); }" }]));
      const contents = /^\/contents\/(.+)\?ref=/.exec(route);
      if (req.method === 'GET' && contents) {
        const file = decodeURIComponent(contents[1]);
        return repoFiles[file] === undefined
          ? res.writeHead(404).end(JSON.stringify({ message: 'Not Found' }))
          : res.end(JSON.stringify({ type: 'file', encoding: 'base64', sha: 'b', content: Buffer.from(repoFiles[file]).toString('base64') }));
      }
      if (req.method === 'POST' && route === '/pulls/7/reviews') {
        github.reviews.push(body);
        return res.writeHead(200).end(JSON.stringify({ id: 900 }));
      }
      if (req.method === 'GET' && route.startsWith('/git/ref/heads/')) return res.end(JSON.stringify({ object: { sha: 'head7' } }));
      if (req.method === 'GET' && route === '/git/commits/head7') return res.end(JSON.stringify({ sha: 'head7', tree: { sha: 'tree7' } }));
      if (req.method === 'POST' && route === '/git/trees') {
        github.trees.push(body);
        return res.writeHead(201).end(JSON.stringify({ sha: `tree${github.trees.length}` }));
      }
      if (req.method === 'POST' && route === '/git/commits') {
        github.commits.push(body);
        return res.writeHead(201).end(JSON.stringify({ sha: `commit${github.commits.length}` }));
      }
      if (req.method === 'PATCH' && route.startsWith('/git/refs/')) return res.writeHead(422).end(JSON.stringify({ message: 'Reference does not exist' }));
      if (req.method === 'POST' && route === '/git/refs') {
        github.refs.push(body);
        return res.writeHead(201).end(JSON.stringify({ ref: body.ref }));
      }
      if (req.method === 'GET' && route.startsWith('/pulls?')) return res.end('[]');
      if (req.method === 'POST' && route === '/pulls') {
        github.pulls.push(body);
        return res.writeHead(201).end(JSON.stringify({ number: 8, html_url: 'https://github.test/acme/app/pull/8' }));
      }
    }
    if (req.url.startsWith('/repos/')) {
      if (req.method === 'DELETE') return res.writeHead(404).end(JSON.stringify({ message: 'Label does not exist' }));
      // The pull request's comments: with report-lost, Qualio's report is there under another id.
      if (req.method === 'GET' && /\/issues\/\d+\/comments/.test(req.url))
        return res.end(JSON.stringify(reportLost ? [{ id: 3, body: 'LGTM', user: { type: 'User' } }, { id: 77, body: REPORT, user: { type: 'Bot' } }] : []));
      if (req.method === 'PATCH') return req.url.endsWith('/comments/404') ? res.writeHead(404).end(JSON.stringify({ message: 'Not Found' })) : res.end(JSON.stringify({ id: Number(req.url.split('/').pop()) }));
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
    // The tests folder: test/heal-fixture (its test fails until the heal); the setup's goes to a new folder.
    if (req.url === '/v1/tests/prepare')
      return res.end(JSON.stringify({ testsDir: setupMode ? 'e2e-new' : mode === 'move' ? 'e2e-moving' : 'test/heal-fixture', managed: true, moving: mode === 'move', suggestions: 'review' }));
    if (req.url === '/v1/tests/snapshot') {
      // The contents travel only when asked for (here: always, the first time).
      if (body.files.some((f) => f.content === undefined) && !body.files.some((f) => f.content !== undefined))
        return res.end(JSON.stringify({ state: 'contents', missing: body.files.map((f) => f.sha256) }));
      return res.end(JSON.stringify({ state: 'stored', snapshotId: 'snap1', committed: 0, outdated: 0, files: [], revisionIds: [], pending: [] }));
    }
    if (req.url === '/v1/tests/changes') {
      if (body.suiteId) return res.end(JSON.stringify(suiteBundle()));
      if (body.whole)
        return res.end(
          JSON.stringify({
            replace: true,
            revisionIds: ['m1'],
            files: [pkg, { path: 'playwright.config.ts', content: "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n" }, { path: 'tests/moved.spec.ts', content: spec('Log in') }],
            pending: [],
          }),
        );
      return res.end(JSON.stringify({ replace: false, revisionIds: healed || healedNow ? ['r2'] : [], files: healed || healedNow ? [{ path: 'tests/login.spec.ts', content: spec('Log in') }] : [], pending: [] }));
    }
    if (req.url === '/v1/tests/heal/status' && mode === 'live') {
      // Running until the host answered every call; the session is offered only to a job that can host it.
      // A job that offers no browser gets the heal's end at once.
      const finished = !body.browser || browserAnswers.length >= browserQueue.length;
      return res.end(JSON.stringify({ status: finished ? 'not_healable' : 'running', ...(!finished && body.browser && { browser: { sessionId: 'live1', roles: LIVE_ROLES } }) }));
    }
    if (req.url === '/v1/browser/next') {
      if (body.sessionId !== 'live1') return res.writeHead(404).end(JSON.stringify({ error: 'Browser session not found' }));
      const next = browserQueue.find((c) => !c.taken);
      if (next) {
        next.taken = true;
        return res.end(JSON.stringify({ call: { id: next.id, tool: next.tool, args: next.args } }));
      }
      return res.end(JSON.stringify(browserAnswers.length >= browserQueue.length ? { done: true } : { idle: true }));
    }
    if (req.url === '/v1/browser/result') {
      browserAnswers.push(body);
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === '/v1/tests/heal/status') {
      healPolls += 1;
      if (propose) return res.end(JSON.stringify({ status: healPolls >= 2 ? 'proposed' : 'running' }));
      healed = healPolls >= 2;
      return res.end(JSON.stringify({ status: healed ? 'patched' : 'running' }));
    }
    if (req.url === '/v1/pr/sync') return res.end(JSON.stringify({ ok: true }));
    // The qualio.yml config: a locked rule is invalid; an overview is asked for, then the config is synced.
    if (req.url === '/v1/config/sync') {
      if (/bug:\s*heal/.test(body.raw)) {
        res.statusCode = 422;
        return res.end(JSON.stringify({ state: 'invalid', problems: [{ key: 'self-healing.rules.bug', message: "can't be set: a possible bug is never healed" }], warnings: [] }));
      }
      const overview = /^overview:\s*(\S+)/m.exec(body.raw)?.[1];
      if (overview && !body.overview) return res.end(JSON.stringify({ state: 'overview', paths: [overview], known: [], maxFiles: 50, maxBytes: 262144 }));
      return res.end(
        JSON.stringify({
          state: 'synced',
          scope: body.prNumber ? 'BRANCH' : 'PROJECT',
          message: `Synced ${body.overview?.length ?? 0} overview files.`,
          applied: [],
          changes: body.prNumber ? [{ key: 'healPolicy', label: 'Self-healing', from: 'Balanced', to: 'Autonomous', when: 'merge', why: 'looser' }] : [],
          warnings: [],
        }),
      );
    }
    if (req.url === '/v1/pr/comment') return res.end(JSON.stringify(/^\/qualio /.test(body.body) ? { outcome: 'command', command: body.body.split(' ')[1] } : { outcome: 'answered' }));
    if (req.url === '/v1/pr/outbox')
      return res.end(JSON.stringify({ items: outbox.filter((i) => !i.sent).map((i) => (i.kind === 'TEST_CHANGES' ? { ...i, payload: body.changes ? testChanges() : null } : i)), waiting: false }));
    const ack = /^\/v1\/pr\/outbox\/(\w+)\/ack$/.exec(req.url);
    if (ack) {
      const item = outbox.find((i) => i.id === ack[1] && !i.sent);
      if (!item) return res.writeHead(404).end(JSON.stringify({ error: 'No pending outbox item with this id' }));
      item.sent = true;
      item.ack = body;
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === '/v1/runs/errored') return res.end(JSON.stringify({ ok: true }));
    res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
  })
  .listen(port, () => console.log(`Stub Qualio API on http://localhost:${port}`));
