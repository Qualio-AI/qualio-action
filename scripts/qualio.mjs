// Talks to Qualio from the Qualio action. Node 20, no dependencies.
//
//   node qualio.mjs setup <tests-dir> <map-dir> <branch> <minutes>
//                                                sets up the first test suite if the project has none:
//                                                maps the app, waits, runs each check until done
//   node qualio.mjs download <dir> <branch>      writes the branch's tests into <dir>
//   node qualio.mjs promote <branch> <merged> [base]  a closed pull request: keep or drop its heals
//   node qualio.mjs wait <run-file> <minutes>    waits for the heal of the run the reporter wrote
//
// Reads QUALIO_API_URL and QUALIO_API_KEY from the environment and never prints the key. Step
// outputs go to $GITHUB_OUTPUT when it is set.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const apiUrl = (process.env.QUALIO_API_URL ?? '').replace(/\/+$/, '');
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

async function download(dir, branch) {
  const { status, body } = await call('/v1/tests/bundle', { branch });
  if (status === 404) {
    console.log(`::notice title=Qualio::${body.error ?? 'This project has no tests yet.'}`);
    return output({ found: 'false' });
  }
  if (status !== 200) throw new Error(`Downloading the tests failed (${status}): ${body.error ?? 'unknown error'}`);
  await writeFiles(dir, body.files);
  console.log(`Downloaded ${body.files.length} files of the tests for ${branch} (bundle ${body.bundleId}).`);
  await output({ found: 'true', 'bundle-id': body.bundleId });
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

/**
 * Sets up the project's first test suite in this job, if it has none that passed yet (Qualio
 * answers "done" otherwise): the mapper Qualio sends maps the application here, Qualio plans,
 * specifies and codes the suite while this job waits, then every check downloads the suite's tests
 * and runs them (reported as round <check>) until Qualio has repaired or dropped every failing test.
 * Outputs state: ready (it already had one), completed (set up now).
 */
async function setup(testsDir, mapDir, branch, minutes) {
  const start = await call('/v1/setup/start', { branch, ghRunId: process.env.GITHUB_RUN_ID || '0' });
  if (start.status !== 200) throw new Error(`Starting the setup failed (${start.status}): ${start.body.error ?? 'unknown error'}`);
  let state = start.body;
  if (state.state === 'done') {
    console.log('This project’s first test suite is ready.');
    return output({ state: 'ready' });
  }
  const { suiteId } = state;
  console.log(`::notice title=Qualio::Setting up the first test suite: this run maps the application, then checks the generated tests here until they pass. It takes longer than later runs.`);
  const deadline = Date.now() + Number(minutes) * 60_000;
  let mapped = false;
  let checked = 0;
  let said = '';
  for (;;) {
    if (state.message && state.message !== said) console.log((said = state.message));
    if (state.state === 'map') {
      if (mapped) throw new Error('The map of the application did not reach Qualio. Check the mapper’s output above.');
      mapped = true;
      console.log('::group::Map the application');
      await writeFiles(mapDir, state.files);
      await install(mapDir);
      const code = await run('npx', ['playwright', 'test', '-c', 'qualio-map.config.ts'], { cwd: mapDir });
      console.log('::endgroup::');
      if (code !== 0) console.log('::warning title=Qualio::Mapping the application reported a problem (see the "Map the application" group).');
    } else if (state.state === 'validate') {
      if (state.round <= checked) throw new Error(`The results of check ${checked} did not reach Qualio. Check the [qualio] lines in its output.`);
      checked = state.round;
      console.log(`::group::Check ${checked}: run the generated tests`);
      const bundle = await call('/v1/tests/bundle', { branch, suiteId });
      if (bundle.status !== 200) throw new Error(`Downloading the tests to check failed (${bundle.status}): ${bundle.body.error ?? 'unknown error'}`);
      await writeFiles(testsDir, bundle.body.files);
      await install(testsDir);
      // Failures are expected here: Qualio repairs those tests (or drops them) and the next check runs.
      await run('npx', ['playwright', 'test'], { cwd: testsDir, env: { QUALIO_RUN_ROUND: String(checked) } });
      console.log('::endgroup::');
    } else if (state.state === 'done') {
      const result = state.result ?? { tests: 0, features: 0, dropped: [] };
      const counts = `${plural(result.tests, 'test')} across ${plural(result.features, 'feature')}`;
      console.log(`The first test suite is ready: ${counts}, all passing.`);
      await summary([
        '### Qualio: first test suite ready',
        '',
        `${counts}, all passing in this job (check ${state.round}).${state.url ? ` [Open it in Qualio](${state.url})` : ''}`,
        ...(result.dropped.length
          ? ['', `Left out (${result.dropped.length}):`, ...result.dropped.map((d) => `- ${d.featureKey} ${d.test}: ${d.reason}${d.bug ? ' **(looks like an application bug)**' : ''}`)]
          : []),
      ]);
      return output({ state: 'completed' });
    } else if (state.state === 'failed') {
      throw new Error(`Setting up the first test suite failed: ${state.error ?? 'unknown error'}${state.url ? ` (${state.url})` : ''}`);
    }
    if (Date.now() >= deadline) throw new Error(`The first test suite was not ready after ${minutes} minutes. Re-run the workflow to continue where it stopped.`);
    if (state.state === 'wait') await new Promise((r) => setTimeout(r, POLL_MS));
    const status = await call(`/v1/setup/${suiteId}/status`, {});
    if (status.status !== 200) throw new Error(`Reading the setup status failed (${status.status}): ${status.body.error ?? 'unknown error'}`);
    state = status.body;
  }
}

async function promote(branch, merged, baseBranch) {
  const { status, body } = await call('/v1/tests/promote', { branch, merged: merged === 'true', baseBranch: baseBranch || null });
  if (status !== 200) throw new Error(`Telling Qualio the pull request closed failed (${status}): ${body.error ?? 'unknown error'}`);
  if (merged !== 'true') console.log(`Dropped ${body.discarded} heal(s) made on ${branch}.`);
  else {
    console.log(body.promoted.length ? `Qualio's heals from ${branch} are now the main tests: ${body.promoted.join(', ')}.` : `No heals were made on ${branch}.`);
    if (body.skipped.length) console.log(`::warning title=Qualio::Not applied because the main tests changed them since: ${body.skipped.join(', ')}.`);
  }
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
  for (;;) {
    const { status, body } = await call('/v1/tests/heal/status', { runId: run.runId });
    if (status !== 200) throw new Error(`Reading the heal status failed (${status}): ${body.error ?? 'unknown error'}`);
    if (body.status !== 'queued' && body.status !== 'running') {
      // proposed: the project asks first; a person accepts the change or calls it a bug in Qualio.
      console.log(body.status === 'proposed' ? 'Heal: proposed. Qualio waits for someone to accept the UI change or mark it as a bug.' : `Heal: ${body.status}.`);
      return output({ status: body.status });
    }
    if (Date.now() >= deadline) {
      console.log('::warning title=Qualio::Qualio is still diagnosing the failures. Re-run the workflow later to pick up a fix.');
      return output({ status: 'timeout' });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const [command, ...args] = process.argv.slice(2);
const commands = { setup, download, promote, wait };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use setup, download, promote or wait.`);
  process.exit(2);
}
commands[command](...args).catch((error) => {
  console.log(`::error title=Qualio::${error.message}`);
  process.exit(1);
});
