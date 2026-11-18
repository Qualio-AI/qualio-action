// What Qualio asks the job itself to do (qualio-v2 specs/tickets-pull-requests-and-tests.md → Runs and regression,
// specs/regression-exploratory-and-bug-bash.md → Tests run in the job): run Qualio's tests (qualio-tests.mjs), and
// run the team's own Playwright tests as they always run (this shard's part of them) and post their JSON report.

import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testsDir } from './inventory.mjs';
import { runQualioTask, slimReport } from './qualio-tests.mjs';

export { slimReport };

const handled = new Set();
const MAX_REPORT_BYTES = 8_000_000;

/** The command with Playwright's JSON reporter added (the team's own reporters stay when they configure them). */
export function withJsonReporter(command) {
  return /playwright\s+test/.test(command) && !/--reporter/.test(command) ? `${command} --reporter=list,json` : command;
}

/** The command for this shard's part of the team's tests: Playwright's --shard when it is Playwright, else only shard 1 runs them. */
export function shardCommand(command, shard) {
  if (!shard || shard.total <= 1) return command;
  if (/playwright\s+test/.test(command) && !/--shard/.test(command)) return `${command} --shard=${shard.current}/${shard.total}`;
  return shard.current === 1 ? command : null;
}

/** Does one thing Qualio asks (each once): a task of Qualio's tests, or this shard's part of the team's own. */
export async function handle(ask, { jobId, call, upload, env = process.env }) {
  const id = ask?.taskId ?? ask?.runId;
  if (!id || handled.has(id)) return;
  if (ask.kind === 'qualio-tests') {
    handled.add(id);
    return runQualioTask(ask, { jobId, call, upload, env });
  }
  if (ask.kind !== 'customer-tests') return;
  handled.add(id);
  // Answers name the task (phase 21) or, from an older Qualio, the run.
  const answer = ask.taskId ? { taskId: ask.taskId } : { runId: ask.runId };
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const base = (env.QUALIO_TESTS_COMMAND ?? '').trim();
  if (!base || !(await testsDir(root, env.QUALIO_TESTS_DIR))) return void (await call(`/v1/runs/${jobId}/results`, { ...answer, skipped: ask.shard?.current > 1 ? undefined : 'This repository has no Playwright tests of its own to run.' }));
  const command = shardCommand(base, ask.shard);
  if (!command) return void (await call(`/v1/runs/${jobId}/results`, { ...answer, report: { suites: [] } }));
  const output = path.join(tmpdir(), `qualio-customer-${Date.now()}.json`);
  console.log(`Running your own tests: ${command}`);
  const code = await new Promise((resolve) => {
    const child = spawn('bash', ['-lc', withJsonReporter(command)], { cwd: root, env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: output, CI: 'true' }, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('close', resolve);
    child.on('error', () => resolve(1));
  });
  const text = await readFile(output, 'utf8').catch(() => null);
  await rm(output, { force: true });
  if (!text) return void (await call(`/v1/runs/${jobId}/results`, { ...answer, skipped: `Your own tests didn’t produce a report (exit ${code}).` }));
  let report = slimReport(JSON.parse(text));
  if (JSON.stringify(report).length > MAX_REPORT_BYTES) report = { suites: [] };
  await call(`/v1/runs/${jobId}/results`, { ...answer, report });
}
