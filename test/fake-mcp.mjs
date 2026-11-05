// A stand-in for Playwright MCP (stdio JSON-RPC), for the live diagnosis test: it records how it was
// started (its arguments, and which environment variables it could see) in the log file named by its
// first argument, and "navigates" without a browser. /away redirects to another site.
//   QUALIO_MCP_COMMAND='["node","test/fake-mcp.mjs","<log>"]'
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [log, ...args] = process.argv.slice(2);
appendFileSync(log, `${JSON.stringify({ args, env: Object.keys(process.env).sort(), signedInAs: process.env.QUALIO_SIGNIN_USERNAME ?? null })}\n`);

let url = 'about:blank';
// Exploring: what the last click opened, and the writes the page's guard blocked.
let dialog = null;
const blocked = [];
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0' } });
  if (method !== 'tools/call') return id == null ? undefined : reply(id, {});
  if (params.name === 'browser_navigate') {
    url = params.arguments.url.endsWith('/away') ? 'https://idp.example/login' : params.arguments.url;
    dialog = null;
    blocked.length = 0;
    return reply(id, text(`### Ran Playwright code\n\`\`\`js\nawait page.goto('${params.arguments.url}');\n\`\`\`\n### Page\n- Page URL: ${url}`));
  }
  // A target resolves like Playwright: 'Log in' once, a bare getByRole('link') twice, anything else nowhere.
  if (params.name === 'browser_snapshot' && params.arguments.target) {
    const target = params.arguments.target;
    if (target.includes("'Log in'")) return reply(id, text(`### Page\n- Page URL: ${url}\n### Snapshot\n\`\`\`yaml\n- button "Log in" [ref=e14] [cursor=pointer]\n\`\`\``));
    for (const name of ['Enrol student', 'Delete course', 'Sign out'])
      if (target.includes(`'${name}'`)) return reply(id, text(`### Snapshot\n\`\`\`yaml\n- button "${name}" [ref=e20] [cursor=pointer]\n\`\`\``));
    if (target.includes("'Help'")) return reply(id, text(`### Snapshot\n\`\`\`yaml\n- link "Help" [ref=e21] [cursor=pointer]:\n  - /url: https://docs.example/help\n\`\`\``));
    if (target.includes("'Email'")) return reply(id, text(`### Snapshot\n\`\`\`yaml\n- textbox "Email" [ref=e22]\n\`\`\``));
    if (target === "getByRole('link')")
      return reply(id, { content: [{ type: 'text', text: `### Error\nError: browserBackend.callTool: Error: strict mode violation: getByRole('link') resolved to 2 elements:\n    1) <a href="/">Home</a> aka getByRole('link', { name: 'Home' })\n    2) <a href="/classes">Courses</a> aka getByRole('link', { name: 'Courses' })\n` }], isError: true });
    return reply(id, { content: [{ type: 'text', text: `### Error\nError: "${target}" does not match any elements.` }], isError: true });
  }
  if (params.name === 'browser_click') {
    if (params.arguments.target.includes('Enrol student')) dialog = '- dialog "Enrol a student" [ref=e30]:\n  - button "Enrol" [ref=e31]';
    // The page's write guard (installed by the exploring browser's init page) stops the delete's POST.
    if (params.arguments.target.includes('Delete course')) blocked.push(`[WARNING] [qualio] blocked form POST ${url} @ :6`);
    return reply(id, text('### Ran Playwright code\n```js\nawait page.click();\n```'));
  }
  if (params.name === 'browser_wait_for') return reply(id, text('### Result\nWaited'));
  if (params.name === 'browser_console_messages') return reply(id, text(`### Result\nTotal messages: ${blocked.length}\n\n${blocked.join('\n')}`));
  if (params.name === 'browser_snapshot') {
    const who = process.env.QUALIO_SIGNIN_USERNAME ? 'Admin User' : 'nobody';
    return reply(id, text(`### Page\n- Page URL: ${url}\n- Page Title: Fake\n### Snapshot\n\`\`\`yaml\n- banner:\n  - generic: ${who}\n- button "Log in"${dialog ? `\n${dialog}` : ''}\n\`\`\``));
  }
  return reply(id, { content: [{ type: 'text', text: `### Error\nunexpected tool ${params.name}` }], isError: true });
});
