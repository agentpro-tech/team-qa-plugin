import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Each web binding chain guard and both eval compat 3 fixes must be load-bearing: removing one turns the suite red.
const root = fileURLToPath(new URL('../../', import.meta.url));
const test = 'test/claude-host/web-lane.test.mjs';
const e2e = 'deployed Vite build runs web requirements';
const cases = [
  { id: 'fix-report-web-keys', file: 'scripts/teamqa.mjs', from: "binding?.schema === 'team-qa/web-binding/v1' ? { verification_lane: 'all', contract_sha256: binding.contract_sha256 }\n        : binding ?", to: 'binding ?', failed: e2e },
  { id: 'fix-handoff-create', file: 'scripts/teamqa.mjs', from: "required: !webHandoffInput(args, '--receipt', 'team-qa/receipt/web-v1')", to: 'required: true', failed: e2e },
  { id: 'fix-handoff-verify', file: 'scripts/teamqa.mjs', from: "required: !webHandoffInput(args, '--file', 'team-qa/handoff/web-v1')", to: 'required: true', failed: e2e },
  { id: 'target-env', file: 'scripts/lib/web-bind.mjs', from: "if (names.length) fail(5, 'WEB_TARGET_ENV_SET', names.join(','), 'ungraded');", to: '', failed: 'web bind refuses TEAMQA_TARGET_*' },
  { id: 'roles-inside-package', file: 'scripts/lib/web-bind.mjs', from: "if (real === pkg || inside(real, pkg)) fail(5, 'WEB_ROLES_INSIDE_PACKAGE', path, 'ungraded');", to: '', failed: 'web bind refuses TEAMQA_TARGET_*' },
  { id: 'record-dry-run', file: 'scripts/lib/web-bind.mjs', from: "if (issues.length) fail(2, issues[0], issues.slice(1).join(' '));", to: '', failed: 'web record grades only' },
  { id: 'identity-proof', file: 'scripts/lib/web-bind.mjs', from: 'runDir, requireProof: true,', to: 'runDir, requireProof: false,', failed: 'web bind rejects requirement graphs' },
  { id: 'graph-target', file: 'scripts/lib/web-bind.mjs', from: "if (graph.target_binding_sha256 !== roster.target.target_binding_sha256) fail(2, 'WEB_GRAPH_TARGET_BINDING_MISMATCH');", to: '', failed: 'web bind rejects requirement graphs' },
];
const copyRepo = id => {
  const copy = join(mkdtempSync(join(tmpdir(), `tq-web-lane-mutant-${id}-`)), 'team-qa');
  cpSync(root, copy, { recursive: true, filter: source => !basename(source).startsWith('._') && !['.git', 'node_modules', 'dist', '.scroll'].includes(basename(source)) });
  return copy;
};
// TAP keeps the `not ok <name>` lines on every Node version (newer Node defaults to the spec reporter).
const run = copy => spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(copy, test)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 600_000 });
const control = run(copyRepo('control'));
assert.equal(control.status, 0, `positive control failed\n${control.stdout}${control.stderr}`);
for (const item of cases) {
  const copy = copyRepo(item.id);
  const path = join(copy, item.file), before = readFileSync(path, 'utf8');
  assert.ok(before.includes(item.from), `mutation missing: ${item.id}`);
  writeFileSync(path, before.replace(item.from, item.to));
  const result = run(copy);
  assert.equal(result.status, 1, `surviving mutation: ${item.id}\n${result.stdout}${result.stderr}`);
  assert.ok(result.stdout.includes(`not ok`) && result.stdout.split('\n').some(line => line.startsWith('not ok') && line.includes(item.failed)), `${item.id}: expected failure in "${item.failed}"\n${result.stdout}`);
  console.log(`MUTATION_KILLED ${item.id} retained=${copy}`);
}
