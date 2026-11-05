// Live diagnosis: while this job waits for Qualio to heal its failed tests, it hosts a browser on the
// application for Qualio's Runner. Qualio never reaches the app: it queues looks (`open`: a path, as a
// role or signed out) at /v1/browser/next, this host opens each page with Playwright MCP and answers
// with the page's accessibility snapshot at /v1/browser/result. Node 20, no dependencies (MCP's
// JSON-RPC over stdio is spoken here directly).
//
// Look only: the host calls Playwright MCP's browser_navigate and browser_snapshot, nothing else, and
// only for paths on the app's own origin. `check` resolves locators with Playwright's own engine through
// the snapshot's `target` (Playwright MCP parses locator text; it never evaluates it) and answers how
// many elements each finds. Sign-ins happen in code (an --init-page script reading the
// role's E2E_<ROLE>_USERNAME / _PASSWORD from this job's env), so credentials never reach Qualio or a
// model. The MCP server gets a minimal environment: never the Qualio API key, GITHUB_TOKEN or other
// secrets.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** Pinned: Playwright MCP drives the Chromium the tests folder's Playwright installed (--executable-path). */
export const MCP_PACKAGE = '@playwright/mcp@0.0.84';
const PROTOCOL_VERSION = '2025-06-18';
const START_TIMEOUT_MS = 180_000; // npx may download the package first
const CALL_TIMEOUT_MS = 45_000;
const MAX_RESULT_CHARS = 50_000;
const SIGNED_OUT = 'signed out';

// What the MCP server (and the browser it starts) may see of this job's environment.
const SAFE_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'CI', 'DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'PLAYWRIGHT_BROWSERS_PATH', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT'];

/** Signs in on every new tab of a role's browser, like Qualio's mapper: the first form with a password field. */
const SIGN_IN = `// Written by the Qualio action (live diagnosis): signs in with this job's secrets, read from its env.
exports.default = async ({ page }) => {
  const { QUALIO_SIGNIN_URL: url, QUALIO_SIGNIN_USERNAME: username, QUALIO_SIGNIN_PASSWORD: password } = process.env;
  if (!url || !username || !password) return;
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  const form = page.locator('form:has(input[type=password])').first();
  if (!(await form.isVisible().catch(() => false))) return; // already signed in
  await form.locator('input:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio])').first().fill(username);
  await form.locator('input[type=password]').first().fill(password);
  await Promise.all([page.waitForLoadState('load'), form.locator('button[type=submit], input[type=submit], button:not([type])').first().click()]);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  if (await page.locator('form:has(input[type=password])').first().isVisible().catch(() => false))
    throw new Error('the sign-in form is still shown after signing in with this role\\'s secrets');
};
`;

/** Locators per check, as Qualio sends them. */
export const MAX_LOCATORS = 10;

/**
 * A locator Qualio may check: Playwright locator code from getBy… (getByRole('button', { name: 'Save' })
 * and its chains), short, one line, nothing that could run (Playwright MCP parses it, never evaluates
 * it; this is a second fence).
 */
export function checkableLocator(raw) {
  const l = typeof raw === 'string' ? raw.trim() : '';
  if (!/^getBy(Role|Label|Placeholder|TestId|Text|AltText|Title)\(/.test(l) || l.length > 300 || /\n|=>|\$\{|\.\s*(evaluate|evaluateAll|evaluateHandle|click|fill|press|type|check|setInputFiles|dispatchEvent)\s*\(/.test(l)) return null;
  return l;
}

/** What browser_snapshot's target answered for one locator: how many elements it found. */
export function locatorCount(locator, answer) {
  if ('text' in answer) {
    const line = /```yaml\n(.+)/.exec(answer.text)?.[1] ?? '';
    const element = line.replace(/^\s*-\s*/, '').replace(/\s*\[(?:ref|cursor|active)[^\]]*\]/g, '').replace(/:\s*$/, '').trim();
    return { locator, count: 1, element: element || null, suggestions: [], error: null };
  }
  const text = answer.error;
  if (/does not match any elements/.test(text)) return { locator, count: 0, element: null, suggestions: [], error: null };
  const many = /resolved to (\d+) elements/.exec(text);
  if (many) return { locator, count: Number(many[1]), element: null, suggestions: [...text.matchAll(/\baka (.+)$/gm)].map((m) => m[1].trim()).slice(0, 5), error: null };
  return { locator, count: null, element: null, suggestions: [], error: (text.split('\n').find((l) => l.trim() && !l.startsWith('###')) ?? 'error').replace(/^Error:\s*/, '').slice(0, 300) };
}

/** A path of the application: starts with one slash, no scheme or host. Same rule as Qualio's. */
export function appPath(raw) {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\') || /[\s\0]/.test(p) || p.length > 500) return null;
  return p;
}

/** One Playwright MCP server over stdio. */
class McpServer {
  constructor(command, args, { env, cwd }) {
    this.child = spawn(command[0], [...command.slice(1), ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.exited = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)));
    this.child.on('error', (error) => this.fail(error));
    this.exited.then((code) => this.fail(new Error(`Playwright MCP exited (code ${code})${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`)));
    this.child.stderr.on('data', (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = message.id != null && this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'MCP error'));
      else waiter.resolve(message.result);
    });
  }

  fail(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.dead = error;
  }

  request(method, params, timeoutMs) {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Playwright MCP gave no answer to ${method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async start() {
    await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'qualio-action', version: '1' } }, START_TIMEOUT_MS);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    return this;
  }

  /** A tool's text; throws with the tool's own message when it reports an error. */
  async tool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS);
    const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (result?.isError) {
      const error = new Error(text.replace(/^### Error\s*/m, '').split('\n').find((l) => l.trim()) ?? 'the browser reported an error');
      error.full = text;
      throw error;
    }
    return text;
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    this.child.kill();
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 3000))]);
  }
}

/** The Chromium the tests folder's Playwright installed (the job already has it), else null. */
function browserExecutable(testsDir) {
  if (process.env.QUALIO_BROWSER_EXECUTABLE) return process.env.QUALIO_BROWSER_EXECUTABLE;
  try {
    const exe = execFileSync(process.execPath, ['-e', "process.stdout.write(require('@playwright/test').chromium.executablePath())"], { cwd: testsDir, encoding: 'utf8', timeout: 30_000 }).trim();
    return exe && existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pageUrl = (text) => /^- Page URL: (\S+)/m.exec(text)?.[1] ?? null;

/** The snapshot as the Runner reads it: the page's URL, title and accessibility tree. */
function pageText(snapshot) {
  const start = snapshot.indexOf('### Page');
  const text = start >= 0 ? snapshot.slice(start) : snapshot;
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (cut)` : text;
}

/**
 * Starts the host for a heal's browser session ({ sessionId, roles: [{ role, usernameEnv, passwordEnv }] }).
 * `call` posts to Qualio (qualio.mjs's). Returns { stop, done, stats }; it ends by itself when Qualio
 * says the heal is done.
 */
export function startBrowserHost(session, { call, baseUrl, testsDir, tempDir, log = console.log }) {
  const base = new URL(baseUrl);
  const command = process.env.QUALIO_MCP_COMMAND ? JSON.parse(process.env.QUALIO_MCP_COMMAND) : ['npx', '-y', MCP_PACKAGE];
  const servers = new Map(); // role (or SIGNED_OUT) → Promise<McpServer>
  const stats = { opened: 0, failed: 0 };
  let stopped = false;
  let executable;

  async function serverFor(role) {
    const key = role ?? SIGNED_OUT;
    if (!servers.has(key)) servers.set(key, launch(role));
    return servers.get(key);
  }

  async function launch(role) {
    if (executable === undefined) executable = browserExecutable(testsDir);
    if (!executable) throw new Error("the tests folder's Playwright Chromium was not found, so this job can't show the app");
    const env = Object.fromEntries(SAFE_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    const dir = path.join(tempDir, (role ?? SIGNED_OUT).replace(/[^\w-]+/g, '_'));
    await mkdir(dir, { recursive: true });
    const args = ['--headless', '--isolated', '--block-service-workers', '--output-dir', dir, '--executable-path', executable, '--timeout-navigation', '20000'];
    if (role) {
      const account = session.roles.find((r) => r.role === role);
      const username = account && process.env[account.usernameEnv];
      const password = account && process.env[account.passwordEnv];
      if (!username || !password) throw new Error(`can't sign in as ${role}: ${account ? `${account.usernameEnv} or ${account.passwordEnv} is empty in this job` : 'no such role'}`);
      const signIn = path.join(tempDir, 'sign-in.cjs');
      await writeFile(signIn, SIGN_IN);
      args.push('--init-page', signIn);
      Object.assign(env, { QUALIO_SIGNIN_URL: base.href, QUALIO_SIGNIN_USERNAME: username, QUALIO_SIGNIN_PASSWORD: password });
    }
    return new McpServer(command, args, { env, cwd: dir }).start();
  }

  /** Opens a path as a role (the app's origin only); the server, ready for more on that page. */
  async function load({ path: rawPath, role }) {
    const p = appPath(rawPath);
    if (!p) throw new Error('not a path of the application');
    if (role != null && !session.roles.some((r) => r.role === role)) throw new Error(`no "${role}" role`);
    const url = new URL(p, base);
    if (url.origin !== base.origin) throw new Error("not on the application's origin");
    const server = await serverFor(role ?? null);
    await server.tool('browser_navigate', { url: url.href });
    const snapshot = await server.tool('browser_snapshot', {});
    const landed = pageUrl(snapshot);
    // A redirect to another site (an identity provider, say) is not the app: its content stays here.
    if (landed && new URL(landed).origin !== base.origin) throw new Error(`the page redirected away from the application (to ${new URL(landed).origin})`);
    return { server, snapshot };
  }

  async function open(args) {
    return pageText((await load(args)).snapshot);
  }

  /** How many elements each locator finds on the page, with Playwright's engine (the snapshot's target). */
  async function check(args) {
    const locators = Array.isArray(args.locators) ? args.locators.slice(0, MAX_LOCATORS) : [];
    if (!locators.length) throw new Error('no locators to check');
    const { server } = await load(args);
    const checks = [];
    for (const raw of locators) {
      const locator = checkableLocator(raw);
      if (!locator) {
        checks.push({ locator: String(raw).slice(0, 300), count: null, element: null, suggestions: [], error: 'not a getBy… locator this job checks' });
        continue;
      }
      const answer = await server.tool('browser_snapshot', { target: locator }).then((text) => ({ text }), (error) => ({ error: error.full ?? error.message }));
      checks.push(locatorCount(locator, answer));
    }
    return JSON.stringify({ checks });
  }

  async function answer(c) {
    try {
      if (c.tool !== 'open' && c.tool !== 'check') throw new Error(`the tool "${c.tool}" is not allowed`);
      const result = c.tool === 'open' ? await open(c.args ?? {}) : await check(c.args ?? {});
      stats.opened += 1;
      return { result };
    } catch (error) {
      stats.failed += 1;
      return { error: String(error.message ?? error).slice(0, 500) };
    }
  }

  const done = (async () => {
    let failures = 0;
    while (!stopped) {
      let reply;
      try {
        reply = await call('/v1/browser/next', { sessionId: session.sessionId, wait: 20 });
      } catch (error) {
        reply = { status: 0, body: { error: error.message } };
      }
      if (stopped) break;
      if (reply.status === 404 || reply.body?.done) break;
      if (reply.status !== 200) {
        if (++failures >= 5) {
          log(`::warning title=Qualio::The live browser stopped: Qualio answered ${reply.status} (${reply.body?.error ?? 'unknown error'}).`);
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      failures = 0;
      const c = reply.body?.call;
      if (!c) continue;
      const result = await answer(c);
      const what = c.tool === 'check' ? `checked ${plural(c.args?.locators?.length ?? 0, 'locator')} on` : 'showed';
      log(`Live diagnosis: ${'result' in result ? what : "couldn't show"} ${c.args?.path ?? '?'} ${c.args?.role ? `as ${c.args.role}` : SIGNED_OUT}${'error' in result ? ` (${result.error})` : ''}.`);
      await call('/v1/browser/result', { sessionId: session.sessionId, callId: c.id, ...result }).catch(() => {});
    }
    await Promise.all([...servers.values()].map((s) => s.then((server) => server.close(), () => {})));
  })();

  return {
    stats,
    done,
    async stop() {
      stopped = true;
      await Promise.all([...servers.values()].map((s) => s.then((server) => server.close(), () => {})));
      // The loop ends at its next answer (a long poll lasts at most ~20 s); the job needn't wait for it.
      await Promise.race([done, new Promise((r) => setTimeout(r, 1000))]);
    },
  };
}
