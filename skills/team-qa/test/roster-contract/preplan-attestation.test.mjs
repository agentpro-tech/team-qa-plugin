import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { fail, readJson, sha256File } from '../../scripts/lib/core.mjs';
import { loadTracked } from '../../scripts/lib/validators.mjs';

// Synthetic policy fixtures: evaluate the actual private discovery/cap functions.
// These do not claim an authentic model receipt or an approved live run.
const source = readFileSync(new URL('../../scripts/lib/run-contract.mjs', import.meta.url), 'utf8');
const functions = ['roleAttemptLimit', 'roleAttestationPaths'].map(name => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `missing ${name}`);
  return match[0];
}).join('\n');
const requireValue = (value, code, detail) => { if (!value) fail(3, code, detail); };
const valid = errors => { if (errors.length) fail(3, 'RUN_DOCUMENT_INVALID', errors.join(';')); };
const paths = new Function('existsSync', 'readdirSync', 'join', 'readJson', 'resolve', 'requireValue', 'sha256File', 'loadTracked', 'valid', `${functions}\nreturn roleAttestationPaths;`)(existsSync, readdirSync, join, readJson, resolve, requireValue, sha256File, loadTracked, valid);
const fixture = () => mkdtempSync(join(tmpdir(), 'tq-preplan-discovery-'));
function attempts(runDir, names = []) {
  const dir = join(runDir, 'role-bindings', 'executor_gui');
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), 'invalid attestation bytes');
}
function lockTracked(runDir, cases = 1) {
  const tracked = join(runDir, 'tracked.json');
  writeFileSync(tracked, JSON.stringify({ cases: Array.from({ length: cases }, (_, i) => ({ id: `CASE-${i}`, req_id: 'REQ-1', lane: 'lane', steps: ['Inspect'], expected: 'Result', data: {}, priority: 'P2', kind: 'behavioral', taxonomy: ['functional'], states: ['ideal'], viewports: ['desktop'] })) }));
  writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { tracked: { path: 'tracked.json', sha256: sha256File(tracked) } } }));
  return tracked;
}

test('pre-PLAN manager/analyst discovery needs no GUI tracked lock before GUI retries exist', () => {
  const runDir = fixture();
  for (const role of ['test_manager', 'analyst', 'designer', 'executor_gui', 'executor_code']) assert.deepEqual(paths(runDir, role), []);
  assert.equal(existsSync(join(runDir, 'docs-lock.json')), false);
});
test('empty and unrecognized GUI attempt contents do not introduce a pre-PLAN lock dependency', () => {
  const runDir = fixture();
  attempts(runDir);
  assert.deepEqual(paths(runDir, 'executor_gui'), []);
  attempts(runDir, ['notes.txt', 'attempt-bad.json', 'attempt-1.json', 'attempt-0.json', 'attempt-2.json.bak']);
  assert.deepEqual(paths(runDir, 'executor_gui'), []);
});
test('recognized GUI attempt names still require a lock even if their contents are invalid', () => {
  const runDir = fixture();
  attempts(runDir, ['attempt-2.json']);
  assert.throws(() => paths(runDir, 'executor_gui'), { code: 'INPUT_MISSING' });
});
test('GUI discovery preserves the three-attempts-per-tracked-case cap', () => {
  const runDir = fixture();
  attempts(runDir, ['attempt-2.json', 'attempt-3.json', 'attempt-4.json', 'attempt-6.json', 'attempt-7.json']);
  lockTracked(runDir, 1);
  assert.deepEqual(paths(runDir, 'executor_gui').map(path => basename(path)).sort(), ['attempt-2.json', 'attempt-3.json']);
  lockTracked(runDir, 2);
  assert.deepEqual(paths(runDir, 'executor_gui').map(path => basename(path)).sort(), ['attempt-2.json', 'attempt-3.json', 'attempt-4.json', 'attempt-6.json']);
});
test('GUI attempt records cannot bypass malformed, drifted or empty tracked scope', () => {
  for (const mode of ['malformed', 'drifted', 'invalid', 'empty']) {
    const runDir = fixture();
    attempts(runDir, ['attempt-2.json']);
    const tracked = lockTracked(runDir, mode === 'empty' ? 0 : 1);
    if (mode === 'malformed') writeFileSync(join(runDir, 'docs-lock.json'), '{}');
    if (mode === 'drifted' || mode === 'invalid') writeFileSync(tracked, '{}');
    if (mode === 'invalid') writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { tracked: { path: 'tracked.json', sha256: sha256File(tracked) } } }));
    assert.throws(() => paths(runDir, 'executor_gui'), { code: { malformed: 'ROLE_ATTEMPT_SCOPE_LOCK', drifted: 'ROLE_ATTEMPT_SCOPE_DRIFT', invalid: 'RUN_DOCUMENT_INVALID', empty: 'ROLE_ATTEMPT_SCOPE_EMPTY' }[mode] });
  }
});
test('non-GUI discovery retains its fixed retry cap without a document lock', () => {
  const runDir = fixture(), dir = join(runDir, 'role-bindings', 'analyst');
  mkdirSync(dir, { recursive: true });
  for (const n of [2, 3, 4]) writeFileSync(join(dir, `attempt-${n}.json`), '{}');
  assert.deepEqual(paths(runDir, 'analyst').map(path => basename(path)).sort(), ['attempt-2.json', 'attempt-3.json']);
});
