// The job's browser host (qualio-v2 specs/tickets-pull-requests-and-tests.md → The browser host). Qualio's agents
// run at Qualio; their browsers run here, next to the app this job started, so nothing about the app is public.
// The host keeps one outbound WebSocket to Qualio's relay; for each browser Qualio asks for, it opens a channel and
// pipes it to a local Chromium (Playwright's launchServer). Passwords never leave the job: Qualio types placeholders
// such as {{E2E_ADMIN_PASSWORD}}, which the host fills from this job's environment before they reach the browser.

import { WebSocket } from 'ws';

const PLACEHOLDER = /\{\{(E2E_[A-Z0-9_]+)\}\}/g;

/** Fills the job's E2E_* placeholders in one frame Qualio sends to the browser (JSON text), JSON-escaped. */
export function fillPlaceholders(frame, env = process.env) {
  if (typeof frame !== 'string' || !frame.includes('{{E2E_')) return frame;
  return frame.replace(PLACEHOLDER, (whole, name) => (typeof env[name] === 'string' && env[name] !== '' ? JSON.stringify(env[name]).slice(1, -1) : whole));
}

/** A URL of the relay with its path and token. */
const relayUrl = (base, path, token) => `${base.replace(/\/+$/, '')}${path}?token=${encodeURIComponent(token)}`;

/**
 * Hosts browsers for Qualio until `stop()`: a control connection, a local browser server started on first use,
 * one channel per Playwright connection. `launchServer` is Playwright's (injected in tests).
 */
export function runHost({ relay, token, env = process.env, launchServer, log = console.log }) {
  let server = null;
  let control = null;
  let stopped = false;
  const sockets = new Set();
  const local = async () => {
    server ??= launchServer({ args: ['--disable-dev-shm-usage'] });
    return (await server).wsEndpoint();
  };

  const openChannel = async (channel) => {
    // The browser server first: frames Qualio already sent arrive as soon as the channel opens.
    const endpoint = await local();
    const remote = new WebSocket(relayUrl(relay, `/channel/${channel}`, token), { maxPayload: 256 * 1024 * 1024 });
    const browser = new WebSocket(endpoint, { maxPayload: 256 * 1024 * 1024 });
    sockets.add(remote).add(browser);
    const queue = [];
    let ready = 0;
    const flush = () => {
      if (++ready < 2) return;
      for (const [to, data, binary] of queue.splice(0)) to.send(data, { binary });
    };
    const forward = (to, fill) => (data, binary) => {
      const out = fill && !binary ? fillPlaceholders(data.toString(), env) : data;
      if (ready < 2) queue.push([to, out, binary]);
      else if (to.readyState === WebSocket.OPEN) to.send(out, { binary });
    };
    remote.on('open', flush).on('message', forward(browser, true));
    browser.on('open', flush).on('message', forward(remote, false));
    const close = () => {
      remote.close();
      browser.close();
      sockets.delete(remote);
      sockets.delete(browser);
    };
    remote.on('close', close).on('error', close);
    browser.on('close', close).on('error', close);
  };

  const connect = () => {
    if (stopped) return;
    control = new WebSocket(relayUrl(relay, '/host', token));
    control.on('open', () => log('Qualio’s agents can use this job’s browsers now.'));
    control.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type === 'open' && /^[a-f0-9]{8,64}$/.test(message.channel ?? '')) openChannel(message.channel).catch((error) => log(`A browser for Qualio couldn’t start: ${error.message}`));
    });
    // A dropped connection comes back (the relay may restart); a refused token ends hosting.
    control.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) stopped = true;
    });
    control.on('close', () => !stopped && setTimeout(connect, 2000));
    control.on('error', () => undefined);
  };
  connect();

  return {
    async stop() {
      stopped = true;
      control?.close();
      for (const s of sockets) s.close();
      if (server) await (await server).close().catch(() => undefined);
    },
  };
}
