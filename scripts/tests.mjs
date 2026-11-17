// What Qualio asks the job itself to do (qualio-v2 specs/tickets-pull-requests-and-tests.md → Runs and regression):
// run the team's own Playwright tests, as they always run, and post their JSON report. Qualio's own tests run at
// Qualio, through this job's browsers.

import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testsDir } from './inventory.mjs';

const handled = new Set();
const MAX_REPORT_BYTES = 8_000_000;

/** The command with Playwright's JSON reporter added (the team's own reporters stay when they configure them). */
export function withJsonReporter(command) {
  return /playwright\s+test/.test(command) && !/--reporter/.test(command) ? `${command} --reporter=list,json` : command;
}

/** Drops what Qualio doesn't need (attachment bodies, stdout) so the report fits. */
export function slimReport(report) {
  const suites = (list) =>
    (list ?? []).map((s) => ({
      ...s,
      suites: suites(s.suites),
      specs: (s.specs ?? []).map((spec) => ({ ...spec, tests: (spec.tests ?? []).map((t) => ({ ...t, results: (t.results ?? []).map((r) => ({ status: r.status, duration: r.duration, error: r.error, errors: r.errors, steps: (r.steps ?? []).map((x) => ({ title: x.title, error: x.error ? true : undefined })), attachments: (r.attachments ?? []).filter((a) => a.name === 'qualio-signals') })) })) })),
    }));
  return { suites: suites(report.suites) };
}

export async function handle(ask, { jobId, call, env = process.env }) {
  if (ask?.kind !== 'customer-tests' || handled.has(ask.runId)) return;
  handled.add(ask.runId);
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const command = (env.QUALIO_TESTS_COMMAND ?? '').trim();
  if (!command || !(await testsDir(root, env.QUALIO_TESTS_DIR))) return void (await call(`/v1/runs/${jobId}/results`, { runId: ask.runId, skipped: 'This repository has no Playwright tests of its own to run.' }));
  const output = path.join(tmpdir(), `qualio-customer-${Date.now()}.json`);
  console.log(`Running your own tests: ${command}`);
  const code = await new Promise((resolve) => {
    const child = spawn('bash', ['-lc', withJsonReporter(command)], { cwd: root, env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: output, CI: 'true' }, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('close', resolve);
    child.on('error', () => resolve(1));
  });
  const text = await readFile(output, 'utf8').catch(() => null);
  await rm(output, { force: true });
  if (!text) return void (await call(`/v1/runs/${jobId}/results`, { runId: ask.runId, skipped: `Your own tests didn’t produce a report (exit ${code}).` }));
  let report = slimReport(JSON.parse(text));
  if (JSON.stringify(report).length > MAX_REPORT_BYTES) report = { suites: [] };
  await call(`/v1/runs/${jobId}/results`, { runId: ask.runId, report });
}
