// Qualio AI reporter for Playwright. The Qualio action adds it to the run (QUALIO_REPORTER); older
// tests folders had a copy of it in support/qualio-reporter.ts.
//
// When QUALIO_API_URL and QUALIO_API_KEY are set (e.g. in GitHub Actions), it registers the run with
// Qualio, uploads artifacts (every test's video and screenshots; for failures also the trace, ARIA
// snapshot and server errors) and reports every test's result, steps and output. Without them it does nothing, so local runs are unaffected. It never fails your
// test run: reporting problems are printed as warnings.
//
// When QUALIO_REPORT_FILE is set (Qualio's hosted runner), it makes no network calls and writes the
// same report, with the artifact file paths, to that file instead.
//
// The Qualio action writes a run manifest (QUALIO_RUN_MANIFEST: the changes Qualio offers that it applied
// on top of the checked-out tests; tests Qualio still held carried it as .qualio-bundle.json), which is
// sent with the run. When QUALIO_RUN_FILE is set (by the action), the run id, status and heal
// request result are written there, so the action can wait for the heal and re-run.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

type Kind = 'VIDEO' | 'SCREENSHOT' | 'TRACE' | 'ARIA' | 'LOG';
type Upload = { name: string; kind: Kind; contentType: string; testId: string; filePath?: string; body?: Buffer };
type ReportedResult = {
  testId: string;
  title: string;
  file: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'TIMED_OUT' | 'FLAKY';
  error: string | null;
  durationMs: number;
  retry: number;
  /** What the test did (test.step, actions, assertions, hooks), in order; depth is the nesting level. */
  steps: ReportedStep[];
  /** The test's own stdout and stderr. */
  log: string | null;
};
type ReportedStep = { title: string; category: string; durationMs: number; depth: number; error: string | null };

const STEP_CATEGORIES = new Set(['test.step', 'pw:api', 'expect', 'hook']);
const MAX_STEPS = 300;
const MAX_STEP_TITLE = 300;
const MAX_TEST_LOG = 50_000;

const BUNDLE_MANIFEST = '.qualio-bundle.json';
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// Artifacts registered per request (Qualio accepts at most 100): a run with many failing tests, each
// retried in CI, easily attaches more.
const ARTIFACT_BATCH = 50;
const MAX_LOG_CHARS = 1_000_000;
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

const STATUS: Record<TestResult['status'], ReportedResult['status']> = {
  passed: 'PASSED',
  failed: 'FAILED',
  timedOut: 'TIMED_OUT',
  skipped: 'SKIPPED',
  interrupted: 'FAILED',
};

function artifactKind(attachment: TestResult['attachments'][number]): Kind | null {
  if (attachment.name === 'video') return 'VIDEO';
  if (attachment.name === 'trace') return 'TRACE';
  if (attachment.name === 'error-context') return 'ARIA';
  if (attachment.name === 'qualio-signals') return 'LOG';
  if (attachment.contentType.startsWith('image/')) return 'SCREENSHOT';
  return null;
}

/** A test's steps in order, nested steps one level deeper; fixtures are skipped but their actions kept. */
export function flattenSteps(steps: TestStep[], depth = 0, out: ReportedStep[] = []): ReportedStep[] {
  for (const step of steps) {
    if (out.length >= MAX_STEPS) break;
    const kept = STEP_CATEGORIES.has(step.category);
    if (kept) {
      const error = step.error ? stripAnsi(step.error.message ?? step.error.value ?? '').split('\n')[0]!.slice(0, 500) || 'Failed' : null;
      out.push({ title: step.title.slice(0, MAX_STEP_TITLE), category: step.category, durationMs: Math.max(0, Math.round(step.duration)), depth, error });
    }
    flattenSteps(step.steps, kept ? depth + 1 : depth, out);
  }
  return out;
}

/** The run manifest (the action's, else a .qualio-bundle.json in the tests folder), or null without one. */
export async function readBundle(rootDir: string, manifestFile = process.env.QUALIO_RUN_MANIFEST): Promise<{ id: string; revisionIds: string[]; lacking?: number[] } | null> {
  try {
    const manifest = JSON.parse(await fs.readFile(manifestFile || path.join(rootDir, BUNDLE_MANIFEST), 'utf8')) as { bundleId?: unknown; revisionIds?: unknown; lacking?: unknown };
    if (typeof manifest.bundleId !== 'string' || !Array.isArray(manifest.revisionIds)) return null;
    // Merged pull requests the tested commit lacked: the bundle has the main tests from before them.
    const lacking = Array.isArray(manifest.lacking) ? manifest.lacking.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
    return { id: manifest.bundleId, revisionIds: manifest.revisionIds.filter((id): id is string => typeof id === 'string'), ...(lacking.length && { lacking }) };
  } catch {
    return null;
  }
}

/** Run identity from the GitHub Actions environment (with fallbacks for local runs). */
export function ciContext(env: NodeJS.ProcessEnv = process.env) {
  const pr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '');
  return {
    ghRunId: env.GITHUB_RUN_ID ?? String(Date.now()),
    ghRunAttempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1),
    // 2 when the Qualio action re-runs the tests in the same job after a heal.
    round: Number(env.QUALIO_RUN_ROUND) || 1,
    commitSha: env.QUALIO_COMMIT_SHA || env.GITHUB_SHA || 'local',
    branch: env.QUALIO_BRANCH || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || 'local',
    baseBranch: env.GITHUB_BASE_REF || null,
    prNumber: pr ? Number(pr[1]) : null,
    workflowUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
    shard: shardContext(env),
  };
}

/**
 * This job's shard when the Qualio action runs the tests across several jobs (QUALIO_SHARD_INDEX of
 * QUALIO_SHARD_TOTAL, from the shard plan QUALIO_SHARD_PLAN): the jobs report into one run.
 */
export function shardContext(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const index = Number(env.QUALIO_SHARD_INDEX);
  const total = Number(env.QUALIO_SHARD_TOTAL);
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 2 || index < 1 || index > total) return null;
  // The job's setup time (checkout, install, the app) until the tests start: the planner weighs it.
  const startedAt = Number(env.QUALIO_JOB_STARTED_AT) * 1000;
  const setupMs = startedAt > 0 && now >= startedAt ? Math.round(now - startedAt) : null;
  return { index, total, planId: env.QUALIO_SHARD_PLAN || null, setupMs };
}

export default class QualioReporter implements Reporter {
  private readonly apiUrl = (process.env.QUALIO_API_URL ?? '').replace(/\/+$/, '');
  private readonly apiKey = process.env.QUALIO_API_KEY ?? '';
  private readonly reportFile = process.env.QUALIO_REPORT_FILE ?? '';
  private readonly runFile = process.env.QUALIO_RUN_FILE ?? '';
  private rootDir = process.cwd();
  private runId: Promise<string | null> | null = null;
  private shard: number | null = null;
  private readonly results = new Map<string, ReportedResult>();
  private readonly uploads: Upload[] = [];
  private log = '';

  printsToStdio() {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite) {
    // Paths relative to the tests folder (where playwright.config.ts lives), matching the repository layout.
    this.rootDir = config.configFile ? path.dirname(config.configFile) : config.rootDir;
    if (this.reportFile) {
      this.append(`Running ${suite.allTests().length} tests with ${config.workers} worker(s)`);
      return;
    }
    if (!this.apiUrl || !this.apiKey) {
      console.log('[qualio] QUALIO_API_URL / QUALIO_API_KEY not set: results are not reported to Qualio.');
      return;
    }
    this.append(`Running ${suite.allTests().length} tests with ${config.workers} worker(s)`);
    const context = ciContext();
    this.shard = context.shard?.index ?? null;
    const tests = suite.allTests();
    const shard = context.shard && { ...context.shard, tests: tests.length, files: new Set(tests.map((t) => t.location.file)).size };
    this.runId = readBundle(this.rootDir)
      .then((bundle) => this.call<{ runId: string }>('POST', '/v1/runs', { ...context, shard, bundle }))
      .then((r) => r.runId)
      .catch((error) => {
        console.warn(`[qualio] Could not register the run: ${(error as Error).message}`);
        return null;
      });
  }

  onStdOut(chunk: string | Buffer, test?: TestCase) {
    this.append(`${test ? `[${test.title}] ` : ''}${chunk.toString().trimEnd()}`);
  }

  onStdErr(chunk: string | Buffer, test?: TestCase) {
    this.append(`${test ? `[${test.title}] ` : ''}${chunk.toString().trimEnd()}`);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.runId && !this.reportFile) return;
    const title = test.titlePath().slice(3).join(' › ') || test.title;
    const outcome = test.outcome();
    const status: ReportedResult['status'] = outcome === 'flaky' ? 'FLAKY' : STATUS[result.status];
    const error = result.errors.map((e) => stripAnsi(e.message ?? e.value ?? '')).filter(Boolean).join('\n\n') || null;
    this.results.set(test.id, {
      testId: test.id,
      title,
      file: path.relative(this.rootDir, test.location.file),
      status,
      error,
      durationMs: Math.round(result.duration),
      retry: result.retry,
      steps: flattenSteps(result.steps),
      log: [...result.stdout, ...result.stderr].map((chunk) => chunk.toString()).join('').slice(0, MAX_TEST_LOG) || null,
    });
    this.append(`${status === 'PASSED' ? '✓' : status === 'SKIPPED' ? '-' : '✘'} ${title} (${Math.round(result.duration)}ms)${result.retry ? ` [retry ${result.retry}]` : ''}`);
    if (error) this.append(error.split('\n').map((l) => `    ${l}`).join('\n'));

    for (const attachment of result.attachments) {
      const kind = artifactKind(attachment);
      if (!kind || (!attachment.path && !attachment.body)) continue;
      const name = attachment.path ? path.basename(attachment.path) : `${attachment.name}.${kind === 'ARIA' ? 'md' : kind === 'LOG' ? 'json' : 'bin'}`;
      this.uploads.push({
        name: result.retry ? `retry${result.retry}-${name}` : name,
        kind,
        contentType: kind === 'ARIA' ? 'text/markdown' : attachment.contentType,
        testId: test.id,
        filePath: attachment.path,
        body: attachment.body,
      });
    }
  }

  async onEnd(result: FullResult) {
    if (this.reportFile) return this.writeReport(result);
    const runId = await this.runId;
    if (!runId) return;
    try {
      // Artifacts are evidence, not the report: if they can't be stored, the results still go to Qualio.
      await this.uploadArtifacts(runId).catch((error) => console.warn(`[qualio] Could not upload artifacts: ${(error as Error).message}`));
      const response = await this.call<{ url: string; status: string; pendingShards?: number[] }>('POST', `/v1/runs/${runId}/results`, {
        status: result.status,
        durationMs: Math.round(result.duration),
        results: [...this.results.values()],
        log: this.log,
        ...(this.shard && { shard: this.shard }),
      });
      console.log(`[qualio] Results reported: ${response.url}`);
      let heal: string | null = null;
      if (response.status === 'RUNNING') {
        // A sharded run: Qualio records it (and heals it) once the other shards have reported.
        console.log(`[qualio] Waiting for shard${response.pendingShards?.length === 1 ? '' : 's'} ${(response.pendingShards ?? []).join(', ')} to report: the run is recorded once all have.`);
        // This shard's own tests failed: the action waits for the run's heal.
        if (result.status !== 'passed') heal = 'queued';
      } else if (response.status === 'FAILED') {
        // Hand the failures to Qualio's self-healing (it decides whether they're healable).
        heal = (await this.call<{ status: string }>('POST', '/v1/tests/heal', { runId })).status;
        if (heal === 'queued') console.log('[qualio] Self-healing requested: Qualio will diagnose the failures and fix the tests if they are healable.');
      }
      // A shard waiting for the others writes its own outcome, so the action knows whether to wait for the heal.
      const status = response.status === 'RUNNING' ? (result.status === 'passed' ? 'PASSED' : 'FAILED') : response.status;
      await this.writeRunFile({ runId, status, url: response.url, heal });
    } catch (error) {
      console.warn(`[qualio] Could not report results: ${(error as Error).message}`);
    }
  }

  private async writeRunFile(run: { runId: string; status: string; url: string; heal: string | null }) {
    if (!this.runFile) return;
    await fs.writeFile(this.runFile, `${JSON.stringify(run)}\n`).catch((error) => console.warn(`[qualio] Could not write the run file: ${(error as Error).message}`));
  }

  private async writeReport(result: FullResult) {
    try {
      const dir = path.dirname(this.reportFile);
      await fs.mkdir(dir, { recursive: true });
      const uploads = await Promise.all(
        this.uploads.map(async ({ name, kind, contentType, testId, filePath, body }, i) => {
          // In-memory attachments are written next to the report so the host can collect them.
          const file = filePath ?? path.join(dir, `attachment-${i}-${name}`);
          if (!filePath) await fs.writeFile(file, body!);
          return { name, kind, contentType, testId, path: file };
        }),
      );
      const report = {
        status: result.status,
        durationMs: Math.round(result.duration),
        results: [...this.results.values()],
        log: this.log,
        uploads,
      };
      await fs.writeFile(this.reportFile, JSON.stringify(report));
    } catch (error) {
      console.warn(`[qualio] Could not write the report file: ${(error as Error).message}`);
    }
  }

  private append(line: string) {
    if (this.log.length < MAX_LOG_CHARS) this.log += `${line}\n`;
  }

  private async uploadArtifacts(runId: string) {
    const files: (Upload & { size: number })[] = [];
    for (const upload of this.uploads) {
      const size = upload.body?.length ?? (await fs.stat(upload.filePath!).then((s) => s.size).catch(() => -1));
      if (size >= 0 && size <= MAX_UPLOAD_BYTES) files.push({ ...upload, size });
    }
    for (let start = 0; start < files.length; start += ARTIFACT_BATCH) {
      const batch = files.slice(start, start + ARTIFACT_BATCH);
      const { uploads } = await this.call<{ uploads: { url: string }[] }>('POST', `/v1/runs/${runId}/artifacts`, {
        files: batch.map(({ name, kind, contentType, size, testId }) => ({ name, kind, contentType, size, testId })),
      });
      // Upload a few at a time; a failed upload loses that artifact, not the report.
      for (let i = 0; i < batch.length; i += 4) {
        await Promise.all(
          batch.slice(i, i + 4).map(async (file, j) => {
            const body = file.body ?? (await fs.readFile(file.filePath!));
            const res = await fetch(uploads[i + j]!.url, { method: 'PUT', body: new Uint8Array(body), headers: { 'content-type': file.contentType } });
            if (!res.ok) console.warn(`[qualio] Upload of ${file.name} failed (${res.status})`);
          }),
        );
      }
    }
  }

  private async call<T>(method: string, route: string, body: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${this.apiUrl}${route}`, {
          method,
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) return (await res.json()) as T;
        // Client errors (bad key, invalid payload) won't succeed on retry.
        if (res.status < 500 || attempt >= 3) throw new Error(`${method} ${route} → ${res.status} ${await res.text()}`);
      } catch (error) {
        if (attempt >= 3 || (error as Error).message.includes('→ 4')) throw error;
      }
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
}
