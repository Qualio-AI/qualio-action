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
import vm from 'node:vm';
import { appPath, checkableLocator, clickRefusal, EXPLORE_INIT, locatorCount, SIGN_IN, startBrowserHost, WRITE_GUARD } from '../scripts/browser-host.mjs';
import { freePort } from './free-port.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const children = [];
after(() => children.forEach((c) => c.kill()));

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

function waitStep(url, env, command = (runFile) => ['wait', runFile, '1']) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qualio-live-'));
  const runFile = path.join(dir, 'run.json');
  writeFileSync(runFile, JSON.stringify({ runId: 'run_1', status: 'FAILED', heal: 'queued' }));
  const log = path.join(dir, 'mcp.log');
  const out = execFileSync(process.execPath, [path.join(root, 'scripts/qualio.mjs'), ...command(runFile)], {
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
  assert.match(out, /Qualio looked at 3 pages of the running app \(4 couldn't be shown\)/);

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
  // The check: one element, two (with Playwright's suggestions), none, and a refused "locator".
  assert.deepEqual(JSON.parse(answers.b7.result).checks, [
    { locator: "getByRole('button', { name: 'Log in' })", count: 1, element: 'button "Log in"', suggestions: [], error: null },
    { locator: "getByRole('link')", count: 2, element: null, suggestions: ["getByRole('link', { name: 'Home' })", "getByRole('link', { name: 'Courses' })"], error: null },
    { locator: "getByRole('button', { name: 'Gone' })", count: 0, element: null, suggestions: [], error: null },
    { locator: 'page.evaluate(() => document.cookie)', count: null, element: null, suggestions: [], error: 'not a getBy… locator this job checks' },
  ]);

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

test("hosts the browser at the end of the job while a test chat looks at the app on its branch", async () => {
  const url = await stub('live');
  const { out, starts } = waitStep(url, {}, () => ['look', 'demo/rename', '1']);
  assert.match(out, /A test chat in Qualio is looking at the running app/);
  assert.match(out, /Test chat: Qualio looked at 3 pages of the running app/);
  assert.equal(starts.length, 2);
  const calls = await (await fetch(`${url}/__calls`)).json();
  assert.deepEqual(calls.find((c) => c.route === '/v1/browser/look').body, { branch: 'demo/rename' });
});

test('hosts nothing at the end of the job when no chat asked, or with look-minutes 0 or live diagnosis off', async () => {
  const url = await stub('live');
  for (const [branch, env, minutes] of [['main', {}, '1'], ['demo/rename', {}, '0'], ['demo/rename', { QUALIO_LIVE_DIAGNOSIS: 'false' }, '1']]) {
    const { out, starts } = waitStep(url, env, () => ['look', branch, minutes]);
    assert.equal(out.trim(), '');
    assert.deepEqual(starts, []);
  }
  const calls = await (await fetch(`${url}/__calls`)).json();
  assert.equal(calls.filter((c) => c.route === '/v1/browser/look').length, 1);
  assert.ok(!calls.some((c) => c.route === '/v1/browser/next'));
});

test('checkableLocator lets only getBy… locators through', () => {
  assert.equal(checkableLocator("getByRole('link', { name: 'Next page' }).first()"), "getByRole('link', { name: 'Next page' }).first()");
  for (const bad of ['page.evaluate(() => 1)', "getByRole('a').evaluate(() => 1)", "getByRole('a').click()", "getByRole('a', { name: `${x}` })", "locator('#id')", "getByRole('a')\n.fill('x')"]) assert.equal(checkableLocator(bad), null);
});

test('locatorCount reads what the snapshot target answered', () => {
  assert.equal(locatorCount('x', { error: 'Error: "x" is not a valid target. Use a ref…' }).error, '"x" is not a valid target. Use a ref…');
  assert.equal(locatorCount('x', { text: '```yaml\n- textbox "Email address" [ref=e10]\n```' }).element, 'textbox "Email address"');
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

test('clickRefusal lets exploring click only what opens, switches or navigates within the app', () => {
  const app = { origin: 'http://app.test:3000', excludes: ['/admin/danger'] };
  assert.equal(clickRefusal('button "Enrol student"', null, app), null);
  assert.equal(clickRefusal('tab "Grades"', null, app), null);
  assert.equal(clickRefusal('link "Course"', '/classes/2', app), null);
  assert.match(clickRefusal('textbox "Email"', null, app), /only clicks buttons, links, tabs and menus/);
  assert.match(clickRefusal('button "Sign out"', null, app), /never signs out/);
  assert.match(clickRefusal('link "Leave"', '/logout', app), /never signs out/);
  assert.match(clickRefusal('link "Docs"', 'https://docs.example/', app), /leaves the application/);
  assert.match(clickRefusal('link "Wipe"', '/admin/danger/wipe', app), /excluded from mapping \(\/admin\/danger\)/);
});

test('the write guard blocks writes and lets reads through', async () => {
  // Run the guard in a tiny fake window, as a page would.
  const warned = [];
  const sent = [];
  class XHR { open(method, url) { this.m = method; this.u = url; } send() { sent.push(`${this.m} ${this.u}`); } }
  const listeners = [];
  const window = { fetch: async (input, init) => (sent.push(`${init?.method ?? 'GET'} ${input}`), 'ok') };
  const sandbox = { window, console: { warn: (m) => warned.push(m) }, XMLHttpRequest: XHR, navigator: {}, DOMException: class extends Error {}, HTMLFormElement: class { submit() {} }, document: { addEventListener: (...a) => listeners.push(a) } };
  new Function(...Object.keys(sandbox), WRITE_GUARD)(...Object.values(sandbox));
  assert.equal(await window.fetch('/api/classes'), 'ok');
  await assert.rejects(window.fetch('/api/classes', { method: 'POST', body: '{}' }), /Blocked by Qualio/);
  assert.equal(await window.fetch('/graphql', { method: 'POST', body: '{"query":"query { classes { id } }"}' }), 'ok');
  await assert.rejects(window.fetch('/graphql', { method: 'POST', body: '{"query":"mutation { deleteClass(id: 1) }"}' }), /Blocked/);
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('DELETE', '/api/classes/1');
  assert.throws(() => xhr.send(), /Blocked/);
  // A POST form is stopped before the app sees it; a GET form (a search) goes through.
  const [type, onSubmit, capture] = listeners[0];
  assert.equal(type, 'submit');
  assert.equal(capture, true);
  let stopped = 0;
  const event = (method) => ({ target: { method, action: '/x' }, preventDefault: () => stopped++, stopImmediatePropagation: () => {} });
  onSubmit(event('post'));
  onSubmit(event('get'));
  assert.equal(stopped, 1);
  assert.deepEqual(sent, ['GET /api/classes', 'POST /graphql']);
  assert.equal(warned.length, 4);
});

test('explores: clicks in a guarded browser, reports what opened and what was blocked', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qualio-explore-'));
  const log = path.join(dir, 'mcp.log');
  const queue = [
    { id: 'x1', tool: 'explore', args: { path: '/classes/1', role: 'Admin', control: "getByRole('button', { name: 'Enrol student' })" } },
    { id: 'x2', tool: 'explore', args: { path: '/classes/1/delete', role: 'Admin', control: "getByRole('button', { name: 'Delete course' })" } },
    { id: 'x3', tool: 'explore', args: { path: '/', role: 'Admin', control: "getByRole('button', { name: 'Sign out' })" } },
    { id: 'x4', tool: 'explore', args: { path: '/', role: null, control: "getByRole('link', { name: 'Help' })" } },
    { id: 'x5', tool: 'explore', args: { path: '/', role: null, control: "getByRole('textbox', { name: 'Email' })" } },
    { id: 'x6', tool: 'explore', args: { path: '/', role: null, control: "getByRole('button', { name: 'Gone' })" } },
  ];
  const answers = {};
  const call = async (route, body) => {
    if (route === '/v1/browser/next') {
      const next = queue.shift();
      return { status: 200, body: next ? { call: next } : { done: true } };
    }
    answers[body.callId] = body;
    return { status: 200, body: { ok: true } };
  };
  const env = { QUALIO_MCP_COMMAND: process.env.QUALIO_MCP_COMMAND, QUALIO_BROWSER_EXECUTABLE: process.env.QUALIO_BROWSER_EXECUTABLE, E2E_ADMIN_USERNAME: process.env.E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD };
  Object.assign(process.env, { QUALIO_MCP_COMMAND: JSON.stringify([process.execPath, path.join(root, 'test/fake-mcp.mjs'), log]), QUALIO_BROWSER_EXECUTABLE: process.execPath, E2E_ADMIN_USERNAME: 'admin@school.test', E2E_ADMIN_PASSWORD: 's3cret-pw' });
  try {
    const host = startBrowserHost(
      { sessionId: 's1', roles: [{ role: 'Admin', usernameEnv: 'E2E_ADMIN_USERNAME', passwordEnv: 'E2E_ADMIN_PASSWORD' }], excludes: [] },
      { call, baseUrl: 'http://app.test:3000', testsDir: dir, tempDir: dir, log: () => {} },
    );
    await host.done;
  } finally {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const enrol = JSON.parse(answers.x1.result);
  assert.equal(enrol.element, 'button "Enrol student"');
  assert.equal(enrol.url, 'http://app.test:3000/classes/1');
  assert.match(enrol.snapshot, /- dialog "Enrol a student"/);
  assert.deepEqual(enrol.blocked, []);
  assert.deepEqual(JSON.parse(answers.x2.result).blocked, ['form POST http://app.test:3000/classes/1/delete']);
  assert.match(answers.x3.error, /never signs out/);
  assert.match(answers.x4.error, /leaves the application/);
  assert.match(answers.x5.error, /only clicks buttons, links, tabs and menus/);
  assert.match(answers.x6.error, /not on the page/);
  // Exploring browsers are their own (per role), and every one installs the write guard.
  const starts = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(starts.length, 2);
  for (const s of starts) assert.match(s.args[s.args.indexOf('--init-page') + 1], /explore-init\.cjs$/);
  assert.equal(starts.find((s) => s.signedInAs)?.signedInAs, 'admin@school.test');
  assert.match(readFileSync(path.join(dir, 'explore-init.cjs'), 'utf8'), /addInitScript\(\{ content: guard \}\)/);
  assert.equal(readFileSync(path.join(dir, 'write-guard.js'), 'utf8'), WRITE_GUARD);
});

test('the scripts the browser loads compile (the fake MCP server never runs them)', () => {
  for (const [name, source] of Object.entries({ SIGN_IN, EXPLORE_INIT, WRITE_GUARD })) assert.doesNotThrow(() => new vm.Script(source, { filename: name }), name);
});
