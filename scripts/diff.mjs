// Line diffs for Qualio's suggestions on pull requests. Node 20, no dependencies.
//
// GitHub only accepts a review comment on lines that are part of the pull request's diff (right side:
// added and context lines), and a ```suggestion block replaces exactly the lines the comment spans.

/** Lines of a file, as GitHub numbers them (a final newline doesn't add a line). */
export function lines(text) {
  const all = text.split('\n');
  if (all.length > 1 && all.at(-1) === '') all.pop();
  return all;
}

/** Above this many cells the diff gives up on precision: one hunk for the whole changed middle. */
const MAX_CELLS = 4_000_000;

/**
 * The hunks that turn `before` into `after`: `start` and `end` are 1-based line numbers in `before`
 * (end exclusive, so start === end inserts before line `start`), `with` the lines that replace them.
 */
export function diffHunks(before, after) {
  const a = lines(before);
  const b = lines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (!A.length && !B.length) return [];
  if ((A.length + 1) * (B.length + 1) > MAX_CELLS) return [{ start: pre + 1, end: pre + 1 + A.length, with: B }];
  // Longest common subsequence, then the runs between matches are the hunks.
  const n = A.length;
  const m = B.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const hunks = [];
  let i = 0;
  let j = 0;
  let open = null;
  const close = () => {
    if (open) hunks.push({ start: pre + open.i + 1, end: pre + i + 1, with: B.slice(open.j, j) });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      close();
      i++;
      j++;
    } else {
      open ??= { i, j };
      if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) j++;
      else i++;
    }
  }
  close();
  return hunks;
}

/** The right-side line numbers a pull request's diff of a file shows (added and context lines), from GitHub's `patch`. */
export function commentableLines(patch) {
  const out = new Set();
  let line = 0;
  for (const row of (patch ?? '').split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header) line = Number(header[1]);
    else if (row.startsWith('+') || row.startsWith(' ')) out.add(line++);
    else if (row === '') {
      // An empty line inside a hunk is a context line whose leading space was trimmed.
      if (line > 0) out.add(line++);
    }
    // '-' rows are the left side, '\' is "No newline at end of file".
  }
  return out;
}

/**
 * The review comments that suggest `after` in place of `before` (the file as the pull request's head has
 * it), or null when a hunk falls outside the lines the pull request's diff shows. A pure insertion is
 * anchored on the line before it (or after it, at the top of the file), which the suggestion repeats.
 */
export function suggestionComments(path, before, after, commentable) {
  const old = lines(before);
  const comments = [];
  for (const h of diffHunks(before, after)) {
    let start = h.start;
    let end = h.end - 1;
    let replacement = h.with;
    if (h.end === h.start) {
      // Insertion before line h.start: span the line before and keep it.
      if (h.start > 1) {
        start = end = h.start - 1;
        replacement = [old[start - 1], ...h.with];
      } else if (old.length) {
        start = end = 1;
        replacement = [...h.with, old[0]];
      } else return null;
    }
    for (let l = start; l <= end; l++) if (!commentable.has(l)) return null;
    comments.push({
      path,
      line: end,
      side: 'RIGHT',
      ...(start < end && { start_line: start, start_side: 'RIGHT' }),
      suggestion: replacement,
    });
  }
  return comments;
}

/** A ```suggestion block, fenced so that backticks inside the lines can't close it. */
export function suggestionBlock(replacement) {
  const longest = Math.max(2, ...replacement.map((l) => (l.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0)));
  const fence = '`'.repeat(longest + 1);
  return `${fence}suggestion\n${replacement.join('\n')}${replacement.length ? '\n' : ''}${fence}`;
}
