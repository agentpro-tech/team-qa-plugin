import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Eval compat 3: a deployed-build run must be bound (teamqa web bind) before `run transition --to EXECUTE`,
// because every execute-phase check reads binding.json and a run cannot leave EXECUTE.
const cli = fileURLToPath(new URL('../../scripts/teamqa.mjs', import.meta.url));
const deployed = { project_id: 'sample-shop', preview_url: 'http://127.0.0.1:5401/intro', version: 'index-CJjkO35e', kind: 'deployed-build',
  environment: 'Local', backend_origin: 'http://127.0.0.1:5411', frontend_build: { kind: 'vite', id: 'index-CJjkO35e' },
  asset_manifest_sha256: 'a'.repeat(64), identity_proof: { path: 'identity/proof.json', sha256: 'b'.repeat(64) }, target_binding_sha256: 'c'.repeat(64) };
function workspace(target, binding) {
  const cwd = mkdtempSync(join(tmpdir(), 'teamqa-execute-guard-'));
  const runDir = join(cwd, 'runs', 'web-guard-r1');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'roster.json'), JSON.stringify({ run_id: 'web-guard-r1', round: 1, target, roles: [] }));
  if (binding !== undefined) writeFileSync(join(runDir, 'binding.json'), JSON.stringify(binding));
  return cwd;
}
const transition = (cwd, to) => {
  const r = spawnSync(process.execPath, [cli, 'run', 'transition', '--run', 'web-guard-r1', '--to', to], { cwd, encoding: 'utf8',
    env: { ...process.env, TEAMQA_TARGET_PROJECT_ID: '', TEAMQA_TARGET_PREVIEW_URL: '', TEAMQA_TARGET_VERSION: '' } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

test('deployed run without binding.json cannot enter EXECUTE', () => {
  const r = transition(workspace(deployed), 'EXECUTE');
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /WEB_BINDING_REQUIRED/);
});

test('deployed run with an invalid binding cannot enter EXECUTE', () => {
  const r = transition(workspace(deployed, { schema: 'team-qa/web-binding/v1' }), 'EXECUTE');
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /WEB_BINDING_INVALID/);
});

test('the guard only applies to deployed targets entering EXECUTE', () => {
  const git = { project_id: 'sample-shop', preview_url: 'http://127.0.0.1:5401/', version: 'abc' };
  for (const [target, to] of [[git, 'EXECUTE'], [deployed, 'DESIGN']]) {
    const r = transition(workspace(target), to);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.out, /WEB_BINDING_(REQUIRED|INVALID)/, r.out);
  }
});
