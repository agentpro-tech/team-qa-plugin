// Upgrade R2a: the CLI engine binding. One call is one fresh, read-only harness session: the exact input goes to
// stdin, nothing else of the root's environment leaks in, and the answer is read back from the harness's own stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { adjudicatorArgs, cliEngine, engineOutputText } from '../../scripts/lib/adjudicator-engine.mjs';
import { adjudicateCase } from '../../scripts/lib/adjudicator.mjs';
import { runSpend } from '../../scripts/lib/cost.mjs';
import { runTiming } from '../../scripts/lib/timing.mjs';
import { SEAT, fixtureRun, here } from './support.mjs';

const codexSeat = { ...SEAT, provider: 'openai', family: 'gpt', model: 'gpt-6.1-sol', harness: 'codex', harness_version: '0.151.0',
  harness_bin: join(here, 'stub-adjudicator-codex.mjs'), reasoning_control: { kind: 'codex-config', args: ['-c', 'model_reasoning_effort="high"'] } };
const logs = (path) => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the Claude CLI binding is read-only, isolated and sends exactly the input', async () => {
  const f = fixtureRun(), log = join(f.base, 'calls.jsonl'), attempt = randomUUID();
  const engine = cliEngine(SEAT, { env: { ...process.env, ROOT_ONLY_SENTINEL: 'x' }, extraEnv: { TEAMQA_TEST_ADJUDICATOR_LOG: log } });
  const input = 'TEAMQA_ADJUDICATOR v1 phase=checklist run=adj-run case=TC-01\nTEAMQA_ADJUDICATOR_PAYLOAD_START\n{"requirement":{"sources":[{"title":"T"}]}}\nTEAMQA_ADJUDICATOR_PAYLOAD_END\n';
  const out = await engine.call({ phase: 'checklist', input, attempt, runDir: f.runDir, images: [] });
  assert.match(out.output, /TEAMQA_ADJUDICATOR_CHECKLIST v1/);
  assert.equal(out.session_id, attempt);
  const [call] = logs(log);
  assert.equal(call.input, input);
  for (const flag of ['-p', '--safe-mode', '--permission-mode', 'plan', '--strict-mcp-config', '--session-id', attempt, '--model', 'claude-sonnet-5-5', '--effort', 'high']) assert.ok(call.argv.includes(flag), flag);
  assert.equal(call.argv[call.argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.match(call.argv[call.argv.indexOf('--disallowedTools') + 1], /Bash/);
  assert.equal(call.argv[call.argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(call.env.includes('ROOT_ONLY_SENTINEL'), false);
  assert.deepEqual(adjudicatorArgs({ seat: SEAT, attempt, images: [] }), call.argv);
});

test('the Codex CLI binding runs in a read-only sandbox and attaches the images', async () => {
  const f = fixtureRun(), log = join(f.base, 'calls.jsonl'), attempt = randomUUID();
  const engine = cliEngine(codexSeat, { extraEnv: { TEAMQA_TEST_ADJUDICATOR_LOG: log } });
  const image = join(f.runDir, f.rel.shot);
  const input = 'TEAMQA_ADJUDICATOR v1 phase=checklist run=adj-run case=TC-01\nTEAMQA_ADJUDICATOR_PAYLOAD_START\n{"requirement":{"sources":[]}}\nTEAMQA_ADJUDICATOR_PAYLOAD_END\n';
  const out = await engine.call({ phase: 'checklist', input, attempt, runDir: f.runDir, images: [image] });
  assert.match(out.output, /TEAMQA_ADJUDICATOR_CHECKLIST v1/);
  const [call] = logs(log);
  assert.equal(call.input, input);
  assert.deepEqual(call.argv.slice(0, 2), ['exec', '--skip-git-repo-check']);
  assert.equal(call.argv[call.argv.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(call.argv[call.argv.indexOf('--image') + 1], image);
  assert.equal(call.argv[call.argv.indexOf('-m') + 1], 'gpt-6.1-sol');
  assert.equal(call.argv.at(-1), 'approval_policy="never"');
});

test('the answer is read from a stream-json result, a codex agent message or plain text', () => {
  const claude = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }), JSON.stringify({ type: 'result', result: 'final answer' })].join('\n');
  assert.equal(engineOutputText(claude), 'partial\nfinal answer');
  const codex = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex answer' } });
  assert.equal(engineOutputText(codex), 'codex answer');
  assert.equal(engineOutputText('plain text answer'), 'plain text answer');
});

test('a case adjudicated through the CLI binding leaves its attempts where the time and cost receipts read them', async () => {
  const f = fixtureRun({ missingStep: true });
  const result = await adjudicateCase({ runDir: f.runDir, caseId: f.caseId, seat: SEAT, engine: cliEngine(SEAT), attestationPath: f.attestation, boardPath: f.qaBoard });
  assert.equal(result.outcome, 'CONTEST');
  assert.equal(result.engine.kind, 'cli');
  const attempts = [result.engine.checklist_attempt, result.engine.attempt];
  for (const attempt of attempts) {
    const dir = join(f.runDir, 'dispatch', 'adjudicator', attempt);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.role, 'adjudicator');
    assert.equal(state.case_id, 'TC-01');
    assert.equal(state.status, 'done');
    assert.ok(existsSync(join(dir, 'stdout.jsonl')));
  }
  const spend = runSpend(f.runDir);
  assert.equal(spend.roles.adjudicator.attempts, 2);
  assert.equal(spend.roles.adjudicator.usd, 0.02);
  const timing = runTiming({ runDir: f.runDir, runId: f.runId });
  assert.equal(timing.attempts.filter((a) => a.role === 'adjudicator').length, 2);
  assert.equal(timing.summary.attempts_by_role.adjudicator.count, 2);
});
