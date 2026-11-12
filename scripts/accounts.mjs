// Test account passwords for the job: the QUALIO_TEST_PASSWORDS secret (the action's `test-passwords` input) holds
// one `Role=password` line per role. Usernames come from the Qualio config (roles[].username, which Qualio sends
// back as E2E_<ROLE>_USERNAME); passwords never leave the job.

/** Upper-snake key of a role for environment variables: "Head teacher" → HEAD_TEACHER. Same rule as @qualio/shared's roleEnvKey. */
export function roleEnvKey(role) {
  return role
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
}

/**
 * Reads `Role=password` lines (the first `=` splits, so a password may contain `=`). Blank lines and lines
 * starting with `#` are skipped. Returns the variables to set and the numbers of lines it couldn't read
 * (never their content, which may be a password).
 */
export function parsePasswords(text) {
  const passwords = [];
  const unreadable = [];
  for (const [i, raw] of (text ?? '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    const role = at > 0 ? line.slice(0, at).trim() : '';
    const password = at > 0 ? line.slice(at + 1) : '';
    const key = role ? roleEnvKey(role) : '';
    if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key) || !password) {
      unreadable.push(i + 1);
      continue;
    }
    passwords.push({ role, name: `E2E_${key}_PASSWORD`, password });
  }
  return { passwords, unreadable };
}
