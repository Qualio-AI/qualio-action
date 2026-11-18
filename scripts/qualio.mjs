#!/usr/bin/env node
// The Qualio Basher action (qualio-v2 specs/tickets-pull-requests-and-tests.md → The GitHub Action). One command
// runs the whole job: tell Qualio about the pull request, lend Qualio's agents this job's browsers, run the tests
// when Qualio asks, post Qualio's report with the job's GITHUB_TOKEN, and pass or fail the job as Qualio says.
//
// Shards (qualio-v2 specs/regression-exploratory-and-bug-bash.md → Tests run in the job): with `shard: i/n` from the
// workflow's matrix, every job of one workflow run joins the same Qualio run. Shard 1 starts it and leads (it tells
// Qualio about the pull request, hosts the agents' browsers and posts the report); every shard runs the tests
// Qualio gives it.

import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { deliver } from './github.mjs';
import { readTests, testsDir } from './inventory.mjs';

const env = process.env;
const apiUrl = (env.QUALIO_API_URL ?? '').replace(/\/+$/, '');
const apiKey = env.QUALIO_API_KEY ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POSTs raw bytes to Qualio (a failure's video or screenshot), retrying server and network errors. */
export async function upload(route, bytes, contentType) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${apiUrl}${route}`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': contentType }, body: bytes, signal: AbortSignal.timeout(120_000) });
      if (res.status < 500 || attempt >= 3) return res.status;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
    await sleep(attempt * 2000);
  }
}

/** This job's shard of the workflow's matrix: `i/n` (default 1/1). */
export function parseShard(text) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text || '1/1');
  const index = m ? Number(m[1]) : 1;
  const total = m ? Number(m[2]) : 1;
  if (!m || index < 1 || total < 1 || index > total || total > 8) throw new Error(`shard is i/n, such as 2/4 (at most 8 jobs): got "${text}".`);
  return { index, total };
}

/** POSTs JSON to Qualio, retrying server and network errors: { status, body }. */
export async function call(route, body = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${apiUrl}${route}`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      if (res.status < 500 || attempt >= 3) return { status: res.status, body: json ?? { error: text.slice(0, 300) } };
    } catch (error) {
      if (attempt >= 3) throw new Error(`Qualio could not be reached at ${apiUrl}: ${error.message}`);
    }
    await sleep(attempt * 2000);
  }
}

async function githubEvent() {
  if (!env.GITHUB_EVENT_PATH) return {};
  try {
    return JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function summary(lines) {
  const text = `${lines.join('\n')}\n`;
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
}

/** The pull request this job is about, told to Qualio (title, description, branch, state). */
async function sync(event) {
  const pr = event.pull_request;
  if (!pr) return null;
  const { status, body } = await call('/v1/pr/sync', {
    number: pr.number,
    title: pr.title ?? '',
    body: pr.body ?? '',
    branch: pr.head?.ref ?? '',
    baseBranch: pr.base?.ref ?? '',
    headSha: pr.head?.sha ?? '',
    url: pr.html_url ?? null,
    authorLogin: pr.user?.login ?? null,
    state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    mergeCommitSha: pr.merged ? (pr.merge_commit_sha ?? null) : null,
  });
  if (status !== 200) console.log(`::warning title=Qualio::Qualio could not record pull request #${pr.number} (${status}): ${body.error ?? 'unknown error'}`);
  else if (body.features?.length) console.log(`Pull request #${pr.number} implements ${body.features.join(', ')}.`);
  return pr;
}

/** Exports each test user's password placeholder variable from the job's secrets (masked; never sent to Qualio). */
export function exportAccounts(accounts, target = env) {
  const missing = [];
  for (const a of accounts ?? []) {
    const value = target[a.variable] || target[a.secret] || '';
    if (!value) missing.push(a.secret);
    else {
      target[a.variable] = value;
      console.log(`::add-mask::${value}`);
    }
  }
  if (missing.length) console.log(`::warning title=Qualio::These test users' secrets are empty, so Qualio can't sign in as them: ${missing.join(', ')}. Add them in Settings → Secrets and variables → Actions and in the workflow's env.`);
  return missing;
}

/** Sends what Qualio queued for this pull request (its report, statuses) with the job's token. Never fails the job. */
async function outbox(prNumber) {
  if (!prNumber || !env.GITHUB_TOKEN) return;
  const { status, body } = await call('/v1/pr/outbox', { pr: prNumber });
  if (status !== 200) return;
  for (const item of body.items ?? []) {
    const result = await deliver({ ...item, prNumber }, env);
    if (result.failed && (result.failed.status === 0 || result.failed.status === 403 || result.failed.status === 429 || result.failed.status >= 500)) {
      console.log(`Not sent yet (${item.kind}, GitHub ${result.failed.status || 'unreachable'}): ${result.failed.message}`);
      continue;
    }
    await call(`/v1/pr/outbox/${item.id}/ack`, { commentId: result.commentId ?? null, error: result.failed ? `GitHub ${result.failed.status}: ${result.failed.message}` : null });
  }
}

/** Runs what Qualio asks of the job itself (the tests: phase 15's tests.mjs), when it is there. */
async function jobWork(jobId, status) {
  if (!status.ask) return;
  const work = await import('./tests.mjs').catch(() => null);
  if (!work) return void (await call(`/v1/runs/${jobId}/results`, { skipped: 'This action version can’t run tests yet.' }));
  await work.handle(status.ask, { jobId, call, upload, env });
}

/** Hosted mode: Qualio runs on its own browsers; this job only asks, waits and posts the report. */
export async function hosted() {
  if (!apiKey || !apiUrl) throw new Error('Set api-key (the QUALIO_API_KEY secret) and api-url.');
  const event = await githubEvent();
  const pr = event.pull_request ?? null;
  const started = await call('/v1/runs/hosted', {
    event: pr ? 'pull_request' : env.GITHUB_EVENT_NAME === 'push' ? 'push' : 'manual',
    branch: pr?.head?.ref ?? (env.GITHUB_REF_NAME || ''),
    sha: pr?.head?.sha ?? (env.GITHUB_SHA || ''),
    url: env.QUALIO_HOSTED_URL || null,
    pr: pr ? { number: pr.number, title: pr.title ?? '', body: pr.body ?? '', branch: pr.head?.ref ?? '', baseBranch: pr.base?.ref ?? '', headSha: pr.head?.sha ?? '', url: pr.html_url ?? null, authorLogin: pr.user?.login ?? null, state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open', mergeCommitSha: pr.merged ? (pr.merge_commit_sha ?? null) : null } : null,
  });
  if (started.status !== 200) throw new Error(`Qualio refused the run (${started.status}): ${started.body.error ?? 'unknown error'}`);
  let status = { state: started.body.state ?? 'STARTED' };
  const deadline = Date.now() + Number(env.QUALIO_JOB_MINUTES || 60) * 60_000;
  let said = '';
  while (started.body.jobId && Date.now() < deadline) {
    const r = await call(`/v1/runs/hosted/${started.body.jobId}/status`);
    if (r.status === 200) status = r.body;
    if (status.message && status.message !== said) console.log((said = status.message));
    if (status.state === 'DONE' || status.state === 'ERRORED') break;
    await sleep(Number(env.QUALIO_POLL_MS || 10_000));
  }
  await outbox(pr?.number);
  await summary(['## Qualio', status.summary ?? status.message ?? 'Qualio’s run ended.', ...(status.url ? [`[Open it in Qualio](${status.url})`] : [])]);
  return status.result === 'failed' ? 1 : 0;
}

/** Starts (or, for a shard after the first, joins) this workflow run's Qualio run. */
async function start(event, pr, shard) {
  const startBody = {
    event: pr ? 'pull_request' : env.GITHUB_EVENT_NAME === 'push' ? 'push' : 'manual',
    branch: pr?.head?.ref ?? (env.GITHUB_REF_NAME || ''),
    sha: pr?.head?.sha ?? (env.GITHUB_SHA || ''),
    baseUrl: env.QUALIO_BASE_URL || 'http://localhost:3000',
    pr: pr?.number ?? null,
    runsTests: true,
    ...(env.GITHUB_RUN_ID ? { runKey: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || 1}` } : {}),
    shard,
  };
  if (shard.index > 1 && startBody.runKey) {
    // Shard 1 starts the run; this one joins it. Only when shard 1 never comes (a re-run of the failed jobs only)
    // does it start the run itself.
    const until = Date.now() + Number(env.QUALIO_JOIN_WAIT_MS || 5 * 60_000);
    while (Date.now() < until) {
      const joined = await call('/v1/runs/start', { ...startBody, join: true });
      if (joined.status !== 200) return joined;
      if (!joined.body.waiting) return joined;
      await sleep(Number(env.QUALIO_POLL_MS || 5000));
    }
    await sync(event);
  }
  return call('/v1/runs/start', startBody);
}

export async function main() {
  if (!apiKey || !apiUrl) throw new Error('Set api-key (the QUALIO_API_KEY secret) and api-url.');
  const shard = parseShard(env.QUALIO_SHARD);
  const event = await githubEvent();
  const first = shard.index === 1;
  const pr = first ? await sync(event) : (event.pull_request ?? null);
  if (pr && (pr.state === 'closed' || pr.merged)) {
    // Merged or closed: Qualio reconciles the tests; nothing runs (shard 1 says so).
    if (first) await outbox(pr.number);
    return 0;
  }
  const started = await start(event, pr, shard);
  if (started.status !== 200) throw new Error(`Qualio refused the run (${started.status}): ${started.body.error ?? 'unknown error'}`);
  const { jobId, token, relayUrl, accounts } = started.body;
  // A Qualio from before shards answers no `lead`: this job leads.
  const lead = started.body.lead !== false;
  exportAccounts(accounts);
  if (shard.total > 1) console.log(`Job ${shard.index} of ${shard.total}${lead ? ': it leads the run' : ''}.`);
  // Your own tests: their titles tell Qualio which spec cases are covered already.
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const dir = lead ? await testsDir(root, env.QUALIO_TESTS_DIR) : null;
  if (dir) {
    const files = await readTests(root, dir);
    const sent = await call('/v1/tests/inventory', { branch: pr?.head?.ref ?? (env.GITHUB_REF_NAME || ''), files });
    if (sent.status === 200) console.log(`Qualio read your ${sent.body.tests ?? 0} tests in ${files.length} files.`);
  }
  // The leader hosts the agents' browsers (loaded here: the hosted action runs without the host's dependencies).
  let host = null;
  if (lead && token) {
    const { runHost } = await import('./host.mjs');
    const { chromium } = await import('@playwright/test');
    host = runHost({ relay: relayUrl, token, launchServer: (options) => chromium.launchServer(options) });
  }
  const deadline = Date.now() + Number(env.QUALIO_JOB_MINUTES || 60) * 60_000;
  let status = { state: 'STARTED' };
  let said = '';
  try {
    while (Date.now() < deadline) {
      const r = await call(`/v1/runs/${jobId}/status`, { shard: shard.index });
      if (r.status === 200) status = r.body;
      if (status.message && status.message !== said) console.log((said = status.message));
      if (status.state === 'DONE' || status.state === 'ERRORED') break;
      // While it runs tests, the shard keeps saying it is alive, so its work isn't moved to another.
      const beat = setInterval(() => void call(`/v1/runs/${jobId}/status`, { shard: shard.index }).catch(() => undefined), Number(env.QUALIO_HEARTBEAT_MS || 30_000));
      try {
        await jobWork(jobId, status);
      } finally {
        clearInterval(beat);
      }
      await sleep(Number(env.QUALIO_POLL_MS || 5000));
    }
  } catch (error) {
    // A shard that doesn't lead tells Qualio, so its tests move to the others.
    if (!lead) await call(`/v1/runs/${jobId}/errored`, { error: error.message.slice(0, 900), shard: shard.index }).catch(() => undefined);
    throw error;
  } finally {
    await host?.stop();
  }
  if (lead) await outbox(pr?.number);
  await summary([`## Qualio`, status.summary ?? status.message ?? 'Qualio’s run ended.', ...(status.url ? [`[Open it in Qualio](${status.url})`] : [])]);
  if (status.state !== 'DONE') {
    console.log(`::warning title=Qualio::${status.error ?? 'Qualio didn’t finish in time.'}`);
    return 0;
  }
  return status.result === 'failed' ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  (process.argv[2] === 'hosted' ? hosted() : main())
    .then((code) => process.exit(code))
    .catch(async (error) => {
      console.log(`::error title=Qualio::${error.message}`);
      process.exit(1);
    });
