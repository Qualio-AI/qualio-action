// Talks to Qualio for tests served by Qualio (tests-source: qualio). Node 20, no dependencies.
//
//   node qualio.mjs download <dir> <branch>      writes the branch's tests into <dir>
//   node qualio.mjs promote <branch> <merged> [base]  a closed pull request: keep or drop its heals
//   node qualio.mjs wait <run-file> <minutes>    waits for the heal of the run the reporter wrote
//
// Reads QUALIO_API_URL and QUALIO_API_KEY from the environment and never prints the key. Step
// outputs go to $GITHUB_OUTPUT when it is set.
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

async function download(dir, branch) {
  const { status, body } = await call('/v1/tests/bundle', { branch });
  if (status === 404) {
    console.log(`::notice title=Qualio::${body.error ?? 'This project has no tests yet.'}`);
    return output({ found: 'false' });
  }
  if (status !== 200) throw new Error(`Downloading the tests failed (${status}): ${body.error ?? 'unknown error'}`);
  await mkdir(dir, { recursive: true });
  // A re-download replaces the tests but keeps the installed dependencies.
  for (const entry of await readdir(dir)) if (entry !== 'node_modules') await rm(path.join(dir, entry), { recursive: true, force: true });
  for (const file of body.files) {
    const target = safePath(dir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  console.log(`Downloaded ${body.files.length} files of the tests for ${branch} (bundle ${body.bundleId}).`);
  await output({ found: 'true', 'bundle-id': body.bundleId });
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
      console.log(`Heal: ${body.status}.`);
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
const commands = { download, promote, wait };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use download, promote or wait.`);
  process.exit(2);
}
commands[command](...args).catch((error) => {
  console.log(`::error title=Qualio::${error.message}`);
  process.exit(1);
});
