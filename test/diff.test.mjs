// Line diffs and suggestions on pull requests (scripts/diff.mjs).
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentableLines, diffHunks, suggestionBlock, suggestionComments } from '../scripts/diff.mjs';

test('diffHunks finds replaced, inserted and deleted lines', () => {
  assert.deepEqual(diffHunks('a\nb\nc\n', 'a\nB\nc\n'), [{ start: 2, end: 3, with: ['B'] }]);
  assert.deepEqual(diffHunks('a\nc\n', 'a\nb\nc\n'), [{ start: 2, end: 2, with: ['b'] }]);
  assert.deepEqual(diffHunks('a\nb\nc\n', 'a\nc\n'), [{ start: 2, end: 3, with: [] }]);
  assert.deepEqual(diffHunks('same\n', 'same\n'), []);
  assert.deepEqual(diffHunks('a\nb\nc\nd\n', 'A\nb\nc\nD\n'), [
    { start: 1, end: 2, with: ['A'] },
    { start: 4, end: 5, with: ['D'] },
  ]);
});

test('commentableLines reads the right side of a patch', () => {
  const patch = '@@ -1,3 +1,4 @@\n line1\n-old\n+new\n+added\n line3\n@@ -10,2 +11,2 @@\n ten\n+eleven';
  assert.deepEqual([...commentableLines(patch)], [1, 2, 3, 4, 11, 12]);
});

test('suggestionComments anchors each hunk on lines the diff shows, or gives up', () => {
  const before = 'one\ntwo\nthree\nfour\n';
  const after = 'one\nTWO\nthree\nfour\n';
  assert.deepEqual(suggestionComments('e2e/a.ts', before, after, new Set([1, 2, 3])), [{ path: 'e2e/a.ts', line: 2, side: 'RIGHT', suggestion: ['TWO'] }]);
  assert.equal(suggestionComments('e2e/a.ts', before, after, new Set([4])), null);
  // An insertion repeats the line it hangs on.
  assert.deepEqual(suggestionComments('e2e/a.ts', before, 'one\ntwo\nnew\nthree\nfour\n', new Set([2])), [{ path: 'e2e/a.ts', line: 2, side: 'RIGHT', suggestion: ['two', 'new'] }]);
  // Several lines: start_line.
  assert.deepEqual(suggestionComments('e2e/a.ts', before, 'one\n2\n3\nfour\n', new Set([1, 2, 3, 4])), [
    { path: 'e2e/a.ts', line: 3, side: 'RIGHT', start_line: 2, start_side: 'RIGHT', suggestion: ['2', '3'] },
  ]);
});

test('suggestionBlock fences around backticks in the code', () => {
  assert.equal(suggestionBlock(['const a = `x`;']), '```suggestion\nconst a = `x`;\n```');
  assert.equal(suggestionBlock(['```']), '````suggestion\n```\n````');
  assert.equal(suggestionBlock([]), '```suggestion\n```');
});
