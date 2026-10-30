import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('RED-TQ-TARGET-LOCK-001: report contract requires exact target identity', () => {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'report.json'), 'utf8'));

  assert.ok(schema.required.includes('target'), 'summary report must require target identity');
  assert.equal(schema.properties.target.type, 'object');
  assert.equal(schema.properties.target.additionalProperties, false);
  assert.deepEqual(schema.properties.target.required, ['project_id', 'preview_url', 'version']);
  assert.equal(schema.properties.target.properties.project_id.type, 'string');
  assert.equal(schema.properties.target.properties.project_id.minLength, 1);
  assert.equal(schema.properties.target.properties.preview_url.type, 'string');
  assert.equal(schema.properties.target.properties.preview_url.minLength, 1);
  assert.equal(schema.properties.target.properties.version.type, 'string');
  assert.equal(schema.properties.target.properties.version.minLength, 1);
});
