// Upgrade R2a: the adjudicator seat of the roster. It comes from a model family other than every executor seat's,
// is shadow unless the request switches it on, and the roster validator refuses an edited seat of the executor family.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { approveRoster, assertApprovedRoster, checkRoster, modelFamily, selectRoster } from '../../scripts/lib/roster.mjs';
import { rosterChat } from '../../scripts/lib/chat-presentation.mjs';
import { sha256File } from '../../scripts/lib/core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalogPath = join(root, 'test/roster-dynamic/catalog-openai-v1.json');
const catalog = () => JSON.parse(readFileSync(catalogPath, 'utf8'));
const request = (extra = {}) => ({ ...JSON.parse(readFileSync(join(root, 'test/roster-dynamic/request-default.json'), 'utf8')), ...extra });
const clone = (value) => structuredClone(value);

test('a request without an adjudicator keeps the roster as before', () => {
  const roster = selectRoster({ catalog: catalog(), request: request(), catalogPath });
  assert.equal(Object.hasOwn(roster, 'adjudicator'), false);
  checkRoster(roster);
});

test('the adjudicator seat comes from another model family and is shadow by default', () => {
  const roster = selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'anthropic' } }), catalogPath });
  const seat = roster.adjudicator;
  assert.equal(seat.role, 'adjudicator');
  assert.equal(seat.mode, 'shadow');
  assert.equal(seat.scope, 'pass_only', 'PASS cases only unless the request asks for all');
  assert.equal(seat.provider, 'anthropic');
  assert.equal(seat.family, 'claude');
  assert.equal(seat.model, 'claude-sonnet-5-5');
  assert.equal(seat.harness, 'claude');
  assert.equal(seat.effort, 'high');
  assert.deepEqual(seat.executor_families, { executor_gui: 'gpt', executor_code: 'gpt' });
  assert.deepEqual(seat.tools, ['fs.read']);
  assert.equal(seat.permission_profile, 'read-only');
  assert.deepEqual(seat.context.map((c) => c.path), ['references/adjudicator-instructions.md', 'references/adjudicator-policy.json']);
  assert.deepEqual(seat.reasoning_control, { kind: 'claude-effort', args: ['--effort', 'high'] });
  assert.equal(modelFamily('openai'), 'gpt');
  assert.equal(modelFamily('acme'), null);
  checkRoster(roster);
});

test('select refuses an adjudicator of the executor family, or of a family the policy does not know', () => {
  assert.throws(() => selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'openai' } }), catalogPath }), /ADJUDICATOR_SAME_FAMILY/);
  assert.throws(() => selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'acme' } }), catalogPath }), /ADJUDICATOR_FAMILY_UNKNOWN/);
  assert.throws(() => selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'anthropic', model: 'claude-opus-5-5' } }), catalogPath }), /ADJUDICATOR_MODEL_UNAVAILABLE/,
    'claude-opus-5-5 is reviewed only as a code executor, not for a read-only judging role');
  assert.throws(() => selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'anthropic', extra: true } }), catalogPath }), /ADJUDICATOR_REQUEST_FIELDS/);
});

test('the roster validator refuses a seat edited to the executor family', () => {
  const roster = selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'anthropic' } }), catalogPath });
  const sameFamily = clone(roster);
  Object.assign(sameFamily.adjudicator, { provider: 'openai', family: 'gpt', model: 'gpt-6.1-sol' });
  assert.throws(() => checkRoster(sameFamily), /ADJUDICATOR_SAME_FAMILY/);
  const relabeled = clone(roster);
  relabeled.adjudicator.provider = 'openai';
  assert.throws(() => checkRoster(relabeled), /ADJUDICATOR_FAMILY_MISMATCH/);
  const executorMoved = clone(roster);
  executorMoved.adjudicator.executor_families = { executor_gui: 'gemini', executor_code: 'gemini' };
  assert.throws(() => checkRoster(executorMoved), /ADJUDICATOR_EXECUTOR_FAMILIES_DRIFT/);
  const contextDrift = clone(roster);
  contextDrift.adjudicator.context[0].sha256 = '0'.repeat(64);
  assert.throws(() => checkRoster(contextDrift), /ADJUDICATOR_CONTEXT_DRIFT/);
  const wider = clone(roster);
  wider.adjudicator.tools = ['fs.read', 'fs.write'];
  assert.throws(() => checkRoster(wider), /ADJUDICATOR_PERMISSION_DRIFT/);
  const unknownField = clone(roster);
  unknownField.adjudicator.verdict_access = true;
  assert.throws(() => checkRoster(unknownField), /ADJUDICATOR_SEAT_FIELDS/);
});

test('enforce is an explicit switch in the request; any other mode is refused', () => {
  const roster = selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'anthropic', mode: 'enforce' } }), catalogPath });
  assert.equal(roster.adjudicator.mode, 'enforce');
  checkRoster(roster);
  assert.throws(() => selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'anthropic', mode: 'on' } }), catalogPath }), /ADJUDICATOR_MODE/);
  const edited = clone(roster);
  edited.adjudicator.mode = 'always';
  assert.throws(() => checkRoster(edited), /ADJUDICATOR_MODE/);
});

test('the scope is PASS-only by default and the request may widen it to all executed cases', () => {
  const all = selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'anthropic', scope: 'all' } }), catalogPath });
  assert.equal(all.adjudicator.scope, 'all');
  checkRoster(all);
  assert.throws(() => selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'anthropic', scope: 'fail_only' } }), catalogPath }), /ADJUDICATOR_SCOPE/);
  const edited = clone(all);
  edited.adjudicator.scope = 'some';
  assert.throws(() => checkRoster(edited), /ADJUDICATOR_SCOPE/);
  const missing = clone(all);
  delete missing.adjudicator.scope;
  assert.throws(() => checkRoster(missing), /ADJUDICATOR_SCOPE/);
});

test('Claude executors get a GPT adjudicator', () => {
  const roster = selectRoster({ catalog: catalog(), catalogPath, request: request({
    provider: 'anthropic', manager: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', harness: 'claude' },
    adjudicator: { provider: 'openai', model: 'gpt-6.1-sol' } }) });
  assert.deepEqual(roster.adjudicator.executor_families, { executor_gui: 'claude', executor_code: 'claude' });
  assert.equal(roster.adjudicator.family, 'gpt');
  assert.equal(roster.adjudicator.harness, 'codex');
  checkRoster(roster);
});

test('approval carries the seat; the chat table shows it and its family', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tq-adjudicator-roster-')), file = join(dir, 'roster.candidate.json');
  const plain = selectRoster({ catalog: catalog(), request: request(), catalogPath });
  const roster = selectRoster({ catalog: catalog(), request: request({ adjudicator: { provider: 'anthropic' } }), catalogPath });
  writeFileSync(file, JSON.stringify(roster));
  const hash = sha256File(file);
  const chat = rosterChat(roster, hash);
  assert.match(chat, /\| Adjudicator \(shadow\) \| anthropic \/ claude-sonnet-5-5 \| high \| Claude CLI \|/);
  assert.match(chat, /- Adjudicator: family=claude; executor families: executor_gui=gpt, executor_code=gpt; mode=shadow/);
  assert.match(chat, /; scope=pass_only \(PASS cases only\);/);
  assert.doesNotMatch(rosterChat(plain, hash), /Adjudicator/);
  await approveRoster({ runDir: dir, file, userEvent: { schema: 'team-qa/roster-user-event/v1', actor: 'user', id: 'fixture-user', text: 'I approve this fixture roster', run_id: roster.run_id, round: roster.round, roster_hash: hash } });
  assert.equal(assertApprovedRoster({ runDir: dir }).adjudicator.family, 'claude');
});

test('roster select takes a separate catalog for the adjudicator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tq-adjudicator-select-'));
  const requestPath = join(dir, 'request.json'), out = join(dir, 'roster.json');
  writeFileSync(requestPath, JSON.stringify(request({ adjudicator: { provider: 'anthropic' } })));
  const openaiOnly = catalog();
  openaiOnly.models = openaiOnly.models.filter((m) => m.provider === 'openai');
  const mainPath = join(root, 'test/roster-dynamic/catalog-openai-v1.json');
  const r = spawnSync(process.execPath, [join(root, 'scripts/roster.mjs'), 'select', '--catalog', mainPath, '--adjudicator-catalog', catalogPath, '--request', requestPath, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const roster = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(roster.adjudicator.model, 'claude-sonnet-5-5');
  assert.equal(roster.adjudicator.catalog_sha256, sha256File(catalogPath));
  assert.throws(() => selectRoster({ catalog: openaiOnly, request: request({ adjudicator: { provider: 'anthropic' } }), catalogPath }), /ADJUDICATOR_MODEL_UNAVAILABLE/);
  checkRoster(roster);
});
