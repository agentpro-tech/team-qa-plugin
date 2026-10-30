import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { roleContext } from '../../scripts/lib/run-contract.mjs';
import { sha256 } from '../../scripts/lib/core.mjs';
const root = new URL('../../', import.meta.url).pathname;
test('role context hashes actual source contracts and keeps five role contexts distinct', () => {
  const sets = [];
  for (const role of ['test_manager', 'analyst', 'designer', 'executor_gui', 'executor_code']) {
    const context = roleContext(role);
    assert.equal(context.length, 6);
    assert.ok(context.some((row) => row.path === 'SKILL.md'));
    assert.ok(context.some((row) => row.path === 'references/interfaces.md'));
    for (const item of context) assert.equal(item.sha256, sha256(readFileSync(`${root}${item.path}`)));
    sets.push(JSON.stringify(context));
  }
  assert.equal(new Set(sets).size, 5);
  assert.throws(() => roleContext('coverage_gate'), /RUN_ROLE_UNKNOWN/);
});
