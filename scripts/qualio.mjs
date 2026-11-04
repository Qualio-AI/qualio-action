// Talks to Qualio from the Qualio action. Node 20, no dependencies.
//
//   node qualio.mjs setup <tests-dir> <map-dir> <branch> <minutes>
//                                                sets up the first test suite if the project has none:
//                                                maps the app, waits, runs each check until done
//   node qualio.mjs download <dir> <branch>      writes the branch's tests into <dir>
//   node qualio.mjs promote <branch> <merged> [base]  a closed pull request: keep or drop its heals
//   node qualio.mjs wait <run-file> <minutes>    waits for the heal of the run the reporter wrote
//   node qualio.mjs sync                         tells Qualio about this pull request (title, branch, head, merged)
//   node qualio.mjs config <branch>              sends qualio.yml's config (CONFIG or CONFIG_FILE) and the overview
//                                                documents it names; fails the job when the config is invalid
//   node qualio.mjs outbox [wait-minutes]        sends what Qualio queued for GitHub (comments, statuses,
//                                                dispatches, labels) with GITHUB_TOKEN; waits for answers
//   node qualio.mjs comment                      relays a new pull request comment to Qualio (comment job)
//   node qualio.mjs errored <conclusion>         this job failed before reporting results
//
// Reads QUALIO_API_URL and QUALIO_API_KEY (and GITHUB_TOKEN for outbox) from the environment and never prints them. Step
// outputs go to $GITHUB_OUTPUT when it is set.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const apiUrl = (process.env.QUALIO_API_URL ?? '').replace(/\/+$/, '');
const apiKey = process.env.QUALIO_API_KEY ?? '';
const POLL_MS = Number(process.env.QUALIO_POLL_MS || 10_000);
/** Per test in the setup's checks (generated tests use short action and expect timeouts too). */
const CHECK_TEST_TIMEOUT_MS = 20_000;

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

/** Runs git in the checked-out repository; never throws. */
function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: process.env.GITHUB_WORKSPACE || process.cwd(), maxBuffer: 1 << 20, timeout: 120_000 }, (error, stdout) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 128) : 0, stdout: String(stdout ?? '').trim() }),
    );
  });
}

/**
 * Which of `merges` ({ number, sha }: pull requests merged into the target branch that changed the
 * main tests) the checked-out code doesn't contain. Their tests expect changes this code doesn't
 * have yet, so Qualio serves the tests from before them. Null when it can't tell (no git, no
 * history): the latest tests are used, as before.
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
    if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
    let { code } = await git(['merge-base', '--is-ancestor', sha, 'HEAD']);
    if (code > 1 && (await git(['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', sha])).code === 0) code = (await git(['merge-base', '--is-ancestor', sha, 'HEAD'])).code;
    // 1: not an ancestor. Anything else (a commit GitHub no longer has): don't count it.
    if (code === 1) lacking.push(number);
  }
  return lacking;
}

async function download(dir, branch) {
  let { status, body } = await call('/v1/tests/bundle', { branch });
  if (status === 200 && body.merges?.length) {
    const lacking = await lackingMerges(body.merges);
    if (lacking === null) console.log('::notice title=Qualio::Could not check which merged pull requests this commit includes (no git history), so the latest tests are used.');
    else if (lacking.length) ({ status, body } = await call('/v1/tests/bundle', { branch, lacking }));
  }
  if (status === 404) {
    console.log(`::notice title=Qualio::${body.error ?? 'This project has no tests yet.'}`);
    return output({ found: 'false' });
  }
  if (status !== 200) throw new Error(`Downloading the tests failed (${status}): ${body.error ?? 'unknown error'}`);
  await writeFiles(dir, body.files);
  console.log(`Downloaded ${body.files.length} files of the tests for ${branch} (bundle ${body.bundleId}).`);
  if (body.lacking?.length) {
    const refs = body.lacking.map((n) => `#${n}`);
    const list = refs.length === 1 ? refs[0] : `${refs.slice(0, -1).join(', ')} and ${refs.at(-1)}`;
    console.log(`::warning title=Qualio::This branch doesn't include ${list} yet, so the tests from before ${refs.length === 1 ? 'it' : 'them'} run and failures aren't healed. Merge or rebase the target branch to run the latest tests.`);
  }
  // Tickets this pull request names whose tests Qualio hasn't written yet: Qualio runs the workflow again once they are.
  for (const { key, reason } of body.pending ?? [])
    console.log(`::notice title=Qualio::${key} has no tests in this run yet: ${reason}. Qualio runs this workflow again once they are written.`);
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

// Job summary blocks, as Qualio writes them on GitHub (@qualio/shared/github-markdown in qualio-webapp).
const alert = (kind, body) => [`> [!${kind}]`, ...body.trim().split('\n').map((line) => (line.trim() ? `> ${line}` : '>'))].join('\n');
const cell = (text, max = 200) => {
  const line = String(text).replace(/\s*\n\s*/g, ' ').trim();
  return (line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line).replace(/\|/g, '\\|');
};
const details = (title, body) => `<details><summary>${title}</summary>\n\n${body}\n\n</details>`;

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
      // No retries and a short test timeout: a retry tells Qualio nothing new and only costs the job's time.
      await run('npx', ['playwright', 'test', '--retries=0', `--timeout=${CHECK_TEST_TIMEOUT_MS}`], { cwd: testsDir, env: { QUALIO_RUN_ROUND: String(checked) } });
      console.log('::endgroup::');
    } else if (state.state === 'done') {
      const result = state.result ?? { tests: 0, features: 0, dropped: [] };
      const counts = `${plural(result.tests, 'test')} across ${plural(result.features, 'feature')}`;
      console.log(`The first test suite is ready: ${counts}, all passing.`);
      await summary([
        '### 🎉 Qualio: first test suite ready',
        '',
        alert('TIP', `✅ ${counts}, all passing in this job (check ${state.round}).${state.url ? ` [Open it in Qualio](${state.url})` : ''}`),
        ...(result.dropped.length
          ? [
              '',
              details(
                `⚠️ Left out (${result.dropped.length})`,
                [
                  '|  | Feature | Test | Reason |',
                  '|---|---|---|---|',
                  ...result.dropped.map((d) => `| ${d.bug ? '🐞' : '⏭️'} | ${cell(d.featureKey, 40)} | ${cell(d.test)} | ${cell(`${d.reason}${d.bug ? ': looks like an application bug' : ''}`, 300)} |`),
                ].join('\n'),
              ),
            ]
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
  else if (body.held)
    console.log(`::warning title=Qualio::The latest run on ${branch} did not pass, so its tests were not added to the main tests. Promote or discard them on the pull request's page in Qualio.`);
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

/** Sends one outbox item. Returns the GitHub call that failed, if one did, and the report comment's id. */
async function deliver(item) {
  const repo = `/repos/${process.env.GITHUB_REPOSITORY}`;
  if (item.kind === 'REPORT') return deliverReport(repo, item);
  return { failed: await deliverOne(repo, item) };
}

async function deliverOne(repo, item) {
  const p = item.payload;
  const ok = (r) => (r.status >= 200 && r.status < 300 ? null : r);
  switch (item.kind) {
    case 'COMMENT':
      return ok(await github('POST', `${repo}/issues/${item.prNumber}/comments`, { body: p.body }));
    case 'REACTION':
      return ok(await github('POST', `${repo}/issues/comments/${p.commentId}/reactions`, { content: p.content }));
    case 'STATUS':
      return ok(await github('POST', `${repo}/statuses/${item.sha}`, { state: p.state, context: p.context, description: p.description?.slice(0, 140), target_url: p.targetUrl }));
    case 'DISPATCH': {
      // This workflow's own file (owner/repo/.github/workflows/qualio.yml@refs/...), qualio.yml by default.
      const file = /\/([^/@]+\.ya?ml)@/.exec(process.env.GITHUB_WORKFLOW_REF ?? '')?.[1] ?? 'qualio.yml';
      return ok(await github('POST', `${repo}/actions/workflows/${file}/dispatches`, { ref: p.ref }));
    }
    case 'LABEL': {
      if (p.add?.length) {
        const failed = ok(await github('POST', `${repo}/issues/${item.prNumber}/labels`, { labels: p.add }));
        if (failed) return failed;
      }
      for (const name of p.remove ?? []) {
        const r = await github('DELETE', `${repo}/issues/${item.prNumber}/labels/${encodeURIComponent(name)}`);
        if (r.status !== 404 && ok(r)) return r;
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
    const { failed, commentId } = await deliver(item);
    // Missing token permissions, rate limits and GitHub outages are retried by the next job.
    if (failed && (failed.status === 0 || failed.status === 403 || failed.status === 429 || failed.status >= 500)) {
      denied ||= failed.status === 403;
      console.log(`Not sent yet (${item.kind}, GitHub ${failed.status || 'unreachable'}): ${failed.message}`);
      continue;
    }
    await call(`/v1/pr/outbox/${item.id}/ack`, { error: failed ? `GitHub ${failed.status}: ${failed.message}` : null, ...(commentId && { commentId }) });
    if (!failed) sent += 1;
    else console.log(`GitHub refused an update (${item.kind}, ${failed.status}): ${failed.message}`);
  }
  return { sent, denied };
}

/**
 * Sends what Qualio couldn't send to GitHub itself (no GitHub App, or one without the permission)
 * with this job's GITHUB_TOKEN. With `waitMinutes`, keeps polling while Qualio says an agent is still
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
    const { status, body } = await call('/v1/pr/outbox', { report: true });
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
    console.log("::warning title=Qualio::This job's GITHUB_TOKEN may not write comments, statuses or dispatch workflows. Add to the workflow: permissions: { contents: read, pull-requests: write, issues: write, statuses: write, actions: write }.");
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
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

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
 * this pull request's branch (stricter changes now, looser ones when it merges). The overview documents
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

/** This job failed before the reporter sent results: the run shows as errored in Qualio right away. */
async function errored(conclusion) {
  const { GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_RUN_ID || !GITHUB_REPOSITORY) return;
  const { status, body } = await call('/v1/runs/errored', {
    ghRunId: GITHUB_RUN_ID,
    runAttempt: Number(GITHUB_RUN_ATTEMPT || 1),
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
    headSha: process.env.QUALIO_COMMIT_SHA || process.env.GITHUB_SHA,
    conclusion: conclusion || 'failure',
    url: `${GITHUB_SERVER_URL || 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
  });
  if (status !== 200) console.log(`::warning title=Qualio::Could not tell Qualio this job failed (${status}): ${body.error ?? 'unknown error'}`);
}

const [command, ...args] = process.argv.slice(2);
const commands = { setup, download, promote, wait, sync, config, outbox, errored, comment };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use setup, download, promote, wait, sync, config, outbox, errored or comment.`);
  process.exit(2);
}
commands[command](...args).catch((error) => {
  console.log(`::error title=Qualio::${error.message}`);
  process.exit(1);
});
