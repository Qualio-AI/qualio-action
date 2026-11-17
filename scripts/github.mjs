// Delivers what Qualio queued for GitHub with the job's own GITHUB_TOKEN (Qualio never calls GitHub itself).
// Copied from ../qualio-action/scripts/qualio.mjs (github, findReport, deliverReport) and trimmed.

export const REPORT_MARKER = '<!-- qualio-report -->';

/** One GitHub REST call with the job's token: its status (0 when GitHub couldn't be reached), JSON and message. */
export async function github(method, route, body, env = process.env) {
  const base = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, message: res.ok ? '' : (data?.message ?? text.slice(0, 200)) };
  } catch (error) {
    return { status: 0, message: error.message };
  }
}

async function findReport(repo, prNumber, env) {
  for (let page = 1; page <= 10; page += 1) {
    const r = await github('GET', `${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`, undefined, env);
    if (r.status !== 200 || !Array.isArray(r.data)) return null;
    const found = r.data.find((c) => (c.body ?? '').trimStart().startsWith(REPORT_MARKER));
    if (found) return found.id;
    if (r.data.length < 100) return null;
  }
  return null;
}

/** The pull request's one report comment, edited in place (the id Qualio knows, else found by its marker), else posted. */
async function deliverReport(repo, item, env) {
  const body = { body: item.body };
  const edit = async (id) => {
    const r = await github('PATCH', `${repo}/issues/comments/${id}`, body, env);
    return r.status >= 200 && r.status < 300 ? { commentId: String(id) } : r.status === 404 ? null : { failed: r };
  };
  for (const id of [item.commentId, await findReport(repo, item.prNumber, env)].filter(Boolean)) {
    const edited = await edit(id);
    if (edited) return edited;
  }
  const r = await github('POST', `${repo}/issues/${item.prNumber}/comments`, body, env);
  return r.status >= 200 && r.status < 300 ? { commentId: String(r.data?.id ?? '') } : { failed: r };
}

/** Sends one outbox item. */
export async function deliver(item, env = process.env) {
  const repo = `/repos/${env.GITHUB_REPOSITORY}`;
  if (item.kind === 'REPORT') return deliverReport(repo, item, env);
  const p = item.payload ?? {};
  const refused = (r) => (r.status >= 200 && r.status < 300 ? {} : { failed: r });
  if (item.kind === 'STATUS') return refused(await github('POST', `${repo}/statuses/${p.sha}`, { state: p.state, context: p.context, description: (p.description ?? '').slice(0, 140), target_url: p.targetUrl ?? undefined }, env));
  if (item.kind === 'REACTION') return refused(await github('POST', `${repo}/issues/comments/${p.commentId}/reactions`, { content: p.content }, env));
  return { failed: { status: 400, message: `unknown item kind ${item.kind}` } };
}
