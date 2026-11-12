#!/usr/bin/env node
// The qualio CLI (@qualio-ai/cli): a feature's tests from a developer's terminal. Node 20, no dependencies.
//
//   qualio generate <KEY>                  the tests for a feature or ticket (SCH-42, F-7, a Jira issue)
//   qualio generate --describe "<what>"    the tests for something without a ticket (like the Workbench)
//   qualio run                             runs the tests folder here, reports to Qualio and heals failures
//   qualio status <KEY>                    where a feature stands
//   qualio login --key <qk_…>              saves the project API key (~/.config/qualio/credentials.json)
//   qualio whoami                          which Qualio project the key belongs to
//
// It reuses the Qualio action's code (../../scripts/qualio.mjs) in this process: the tests folder goes to
// Qualio as a snapshot (never the rest of the repository), Qualio's changes are written into the checkout
// uncommitted, and the tests run here against the app on this machine (qualio.yml's app.url, or
// --base-url). Its work uses the branch `local:<git branch>`, which Qualio keeps out of pull requests, the
// baseline and GitHub. Passwords stay here: ${NAME} variables of qualio.yml's users are read from this
// shell or .qualio/.env.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ACTION_SCRIPT = path.resolve(here, '../../scripts/qualio.mjs');
const VERSION = JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8')).version;
const DEFAULT_API_URL = 'https://app.qualio-ai.com';
const POLL_MS = Number(process.env.QUALIO_CLI_POLL_MS || 3000);
/** How long `generate` waits for the Analyst and the Coder before giving up (they keep working in Qualio). */
const WAIT_MINUTES = Number(process.env.QUALIO_CLI_WAIT_MINUTES || 30);

// ── Output ────────────────────────────────────────────────────────────────────────────────────────

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const dim = paint(2);
const bold = paint(1);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);
const cyan = paint(36);
const print = console.log.bind(console);
const ok = (text) => print(`${green('✔')} ${text}`);
const info = (text) => print(`${cyan('ℹ')} ${text}`);
const warn = (text) => print(`${yellow('⚠')} ${text}`);
const step = (text) => print(`${cyan('▶')} ${text}`);

/**
 * The action's code prints GitHub Actions workflow commands: here they become plain lines, and the
 * secret masks (::add-mask::) and log groups are dropped, so a password is never printed.
 */
console.log = (...args) => {
  const line = args.map(String).join(' ');
  if (/^::(add-mask|group|endgroup)::/.test(line)) return;
  const command = /^::(warning|notice|error)(?: [^:]*)?::(.*)$/s.exec(line);
  if (!command) return print(dim(line));
  const [, kind, text] = command;
  if (kind === 'error') print(`${red('✖')} ${text}`);
  else if (kind === 'warning') warn(text);
  else info(text);
};

class UserError extends Error {}

// ── Arguments ─────────────────────────────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(['describe', 'base-url', 'config', 'api-url', 'key', 'minutes']);
const BOOLEAN_FLAGS = new Set(['force', 'no-run', 'no-map', 'yes', 'help', 'version']);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.replace(/^--?/, '').split(/=(.*)/s);
    const flag = name === 'h' ? 'help' : name === 'v' ? 'version' : name === 'y' ? 'yes' : name;
    if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UserError(`--${flag} needs a value.`);
      flags[flag] = value;
    } else if (BOOLEAN_FLAGS.has(flag)) flags[flag] = true;
    else throw new UserError(`Unknown option --${flag}. Run qualio --help.`);
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

const HELP = `qualio ${VERSION}: your features' E2E tests, from the terminal.

Usage
  qualio generate <KEY>                 Write the tests for a feature or ticket (SCH-42, F-7, a Jira issue),
                                        run them against your app here and heal them
  qualio generate --describe "<what>"   The same for something without a ticket
  qualio run                            Run the tests folder here, report to Qualio and heal failures
  qualio status <KEY>                   Where a feature stands
  qualio login <qk_…>                   Save your project's API key (or set QUALIO_API_KEY)
  qualio whoami                         Which Qualio project the key belongs to

Options
  --base-url <url>    The app's URL on this machine (default: qualio.yml's app.url)
  --config <file>     The Qualio config (default: .qualio/qualio-config.yml)
  --yes, -y           Answer the Analyst's questions with its recommended answers
  --force             Send a ticket triage dropped to the Analyst anyway
  --no-run            Write the tests, don't run them
  --no-map            Don't map the app, even when Qualio asks for a map
  --minutes <n>       How long to wait for a heal (default 10)
  --api-url <url>     Qualio's URL (default ${DEFAULT_API_URL}, or QUALIO_API_URL)

The tests Qualio writes are left in your tests folder, uncommitted: review them with git diff and commit.
Passwords in qualio.yml's users (\${ADMIN_PASSWORD}) are read from your shell or .qualio/.env, never sent.`;

// ── Credentials ───────────────────────────────────────────────────────────────────────────────────

const credentialsFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'qualio', 'credentials.json');

async function savedCredentials() {
  try {
    return JSON.parse(await readFile(credentialsFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function credentials(flags) {
  const saved = await savedCredentials();
  const apiKey = flags.key || process.env.QUALIO_API_KEY || saved.apiKey;
  const apiUrl = (flags['api-url'] || process.env.QUALIO_API_URL || saved.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  if (!apiKey) throw new UserError('No API key. Copy your project’s key from Qualio (Settings → API keys), then run: qualio login --key qk_…  (or set QUALIO_API_KEY).');
  return { apiKey, apiUrl };
}

/** GET /v1/auth/verify: the project the key belongs to. */
async function verify({ apiKey, apiUrl }) {
  let res;
  try {
    res = await fetch(`${apiUrl}/v1/auth/verify`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new UserError(`Qualio could not be reached at ${apiUrl}: ${error.message}`);
  }
  if (res.status === 401) throw new UserError('The API key is invalid or was revoked. Generate a new one in Qualio (Settings → API keys).');
  if (!res.ok) throw new UserError(`Qualio answered ${res.status} at ${apiUrl}/v1/auth/verify.`);
  return (await res.json()).project;
}

// ── The repository ────────────────────────────────────────────────────────────────────────────────

function git(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The checkout this runs in: its root, git branch and commit, and Qualio's local branch for them. */
export function repository(cwd = process.cwd()) {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) throw new UserError('Run qualio inside the git repository that holds your E2E tests.');
  const sha = git(['rev-parse', 'HEAD'], root) || '0000000';
  // symbolic-ref also names the branch of a repository with no commit yet; a detached HEAD has none.
  const named = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  const gitBranch = named || `detached-${sha.slice(0, 7)}`;
  return { root, sha, gitBranch, branch: `local:${gitBranch}` };
}

/** KEY=value lines (a .env file): only names not already set in this shell. */
export function parseDotEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[m[1]] = value;
  }
  return values;
}

// ── The action's code, in this process ──────────────────────────────────────────────────────────

/**
 * Sets the environment the action's code reads (as a GitHub Actions job would), then imports it.
 * Its step outputs go to a temporary file per call (`outputs`).
 */
async function session(flags) {
  const creds = await credentials(flags);
  const repo = repository();
  process.chdir(repo.root);
  const temp = await mkdtemp(path.join(tmpdir(), 'qualio-cli-'));
  const configFile = flags.config || (existsSync(path.join(repo.root, '.qualio', 'qualio-config.yml')) ? '.qualio/qualio-config.yml' : '');
  // The variables qualio.yml's users read (${ADMIN_PASSWORD}), from .qualio/.env when this shell lacks them.
  const dotEnv = path.join(repo.root, '.qualio', '.env');
  if (existsSync(dotEnv)) {
    for (const [name, value] of Object.entries(parseDotEnv(readFileSync(dotEnv, 'utf8')))) if (process.env[name] === undefined) process.env[name] = value;
    if (git(['check-ignore', '-q', '.qualio/.env'], repo.root) === null) warn('.qualio/.env is not in .gitignore: add it, so its passwords are never committed.');
  }
  Object.assign(process.env, {
    QUALIO_API_URL: creds.apiUrl,
    QUALIO_API_KEY: creds.apiKey,
    GITHUB_WORKSPACE: repo.root,
    QUALIO_COMMIT_SHA: repo.sha,
    QUALIO_RUN_MANIFEST: path.join(temp, 'manifest.json'),
    CONFIG: '',
    CONFIG_FILE: configFile,
  });
  if (flags['base-url']) process.env.QUALIO_BASE_URL = flags['base-url'].replace(/\/+$/, '');
  for (const name of ['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_STEP_SUMMARY', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH']) delete process.env[name];
  const action = await import(ACTION_SCRIPT);
  const s_apiUrl = () => creds.apiUrl;
  let n = 0;
  /** Runs one of the action's steps and returns its outputs (key=value lines). */
  const outputs = async (run) => {
    const file = path.join(temp, `outputs-${++n}`);
    await writeFile(file, '');
    process.env.GITHUB_OUTPUT = file;
    try {
      await run();
    } finally {
      delete process.env.GITHUB_OUTPUT;
    }
    return Object.fromEntries((await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  };
  /** A POST to Qualio that must succeed. */
  const post = async (route, body) => {
    const { status, body: answer } = await action.call(route, body);
    // A Qualio from before the CLI has no such route (Next.js answers its HTML 404 page).
    if (status === 404 && /<(!doctype|html)/i.test(answer.error ?? '')) throw new UserError(`${s_apiUrl()} doesn’t support the qualio CLI yet.`);
    if (status >= 400) throw new UserError(answer.error ?? `Qualio answered ${status}.`);
    return answer;
  };
  // Qualio's reporter, copied next to the tests for the run (prepare), goes again at the end: nothing of
  // Qualio's runtime is left in the developer's checkout to be committed by mistake.
  const reporterDirs = new Set();
  const cleanup = async () => {
    for (const dir of reporterDirs) {
      await rm(path.join(dir, '.qualio', 'qualio-reporter.ts'), { force: true });
      await rmdir(path.join(dir, '.qualio')).catch(() => {});
    }
    await rm(temp, { recursive: true, force: true });
  };
  // Ctrl+C cleans up too (Playwright, a child of this process, stops with it).
  process.once('SIGINT', () => cleanup().finally(() => process.exit(130)));
  return { creds, repo, temp, configFile, action, outputs, post, reporterDirs, cleanup };
}

/** The test accounts (qualio.yml's users), then the tests folder: sent to Qualio, with its open changes on top. */
async function prepareFolder(s) {
  if (s.configFile) await s.action.accounts();
  const out = await s.outputs(() => s.action.prepare(s.repo.branch));
  if (out.dir) s.reporterDirs.add(out.dir);
  return { dir: out.dir, hasTests: out.run === 'true', reporter: out.reporter || process.env.QUALIO_REPORTER || '', reporterArgs: out['reporter-args'] || '', config: out.config || '' };
}

/** Maps the app on this machine when Qualio asks for a map (a project's first map, or after Map again). */
async function mapApp(s, flags) {
  const out = await s.outputs(() => s.action.map(path.join(s.temp, 'mapper'), s.repo.branch, flags.minutes || '15'));
  if (out.state === 'mapped') ok('Mapped the app');
}

// ── Asking for the tests ──────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** The answers to the Analyst's questions, from the terminal (or its recommendations with --yes). */
export async function answerQuestions(questions, { yes, prompt = ask } = {}) {
  const lines = [];
  for (const q of questions) {
    const pick = q.recommended ?? (q.options?.length === 1 ? q.options[0] : null);
    let answer;
    if (yes) {
      if (!pick) throw new UserError(`The Analyst asks "${q.question}" and recommends no answer: run without --yes to answer it.`);
      answer = pick;
      print(`${bold('?')} ${q.question} ${dim('→')} ${answer} ${dim('(recommended)')}`);
    } else {
      print(`\n${bold('?')} ${bold(q.question)}${q.reason ? `\n  ${dim(q.reason)}` : ''}`);
      (q.options ?? []).forEach((o, i) => print(`  ${i + 1}) ${o}${o === q.recommended ? ` ${green('(recommended)')}` : ''}`));
      for (;;) {
        const typed = await prompt(q.options?.length ? `  Pick a number or type your answer${pick ? ` [${(q.options.indexOf(pick) + 1) || pick}]` : ''}: ` : '  Your answer: ');
        if (!typed && pick) answer = pick;
        else if (/^\d+$/.test(typed) && q.options?.[Number(typed) - 1]) answer = q.options[Number(typed) - 1];
        else if (typed) answer = typed;
        if (answer) break;
      }
    }
    lines.push(`${q.question}\n${answer}`);
  }
  return lines.join('\n\n');
}

/**
 * Asks Qualio for the feature's tests and follows it: the Analyst's questions are answered here, then the
 * Coder writes the tests for this local branch. Resolves with the answer once they are ready.
 */
async function askForTests(s, { key, flags }) {
  const branch = s.repo.branch;
  let answer = await s.post('/v1/features/generate', { ...(flags.describe ? { describe: flags.describe } : { key }), branch, ...(flags.force && { force: true }) });
  const name = () => answer.featureKey ?? answer.key;
  if (answer.url) info(`${bold(name())}${answer.title ? ` ${answer.title}` : ''}: ${answer.url}`);
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  let said = '';
  const say = (state, text) => {
    if (said !== state) print(text);
    said = state;
  };
  for (;;) {
    switch (answer.state) {
      case 'ready':
        ok(`Tests written for ${name()} (${answer.spec.testCases} test case${answer.spec.testCases === 1 ? '' : 's'})`);
        return answer;
      case 'triaging':
        say('triaging', dim(`Triage is reading ${answer.key}…`));
        break;
      case 'analysing':
        say('analysing', dim('The Analyst is reading the request…'));
        break;
      case 'coding':
        if (said !== 'coding') ok(`Spec approved: ${name()} "${answer.spec.title}" (${answer.spec.testCases} test cases)`);
        say('coding', dim('The Coder is writing the tests…'));
        break;
      case 'questions': {
        if (!flags.yes && !interactive())
          throw new UserError(`The Analyst has ${answer.questions.length} question(s) for ${name()}. Answer them in Qualio (${answer.url}), or run again in a terminal or with --yes.`);
        print(`\n${bold('The Analyst asks:')} ${answer.message}`);
        const text = await answerQuestions(answer.questions, { yes: flags.yes });
        await s.post('/v1/features/reply', { key: name(), text });
        answer = { ...answer, state: 'analysing' };
        said = '';
        continue;
      }
      case 'needs_spec': {
        print(`\n${yellow('The Analyst needs more to write tests:')} ${answer.message}`);
        for (const m of answer.missing ?? []) print(`  - ${m}`);
        if (!interactive()) throw new UserError(`Add the details to ${name()} (${answer.url}), then run again.`);
        const text = await ask('\n  Add the details here (empty to stop): ');
        if (!text) throw new UserError(`Add the details to ${name()} (${answer.url}), then run again.`);
        await s.post('/v1/features/reply', { key: name(), text });
        answer = { ...answer, state: 'analysing' };
        said = '';
        continue;
      }
      case 'dropped':
        throw new UserError(`Triage found nothing to test in ${answer.key}: ${answer.reason} Run again with --force to send it to the Analyst anyway.`);
      case 'spec_waiting':
        throw new UserError(`${answer.message} ${answer.url ?? ''}`.trim());
      case 'failed':
        throw new UserError(answer.error);
      default:
        throw new UserError(`Qualio answered an unknown state (${answer.state}). Update the CLI: npm i -g @qualio-ai/cli`);
    }
    if (Date.now() > deadline) throw new UserError(`Still waiting after ${WAIT_MINUTES} minutes. Qualio keeps working: run the same command again later.`);
    await sleep(POLL_MS);
    answer = await s.post('/v1/features/status', { key: name(), branch });
  }
}

/** Writes Qualio's open changes on this local branch (the new tests, a heal's fix) into the tests folder. */
async function writeChanges(s, dir) {
  const answer = await s.post('/v1/tests/changes', { branch: s.repo.branch, binary: true });
  s.action.printNotices(answer.notices);
  if (answer.replace) throw new UserError('This project’s tests are still kept in Qualio: merge Qualio’s pull request that moves them into your repository first.');
  const changed = [];
  for (const file of answer.files) {
    const current = await readFile(path.join(dir, file.path)).catch(() => null);
    const next = file.content === null ? null : file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content);
    if (current === null ? next !== null : next === null || !current.equals(next)) changed.push({ path: file.path, deleted: next === null });
  }
  await s.action.applyFiles(dir, answer.files);
  await s.action.writeManifest('repo', answer.revisionIds);
  return changed;
}

// ── Running the tests here ────────────────────────────────────────────────────────────────────────

function run(command, args, { cwd, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function appAnswers(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
}

/** The tests folder's own Playwright (found like Node finds a package: here or in a parent folder), else npx's. */
function playwrightCommand(dir) {
  try {
    return [process.execPath, [createRequire(path.join(dir, 'package.json')).resolve('@playwright/test/cli.js')]];
  } catch {
    return ['npx', ['playwright']];
  }
}

/** Installs the tests folder's packages and Chromium when it has none yet (a folder Qualio just started). */
async function ensureInstalled(dir) {
  if (existsSync(path.join(dir, 'node_modules'))) return;
  step(`Installing the tests' packages in ${path.relative(process.cwd(), dir) || '.'}`);
  if ((await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir })) !== 0) throw new UserError('npm install failed in the tests folder.');
  await run('npx', ['playwright', 'install', 'chromium'], { cwd: dir });
}

/**
 * Runs the tests with Qualio's reporter (a local run: Qualio keeps it out of pull requests and the
 * baseline), and when they fail waits for Qualio's diagnosis, hosting a look-only browser on the app;
 * a fix is written and the tests run again once. Resolves with whether they passed in the end.
 */
async function runAndHeal(s, folder, flags) {
  const baseUrl = process.env.QUALIO_BASE_URL;
  if (!baseUrl) throw new UserError('Qualio doesn’t know the app’s URL: set app.url in qualio.yml, or pass --base-url http://localhost:3000.');
  if (!(await appAnswers(baseUrl))) throw new UserError(`Nothing answers at ${baseUrl}. Start your app (or pass --base-url), then: qualio run`);
  await ensureInstalled(folder.dir);
  process.env.QUALIO_TESTS_DIR = folder.dir;
  const runFile = path.join(s.temp, 'run.json');
  const runId = String(Date.now());
  const playwright = (round) => {
    step(`Running the tests against ${baseUrl}${round > 1 ? ' again, with the fix' : ''}`);
    const [command, base] = playwrightCommand(folder.dir);
    return run(command, [...base, 'test', ...(folder.config ? [`--config=${folder.config}`] : []), ...(folder.reporterArgs ? [folder.reporterArgs] : [])], {
      cwd: folder.dir,
      env: {
        QUALIO_REPORTER: folder.reporter,
        QUALIO_RUN_FILE: runFile,
        QUALIO_BRANCH: s.repo.branch,
        // The run's id in Qualio (both rounds share it, as in one CI job).
        GITHUB_RUN_ID: runId,
        QUALIO_RUN_ROUND: String(round),
        // The HTML report would otherwise open a server and wait.
        PW_TEST_HTML_REPORT_OPEN: 'never',
      },
    });
  };
  const runUrl = async () => JSON.parse(await readFile(runFile, 'utf8').catch(() => '{}')).url ?? null;

  if ((await playwright(1)) === 0) {
    ok('The tests passed');
    return true;
  }
  const { status } = await s.outputs(() => s.action.wait(runFile, flags.minutes || '10'));
  const url = await runUrl();
  switch (status) {
    case 'patched': {
      const changed = await writeChanges(s, folder.dir);
      ok(`Qualio healed the tests (${changed.map((c) => c.path).join(', ') || 'no file changed'})`);
      const passed = (await playwright(2)) === 0;
      (passed ? ok : warn)(passed ? 'The tests passed with the fix' : `The tests still fail with the fix. See ${(await runUrl()) ?? url ?? 'the run in Qualio'}`);
      return passed;
    }
    case 'proposed':
      warn(`Qualio proposes a fix it isn’t sure enough to apply. An owner or admin decides in Qualio: ${url ?? ''}`);
      return false;
    case 'not_healable':
      warn(`Qualio thinks this is a bug in the app, not in the tests, so nothing was changed. Details: ${url ?? ''}`);
      return false;
    default:
      if (url) info(`The run in Qualio: ${url}`);
      return false;
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────

async function generate({ args, flags }) {
  const key = args[0];
  if (!key === !flags.describe) throw new UserError('Give a feature key (qualio generate SCH-42) or a description (qualio generate --describe "…"), not both.');
  const s = await session(flags);
  try {
    const project = await verify(s.creds);
    ok(`${project.name} · ${s.repo.gitBranch}${s.configFile ? ` · ${s.configFile}` : ''}`);
    const folder = await prepareFolder(s);
    ok(`Tests folder sent: ${path.relative(s.repo.root, folder.dir) || '.'}`);
    if (!flags['no-map'] && !flags['no-run'] && process.env.QUALIO_BASE_URL && (await appAnswers(process.env.QUALIO_BASE_URL))) await mapApp(s, flags);
    await askForTests(s, { key, flags });
    let changed = await writeChanges(s, folder.dir);
    // A folder Qualio just started (no tests here before): send it again, so the run gets Qualio's reporter.
    if (!folder.hasTests) {
      Object.assign(folder, await prepareFolder(s));
      changed = changed.filter((c) => !c.deleted);
    }
    if (!changed.length) info('The tests folder already has these tests.');
    for (const c of changed) print(`  ${c.deleted ? red('-') : green('+')} ${path.relative(s.repo.root, path.join(folder.dir, c.path))}`);
    const passed = flags['no-run'] ? true : await runAndHeal(s, folder, flags);
    print(`\n${bold('Done.')} The tests are in ${path.relative(s.repo.root, folder.dir) || '.'}, uncommitted: review them with git diff, then commit.`);
    return passed ? 0 : 1;
  } finally {
    await s.cleanup();
  }
}

async function runCommand({ flags }) {
  const s = await session(flags);
  try {
    const project = await verify(s.creds);
    ok(`${project.name} · ${s.repo.gitBranch}`);
    const folder = await prepareFolder(s);
    if (!folder.hasTests) throw new UserError('There are no tests to run yet. Ask for some: qualio generate <KEY>');
    await writeChanges(s, folder.dir);
    return (await runAndHeal(s, folder, flags)) ? 0 : 1;
  } finally {
    await s.cleanup();
  }
}

async function status({ args, flags }) {
  if (!args[0]) throw new UserError('Which feature? qualio status SCH-42');
  const s = await session(flags);
  try {
    const answer = await s.post('/v1/features/status', { key: args[0], branch: s.repo.branch });
    const describe = {
      triaging: 'Triage is reading the ticket.',
      dropped: `Triage found nothing to test: ${answer.reason}`,
      analysing: 'The Analyst is working on it.',
      questions: `The Analyst has ${answer.questions?.length} question(s): run qualio generate ${args[0]} to answer them.`,
      needs_spec: 'The Analyst needs more details to write tests.',
      spec_waiting: answer.message,
      coding: 'The spec is approved; the Coder is writing the tests for this branch.',
      ready: `Tests written for this branch: ${(answer.files ?? []).join(', ')}`,
      failed: answer.error,
    }[answer.state];
    print(`${bold(answer.featureKey ?? answer.key)}${answer.title ? ` ${answer.title}` : ''}: ${describe ?? answer.state}`);
    if (answer.url) print(dim(answer.url));
    return 0;
  } finally {
    await s.cleanup();
  }
}

async function login({ args, flags }) {
  // qualio login --key qk_…, or simply qualio login qk_…
  const key = flags.key || args[0];
  if (!key) throw new UserError('qualio login --key qk_…  (your project’s API key, from Qualio’s Settings → API keys)');
  const creds = { apiKey: key, apiUrl: (flags['api-url'] || process.env.QUALIO_API_URL || DEFAULT_API_URL).replace(/\/+$/, '') };
  const project = await verify(creds);
  const file = credentialsFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  ok(`Saved the key for ${bold(project.name)} in ${file}`);
  return 0;
}

async function whoami({ flags }) {
  const creds = await credentials(flags);
  const project = await verify(creds);
  print(`${bold(project.name)} ${dim(`(${creds.apiUrl})`)}`);
  return 0;
}

export async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.flags.version) return print(VERSION), 0;
  if (parsed.flags.help || !parsed.command || parsed.command === 'help') return print(HELP), 0;
  const commands = { generate, run: runCommand, status, login, whoami };
  const command = commands[parsed.command];
  if (!command) throw new UserError(`Unknown command "${parsed.command}". Run qualio --help.`);
  return command(parsed);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1]);
if (isMain)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (error) => {
      print(`${red('✖')} ${error instanceof UserError ? error.message : error.stack || error.message}`);
      process.exit(1);
    },
  );
