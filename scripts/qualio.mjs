// Talks to Qualio from the Qualio action. Node 20, no dependencies.
//
//   node qualio.mjs map <map-dir> <branch> <minutes>
//                                                maps the app when Qualio asks (the first job, or a re-map),
//                                                hosting a write-guarded browser while Qualio explores it
//   node qualio.mjs prepare <branch> [working-directory]
//                                                finds the tests folder (qualio.yml tests.path), sends Qualio a
//                                                snapshot of it, and writes the changes Qualio offers on top
//   node qualio.mjs apply <dir> <branch>         after a heal: writes the branch's changes (the fix) on top again
//   node qualio.mjs wait <run-file> <minutes>    waits for the heal of the run the reporter wrote; meanwhile hosts a
//                                                browser on the app for Qualio's diagnosis (live diagnosis, see
//                                                browser-host.mjs; QUALIO_LIVE_DIAGNOSIS=false turns it off)
//   node qualio.mjs look <branch> <minutes>      at the end of the job: if a test chat in Qualio asked to look at the
//                                                running app on this branch, hosts the browser while it looks
//   node qualio.mjs sync                         tells Qualio about this pull request (title, branch, head, merged)
//   node qualio.mjs config <branch>              does nothing (qualio.yml is gone: settings live in Qualio)
//   node qualio.mjs outbox [wait-minutes]        sends what Qualio queued for GitHub (the report, statuses,
//                                                dispatches, labels, and its changes to the tests: suggestions and
//                                                the Qualio pull request) with GITHUB_TOKEN; waits for answers
//   node qualio.mjs comment                      relays a new pull request comment to Qualio (comment job)
//   node qualio.mjs errored <conclusion>         this job failed before reporting results
//
// The tests live in the repository (the folder qualio.yml's tests.path names). Qualio never reads the
// repository: this job sends it the tests folder only, and pushes only Qualio's own qualio/* branches.
// Reads QUALIO_API_URL and QUALIO_API_KEY (and GITHUB_TOKEN for outbox) from the environment and never prints them. Step
// outputs go to $GITHUB_OUTPUT when it is set.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePasswords } from './accounts.mjs';
import { startBrowserHost } from './browser-host.mjs';

const apiUrl = (process.env.QUALIO_API_URL ?? '').replace(/\/+$/, '');
/** Qualio's guide to letting the action open Qualio's pull requests (shown when GitHub refuses one). */
const ALLOW_PULL_REQUESTS_DOCS = `${apiUrl}/docs/getting-started#allow-pull-requests`;
const apiKey = process.env.QUALIO_API_KEY ?? '';
const POLL_MS = Number(process.env.QUALIO_POLL_MS || 10_000);

async function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

/** POSTs JSON to Qualio, retrying server and network errors. Returns { status, body }. */
async function call(route, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${apiUrl}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      if (res.status < 500 || attempt >= 3) return { status: res.status, body: json ?? { error: text.slice(0, 300) } };
    } catch (error) {
      if (attempt >= 3) throw new Error(`Qualio could not be reached at ${apiUrl}: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}

/** Only plain relative paths inside the tests folder. */
function safePath(dir, file) {
  const target = path.resolve(dir, file);
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Refusing to write ${file}`);
  return target;
}

const workspace = () => path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const actionDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Folders of a tests folder that aren't tests: installed packages, Playwright's output, Qualio's runtime. */
/** What Qualio says this job couldn't get (e.g. a binary test file for an older action). */
const printNotices = (notices) => {
  for (const notice of notices ?? []) console.log(`::warning title=Qualio::${notice}`);
};

/** The run manifest the reporter sends with the run: which of Qualio's changes this job applied. */
async function writeManifest(bundleId, revisionIds) {
  const file = process.env.QUALIO_RUN_MANIFEST;
  if (file) await writeFile(file, `${JSON.stringify({ bundleId, revisionIds }, null, 2)}\n`);
}

/** Qualio's reporter, from this action, next to the tests (Playwright transpiles it there like the tests). */
async function installReporter(dir) {
  const target = path.join(dir, '.qualio', 'qualio-reporter.ts');
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(actionDir, 'runtime', 'qualio-reporter.ts'), target);
  return target;
}

/** The pull request number of a pull_request job, else null. */
async function eventPrNumber() {
  if (!/^pull_request/.test(process.env.GITHUB_EVENT_NAME ?? '') || !process.env.GITHUB_EVENT_PATH) return null;
  try {
    return JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.number ?? null;
  } catch {
    return null;
  }
}

/**
 * The tests folder for this job. With Qualio (phase 84: Qualio keeps the tests), a folder of the job's own
 * outside the checkout, where the tests Qualio serves are written: nothing in the repository changes.
 * Without an api-key, the action's working-directory input (or e2e), run unreported.
 */
async function testsFolder(branch, input) {
  if (!apiKey || !apiUrl) return { rel: input || 'e2e', abs: path.resolve(workspace(), input || 'e2e'), offline: true };
  const { status, body } = await call('/v1/tests/prepare', { branch });
  if (status !== 200) throw new Error(`Asking Qualio for the tests failed (${status}): ${body.error ?? 'unknown error'}`);
  await exportTestEnv(body.env);
  const abs = path.join(process.env.RUNNER_TEMP || tmpdir(), 'qualio-tests');
  return { rel: abs, abs, offline: false };
}

// The variables Qualio may answer for the tests: the app's URL in this job (qualio.yml's app.url, unless the
// base-url input set QUALIO_BASE_URL), support/email.ts's (qualio.yml's email: where the app's emails are
// caught in this job) and the roles' usernames (roles[].username). Never a password.
const TEST_ENV = /^(?:QUALIO_BASE_URL|QUALIO_MAIL(?:_(?:URL|DOMAIN|SERVER))?|E2E_[A-Z0-9_]+_USERNAME)$/;

/**
 * Exports the test environment Qualio answers (only QUALIO_MAIL*, never a secret: a hosted inbox's API key
 * comes from the job's own QUALIO_MAIL_API_KEY) for the later steps that run Playwright. A variable the job
 * already sets wins.
 */
async function exportTestEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const exported = {};
  for (const [name, value] of Object.entries(env)) {
    if (!TEST_ENV.test(name) || typeof value !== 'string' || /[\r\n]/.test(value) || process.env[name]) continue;
    if (name === 'QUALIO_BASE_URL' && !/^https?:\/\/\S+$/.test(value)) continue;
    exported[name] = value;
    process.env[name] = value;
  }
  const lines = Object.entries(exported).map(([k, v]) => `${k}=${v}\n`).join('');
  if (lines && process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, lines);
  if (exported.QUALIO_BASE_URL) console.log(`The app's URL in this job: ${exported.QUALIO_BASE_URL} (qualio.yml's app.url).`);
  if (exported.QUALIO_MAIL) console.log(`The tests read email from ${exported.QUALIO_MAIL}${exported.QUALIO_MAIL_URL ? ` (${exported.QUALIO_MAIL_URL})` : ''}.`);
  // A role the config names a username for, without a password in this job: its sign-in would fail.
  for (const name of Object.keys(env).filter((n) => /^E2E_[A-Z0-9_]+_USERNAME$/.test(n))) {
    const password = name.replace(/_USERNAME$/, '_PASSWORD');
    if (!process.env[password]) console.log(`::warning title=Qualio::${password} is not set, so tests that sign in with ${env[name]} will fail. Give that user a password in the config (users.<role>.password: \${ROLE_PASSWORD}, set from a repository secret in the workflow's env).`);
  }
  return exported;
}

const exists = (p) => stat(p).then(() => true, () => false);

/** Replaces the folder's files with `files`, keeping the installed dependencies. */
async function writeFiles(dir, files) {
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) if (entry !== 'node_modules') await rm(path.join(dir, entry), { recursive: true, force: true });
  for (const file of files) {
    const target = safePath(dir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content);
  }
}

/** Runs a command with the job's output; resolves with its exit code. */
function run(command, args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function mustRun(command, args, options) {
  const code = await run(command, args, options);
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit code ${code}).`);
}

let chromiumInstalled = false;
/** npm dependencies of a downloaded folder, and Chromium once per job (QUALIO_SKIP_INSTALL skips both, for tests). */
async function install(dir) {
  if (process.env.QUALIO_SKIP_INSTALL === 'true') return;
  await mustRun('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir });
  if (!chromiumInstalled) await mustRun('npx', ['playwright', 'install', '--with-deps', 'chromium'], { cwd: dir });
  chromiumInstalled = true;
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// Job summary table cells, as Qualio writes them on GitHub (@qualio/shared/github-markdown in qualio-webapp).
const cell = (text, max = 200) => {
  const line = String(text).replace(/\s*\n\s*/g, ' ').trim();
  return (line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line).replace(/\|/g, '\\|');
};

async function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

/**
 * Maps the application in this job when Qualio asks (the project's first job, or after someone asked to
 * map it again): the mapper Qualio sends crawls the app here (signed out and as each role, with the job's
 * E2E_<ROLE>_* secrets), and this job then hosts a write-guarded browser
 * while Qualio explores what links can't reach. Mapping generates no tests and never fails the job: a
 * problem is a warning, and the next job maps again. Outputs state: mapped, skipped (nothing to map, or an
 * older Qualio), failed.
 */
async function map(mapDir, branch, minutes) {
  const start = await call('/v1/map/start', { branch, ghRunId: process.env.GITHUB_RUN_ID || '0' });
  // An older Qualio maps through the first-suite setup, which it no longer runs for this action.
  if (start.status === 404) return output({ state: 'skipped' });
  if (start.status !== 200) {
    console.log(`::warning title=Qualio::Asking Qualio whether to map the application failed (${start.status}): ${start.body.error ?? 'unknown error'}. The tests run as usual.`);
    return output({ state: 'failed' });
  }
  let state = start.body;
  // The app's URL for this branch (qualio.yml's app.url), for the mapper, its browser and the later steps;
  // the base-url input, when the workflow sets one, wins.
  if (typeof state.baseUrl === 'string') await exportTestEnv({ QUALIO_BASE_URL: state.baseUrl });
  if (state.state !== 'map') return output({ state: 'skipped' });
  const { crawlId } = state;
  const deadline = Date.now() + Number(minutes) * 60_000;
  console.log('::group::Map the application');
  try {
    await writeFiles(mapDir, state.files);
    await install(mapDir);
    const code = await run('npx', ['playwright', 'test', '-c', 'qualio-map.config.ts'], { cwd: mapDir });
    if (code !== 0) console.log('::warning title=Qualio::Mapping the application reported a problem (see the "Map the application" group).');
  } catch (error) {
    console.log(`::warning title=Qualio::Mapping the application failed: ${error.message}. The tests run as usual; the next job maps again.`);
    return output({ state: 'failed' });
  } finally {
    console.log('::endgroup::');
  }
  // While Qualio explores what links can't reach, this job hosts the browser (writes blocked).
  const live = liveDiagnosis(mapDir);
  let host = null;
  let said = '';
  try {
    for (;;) {
      const status = await call(`/v1/map/${crawlId}/status`, { ...(live && { browser: true }) });
      if (status.status !== 200) {
        console.log(`::warning title=Qualio::Reading the map's status failed (${status.status}): ${status.body.error ?? 'unknown error'}.`);
        return output({ state: 'failed' });
      }
      state = status.body;
      if (state.message && state.message !== said) console.log((said = state.message));
      if (live && state.browser && !host) {
        console.log("Qualio is exploring what links can't reach (dialogs, tabs, menus) through this job's browser. Every request that could change data is blocked there.");
        host = startBrowserHost(state.browser, { call, ...live, log: (line) => console.log(line.replace(/^Live diagnosis:/, 'Exploring:')) });
      }
      if (state.state === 'done') return output({ state: 'mapped' });
      if (state.state === 'failed') {
        console.log(`::warning title=Qualio::Mapping the application failed: ${state.error ?? 'unknown error'}. The tests run as usual; the next job maps again.`);
        return output({ state: 'failed' });
      }
      if (state.state === 'map') {
        console.log('::warning title=Qualio::The map of the application did not reach Qualio. Check the mapper’s output above; the next job maps again.');
        return output({ state: 'failed' });
      }
      if (Date.now() >= deadline) {
        console.log(`::warning title=Qualio::Qualio was still exploring after ${minutes} minutes: the map keeps what it found so far.`);
        return output({ state: 'mapped' });
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    if (host) {
      await host.stop();
      if (host.stats.opened || host.stats.failed) console.log(`Exploring: Qualio clicked ${plural(host.stats.opened, 'control')} in this job's browser${host.stats.failed ? ` (${host.stats.failed} couldn't be clicked)` : ''}, with every write blocked.`);
    }
  }
}

/** Runs git in the checkout; resolves with its exit code and trimmed output. */
function git(args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: workspace(), stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', () => resolve({ code: 128, stdout: '' }));
    child.on('exit', (code) => resolve({ code: code ?? 128, stdout: stdout.trim() }));
  });
}

/**
 * The recent merges into the target branch (that changed the main tests) the checked-out commit doesn't
 * contain yet: the job then gets the main tests from before them, which fit its code. Null without history.
 */
async function lackingMerges(merges) {
  if ((await git(['rev-parse', '--is-inside-work-tree'])).stdout !== 'true') return null;
  // A pull_request job checks out the pull request merged with the current base: it has every merge.
  if (/^pull_request/.test(process.env.GITHUB_EVENT_NAME ?? '') && process.env.GITHUB_EVENT_PATH) {
    try {
      const head = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.head?.sha;
      if (head && (await git(['rev-parse', 'HEAD'])).stdout !== head) return [];
    } catch {}
  }
  // actions/checkout fetches one commit: get the history (commits and trees only, no file contents).
  if ((await git(['rev-parse', '--is-shallow-repository'])).stdout === 'true' && (await git(['fetch', '--quiet', '--no-tags', '--filter=blob:none', '--unshallow', 'origin'])).code !== 0)
    return null;
  const lacking = [];
  for (const { number, sha } of merges) {
    if (!/^[0-9a-f]{7,64}$/.test(sha ?? '')) continue;
    let { code } = await git(['merge-base', '--is-ancestor', sha, 'HEAD']);
    if (code > 1 && (await git(['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', sha])).code === 0) code = (await git(['merge-base', '--is-ancestor', sha, 'HEAD'])).code;
    // 1: not an ancestor. Anything else (a commit GitHub no longer has): don't count it.
    if (code === 1) lacking.push(number);
  }
  return lacking;
}

/**
 * Writes the tests Qualio keeps for this branch into `dir` (replacing what was there, keeping installed
 * dependencies) and the run manifest. Returns false when Qualio has no tests for the project yet.
 */
async function downloadTests(dir, branch, { quiet = false } = {}) {
  let { status, body } = await call('/v1/tests/bundle', { branch, binary: true });
  if (status === 200 && body.merges?.length) {
    const lacking = await lackingMerges(body.merges);
    if (lacking === null) console.log('::notice title=Qualio::Could not check which merged pull requests this commit includes (no git history), so the latest tests are used.');
    else if (lacking.length) ({ status, body } = await call('/v1/tests/bundle', { branch, binary: true, lacking }));
  }
  if (status === 404) {
    console.log(`::notice title=Qualio::${body.error ?? 'Qualio has no tests for this project yet.'}`);
    return false;
  }
  if (status !== 200) throw new Error(`Getting the tests from Qualio failed (${status}): ${body.error ?? 'unknown error'}`);
  printNotices(body.notices);
  await writeFiles(dir, body.files);
  await writeManifest(body.bundleId, body.revisionIds ?? []);
  if (quiet) return true;
  console.log(`Got ${plural(body.files.length, 'file')} of the tests Qualio keeps for ${branch} (${body.bundleId}).`);
  if (body.lacking?.length) {
    const refs = body.lacking.map((n) => `#${n}`);
    const list = refs.length === 1 ? refs[0] : `${refs.slice(0, -1).join(', ')} and ${refs.at(-1)}`;
    console.log(`::warning title=Qualio::This branch doesn't include ${list} yet, so the tests from before ${refs.length === 1 ? 'it' : 'them'} run and failures aren't healed. Merge or rebase the target branch to run the latest tests.`);
  }
  for (const { key, reason } of body.pending ?? []) console.log(`::notice title=Qualio::${key} has no tests in this run yet: ${reason}. Qualio runs this workflow again once they are written.`);
  return true;
}

/**
 * Gets the tests ready to run. With Qualio: the tests Qualio keeps for this branch, written into a folder of
 * the job's own (the repository is never changed), with Qualio's reporter. Without an api-key: the
 * working-directory folder as it is, unreported. Outputs dir (absolute), run (true/false).
 */
async function prepare(branch, input = '') {
  const folder = await testsFolder(branch, input);
  const dir = folder.abs;
  if (folder.offline) {
    if (!(await exists(dir))) throw new Error(`The tests folder '${folder.rel}' does not exist. Set the action's api-key to run the tests Qualio keeps for this project.`);
    await output({ mode: 'repo', reporter: '', config: '' });
    return output({ run: 'true', dir });
  }
  if (!(await downloadTests(dir, branch))) return output({ run: 'false', dir });
  process.env.QUALIO_REPORTER = await installReporter(dir);
  await output({ reporter: process.env.QUALIO_REPORTER, 'reporter-args': '', mode: 'bundle', config: '' });
  await output({ run: 'true', dir });
}

/** After a heal: the tests Qualio keeps for this branch again (now with the fix), for the re-run. */
async function apply(dir, branch) {
  if (!(await downloadTests(dir, branch, { quiet: true }))) throw new Error('Qualio no longer has tests for this project.');
  await installReporter(dir);
  console.log("Got Qualio's fix with the tests for the re-run.");
}

async function wait(runFile, minutes) {
  let run;
  try {
    run = JSON.parse(await readFile(runFile, 'utf8'));
  } catch {
    console.log('The results were not reported to Qualio, so there is no heal to wait for.');
    return output({ status: 'unreported' });
  }
  if (run.status !== 'FAILED' || run.heal !== 'queued') return output({ status: run.status === 'FAILED' ? 'none' : 'passed' });
  const deadline = Date.now() + Number(minutes) * 60_000;
  console.log(`Waiting up to ${minutes} minute(s) for Qualio to diagnose the failures…`);
  const live = liveDiagnosis();
  let host = null;
  try {
    for (;;) {
      const { status, body } = await call('/v1/tests/heal/status', { runId: run.runId, ...(live && { browser: true }) });
      if (status !== 200) throw new Error(`Reading the heal status failed (${status}): ${body.error ?? 'unknown error'}`);
      if (body.status !== 'queued' && body.status !== 'running') {
        // proposed: the project asks first; a person accepts the change or calls it a bug in Qualio.
        console.log(body.status === 'proposed' ? 'Heal: proposed. Qualio waits for someone to accept the UI change or mark it as a bug.' : `Heal: ${body.status}.`);
        return output({ status: body.status });
      }
      // Live diagnosis: Qualio may look at the running app through this job while it diagnoses.
      if (live && body.browser && !host) {
        console.log("Qualio can look at the running app from this job while it diagnoses (live diagnosis: pages are only opened, never clicked or filled in).");
        host = startBrowserHost(body.browser, { call, ...live });
      }
      if (Date.now() >= deadline) {
        console.log('::warning title=Qualio::Qualio is still diagnosing the failures. Re-run the workflow later to pick up a fix.');
        return output({ status: 'timeout' });
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    if (host) {
      await host.stop();
      if (host.stats.opened || host.stats.failed) console.log(`Live diagnosis: Qualio looked at ${plural(host.stats.opened, 'page')} of the running app${host.stats.failed ? ` (${host.stats.failed} couldn't be shown)` : ''}.`);
    }
  }
}

/**
 * Whether this job can host a browser on the app for Qualio (a heal's diagnosis, the setup's exploration):
 * the action's live-diagnosis input (on by default), the app's URL, and a folder whose Playwright's
 * Chromium the browser uses (the tests folder, or the setup's mapper folder).
 */
function liveDiagnosis(dir = process.env.QUALIO_TESTS_DIR) {
  const baseUrl = process.env.QUALIO_BASE_URL;
  const testsDir = dir;
  if (process.env.QUALIO_LIVE_DIAGNOSIS === 'false' || !baseUrl || !testsDir) return null;
  try {
    if (!/^https?:$/.test(new URL(baseUrl).protocol)) return null;
  } catch {
    return null;
  }
  return { baseUrl, testsDir, tempDir: path.join(process.env.RUNNER_TEMP || tmpdir(), 'qualio-live') };
}

/**
 * At the end of the job: whether a test chat in Qualio wants to look at the running app on this branch
 * (it asked after the failed run's job was gone, and Qualio started this workflow). If one does, the job
 * hosts the look-only browser until Qualio says the chat is done, or `minutes` pass.
 */
async function look(branch, minutes = '10') {
  const live = liveDiagnosis();
  if (!live || !(Number(minutes) > 0)) return;
  const { status, body } = await call('/v1/browser/look', { branch });
  // An older Qualio has no test chat looks.
  if (status === 404) return;
  if (status !== 200) return console.log(`::warning title=Qualio::Could not ask Qualio whether a test chat wants to look at the app (${status}): ${body.error ?? 'unknown error'}`);
  if (!body.browser) return;
  console.log(`A test chat in Qualio is looking at the running app through this job, for up to ${minutes} minute(s): pages are only opened, never clicked or filled in.`);
  const host = startBrowserHost(body.browser, { call, ...live });
  let timer;
  await Promise.race([host.done, new Promise((r) => (timer = setTimeout(r, Number(minutes) * 60_000)))]);
  clearTimeout(timer);
  await host.stop();
  console.log(`Test chat: Qualio looked at ${plural(host.stats.opened, 'page')} of the running app${host.stats.failed ? ` (${host.stats.failed} couldn't be shown)` : ''}.`);
}

async function sync() {
  if (!['pull_request', 'pull_request_target'].includes(process.env.GITHUB_EVENT_NAME)) return;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  // Names only, never values: the job's test account variables whose secret is missing.
  const emptySecrets = Object.entries(process.env)
    .filter(([name, value]) => /^E2E_[A-Z0-9_]+_(USERNAME|PASSWORD)$/.test(name) && !value)
    .map(([name]) => name)
    .sort();
  const { status, body } = await call('/v1/pr/sync', {
    action: event.action,
    number: pr.number,
    title: pr.title ?? '',
    body: pr.body ?? null,
    url: pr.html_url,
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    headSha: pr.head.sha,
    merged: Boolean(pr.merged),
    // The merge commit: runs on branches without it get the main tests from before this pull request.
    mergeCommitSha: pr.merged ? (pr.merge_commit_sha ?? null) : null,
    emptySecrets,
    // Who opened it: Qualio tells them in the app when a test finds a possible bug.
    author: pr.user?.login ?? null,
  });
  if (status !== 200) return console.log(`::warning title=Qualio::Qualio could not record pull request #${pr.number} (${status}): ${body.error ?? 'unknown error'}`);
  console.log(`Qualio recorded pull request #${pr.number} (${event.action}).`);
  if (emptySecrets.length) console.log(`::warning title=Qualio::These test account secrets are empty, so tests that sign in as those roles will fail: ${emptySecrets.join(', ')}. Add them in Settings → Secrets and variables → Actions.`);
}

/** One GitHub REST call with the job's token. Returns the HTTP status (0 when GitHub couldn't be reached) and the answer's JSON. */
async function github(method, route, body) {
  const base = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const data = (() => { try { return JSON.parse(text); } catch { return null; } })();
    return { status: res.status, data, message: res.ok ? '' : (data?.message ?? text.slice(0, 200)) };
  } catch (error) {
    return { status: 0, message: error.message };
  }
}

/** Starts Qualio's report comment on a pull request (an HTML comment, invisible on GitHub). */
const REPORT_MARKER = '<!-- qualio:report -->';

/** Qualio's report comment on a pull request, found by its marker: its id, or null. */
async function findReport(repo, prNumber) {
  for (let page = 1; page <= 10; page += 1) {
    const r = await github('GET', `${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.data)) return null;
    const found = r.data.find((c) => c.user?.type === 'Bot' && (c.body ?? '').trimStart().startsWith(REPORT_MARKER));
    if (found) return found.id;
    if (r.data.length < 100) return null;
  }
  return null;
}

/**
 * The pull request's report: one comment, edited in place. Edits the comment Qualio knows, else the one
 * with the marker (its id was lost, or a job posted it without telling Qualio), else posts it.
 */
async function deliverReport(repo, item) {
  const body = { body: item.payload.body };
  const edit = async (id) => {
    const r = await github('PATCH', `${repo}/issues/comments/${id}`, body);
    return r.status >= 200 && r.status < 300 ? { commentId: id } : r.status === 404 ? null : { failed: r };
  };
  if (item.payload.commentId) {
    const edited = await edit(item.payload.commentId);
    if (edited) return edited;
  }
  const found = await findReport(repo, item.prNumber);
  if (found) {
    const edited = await edit(found);
    if (edited) return edited;
  }
  const r = await github('POST', `${repo}/issues/${item.prNumber}/comments`, body);
  return r.status >= 200 && r.status < 300 ? { commentId: r.data?.id ?? null } : { failed: r };
}

async function deliver(item) {
  const repo = `/repos/${process.env.GITHUB_REPOSITORY}`;
  if (item.kind === 'REPORT') return deliverReport(repo, item);
  return { failed: await deliverOne(repo, item) };
}

async function deliverOne(repo, item) {
  const p = item.payload;
  const refused = (r) => (r.status >= 200 && r.status < 300 ? null : r);
  switch (item.kind) {
    case 'COMMENT':
      return refused(await github('POST', `${repo}/issues/${item.prNumber}/comments`, { body: p.body }));
    case 'REACTION':
      return refused(await github('POST', `${repo}/issues/comments/${p.commentId}/reactions`, { content: p.content }));
    case 'STATUS':
      return refused(await github('POST', `${repo}/statuses/${item.sha}`, { state: p.state, context: p.context, description: p.description?.slice(0, 140), target_url: p.targetUrl }));
    case 'DISPATCH': {
      // This workflow's own file (owner/repo/.github/workflows/qualio.yml@refs/...), qualio.yml by default.
      const file = /\/([^/@]+\.ya?ml)@/.exec(process.env.GITHUB_WORKFLOW_REF ?? '')?.[1] ?? 'qualio.yml';
      return refused(await github('POST', `${repo}/actions/workflows/${file}/dispatches`, { ref: p.ref }));
    }
    case 'LABEL': {
      if (p.add?.length) {
        const failed = refused(await github('POST', `${repo}/issues/${item.prNumber}/labels`, { labels: p.add }));
        if (failed) return failed;
      }
      for (const name of p.remove ?? []) {
        const r = await github('DELETE', `${repo}/issues/${item.prNumber}/labels/${encodeURIComponent(name)}`);
        if (r.status !== 404 && refused(r)) return r;
      }
      return null;
    }
    default:
      return { status: 400, message: `unknown item kind ${item.kind}` };
  }
}

/** Sends one batch of outbox items. Returns how many were sent and whether GitHub refused the token. */
async function sendBatch(items) {
  let sent = 0;
  let denied = false;
  for (const item of items) {
    const { failed, commentId, changes, sharding } = await deliver(item);
    // Missing token permissions, rate limits and GitHub outages are retried by the next job.
    if (failed && (failed.status === 0 || failed.status === 403 || failed.status === 429 || failed.status >= 500)) {
      denied ||= failed.status === 403;
      console.log(`Not sent yet (${item.kind}, GitHub ${failed.status || 'unreachable'}): ${failed.message}`);
      continue;
    }
    await call(`/v1/pr/outbox/${item.id}/ack`, { error: failed ? `GitHub ${failed.status}: ${failed.message}` : null, ...(commentId && { commentId }), ...(changes && !failed && { changes }), ...(sharding && !failed && { sharding }) });
    if (!failed) sent += 1;
    else console.log(`GitHub refused an update (${item.kind}, ${failed.status}): ${failed.message}`);
  }
  return { sent, denied };
}

/**
 * Sends what Qualio queued for GitHub (Qualio never calls GitHub itself) with this job's GITHUB_TOKEN. With `waitMinutes`, keeps polling while Qualio says an agent is still
 * answering (a reply to the Analyst, or, at the end of a pull request's job, reading the pull request),
 * so the answer is posted by this job. Never fails the job: what
 * can't be sent now waits for the next job.
 */
async function outbox(waitMinutes = '0') {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const deadline = Date.now() + Number(waitMinutes || 0) * 60_000;
  // A pull request's job (not the comment job) waits only for Qualio to read that pull request, so a
  // pull request with nothing to test ends with a green status rather than a pending one.
  const prNumber = process.env.QUALIO_OUTBOX_PR === 'true' ? await eventPrNumber() : null;
  let sent = 0;
  let denied = false;
  let quiet = 0;
  let waited = false;
  for (;;) {
    // report: this action edits Qualio's one report comment in place and reacts to commands.
    // changes: this action offers Qualio's changes to the tests (suggestions, the Qualio pull request).
    // lease: a sharded run's jobs end together; each item goes out from one of them.
    // sharding: this action opens Qualio's pull request that changes tests.shards.max.
    const { status, body } = await call('/v1/pr/outbox', {
      report: true,
      binary: true,
      ...(process.env.QUALIO_SHARDED === 'true' && { lease: true }),
      ...(prNumber && { prNumber }),
    });
    if (status !== 200) return console.log(`::warning title=Qualio::Could not read Qualio's GitHub updates (${status}): ${body.error ?? 'unknown error'}`);
    const batch = await sendBatch(body.items);
    sent += batch.sent;
    denied ||= batch.denied;
    // Done when nothing is left and nobody is answering (twice: the answer's comment is queued just after;
    // a pull request's job that never had to wait is done at once).
    waited ||= Boolean(body.waiting);
    quiet = body.items.length === 0 && !body.waiting ? quiet + 1 : 0;
    if (Date.now() >= deadline || quiet >= (prNumber && !waited ? 1 : 2) || denied) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (sent) console.log(`Sent ${sent} update(s) from Qualio to GitHub.`);
  if (denied)
    console.log("::warning title=Qualio::This job's GITHUB_TOKEN may not write comments, statuses or dispatch workflows. Add to the workflow: permissions: { contents: write, pull-requests: write, issues: write, statuses: write, actions: write }.");
}

/**
 * The comment job: tells Qualio about a new comment on a pull request (a reply to the Analyst, or a
 * `/qualio accept|bug|run` command). Comments on issues, by bots, or Qualio's own are skipped.
 */
async function comment() {
  if (process.env.GITHUB_EVENT_NAME !== 'issue_comment') return;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (event.action !== 'created' || !event.issue?.pull_request || event.comment.user.type === 'Bot') return console.log('Not a person\'s new comment on a pull request: nothing to tell Qualio.');
  const { status, body } = await call('/v1/pr/comment', {
    number: event.issue.number,
    commentId: event.comment.id,
    body: event.comment.body ?? '',
    user: { id: event.comment.user.id, login: event.comment.user.login, type: event.comment.user.type },
  });
  if (status !== 200) return console.log(`::warning title=Qualio::Qualio could not read the comment (${status}): ${body.error ?? 'unknown error'}`);
  console.log(body.outcome === 'ignored' ? `Qualio skipped the comment: ${body.reason}.` : `Qualio received the comment (${body.command ?? body.outcome}).`);
}


// ── Auto-sharding (specs/auto-sharding.md) ───────────────────────────────────────────────────────

/**
 * The test files Playwright would run in the tests folder, relative to it, with their test counts (each
 * project's copy counts): `playwright test --list` with the team's own config, so testDir, testMatch
 * and projects are Playwright's to decide. Null when listing fails.
 */
async function listTests(dir) {
  let report;
  if (process.env.QUALIO_PLAYWRIGHT_LIST) report = JSON.parse(await readFile(process.env.QUALIO_PLAYWRIGHT_LIST, 'utf8'));
  else {
    const out = await new Promise((resolve) => {
      const config = process.env.QUALIO_PLAYWRIGHT_CONFIG ? [`--config=${process.env.QUALIO_PLAYWRIGHT_CONFIG}`] : [];
      const child = spawn('npx', ['playwright', 'test', ...config, '--list', '--reporter=json'], { cwd: dir, env: { ...process.env, QUALIO_REPORTER: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.on('error', () => resolve(null));
      child.on('exit', (code) => resolve(code === 0 ? text : null));
    });
    if (out === null) return null;
    try {
      report = JSON.parse(out);
    } catch {
      return null;
    }
  }
  const rootDir = report.config?.rootDir ?? dir;
  const counts = new Map();
  const walk = (suites) => {
    for (const suite of suites ?? []) {
      if (suite.file) {
        const rel = path.relative(dir, path.resolve(rootDir, suite.file)).split(path.sep).join('/');
        const tests = (suite.specs ?? []).reduce((n, spec) => n + (spec.tests?.length ?? 1), 0);
        counts.set(rel, (counts.get(rel) ?? 0) + tests);
      }
      walk(suite.suites);
    }
  };
  walk(report.suites);
  return [...counts].map(([file, tests]) => ({ path: file, tests }));
}

/**
 * The plan job: how many jobs run this workflow run's tests and which files each runs, from Qualio
 * (by the tests' past durations, at most qualio.yml's tests.shards.max). Never fails the job: without
 * a plan, one job runs every test. Outputs run, shards (a JSON list for the matrix) and plan-id.
 */
async function plan(branch, dir) {
  const single = (why) => {
    if (why) console.log(`::notice title=Qualio::${why} One job runs every test.`);
    return output({ run: 'true', shards: '[1]', 'plan-id': '' });
  };
  const files = await listTests(dir);
  if (!files) return single('Playwright could not list the tests, so they are not split across jobs.');
  // Even one file is planned: the plan says this workflow is sharded (Qualio's advice relies on it).
  if (!files.length) return single();
  const { GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
  if (!GITHUB_RUN_ID) return single();
  const { status, body } = await call('/v1/tests/plan', {
    branch,
    commitSha: process.env.QUALIO_COMMIT_SHA || process.env.GITHUB_SHA || 'local',
    ghRunId: GITHUB_RUN_ID,
    ghRunAttempt: Number(GITHUB_RUN_ATTEMPT || 1),
    files,
  });
  // An older Qualio has no plans.
  if (status === 404) return single();
  if (status !== 200) return single(`Qualio could not plan the jobs (${status}): ${body.error ?? 'unknown error'}.`);
  const minutes = (ms) => `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (body.shards.length > 1)
    console.log(`Qualio splits ${plural(files.length, 'test file')} across ${body.shards.length} jobs (about ${minutes(body.predictedMs)}, instead of ${minutes(body.singleJobMs)} in one job).`);
  else console.log(`One job runs the ${plural(files.length, 'test file')}: more jobs wouldn't make the run faster.`);
  // The plan id goes out with one job too: that job reports the plan, so Qualio knows the workflow is sharded.
  await output({ run: 'true', shards: JSON.stringify(body.shards), 'plan-id': body.planId });
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A shard job: its files from the run's plan, written as Playwright filters (one per line, each the
 * file's whole absolute path, so login.spec.ts never also picks admin-login.spec.ts) to argsFile.
 * Outputs total (the run's shard count). One shard of one runs everything.
 */
async function shard(planId, index, dir, argsFile) {
  await writeFile(argsFile, '');
  if (!planId) return output({ total: '1' });
  const { status, body } = await call('/v1/tests/plan/shard', { planId, index: Number(index) });
  // Running every test here would run them twice: the job fails instead.
  if (status !== 200) throw new Error(`Qualio could not say which tests shard ${index} runs (${status}): ${body.error ?? 'unknown error'}`);
  if (body.total > 1) {
    const abs = path.resolve(dir);
    await writeFile(argsFile, body.files.map((f) => `^${escapeRegExp(path.join(abs, f))}$`).join('\n') + '\n');
    console.log(`Shard ${body.index} of ${body.total}: ${plural(body.files.length, 'test file')}.`);
  }
  await output({ total: String(body.total) });
}

/** This job failed before the reporter sent results: the run shows as errored in Qualio right away. */
async function errored(conclusion) {
  const { GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_RUN_ID || !GITHUB_REPOSITORY) return;
  const index = Number(process.env.QUALIO_SHARD_INDEX);
  const total = Number(process.env.QUALIO_SHARD_TOTAL);
  const { status, body } = await call('/v1/runs/errored', {
    // A sharded run's job: only this shard ended without results.
    // (Its shard count is unknown when the job failed before reading its plan.)
    ...(index >= 1 && (total > 1 || process.env.QUALIO_SHARD_PLAN) && { shard: { index, ...(total > 1 && { total }), planId: process.env.QUALIO_SHARD_PLAN || null } }),
    ghRunId: GITHUB_RUN_ID,
    runAttempt: Number(GITHUB_RUN_ATTEMPT || 1),
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
    headSha: process.env.QUALIO_COMMIT_SHA || process.env.GITHUB_SHA,
    conclusion: conclusion || 'failure',
    url: `${GITHUB_SERVER_URL || 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
  });
  if (status !== 200) console.log(`::warning title=Qualio::Could not tell Qualio this job failed (${status}): ${body.error ?? 'unknown error'}`);
}

/**
 * The passwords step (input `test-passwords`, the QUALIO_TEST_PASSWORDS secret): masks every password and
 * exports E2E_<ROLE>_PASSWORD for the later steps (the map, the tests, the look-only browser). A variable the
 * job already sets (a per-role secret in its env) wins. Never prints a password, nor a line it can't read.
 */
// `${NAME}` or `${NAME:-default}` in a value Qualio answers for the test accounts and APIs (@qualio/shared's CONFIG_VARIABLE).
const CONFIG_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const EXPORT_NAME = /^(?:E2E_[A-Z0-9_]+_(?:USERNAME|PASSWORD)|QUALIO_API_[A-Z0-9_]+)$/;

/** Fills a value from the job's environment. `json`: values are escaped for a JSON string. */
function resolveTemplate(template, env, json = false) {
  const missing = [];
  const value = template.replace(CONFIG_VARIABLE, (_, name, fallback) => {
    const v = env[name] || fallback;
    if (v === undefined) {
      missing.push(name);
      return '';
    }
    return json ? JSON.stringify(v).slice(1, -1) : v;
  });
  return { value, missing };
}

/**
 * The test accounts and APIs for this job: Qualio answers the variables to export (E2E_<ROLE>_USERNAME/_PASSWORD,
 * QUALIO_API_<NAME>_*) from the project's Settings, with secrets as ${NAME}. Each ${NAME} is read here from the
 * job's environment (the workflow sets it from a GitHub secret), so the value never leaves the job. Secrets are
 * masked; a variable the job already sets wins. Then QUALIO_TEST_PASSWORDS (older workflows) fills the roles still
 * without a password.
 */
async function accounts() {
  if (apiKey && apiUrl) {
    const { status, body } = await call('/v1/config/resolve', {});
    if (status !== 200) console.log(`::warning title=Qualio::Reading the users and APIs from Qualio failed (${status}): ${body.error ?? 'unknown error'}`);
    else {
      const lines = [];
      const done = [];
      for (const item of body.exports ?? []) {
        if (!item || typeof item.env !== 'string' || !EXPORT_NAME.test(item.env) || typeof item.template !== 'string') continue;
        const { value, missing } = resolveTemplate(item.template, process.env, Boolean(item.json));
        if (missing.length) {
          console.log(`::warning title=Qualio::${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in this job, so ${item.env} is empty. Set ${missing.length === 1 ? 'it' : 'them'} from a repository secret in the workflow's env (env: ${missing[0]}: \${{ secrets.${missing[0]} }}).`);
          continue;
        }
        if (!value || /[\r\n]/.test(value)) continue;
        if (item.secret) console.log(`::add-mask::${value}`);
        if (process.env[item.env]) continue;
        process.env[item.env] = value;
        lines.push(`${item.env}=${value}\n`);
        done.push(item.env);
      }
      if (lines.length && process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, lines.join(''));
      console.log(`From the test accounts and APIs in Qualio: ${done.join(', ') || 'nothing to export'}.`);
    }
  }
  await passwords();
}

async function passwords() {
  const text = process.env.QUALIO_TEST_PASSWORDS ?? '';
  if (!text.trim()) return;
  const { passwords: found, unreadable } = parsePasswords(text);
  const lines = [];
  for (const { name, password } of found) {
    console.log(`::add-mask::${password}`);
    if (process.env[name]) continue;
    lines.push(`${name}=${password}\n`);
  }
  if (lines.length && process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, lines.join(''));
  if (unreadable.length) console.log(`::warning title=Qualio::QUALIO_TEST_PASSWORDS: line${unreadable.length === 1 ? '' : 's'} ${unreadable.join(', ')} ${unreadable.length === 1 ? "isn't" : "aren't"} Role=password, so ${unreadable.length === 1 ? 'it was' : 'they were'} skipped.`);
  console.log(`Test account passwords for ${found.length} role${found.length === 1 ? '' : 's'}: ${found.map((p) => p.role).join(', ') || 'none'}.`);
}



// Run as a script (the action's steps): `node qualio.mjs <command> [args…]`.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  // `setup`: the name of the map step before phase 54.
  // config: qualio.yml is gone (phase 83); older workflows' step does nothing.
  const config = async () => console.log("Qualio's settings live in Qualio now: the config input is ignored. You can remove it from the workflow.");
  const commands = { map, setup: map, accounts, passwords, prepare, apply, wait, look, sync, config, outbox, errored, comment, plan, shard };
  if (!commands[command]) {
    console.error(`Unknown command "${command}". Use map, accounts, passwords, prepare, apply, wait, look, sync, config, outbox, errored, comment, plan or shard.`);
    process.exit(2);
  }
  commands[command](...args).catch((error) => {
    console.log(`::error title=Qualio::${error.message}`);
    process.exit(1);
  });
}
