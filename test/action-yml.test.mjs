// GitHub evaluates ${{ }} in action.yml's input and output descriptions too, where only some contexts
// exist: `secrets` there makes action.yml fail to load for every workflow (v1.7.0's test-passwords).
//   node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('no expression in an input or output description, and none but github in input defaults', async () => {
  const yml = await readFile(path.join(root, 'action.yml'), 'utf8');
  const head = yml.slice(0, yml.search(/^runs:/m));
  const problems = [];
  for (const [i, line] of head.split('\n').entries()) {
    if (!line.includes('${{')) continue;
    if (/^\s+description:/.test(line)) problems.push(`line ${i + 1}: an expression in a description`);
    else if (/^\s+default:/.test(line) && /\$\{\{(?![^}]*\bgithub\.)/.test(line)) problems.push(`line ${i + 1}: a default may only use the github context`);
    else if (!/^\s+(default|value):/.test(line)) problems.push(`line ${i + 1}: an expression outside a default or value`);
  }
  assert.deepEqual(problems, []);
});

// A plain (unquoted) YAML value can't contain ': ' or ' #': GitHub then fails to load action.yml for every
// workflow ("Mapping values are not allowed in this context"), as live-diagnosis's description did from
// v1.7.2 to v1.8.0. Quote such a description.
test('no unquoted input or output description that YAML would read as a mapping or a comment', async () => {
  const yml = await readFile(path.join(root, 'action.yml'), 'utf8');
  const head = yml.slice(0, yml.search(/^runs:/m));
  const problems = head
    .split('\n')
    .map((line, i) => [i + 1, /^\s+description: (.*)$/.exec(line)?.[1]])
    .filter(([, value]) => value && !/^["'|>]/.test(value) && /: | #/.test(value))
    .map(([n]) => `line ${n}: quote this description`);
  assert.deepEqual(problems, []);
});
