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
//   node qualio.mjs config <branch>              sends qualio.yml's config (CONFIG or CONFIG_FILE) and the overview
//                                                documents it names; fails the job when the config is invalid
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
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePasswords } from './accounts.mjs';
import { describeBinary, isBinary } from './binary.mjs';
import { startBrowserHost } from './browser-host.mjs';
import { commentableLines, suggestionBlock, suggestionComments } from './diff.mjs';

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
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Folders of a tests folder that aren't tests: installed packages, Playwright's output, Qualio's runtime. */
const NOT_TESTS = new Set(['node_modules', 'test-results', 'playwright-report', 'blob-report', '.qualio', '.git', '.cache']);
const MAX_SNAPSHOT_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The tests folder's files (relative paths, posix), without packages and Playwright's output. */
async function testFiles(dir) {
  const out = [];
  const visit = async (abs, rel) => {
    for (const entry of (await readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (NOT_TESTS.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(childAbs, childRel);
      else if (entry.isFile()) {
        const info = await stat(childAbs);
        if (info.size > MAX_FILE_BYTES) {
          console.log(`::warning title=Qualio::${childRel} is over ${MAX_FILE_BYTES / 1024 / 1024} MB and is not sent to Qualio.`);
          continue;
        }
        // A binary file (a committed .xlsx, a PDF) travels as a text description: never as mangled UTF-8.
        const bytes = await readFile(childAbs);
        // Its bytes' hash goes with it, so Qualio recognises a binary file it added (a test file a person attached).
        out.push(
          isBinary(bytes)
            ? { path: childRel, content: describeBinary(childRel, bytes), bytesSha256: sha256(bytes) }
            : { path: childRel, content: bytes.toString('utf8') },
        );
      }
      if (out.length > MAX_SNAPSHOT_FILES) throw new Error(`The tests folder has over ${MAX_SNAPSHOT_FILES} files. Point qualio.yml's tests.path at the E2E tests only.`);
    }
  };
  await visit(dir, '');
  return out;
}

/**
 * Writes files on top of a folder: null content deletes the file; `encoding: 'base64'` is a binary file (a test
 * file a person attached), written as its bytes. A binary file of the folder is never changed by text, and never
 * deleted.
 */
async function applyFiles(dir, files) {
  for (const file of files) {
    const target = safePath(dir, file.path);
    const binary = file.encoding === 'base64' && file.content !== null;
    const current = await readFile(target).catch(() => null);
    if (current && isBinary(current) && !binary) {
      console.log(`::warning title=Qualio::${file.path} is a binary file: Qualio's change to it was not applied.`);
      continue;
    }
    if (file.content === null) await rm(target, { force: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, binary ? Buffer.from(file.content, 'base64') : file.content);
    }
  }
}

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

/**
 * How the run adds Qualio's reporter. Qualio's generated playwright.config.ts lists it (QUALIO_REPORTER);
 * a team's own config doesn't, so the run names it on the command line, with the list and HTML reporters
 * (the command line replaces the config's reporters). Empty when the config already has it.
 */
async function reporterArgs(dir, reporter) {
  for (const name of ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs']) {
    const text = await readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (text !== null) return text.includes('QUALIO_REPORTER') ? '' : `--reporter=list,html,${reporter}`;
  }
  return '';
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
 * The tests folder for this branch: qualio.yml's tests.path when it sets it, else the action's
 * working-directory input, else the project's folder in Qualio. Relative to the repository root.
 */
async function testsFolder(branch, input) {
  // Without Qualio (no api-key) the tests run where the input says, unreported.
  if (!apiKey || !apiUrl) return { rel: input || 'e2e', abs: path.resolve(workspace(), input || 'e2e'), moving: false, offline: true };
  const { status, body } = await call('/v1/tests/prepare', { branch });
  if (status !== 200) throw new Error(`Asking Qualio for the tests folder failed (${status}): ${body.error ?? 'unknown error'}`);
  await exportTestEnv(body.env);
  const rel = body.managed ? body.testsDir : (input || body.testsDir);
  const abs = path.resolve(workspace(), rel);
  if (abs !== workspace() && !abs.startsWith(workspace() + path.sep)) throw new Error(`The tests folder ${rel} is outside the repository.`);
  return { rel, abs, moving: Boolean(body.moving) };
}

// The variables Qualio may answer for the tests: support/email.ts's (qualio.yml's email: where the app's emails
// are caught in this job) and the roles' usernames (roles[].username). Never a password.
const TEST_ENV = /^(?:QUALIO_MAIL(?:_(?:URL|DOMAIN|SERVER))?|E2E_[A-Z0-9_]+_USERNAME)$/;

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
    exported[name] = value;
    process.env[name] = value;
  }
  const lines = Object.entries(exported).map(([k, v]) => `${k}=${v}\n`).join('');
  if (lines && process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, lines);
  if (exported.QUALIO_MAIL) console.log(`The tests read email from ${exported.QUALIO_MAIL}${exported.QUALIO_MAIL_URL ? ` (${exported.QUALIO_MAIL_URL})` : ''}.`);
  // A role the config names a username for, without a password in this job: its sign-in would fail.
  for (const name of Object.keys(env).filter((n) => /^E2E_[A-Z0-9_]+_USERNAME$/.test(n))) {
    const password = name.replace(/_USERNAME$/, '_PASSWORD');
    if (!process.env[password]) console.log(`::warning title=Qualio::${password} is not set, so tests that sign in with ${env[name]} will fail. Add a line for that role (Role=password) to the QUALIO_TEST_PASSWORDS secret.`);
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
    await writeFile(target, file.content);
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

/**
 * Gets the tests ready to run: finds the tests folder, sends Qualio a snapshot of it (hashes, and the
 * contents Qualio doesn't have yet), and writes the changes Qualio offers on the branch on top (its
 * verified fixes and new tests: they run here before they're suggested, and while they wait to be
 * committed). A project whose tests Qualio still kept gets the whole folder until the move is merged.
 * Outputs dir (absolute), run (true/false).
 */
async function prepare(branch, input = '') {
  const folder = await testsFolder(branch, input);
  const dir = folder.abs;
  const hasConfig = (await exists(path.join(dir, 'package.json'))) && ((await exists(path.join(dir, 'playwright.config.ts'))) || (await exists(path.join(dir, 'playwright.config.js'))));
  if (!(await exists(dir)) && folder.moving) {
    // Qualio still keeps this project's tests: run them from Qualio while the move pull request waits.
    const { status, body } = await call('/v1/tests/changes', { branch, whole: true });
    if (status === 404) {
      console.log(`::notice title=Qualio::${body.error ?? 'This project has no tests yet.'}`);
      return output({ run: 'false', dir });
    }
    if (status !== 200) throw new Error(`Getting the tests from Qualio failed (${status}): ${body.error ?? 'unknown error'}`);
    await writeFiles(dir, body.files);
    await writeManifest('move', body.revisionIds);
    process.env.QUALIO_REPORTER = await installReporter(dir);
    console.log(`::notice title=Qualio::Your E2E tests now live in your repository (${folder.rel}). Until Qualio's pull request that adds them is merged, this job runs them from Qualio.`);
    await output({ reporter: process.env.QUALIO_REPORTER, mode: 'move' });
    return output({ run: 'true', dir });
  }
  const missing = !(await exists(dir));
  // Offline (no api-key) there is nothing else to run; with Qualio, its changes may bring the folder (new
  // tests in a Qualio pull request not merged yet).
  if (missing && folder.offline) throw new Error(missingFolder(folder.rel));
  if (!missing && !hasConfig) throw new Error(`'${folder.rel}' has no package.json and playwright.config.ts. Is tests.path the folder that holds your E2E tests?`);

  if (folder.offline) {
    await output({ mode: 'repo', reporter: '' });
    return output({ run: 'true', dir });
  }
  const files = missing ? [] : await testFiles(dir);
  const request = {
    branch,
    prNumber: await eventPrNumber(),
    headSha: process.env.QUALIO_COMMIT_SHA || process.env.GITHUB_SHA || '0000000',
    testsDir: folder.rel,
    files: files.map((f) => ({ path: f.path, sha256: sha256(f.content), ...(f.bytesSha256 && { bytesSha256: f.bytesSha256 }) })),
    // This action writes binary files Qualio adds (base64 entries).
    binary: true,
  };
  let { status, body } = await call('/v1/tests/snapshot', request);
  if (status === 200 && body.state === 'contents') {
    // Only the contents Qualio doesn't have yet travel.
    const missing = new Set(body.missing);
    ({ status, body } = await call('/v1/tests/snapshot', {
      ...request,
      files: files.map((f) => ({ path: f.path, sha256: sha256(f.content), ...(f.bytesSha256 && { bytesSha256: f.bytesSha256 }), ...(missing.has(sha256(f.content)) && { content: f.content }) })),
    }));
  }
  if (status !== 200 || body.state !== 'stored') throw new Error(`Sending the tests folder to Qualio failed (${status}): ${body.error ?? 'unknown error'}`);
  if (body.committed) console.log(`Qualio sees ${plural(body.committed, 'of its changes')} committed on ${branch}.`);
  if (body.outdated) console.log(`::notice title=Qualio::${plural(body.outdated, 'of Qualio\'s changes')} no longer fit (the lines changed since): Qualio looks again if the tests fail.`);
  // No tests yet: Qualio writes them for the pull requests that name an approved ticket, starting the folder.
  if (missing && !body.files.some((f) => f.path === 'package.json' && f.content !== null)) {
    console.log(`::notice title=Qualio::There are no tests in '${folder.rel}' yet. Qualio writes tests for the pull requests that name an approved ticket, starting the folder; until then this job has nothing to run.`);
    return output({ run: 'false', dir });
  }
  printNotices(body.notices);
  if (body.files.length) {
    await applyFiles(dir, body.files);
    console.log(`Applied ${plural(body.revisionIds.length, 'change')} Qualio offers on ${branch} (${plural(body.files.length, 'file')}): they run here before they're committed.`);
  }
  await writeManifest('repo', body.revisionIds);
  for (const { key, reason } of body.pending ?? [])
    console.log(`::notice title=Qualio::${key} has no tests in this run yet: ${reason}. Qualio runs this workflow again once they are written.`);
  process.env.QUALIO_REPORTER = await installReporter(dir);
  const args = await reporterArgs(dir, process.env.QUALIO_REPORTER);
  if (args) console.log("Your playwright.config doesn't list Qualio's reporter: this job adds it to the run (with the list and HTML reporters).");
  await output({ reporter: process.env.QUALIO_REPORTER, 'reporter-args': args, mode: 'repo' });
  await output({ run: 'true', dir });
}

function missingFolder(rel) {
  return `The tests folder '${rel}' does not exist. Set tests.path in qualio.yml's config to the folder that holds your E2E tests (with package.json and playwright.config.ts), and check out the repository first with actions/checkout.`;
}

/** After a heal: writes the branch's changes (now with the fix) on top of the tests folder for the re-run. */
async function apply(dir, branch, mode = 'repo') {
  const { status, body } = await call('/v1/tests/changes', { branch, binary: true, ...(mode === 'move' && { whole: true }) });
  if (status !== 200) throw new Error(`Getting Qualio's fix failed (${status}): ${body.error ?? 'unknown error'}`);
  printNotices(body.notices);
  if (body.replace) await writeFiles(dir, body.files);
  else await applyFiles(dir, body.files);
  await writeManifest(body.replace ? 'move' : 'repo', body.revisionIds);
  // The reporter stays where prepare put it (writeFiles keeps .qualio only for repo folders): put it back.
  if (body.replace) await installReporter(dir);
  console.log(`Applied Qualio's fix (${plural(body.files.length, 'file')}) for the re-run. It is suggested on the pull request once the tests pass.`);
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

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const ok = (r) => r.status >= 200 && r.status < 300;

/** A file's bytes at a commit, or null when it doesn't exist there. Throws on other errors. */
async function fileAt(repo, file, ref) {
  const r = await github('GET', `${repo}/contents/${encodePath(file)}?ref=${encodeURIComponent(ref)}`);
  if (r.status === 404) return null;
  if (!ok(r)) throw Object.assign(new Error(`GitHub ${r.status}: ${r.message}`), { status: r.status });
  if (Array.isArray(r.data) || r.data?.type !== 'file') return null;
  if (r.data.encoding === 'base64') return Buffer.from(r.data.content ?? '', 'base64');
  // Over 1 MB GitHub sends no content: read the blob.
  const blob = await github('GET', `${repo}/git/blobs/${r.data.sha}`);
  if (!ok(blob)) throw Object.assign(new Error(`GitHub ${blob.status}: ${blob.message}`), { status: blob.status });
  return Buffer.from(blob.data.content ?? '', 'base64');
}

/** The hash that identifies what a change file writes: of its bytes (base64 entries) or its text. */
const changeHash = (f) => (f.content === null ? null : f.encoding === 'base64' ? sha256(Buffer.from(f.content, 'base64')) : sha256(f.content));

/** The lines each file of a pull request's diff shows (right side), by path. */
async function pullRequestLines(repo, number) {
  const byPath = new Map();
  for (let page = 1; page <= 30; page++) {
    const r = await github('GET', `${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    if (!ok(r) || !Array.isArray(r.data)) break;
    for (const f of r.data) if (f.patch) byPath.set(f.filename, commentableLines(f.patch));
    if (r.data.length < 100) break;
  }
  return byPath;
}

/**
 * Suggestions on the pull request for the changes that are edits of lines its diff shows: one review with
 * a ```suggestion per hunk. A change with a hunk GitHub can't anchor (outside the diff, a new or deleted
 * file, a file that changed since) isn't suggested: it goes to the Qualio pull request whole.
 */
async function suggest(repo, p, changes) {
  const pr = await github('GET', `${repo}/pulls/${p.prNumber}`);
  if (!ok(pr)) return { suggested: [] };
  const head = pr.data.head.sha;
  const diff = await pullRequestLines(repo, p.prNumber);
  const comments = [];
  const suggested = [];
  for (const change of changes) {
    const own = [];
    let fits = true;
    for (const f of change.files) {
      const file = path.posix.join(p.testsDir, f.path);
      // A binary file is never a suggestion: it goes in the Qualio pull request.
      if (f.content === null || f.encoding === 'base64' || f.baseSha256 === null || !diff.has(file)) {
        fits = false;
        break;
      }
      const bytes = await fileAt(repo, file, head).catch(() => null);
      if (bytes === null || sha256(bytes) !== f.baseSha256) {
        fits = false;
        break;
      }
      const found = suggestionComments(file, bytes.toString('utf8'), f.content, diff.get(file));
      if (!found) {
        fits = false;
        break;
      }
      own.push(...found);
    }
    if (!fits || !own.length) continue;
    own.forEach((c, i) => {
      const { suggestion, ...anchor } = c;
      const intro = i === 0 ? `${change.body}\n\n` : `${change.title} (${i + 1}/${own.length})\n\n`;
      comments.push({ ...anchor, body: `**Qualio AI:** ${intro}${suggestionBlock(suggestion)}\n\n<!-- qualio:suggestion ${change.id} ${i} -->` });
    });
    suggested.push({ id: change.id, count: own.length });
  }
  if (!comments.length) return { suggested: [] };
  const review = await github('POST', `${repo}/pulls/${p.prNumber}/reviews`, {
    commit_id: head,
    event: 'COMMENT',
    body: `**Qualio AI:** ${plural(suggested.length, 'verified fix', 'verified fixes')} for the E2E tests. Each passed in this pull request's Qualio job: commit the suggestion to keep the tests in step.${p.pageUrl ? ` [Open in Qualio](${p.pageUrl})` : ''}`,
    comments,
  });
  if (!ok(review)) {
    console.log(`Qualio's suggestions were not posted (GitHub ${review.status}: ${review.message}); they go to the Qualio pull request instead.`);
    return { suggested: [], denied: review.status === 403 };
  }
  return { suggested: suggested.map((s) => ({ id: s.id, via: 'suggestion', reviewId: review.data?.id ?? null })) };
}

/** The open pull request from `head` into `base`, if there is one. */
async function findPullRequest(repo, head, base) {
  const owner = (process.env.GITHUB_REPOSITORY ?? '').split('/')[0];
  const r = await github('GET', `${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`);
  return ok(r) && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

/**
 * The Qualio pull request: its branch (qualio/…) is rebuilt from the base branch's head with one commit per
 * change, in order, and force-pushed; the pull request into the base branch is opened or updated. A change
 * whose files the base branch changed otherwise since it was written is left out (a conflict). Only Qualio's
 * own qualio/* branch is ever pushed.
 */
async function qualioPullRequest(repo, p, changes) {
  const result = { delivered: [], conflicts: [] };
  const ref = await github('GET', `${repo}/git/ref/heads/${encodePath(p.branch)}`);
  if (!ok(ref)) return { ...result, failed: ref };
  const baseSha = ref.data.object.sha;
  const baseCommit = await github('GET', `${repo}/git/commits/${baseSha}`);
  if (!ok(baseCommit)) return { ...result, failed: baseCommit };
  let parent = baseSha;
  let tree = baseCommit.data.tree.sha;
  const known = new Map();
  const current = async (file) => {
    if (!known.has(file)) known.set(file, await fileAt(repo, file, baseSha));
    return known.get(file);
  };
  for (const change of changes) {
    const files = change.files.map((f) => ({ ...f, repoPath: path.posix.join(p.testsDir, f.path) }));
    let conflict = null;
    let already = true;
    for (const f of files) {
      const now = await current(f.repoPath);
      const nowHash = now === null ? null : sha256(now);
      const want = changeHash(f);
      if (nowHash !== want) already = false;
      if (nowHash !== f.baseSha256 && nowHash !== want) conflict = f.path;
    }
    if (conflict) {
      result.conflicts.push({ id: change.id, path: conflict });
      continue;
    }
    // The branch has it already (written by hand, or a suggestion committed): nothing to commit.
    if (already) {
      result.delivered.push({ id: change.id, via: 'qualio_pr', commitSha: null });
      continue;
    }
    // A binary file (base64) becomes a blob first: a tree entry's content is text only.
    const entries = [];
    for (const f of files) {
      if (f.content === null) entries.push({ path: f.repoPath, mode: '100644', type: 'blob', sha: null });
      else if (f.encoding === 'base64') {
        const blob = await github('POST', `${repo}/git/blobs`, { content: f.content, encoding: 'base64' });
        if (!ok(blob)) return { ...result, failed: blob };
        entries.push({ path: f.repoPath, mode: '100644', type: 'blob', sha: blob.data.sha });
      } else entries.push({ path: f.repoPath, mode: '100644', type: 'blob', content: f.content });
    }
    const t = await github('POST', `${repo}/git/trees`, { base_tree: tree, tree: entries });
    if (!ok(t)) return { ...result, failed: t };
    const c = await github('POST', `${repo}/git/commits`, { message: `${change.message}\n\n${change.body}\n\nqualio-change: ${change.id}`, tree: t.data.sha, parents: [parent] });
    if (!ok(c)) return { ...result, failed: c };
    parent = c.data.sha;
    tree = t.data.sha;
    for (const f of files) known.set(f.repoPath, f.content === null ? null : f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content));
    result.delivered.push({ id: change.id, via: 'qualio_pr', commitSha: parent });
  }
  if (parent === baseSha) return { ...result, empty: true };
  const branchRef = `heads/${encodePath(p.qualioBranch)}`;
  let pushed = await github('PATCH', `${repo}/git/refs/${branchRef}`, { sha: parent, force: true });
  if (pushed.status === 404 || pushed.status === 422) pushed = await github('POST', `${repo}/git/refs`, { ref: `refs/heads/${p.qualioBranch}`, sha: parent });
  if (!ok(pushed)) return { ...result, delivered: [], failed: pushed };
  let pr = p.qualioPr ? await github('PATCH', `${repo}/pulls/${p.qualioPr.number}`, { title: p.title, body: p.body }) : null;
  if (!pr || !ok(pr)) {
    const existing = await findPullRequest(repo, p.qualioBranch, p.branch);
    pr = existing
      ? await github('PATCH', `${repo}/pulls/${existing.number}`, { title: p.title, body: p.body })
      : await github('POST', `${repo}/pulls`, { title: p.title, head: p.qualioBranch, base: p.branch, body: p.body, maintainer_can_modify: true });
  }
  if (!ok(pr)) {
    const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
    const compare = `${server}/${process.env.GITHUB_REPOSITORY}/compare/${encodeURIComponent(p.branch)}...${encodeURIComponent(p.qualioBranch)}?expand=1`;
    console.log(
      `::warning title=Qualio::Qualio pushed its changes to ${p.qualioBranch} but GitHub didn't let it open the pull request (GitHub ${pr.status}: ${pr.message}). Open it yourself: ${compare}. To let Qualio open it, allow it in Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" (the organization's settings first, if the box is greyed out): ${ALLOW_PULL_REQUESTS_DOCS}. The next Qualio job tries again.`,
    );
    return {
      ...result,
      delivered: result.delivered.map((d) => ({ ...d, via: 'report' })),
      qualioPr: null,
      blocked: { reason: 'pull_request', status: pr.status ?? null, message: String(pr.message ?? '').slice(0, 300), qualioBranch: p.qualioBranch, compareUrl: compare },
    };
  }
  return { ...result, qualioPr: { number: pr.data.number, url: pr.data.html_url, headBranch: p.qualioBranch, headSha: parent, state: 'open' } };
}

/** Closes the Qualio pull request and deletes its branch (it has nothing left to offer). */
async function retireQualioPullRequest(repo, p) {
  await github('PATCH', `${repo}/pulls/${p.qualioPr.number}`, { state: 'closed' });
  await github('DELETE', `${repo}/git/refs/heads/${encodePath(p.qualioBranch)}`);
  console.log(`Closed Qualio pull request #${p.qualioPr.number}: it has nothing left to offer.`);
  return { changes: { retired: p.qualioPr.number } };
}

/**
 * Qualio's changes to a branch's tests (specs/tests-in-the-repository.md §5): suggestions on the pull
 * request where GitHub allows them, the rest as commits in one Qualio pull request into the branch. With
 * report-only (or without the permission to push qualio/* branches), the report shows them instead.
 */
async function deliverTestChanges(repo, item) {
  const p = item.payload;
  // A person merged or closed the Qualio pull request since: Qualio records it, then offers what's left.
  if (p.qualioPr) {
    const r = await github('GET', `${repo}/pulls/${p.qualioPr.number}`);
    if (ok(r) && r.data.state === 'closed')
      return { changes: { qualioPr: { number: r.data.number, url: r.data.html_url, headBranch: p.qualioBranch, headSha: r.data.head?.sha ?? null, state: r.data.merged ? 'merged' : 'closed' } } };
  }
  if (p.close) return p.qualioPr ? retireQualioPullRequest(repo, p) : { changes: {} };
  const delivered = [];
  let rest = p.changes.filter((c) => c.via !== 'suggestion');
  if (p.mode === 'REVIEW' && p.prNumber) {
    const fresh = rest.filter((c) => c.via === null && c.suggest);
    if (fresh.length) {
      const { suggested } = await suggest(repo, p, fresh);
      delivered.push(...suggested);
      const done = new Set(suggested.map((s) => s.id));
      rest = rest.filter((c) => !done.has(c.id));
    }
  }
  if (p.mode !== 'REVIEW') {
    for (const c of rest) if (c.via === null) delivered.push({ id: c.id, via: 'report' });
    return { changes: { delivered } };
  }
  if (!rest.length) return p.qualioPr ? { ...(await retireQualioPullRequest(repo, p)), changes: { delivered, retired: p.qualioPr.number } } : { changes: { delivered } };
  const built = await qualioPullRequest(repo, p, rest);
  if (built.failed) {
    if (built.failed.status === 403 || built.failed.status === 404) {
      console.log(
        `::warning title=Qualio::This job's GITHUB_TOKEN can't push Qualio's branch (qualio/*), so Qualio's changes to the tests are shown in its report instead. Add to the workflow: permissions: { contents: write } (${ALLOW_PULL_REQUESTS_DOCS}). The next Qualio job tries again.`,
      );
      for (const c of rest) if (c.via === null) delivered.push({ id: c.id, via: 'report' });
      return { changes: { delivered, blocked: { reason: 'push', status: built.failed.status, message: String(built.failed.message ?? '').slice(0, 300), qualioBranch: p.qualioBranch, compareUrl: null } } };
    }
    return { failed: built.failed };
  }
  if (built.empty && p.qualioPr) return { ...(await retireQualioPullRequest(repo, p)), changes: { delivered: [...delivered, ...built.delivered], conflicts: built.conflicts, retired: p.qualioPr.number } };
  if (built.qualioPr) console.log(`Qualio pull request #${built.qualioPr.number} (${p.qualioBranch} → ${p.branch}): ${plural(built.delivered.length, 'change')}.`);
  return { changes: { delivered: [...delivered, ...built.delivered], conflicts: built.conflicts, qualioPr: built.qualioPr ?? null, ...(built.blocked && { blocked: built.blocked }) } };
}

/**
 * Qualio's pull request that changes tests.shards.max in the config file (specs/auto-sharding.md: only
 * with tests.shards.suggest, when clearly worth it): one commit on qualio/sharding from the target
 * branch's head, opened or updated as a pull request into it, closed when Qualio no longer proposes it.
 */
async function deliverShardingChange(repo, item) {
  const p = { ...item.payload, testsDir: '' };
  if (p.qualioPr) {
    const r = await github('GET', `${repo}/pulls/${p.qualioPr.number}`);
    if (ok(r) && r.data.state === 'closed') return { sharding: { qualioPr: { number: r.data.number, url: r.data.html_url, state: r.data.merged ? 'merged' : 'closed' } } };
  }
  if (p.close) {
    if (!p.qualioPr) return { sharding: {} };
    await retireQualioPullRequest(repo, p);
    return { sharding: { retired: p.qualioPr.number } };
  }
  const built = await qualioPullRequest(repo, p, [{ id: 'sharding', message: p.title, body: 'Qualio splits the E2E tests across jobs by their past durations.', files: [{ path: p.path, content: p.content, baseSha256: p.baseSha256 }] }]);
  if (built.failed) return { failed: built.failed };
  if (built.conflicts.length) {
    console.log(`Qualio's change to ${p.path} no longer fits (the file changed since): it proposes again from the new one if it's still worth it.`);
    return { sharding: { conflict: true } };
  }
  if (built.empty) return { sharding: {} };
  if (built.qualioPr) console.log(`Qualio pull request #${built.qualioPr.number} (${p.qualioBranch} → ${p.branch}): ${p.title}.`);
  return { sharding: { qualioPr: built.qualioPr ? { number: built.qualioPr.number, url: built.qualioPr.url, state: 'open' } : null } };
}

/** Sends one outbox item. Returns the GitHub call that failed, if one did, and the report comment's id. */
async function deliver(item) {
  const repo = `/repos/${process.env.GITHUB_REPOSITORY}`;
  if (item.kind === 'REPORT') return deliverReport(repo, item);
  if (item.kind === 'TEST_CHANGES') return deliverTestChanges(repo, item);
  if (item.kind === 'SHARDING_CHANGE') return deliverShardingChange(repo, item);
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
 * answering (a reply to the Analyst), so the answer is posted by this job. Never fails the job: what
 * can't be sent now waits for the next job.
 */
async function outbox(waitMinutes = '0') {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const deadline = Date.now() + Number(waitMinutes || 0) * 60_000;
  let sent = 0;
  let denied = false;
  let quiet = 0;
  for (;;) {
    // report: this action edits Qualio's one report comment in place and reacts to commands.
    // changes: this action offers Qualio's changes to the tests (suggestions, the Qualio pull request).
    // lease: a sharded run's jobs end together; each item goes out from one of them.
    // sharding: this action opens Qualio's pull request that changes tests.shards.max.
    const { status, body } = await call('/v1/pr/outbox', { report: true, changes: true, sharding: true, binary: true, ...(process.env.QUALIO_SHARDED === 'true' && { lease: true }) });
    if (status !== 200) return console.log(`::warning title=Qualio::Could not read Qualio's GitHub updates (${status}): ${body.error ?? 'unknown error'}`);
    const batch = await sendBatch(body.items);
    sent += batch.sent;
    denied ||= batch.denied;
    // Done when nothing is left and nobody is answering (twice: the answer's comment is queued just after).
    quiet = body.items.length === 0 && !body.waiting ? quiet + 1 : 0;
    if (Date.now() >= deadline || quiet >= 2 || denied) break;
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

const OVERVIEW_EXTENSIONS = ['.md', '.markdown', '.txt'];

/** The overview documents a config names: files, or the .md/.txt files of folders (recursively), inside the checkout. */
async function overviewFiles(paths, { known, maxFiles, maxBytes }) {
  const root = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const found = new Map();
  const visit = async (abs, rel, named) => {
    const info = await stat(abs).catch(() => null);
    if (!info) throw new Error(`overview: ${rel} does not exist in the checked-out repository. Check out the repository first (actions/checkout) and check the path.`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(abs)).sort()) if (!entry.startsWith('.') && entry !== 'node_modules') await visit(path.join(abs, entry), path.posix.join(rel, entry), false);
    } else if (OVERVIEW_EXTENSIONS.includes(path.extname(abs).toLowerCase())) found.set(rel, abs);
    else if (named) console.log(`::warning title=Qualio config::overview: ${rel} is skipped (only ${OVERVIEW_EXTENSIONS.join(', ')} files are sent).`);
  };
  for (const p of paths) {
    const rel = p.replace(/\/+$/, '') || '.';
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`overview: ${p} is outside the repository.`);
    await visit(abs, rel, true);
  }
  const files = [];
  let bytes = 0;
  for (const [rel, abs] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    if (files.length >= maxFiles) {
      console.log(`::warning title=Qualio config::overview: only the first ${maxFiles} files are sent; ${found.size - maxFiles} more are skipped.`);
      break;
    }
    const content = await readFile(abs, 'utf8');
    bytes += Buffer.byteLength(content);
    if (bytes > maxBytes) throw new Error(`overview: the documents are over ${Math.round(maxBytes / 1024)} KB. Point overview at fewer or shorter files.`);
    const hash = sha256(content);
    // Only what Qualio doesn't have yet travels.
    files.push(known.includes(hash) ? { path: rel, sha256: hash } : { path: rel, sha256: hash, content });
  }
  return files;
}

/**
 * Sends the workflow's Qualio config (the action's config input, or the file config-file names) to
 * Qualio, which validates and applies it: to the project (its first config, or the target branch), or to
 * this pull request's branch (changes to its own runs now, project-wide ones when it merges). The overview documents
 * it names are read from the checkout and sent too. Qualio never reads the repository itself.
 */
async function config(branch) {
  const inline = process.env.CONFIG ?? '';
  const file = (process.env.CONFIG_FILE ?? '').trim();
  if (inline.trim() && file) throw new Error('Use either the config input or config-file, not both.');
  let raw = inline;
  let source = 'inline';
  if (file) {
    const root = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
    const abs = path.resolve(root, file);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`config-file ${file} is outside the repository.`);
    raw = await readFile(abs, 'utf8').catch(() => {
      throw new Error(`config-file ${file} does not exist. Check out the repository first (actions/checkout) and check the path.`);
    });
    source = file;
  }
  if (!raw.trim()) return output({ scope: 'none' });
  let prNumber = null;
  if (/^pull_request/.test(process.env.GITHUB_EVENT_NAME ?? '') && process.env.GITHUB_EVENT_PATH)
    prNumber = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.number ?? null;
  const request = { branch, prNumber, headSha: process.env.QUALIO_COMMIT_SHA || process.env.GITHUB_SHA || '0000000', source, raw };

  let { status, body } = await call('/v1/config/sync', request);
  // Qualio names the overview paths it needs (and the contents it already has); a second ask means it lost them.
  for (let round = 0; status === 200 && body.state === 'overview' && round < 2; round++) {
    const overview = await overviewFiles(body.paths, { known: round === 0 ? (body.known ?? []) : [], maxFiles: body.maxFiles ?? 50, maxBytes: body.maxBytes ?? 256 * 1024 });
    ({ status, body } = await call('/v1/config/sync', { ...request, overview }));
  }
  for (const w of body.warnings ?? []) console.log(`::warning title=Qualio config::${typeof w === 'string' ? w : `${w.key}: ${w.message}`}`);
  if (status === 422) {
    for (const p of body.problems ?? []) console.log(`::error title=Qualio config::${p.key}: ${p.message}`);
    throw new Error(`The Qualio config in ${source === 'inline' ? 'the workflow' : source} is invalid (see the errors above). Nothing was changed in Qualio.`);
  }
  if (status !== 200 || body.state !== 'synced') throw new Error(`Qualio could not read the config (${status}): ${body.error ?? 'unknown error'}`);

  console.log(`::group::Qualio config (${source === 'inline' ? 'qualio.yml' : source})`);
  console.log(body.message);
  for (const c of body.changes ?? []) console.log(`  ${c.label}: ${c.from} → ${c.to} (${c.when === 'now' ? 'on this branch now' : `when merged${c.why === 'looser' ? ', looser' : ''}`})`);
  console.log('::endgroup::');
  const lines = ['### Qualio config', '', body.message];
  if (body.changes?.length)
    lines.push(
      '',
      '| Setting | From | To | Applies |',
      '| --- | --- | --- | --- |',
      ...body.changes.map((c) => `| ${cell(c.label)} | ${cell(c.from)} | ${cell(c.to)} | ${c.when === 'now' ? 'On this branch now' : c.why === 'looser' ? 'When merged (looser)' : 'When merged'} |`),
    );
  await summary(lines);
  await output({ scope: String(body.scope).toLowerCase() });
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
      const child = spawn('npx', ['playwright', 'test', '--list', '--reporter=json'], { cwd: dir, env: { ...process.env, QUALIO_REPORTER: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
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

const [command, ...args] = process.argv.slice(2);
// `setup`: the name of the map step before phase 54.
const commands = { map, setup: map, passwords, prepare, apply, wait, look, sync, config, outbox, errored, comment, plan, shard };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use map, passwords, prepare, apply, wait, look, sync, config, outbox, errored, comment, plan or shard.`);
  process.exit(2);
}
commands[command](...args).catch((error) => {
  console.log(`::error title=Qualio::${error.message}`);
  process.exit(1);
});
