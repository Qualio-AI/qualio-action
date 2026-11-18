// Qualio's tests, run in this job (qualio-v2 specs/regression-exploratory-and-bug-bash.md → Tests run in the job).
// For each task Qualio gives this shard, the job downloads the tests Qualio keeps for the branch into a temporary
// folder (never the checkout), runs the spec files it was given with this action's Playwright and the job's own
// browser, next to the app, posts the report, uploads the failures' videos and screenshots, and deletes the folder.
// Passwords are the job's own secrets (E2E_<NAME>_PASSWORD); Qualio sends only the usernames.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const actionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_REPORT_BYTES = 8_000_000;
/** What the tests never see of the job's environment: Qualio's key and the job's GitHub token. */
const HIDDEN = new Set(['QUALIO_API_KEY', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']);

/** Drops what Qualio doesn't need (attachment bodies, stdout) so the report fits; keeps where the evidence is and each step's time. */
export function slimReport(report) {
  // Qualio's signals keep their body; a video or screenshot only where it is on this runner.
  const attachment = ({ path: where, body, ...rest }) => (rest.name === 'qualio-signals' ? { ...rest, body } : { ...rest, path: where });
  const suites = (list) =>
    (list ?? []).map((s) => ({
      ...s,
      suites: suites(s.suites),
      specs: (s.specs ?? []).map((spec) => ({ ...spec, tests: (spec.tests ?? []).map((t) => ({ ...t, results: (t.results ?? []).map((r) => ({ status: r.status, duration: r.duration, error: r.error, errors: r.errors, steps: (r.steps ?? []).map((x) => ({ title: x.title, duration: x.duration, error: x.error ? true : undefined })), attachments: (r.attachments ?? []).filter((a) => ['qualio-signals', 'video', 'screenshot'].includes(a.name)).map(attachment) })) })) })),
    }));
  return { suites: suites(report.suites) };
}

/** Writes the files into `root`, refusing any path that would leave it. */
export async function writeFiles(root, files) {
  for (const file of files) {
    const full = path.resolve(root, file.path);
    if (!full.startsWith(root + path.sep)) throw new Error(`Qualio sent an unsafe path: ${file.path}`);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.content);
  }
}

/** The environment the tests run with: the job's own (its E2E_* secrets), the usernames, never Qualio's key or the job's token. */
export function testEnv(base, extra) {
  return { ...Object.fromEntries(Object.entries(base).filter(([k]) => !HIDDEN.has(k))), ...extra };
}

/** Runs Playwright in `root` and returns { report, output }. */
async function playwright(root, args, env) {
  const cli = path.join(actionDir, 'node_modules', '@playwright', 'test', 'cli.js');
  let output = '';
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'test', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (d) => {
      process.stdout.write(d);
      output = (output + d).slice(-8000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', resolve);
    child.on('error', resolve);
  });
  const text = await readFile(env.QUALIO_RESULTS_FILE, 'utf8').catch(() => null);
  let report = null;
  try {
    report = text ? slimReport(JSON.parse(text)) : null;
  } catch {}
  if (report && JSON.stringify(report).length > MAX_REPORT_BYTES) report = null;
  return { report, output: output.replace(/\u001b\[[0-9;]*m/g, '').slice(-3000) };
}

/** One task of Qualio's tests for this shard. */
export async function runQualioTask(ask, { jobId, call, upload, env = process.env, log = console.log }) {
  const got = await call(`/v1/runs/${jobId}/tests`, { taskId: ask.taskId });
  if (got.status === 409 || got.status === 404) return;
  if (got.status !== 200) return void (await call(`/v1/runs/${jobId}/results`, { taskId: ask.taskId, skipped: `This job couldn’t download Qualio’s tests (${got.status}).` }));
  const { files, only, repeatEach, env: names } = got.body;
  const root = await realpath(await mkdtemp(path.join(env.RUNNER_TEMP || tmpdir(), 'qualio-tests-')));
  try {
    await writeFiles(root, files);
    await mkdir(path.join(root, 'node_modules', '@playwright'), { recursive: true });
    await symlink(path.join(actionDir, 'node_modules', '@playwright', 'test'), path.join(root, 'node_modules', '@playwright', 'test'), 'dir');
    log(`Running ${only.length} of Qualio’s test files${repeatEach > 1 ? `, each ${repeatEach} times` : ''}.`);
    const args = [...(repeatEach > 1 ? [`--repeat-each=${repeatEach}`] : []), ...only];
    const { report, output } = await playwright(root, args, testEnv(env, { ...names, CI: 'true', QUALIO_BASE_URL: env.QUALIO_BASE_URL || 'http://localhost:3000', QUALIO_RESULTS_FILE: path.join(root, 'results.json'), QUALIO_WORKERS: env.QUALIO_WORKERS || '' }));
    const sent = await call(`/v1/runs/${jobId}/results`, { taskId: ask.taskId, report: report ?? undefined, output: report ? undefined : output });
    if (sent.status !== 200) return void log(`::warning title=Qualio::Qualio didn’t take this job’s report (${sent.status}): ${sent.body.error ?? 'unknown error'}`);
    for (const u of sent.body.uploads ?? []) {
      const file = path.resolve(root, u.path);
      if (!file.startsWith(root + path.sep)) continue;
      const bytes = await readFile(file).catch(() => null);
      if (bytes?.length) await upload(`/v1/runs/${jobId}/evidence?result=${encodeURIComponent(u.resultId)}&kind=${u.kind}`, bytes, u.kind === 'video' ? 'video/webm' : 'image/png').catch(() => undefined);
    }
    if ((sent.body.uploads ?? []).length) await call(`/v1/runs/${jobId}/results`, { taskId: ask.taskId, done: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
