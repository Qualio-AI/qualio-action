// A stand-in for Playwright MCP (stdio JSON-RPC), for the live diagnosis test: it records how it was
// started (its arguments, and which environment variables it could see) in the log file named by its
// first argument, and "navigates" without a browser. /away redirects to another site.
//   QUALIO_MCP_COMMAND='["node","test/fake-mcp.mjs","<log>"]'
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [log, ...args] = process.argv.slice(2);
appendFileSync(log, `${JSON.stringify({ args, env: Object.keys(process.env).sort(), signedInAs: process.env.QUALIO_SIGNIN_USERNAME ?? null })}\n`);

let url = 'about:blank';
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0' } });
  if (method !== 'tools/call') return id == null ? undefined : reply(id, {});
  if (params.name === 'browser_navigate') {
    url = params.arguments.url.endsWith('/away') ? 'https://idp.example/login' : params.arguments.url;
    return reply(id, text(`### Ran Playwright code\n\`\`\`js\nawait page.goto('${params.arguments.url}');\n\`\`\`\n### Page\n- Page URL: ${url}`));
  }
  if (params.name === 'browser_snapshot') {
    const who = process.env.QUALIO_SIGNIN_USERNAME ? 'Admin User' : 'nobody';
    return reply(id, text(`### Page\n- Page URL: ${url}\n- Page Title: Fake\n### Snapshot\n\`\`\`yaml\n- banner:\n  - generic: ${who}\n- button "Log in"\n\`\`\``));
  }
  return reply(id, { content: [{ type: 'text', text: `### Error\nunexpected tool ${params.name}` }], isError: true });
});
