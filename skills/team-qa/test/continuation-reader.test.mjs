import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decideContinuation, readContinuation } from '../scripts/lib/continuation.mjs';
import { approveRoster, selectRoster, verifyProviderInterface } from '../scripts/lib/roster.mjs';
import { loadTracked } from '../scripts/lib/validators.mjs';
import { sha256File } from '../scripts/lib/core.mjs';

const root = new URL('../', import.meta.url).pathname;
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const guiRoot = (() => { try { return verifyProviderInterface({ skill: 'qa-gui' }).root; } catch { return null; } })();

test('real continuation reader accepts locked case data and rejects a canonical board changed after lock', { skip: guiRoot ? false : 'verified QA GUI provider runtime is unavailable' }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'teamqa-continuation-reader-'));
  const request = JSON.parse(readFileSync(join(root, 'test/roster-dynamic/request-default.json'), 'utf8'));
  request.run_id = 'continuation-reader-fixture'; request.target.preview_url = 'http://127.0.0.1:4173';
  const runDir = join(cwd, 'runs', request.run_id); mkdirSync(runDir, { recursive: true });
  const catalogPath = join(root, 'test/roster-dynamic/catalog-openai-v1.json');
  const roster = selectRoster({ catalog: JSON.parse(readFileSync(catalogPath, 'utf8')), request, catalogPath });
  const rosterPath = join(runDir, 'roster.json'); json(rosterPath, roster);
  const approved = await approveRoster({ runDir, file: rosterPath, userEvent: {
    schema: 'team-qa/roster-user-event/v1', id: 'fixture-approval', actor: 'user', text: 'Approve fixture only.',
    run_id: roster.run_id, round: roster.round, roster_hash: sha256File(rosterPath),
  } });

  const canonical = JSON.parse(readFileSync(join(guiRoot, 'test/fixtures/source-traceability/canonical-v6.valid.json'), 'utf8'));
  canonical.boardId = roster.run_id; canonical.currentRound = roster.round;
  const canonicalPath = join(runDir, 'canonical-board.json'); json(canonicalPath, canonical);
  const tracked = { schemaVersion: 2, sourceItems: canonical.sourceItems, cases: canonical.cases.map(c => ({
    id: c.id, req_id: c.requirement, lane: `lane-${c.id.toLowerCase()}`, title: c.title,
    sourceRefs: c.sourceRefs, steps: [c.title], expected: c.title, data: {}, priority: c.priority === 'P3' ? 'P2' : c.priority, kind: c.kind,
  })) };
  const trackedPath = join(runDir, 'tracked.json'); json(trackedPath, tracked);
  const boardPath = join(runDir, 'board.jsonl');
  const boardRecords = tracked.cases.map(c => ({
    case_id: c.id, lane: c.lane, verdict: 'pending', function_verdict: 'ungraded', ui_visual_verdict: 'ungraded',
    evidence: [], source: 'qa-gui', run_id: roster.run_id, ts: '2026-10-15T00:00:00.000Z',
    attempt: 1, started_at: '2026-10-15T00:00:00.000Z', ended_at: '2026-10-15T00:00:01.000Z', timeout_ms: 1000,
    target: roster.target, traceabilityVersion: 'team-qa/source-traceability/v1', sourceRefs: c.sourceRefs,
  }));
  writeFileSync(boardPath, `${boardRecords.map(JSON.stringify).join('\n')}\n`);
  json(join(runDir, 'phase.json'), { schema: 'team-qa/run-contract/v1', run_id: roster.run_id, round: roster.round, roster_hash: approved.roster_hash, phase: 'EXECUTE' });
  json(join(runDir, 'docs-lock.json'), { schema: 'team-qa/docs-lock/v1', run_id: roster.run_id, round: roster.round, roster_hash: approved.roster_hash,
    artifacts: Object.fromEntries([['board', canonicalPath], ['tracked', trackedPath]].map(([name, path]) => [name, { path: path.slice(runDir.length + 1), sha256: sha256File(path) }])) });

  const parsedTracked = loadTracked(trackedPath, { lock: { governed: false } }); assert.deepEqual(parsedTracked.errors, [], parsedTracked.errors.join(';'));
  const previousRoles = process.env.TEAMQA_ROLES;
  const previousGuiRoot = process.env.TEAMQA_QA_GUI_ROOT;
  const rolesPath = join(cwd, 'roles.json'); json(rolesPath, { roles: [] }); process.env.TEAMQA_ROLES = rolesPath;
  process.env.TEAMQA_QA_GUI_ROOT = guiRoot;
  try {
    const accepted = readContinuation({ runDir });
    assert.equal(accepted.runId, roster.run_id);
    assert.deepEqual(accepted.unresolved, canonical.cases.map(c => c.id));
    assert.ok(canonical.cases.every(c => /^[a-f0-9]{64}$/.test(accepted.progressByCase[c.id])));
    // The real reader has verified the locked scope; this fixture lacks the formal manager gate.
    assert.equal(accepted.next.kind, 'diagnose');
    const workDecision = decideContinuation({ cases: canonical.cases.map(c => ({ id: c.id })), records: boardRecords });
    assert.equal(workDecision.next.caseId, canonical.cases[0].id);
    assert.equal(workDecision.next.kind, 'execute');

    canonical.title += ' edited after lock'; json(canonicalPath, canonical);
    assert.throws(() => readContinuation({ runDir }), error => error.code === 'CONTINUATION_DOCUMENT_DRIFT');
  } finally {
    if (previousRoles === undefined) delete process.env.TEAMQA_ROLES; else process.env.TEAMQA_ROLES = previousRoles;
    if (previousGuiRoot === undefined) delete process.env.TEAMQA_QA_GUI_ROOT; else process.env.TEAMQA_QA_GUI_ROOT = previousGuiRoot;
  }
});
