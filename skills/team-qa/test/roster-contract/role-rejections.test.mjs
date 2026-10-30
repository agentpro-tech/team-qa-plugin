import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { selectRoster, approveRoster, assertApprovedRoster } from '../../scripts/lib/roster.mjs';
import { bindRoleAttestation, roleContext } from '../../scripts/lib/run-contract.mjs';
import { sha256File } from '../../scripts/lib/core.mjs';
const root = new URL('../../', import.meta.url).pathname;
async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'tq-role-negative-'));
  const request = JSON.parse(readFileSync(join(root, 'test/roster-dynamic/request-default.json')));
  const runDir = join(cwd, 'runs', request.run_id); mkdirSync(runDir, { recursive: true });
  const catalogPath = join(root, 'test/roster-dynamic/catalog-openai-v1.json');
  const catalog = JSON.parse(readFileSync(catalogPath));
  const roster = selectRoster({ catalog, request, catalogPath });
  const path = join(runDir, 'roster.json'); writeFileSync(path, `${JSON.stringify(roster, null, 2)}\n`);
  await approveRoster({ runDir, file: path, userEvent: { schema: 'team-qa/roster-user-event/v1', id: 'fixture-event', actor: 'user', text: 'Approve fixture only.', run_id: request.run_id, round: request.round, roster_hash: sha256File(path) } });
  const locked = assertApprovedRoster({ runDir });
  const seat = locked.roles.find((r) => r.role === 'test_manager');
  const source = join(runDir, 'stdout.jsonl'); writeFileSync(source, '{"fixture":true}\n');
  const stderr = join(runDir, 'stderr.txt'); writeFileSync(stderr, '');
  const a = { schema: 'team-qa/role-attestation/v1', run_id: locked.run_id, round: locked.round, roster_hash: locked.roster_hash, role: 'test_manager', agent_id: 'fixture-agent', session_id: 'fixture-session', runtime: { provider: seat.provider, model: seat.model, effort: seat.effort, harness: seat.harness, version: seat.harness_version, sent: { model: seat.model, effort: seat.effort }, observed: { model: seat.model, effort: seat.effort, session_id: 'fixture-session' } }, context: roleContext('test_manager'), source: { kind: 'codex-stream', path: source, sha256: sha256File(source), stderr_path: stderr, stderr_sha256: sha256File(stderr) }, graded: true };
  return { runDir, a };
}
test('ungraded fixture role cannot open an official phase', async () => {
  const { runDir, a } = await setup(); a.graded = false; a.source.kind = 'fixture';
  await assert.rejects(bindRoleAttestation({ runDir, attestation: a }), /ROLE_RUNTIME_UNATTESTED/);
});
test('recorded effort alone is insufficient without observed runtime metadata', async () => {
  const { runDir, a } = await setup(); delete a.runtime.observed.effort;
  await assert.rejects(bindRoleAttestation({ runDir, attestation: a }), /ROLE_RUNTIME_OBSERVATION/);
});
test('context receipt must bind the exact current role and interface bytes', async () => {
  const { runDir, a } = await setup(); a.context[0].sha256 = '0'.repeat(64);
  await assert.rejects(bindRoleAttestation({ runDir, attestation: a }), /ROLE_CONTEXT_HASH/);
});
test('model config fields from another seat cannot be relabeled as manager', async () => {
  const { runDir, a } = await setup(); a.runtime.model = 'unapproved-model';
  await assert.rejects(bindRoleAttestation({ runDir, attestation: a }), /ROLE_RUNTIME_CONFIG/);
});

test('a fixture-approved roster cannot be promoted by claiming real graded metadata', async () => {
  const { runDir, a } = await setup();
  await assert.rejects(bindRoleAttestation({ runDir, attestation: a }), /ROSTER_FIXTURE_NOT_OFFICIAL/);
});
