#!/usr/bin/env node
// The Qualio Basher action (qualio-v2 specs/tickets-pull-requests-and-tests.md → The GitHub Action). One command
// runs the whole job: tell Qualio about the pull request, lend Qualio's agents this job's browsers, run the tests
// when Qualio asks, post Qualio's report with the job's GITHUB_TOKEN, and pass or fail the job as Qualio says.

import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { deliver } from './github.mjs';
import { runHost } from './host.mjs';
import { readTests, testsDir } from './inventory.mjs';

const env = process.env;
const apiUrl = (env.QUALIO_API_URL ?? '').replace(/\/+$/, '');
const apiKey = env.QUALIO_API_KEY ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await work.handle(status.ask, { jobId, call, env });
}

export async function main() {
  if (!apiKey || !apiUrl) throw new Error('Set api-key (the QUALIO_API_KEY secret) and api-url.');
  const event = await githubEvent();
  const pr = await sync(event);
  if (pr && (pr.state === 'closed' || pr.merged)) {
    // Merged or closed: Qualio reconciles the tests; nothing runs.
    await outbox(pr.number);
    return 0;
  }
  const started = await call('/v1/runs/start', {
    event: pr ? 'pull_request' : env.GITHUB_EVENT_NAME === 'push' ? 'push' : 'manual',
    branch: pr?.head?.ref ?? (env.GITHUB_REF_NAME || ''),
    sha: pr?.head?.sha ?? (env.GITHUB_SHA || ''),
    baseUrl: env.QUALIO_BASE_URL || 'http://localhost:3000',
    pr: pr?.number ?? null,
    bashMinutes: Number(env.QUALIO_BASH_MINUTES || 10),
  });
  if (started.status !== 200) throw new Error(`Qualio refused the run (${started.status}): ${started.body.error ?? 'unknown error'}`);
  const { jobId, token, relayUrl, accounts } = started.body;
  exportAccounts(accounts);
  // Your own tests: their titles tell Qualio which spec cases are covered already.
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const dir = await testsDir(root, env.QUALIO_TESTS_DIR);
  if (dir) {
    const files = await readTests(root, dir);
    const sent = await call('/v1/tests/inventory', { branch: pr?.head?.ref ?? (env.GITHUB_REF_NAME || ''), files });
    if (sent.status === 200) console.log(`Qualio read your ${sent.body.tests ?? 0} tests in ${files.length} files.`);
  }
  const { chromium } = await import('@playwright/test');
  const host = runHost({ relay: relayUrl, token, launchServer: (options) => chromium.launchServer(options) });
  const deadline = Date.now() + Number(env.QUALIO_JOB_MINUTES || 60) * 60_000;
  let status = { state: 'STARTED' };
  let said = '';
  try {
    while (Date.now() < deadline) {
      const r = await call(`/v1/runs/${jobId}/status`);
      if (r.status === 200) status = r.body;
      if (status.message && status.message !== said) console.log((said = status.message));
      if (status.state === 'DONE' || status.state === 'ERRORED') break;
      await jobWork(jobId, status);
      await sleep(Number(env.QUALIO_POLL_MS || 5000));
    }
  } finally {
    await host.stop();
  }
  await outbox(pr?.number);
  await summary([`## Qualio`, status.summary ?? status.message ?? 'Qualio’s run ended.', ...(status.url ? [`[Open it in Qualio](${status.url})`] : [])]);
  if (status.state !== 'DONE') {
    console.log(`::warning title=Qualio::${status.error ?? 'Qualio didn’t finish in time.'}`);
    return 0;
  }
  return status.result === 'failed' ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main()
    .then((code) => process.exit(code))
    .catch(async (error) => {
      console.log(`::error title=Qualio::${error.message}`);
      process.exit(1);
    });
