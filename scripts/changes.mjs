// Phase 40 (qualio-v2 specs/pull-request-changes.md): what the pull request changed, read in the job with its own
// GITHUB_TOKEN (Qualio never calls GitHub) and sent with /v1/pr/sync so Qualio can test it on the preview. Capped
// in size; lockfiles carry no patch; files that may hold secrets carry no patch, and values that look like secrets
// are masked in the others.
import { github } from './github.mjs';

export const PATCH_MAX = 6_000;
export const CHANGES_MAX = 120_000;
export const FILES_MAX = 300;

const SECRET_FILE = /(^|\/)(\.env(\.[\w.-]+)?|[^/]*\.(pem|key|p12|pfx|jks|keystore|crt)|id_(rsa|ed25519|ecdsa)[^/]*|credentials[^/]*|secrets?\.(json|ya?ml|toml))$/i;
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|Cargo\.lock)$/i;
const SECRET_VALUE = /((?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["'`])([^"'`\s]{6,})/gi;

/** Masks values that look like secrets (`apiKey: "…"`, `PASSWORD="…"`) in a patch. */
export const maskSecrets = (patch) => patch.replace(SECRET_VALUE, (_, key) => `${key}***`);

/** The changes of an open pull request, or null (closed, no token, GitHub refused). */
export async function pullRequestChanges(pr, env = process.env, call = github) {
  if (!pr || pr.state === 'closed' || !env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return null;
  const listed = [];
  let truncated = false;
  for (let page = 1; page <= Math.ceil(FILES_MAX / 100); page++) {
    const r = await call('GET', `/repos/${env.GITHUB_REPOSITORY}/pulls/${pr.number}/files?per_page=100&page=${page}`, undefined, env);
    if (r.status !== 200 || !Array.isArray(r.data)) {
      console.log(`::warning title=Qualio::Qualio couldn't read what pull request #${pr.number} changed (GitHub ${r.status || 'unreachable'}): it won't check the changes on the preview.`);
      return null;
    }
    listed.push(...r.data);
    if (r.data.length < 100) break;
    if (page === Math.ceil(FILES_MAX / 100)) truncated = true;
  }
  let left = CHANGES_MAX;
  const files = listed.slice(0, FILES_MAX).map((f) => {
    let patch = typeof f.patch === 'string' && !SECRET_FILE.test(f.filename) && !LOCKFILE.test(f.filename) ? maskSecrets(f.patch) : null;
    if (patch && patch.length > PATCH_MAX) {
      patch = `${patch.slice(0, PATCH_MAX)}\n… (cut)`;
      truncated = true;
    }
    if (patch && patch.length > left) {
      patch = null;
      truncated = true;
    }
    left -= patch?.length ?? 0;
    return { path: f.filename, status: f.status ?? 'modified', additions: f.additions ?? 0, deletions: f.deletions ?? 0, patch };
  });
  return { headSha: pr.head?.sha ?? '', baseSha: pr.base?.sha ?? null, files, truncated };
}
