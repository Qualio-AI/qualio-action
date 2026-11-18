import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

// GitHub refuses an action whose action.yml isn't valid YAML (an unquoted "default: …" inside a description did
// that once), and the job fails before any step runs.
for (const file of ['action.yml', 'hosted/action.yml'])
  test(`${file} is valid YAML with the inputs and steps GitHub reads`, async () => {
    const doc = parseDocument(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.deepEqual(doc.errors.map((e) => e.message), []);
    const action = doc.toJS();
    assert.equal(typeof action.name, 'string');
    assert.equal(action.runs.using, 'composite');
    assert.ok(action.runs.steps.length > 0);
    for (const [name, input] of Object.entries(action.inputs)) assert.equal(typeof input.description, 'string', `${name} has a description`);
  });
