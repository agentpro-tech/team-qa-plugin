import { existsSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RTM_REQUIREMENT, isRtmEmpty, rtmRequirementIndex } from './report-tokens.mjs';
import { assertUnderCap } from './cost.mjs';
import { fail, readJson, rejectUnknownFields, sha256File, stableJson, withFileLock, writeConfirmed, runAdapter } from './core.mjs';
import { assertApprovedRoster, verifyRoleSource, verifyChildDispatchProof, verifyPlanUserEvent } from './roster.mjs';
import { loadBoard, loadPlan, loadTracked, evidenceIssue } from './validators.mjs';
import { childVerdictIssue } from './child-verdict.mjs';
import { isDeployedTarget, assertWebBinding } from './deployed-target.mjs';
import { dualVerdictIssue } from './dual-verdict.mjs';
import { attemptSequenceIssue, latestAttemptByCase } from './attempt-sequence.mjs';
import { sourceTraceabilityRows } from './source-traceability.mjs';
import { selectRetestCases } from './retest-scope.mjs';
import { boardIntegrityVerify, boardComparePage, verifyNotionReceipt } from '../board-teamwork.mjs';
import { verifyBoardDelivery } from './board-quality.mjs';
import { assertToolPreflight } from './tool-preflight.mjs';
import { executorIdentity } from './executor-identity.mjs';
import { verifyBlockedBoardDelivery } from './board-delivery.mjs';
import { loadPlanPresentation, assertPlanPresented } from './chat-presentation.mjs';
import { siblingSkillRoot } from './install-layout.mjs';
import { SCREEN_ATTEMPTS, SCREEN_ID, screenPlan } from './screen-checks.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const RUN_CONTRACT = 'team-qa/run-contract/v1';
const PHASES = ['PLAN', 'SIGN', 'DESIGN', 'EXECUTE', 'COMPLETE'];
const ROLES = ['test_manager', 'analyst', 'designer', 'executor_gui', 'executor_code'];
const PUBLICATION_ARTIFACTS = ['board_render', 'board_snapshot', 'board_evidence_map', 'board_payload', 'board_quality', 'board_write', 'board_notion'];
const DOCUMENT_ARTIFACTS = ['source', 'dossier', 'plan', 'tracked', 'rtm', 'board', 'template', 'selection', 'change', 'fix_proof', ...PUBLICATION_ARTIFACTS];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireValue = (v, code, detail) => { if (!v) fail(3, code, detail); };
function valid(errors) { if (errors.length) fail(3, 'RUN_DOCUMENT_INVALID', errors.join(';')); }
function boundRun(runDir) {
  let roster;
  try { roster = assertApprovedRoster({ runDir }); }
  catch (error) { if (error.code === 'ROSTER_NOT_APPROVED') fail(3, 'ROSTER_UNAPPROVED', basename(runDir)); throw error; }
  requireValue(roster.run_id === basename(runDir), 'RUN_ID_MISMATCH', basename(runDir));
  return roster;
}
// The tracked plan the document lock pins: the signed case scope of GUI dispatch attempts.
function lockedTrackedCases(runDir) {
  const lock = readJson(join(runDir, 'docs-lock.json')), ref = lock.artifacts?.tracked;
  requireValue(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256 || ''), 'ROLE_ATTEMPT_SCOPE_LOCK');
  const path = resolve(runDir, ref.path); requireValue(existsSync(path) && sha256File(path) === ref.sha256, 'ROLE_ATTEMPT_SCOPE_DRIFT');
  const tracked = loadTracked(path); valid(tracked.errors); requireValue(tracked.value.cases.length > 0, 'ROLE_ATTEMPT_SCOPE_EMPTY');
  return tracked.value.cases;
}
// Kept self-contained (test/roster-contract/preplan-attestation evaluates its source text); lockedTrackedCases above
// reads the same lock for the case-scoped budget.
function roleAttemptLimit(runDir, role) {
  if (role !== 'executor_gui') return 3;
  const lock = readJson(join(runDir, 'docs-lock.json')), ref = lock.artifacts?.tracked;
  requireValue(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256 || ''), 'ROLE_ATTEMPT_SCOPE_LOCK');
  const path = resolve(runDir, ref.path); requireValue(existsSync(path) && sha256File(path) === ref.sha256, 'ROLE_ATTEMPT_SCOPE_DRIFT');
  const tracked = loadTracked(path); valid(tracked.errors); requireValue(tracked.value.cases.length > 0, 'ROLE_ATTEMPT_SCOPE_EMPTY');
  // Fix round 1 (D1): each screen check (one per route and role of a GUI case, screen-checks.mjs screenPlan) is a GUI
  // dispatch of its own, with the same three attempts. Kept inline: this function's source is evaluated on its own.
  const screens = new Set(tracked.value.cases.filter((c) => (c.lane === undefined || c.lane === 'gui') && typeof c.route === 'string' && c.route.startsWith('/'))
    .map((c) => `${c.route}|${typeof c.role === 'string' && c.role ? c.role : ''}`));
  return tracked.value.cases.length * 3 + screens.size * 3;
}
// Case-scoped GUI dispatch on the Claude CLI route (upgrade U2): each `roster.mjs dispatch --case-id <case>` is one
// attempt for one signed case. Every started attempt is appended to dispatch/<role>/case-dispatches.jsonl before the
// worker runs, so a case gets at most three started attempts (an unassigned legacy primary counts against every case)
// and the run at most cases × 3, the same caps as native attempts; a refused start runs no worker.
export const CASE_ATTEMPTS = 3;
export const CASE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const caseLedgerPath = (runDir, role) => join(runDir, 'dispatch', role, 'case-dispatches.jsonl');
function caseLedger(runDir, role) {
  const path = caseLedgerPath(runDir, role);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    let row; try { row = JSON.parse(line); } catch { fail(3, 'DISPATCH_CASE_LEDGER_INVALID', path); }
    requireValue(row && typeof row.case_id === 'string' && typeof row.attempt === 'string', 'DISPATCH_CASE_LEDGER_INVALID', path);
    return row;
  });
}
export function caseDispatchBudget({ runDir, role, caseId }) {
  requireValue(role === 'executor_gui', 'DISPATCH_CASE_ROLE', role);
  requireValue(typeof caseId === 'string' && CASE_ID_PATTERN.test(caseId), 'DISPATCH_CASE_INVALID', String(caseId));
  const cases = lockedTrackedCases(runDir);
  requireValue(cases.some((item) => item.id === caseId), 'DISPATCH_CASE_NOT_IN_PLAN', caseId);
  const started = caseLedger(runDir, role);
  const primary = join(runDir, 'role-bindings', `${role}.json`);
  const legacy = existsSync(primary) && !Object.hasOwn(readJson(primary), 'dispatch_case_id') ? 1 : 0;
  const used = started.filter((row) => row.case_id === caseId).length + legacy;
  return { caseId, used, left: CASE_ATTEMPTS - used, run_used: started.length + legacy, run_limit: cases.length * CASE_ATTEMPTS };
}
// Parallel dispatches are separate processes: the budget check and the append run under one lock on the ledger
// (core.mjs withFileLock), so no started attempt is lost and no case gets a fourth.
export async function startCaseDispatch({ runDir, role, caseId, attempt }) {
  caseDispatchBudget({ runDir, role, caseId });
  // Upgrade R3: under parallel_gui_lanes on, a GUI case starts beside a running one only on another valid parallel lane.
  if (role === 'executor_gui') { const refused = await (await import('./parallel-lanes.mjs')).parallelDispatchIssue({ runDir, caseId, attempt }); if (refused) fail(3, 'DISPATCH_PARALLEL_LANES_REFUSED', refused.slice('DISPATCH_PARALLEL_LANES_REFUSED '.length)); }
  requireValue(typeof attempt === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(attempt), 'DISPATCH_CASE_ATTEMPT_ID', String(attempt));
  const path = caseLedgerPath(runDir, role);
  return withFileLock(path, async () => {
    const budget = caseDispatchBudget({ runDir, role, caseId });
    requireValue(budget.left > 0, 'DISPATCH_CASE_ATTEMPTS_EXHAUSTED', `${caseId} used ${budget.used}/${CASE_ATTEMPTS}`);
    requireValue(budget.run_used < budget.run_limit, 'DISPATCH_CASE_BUDGET_EXHAUSTED', `${budget.run_used}/${budget.run_limit}`);
    assertUnderCap(runDir); // S2: a run that has spent its cost cap starts no new case
    requireValue(!caseLedger(runDir, role).some((row) => row.attempt === attempt), 'DISPATCH_CASE_ATTEMPT_ID', `${attempt} already started`);
    const rows = existsSync(path) ? readFileSync(path, 'utf8') : '';
    await writeConfirmed(path, `${rows}${JSON.stringify({ case_id: caseId, attempt, started_at: new Date().toISOString() })}\n`, 'teamqa.dispatch.case');
    return { ...budget, used: budget.used + 1, left: budget.left - 1 };
  });
}
// Fix round 1 (D1): a screen check dispatch (`roster.mjs dispatch --screen-id <S>`) is one attempt for one screen of the
// locked tracked plan, at most three per screen, recorded in dispatch/<role>/screen-dispatches.jsonl before it runs.
const screenLedgerPath = (runDir, role) => join(runDir, 'dispatch', role, 'screen-dispatches.jsonl');
function screenLedger(runDir, role) {
  const path = screenLedgerPath(runDir, role);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => { let row; try { row = JSON.parse(line); } catch { fail(3, 'DISPATCH_SCREEN_LEDGER_INVALID', path); } return row; });
}
export function lockedScreens(runDir) {
  const lock = readJson(join(runDir, 'docs-lock.json')), ref = lock.artifacts?.tracked;
  requireValue(ref && typeof ref.path === 'string', 'ROLE_ATTEMPT_SCOPE_LOCK');
  const path = resolve(runDir, ref.path); requireValue(existsSync(path) && sha256File(path) === ref.sha256, 'ROLE_ATTEMPT_SCOPE_DRIFT');
  return screenPlan(readJson(path)).screens;
}
export async function startScreenDispatch({ runDir, role, screenId, attempt }) {
  requireValue(role === 'executor_gui', 'DISPATCH_SCREEN_ROLE', role);
  requireValue(typeof screenId === 'string' && SCREEN_ID.test(screenId) && lockedScreens(runDir).some((s) => s.id === screenId), 'DISPATCH_SCREEN_NOT_IN_PLAN', String(screenId));
  requireValue(typeof attempt === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(attempt), 'DISPATCH_CASE_ATTEMPT_ID', String(attempt));
  const path = screenLedgerPath(runDir, role);
  return withFileLock(path, async () => {
    const used = screenLedger(runDir, role).filter((row) => row.screen_id === screenId).length;
    requireValue(used < SCREEN_ATTEMPTS, 'DISPATCH_SCREEN_ATTEMPTS_EXHAUSTED', `${screenId} used ${used}/${SCREEN_ATTEMPTS}`);
    assertUnderCap(runDir);
    const rows = existsSync(path) ? readFileSync(path, 'utf8') : '';
    await writeConfirmed(path, `${rows}${JSON.stringify({ screen_id: screenId, attempt, started_at: new Date().toISOString() })}\n`, 'teamqa.dispatch.screen');
    return { screenId, used: used + 1, left: SCREEN_ATTEMPTS - used - 1 };
  });
}
// The chain value of a scoped dispatch: its case, or `screen:<id>`.
const scopeOf = (a) => (typeof a.dispatch_case_id === 'string' ? a.dispatch_case_id : `screen:${a.dispatch_screen_id}`);
const caseChain = (previousSha256, attemptId, caseId) => createHash('sha256').update(`${previousSha256}\n${attemptId}\n${caseId}`).digest('hex');
const priorAttemptPath = (runDir, role, seq) => seq === 2 ? join(runDir, 'role-bindings', `${role}.json`) : join(runDir, 'role-bindings', role, `attempt-${seq - 1}.json`);
// The case binding of a case-scoped claude-stream attestation, or null when it has none: a GUI claude-stream attestation
// naming a case of the locked tracked plan; a v2 one is the requested worker session and chains to the one before it.
export function caseAttestationIssue(runDir, a) {
  const screen = Object.hasOwn(a ?? {}, 'dispatch_screen_id');
  if (!Object.hasOwn(a ?? {}, 'dispatch_case_id') && !screen) return null;
  if (screen) {
    if (Object.hasOwn(a, 'dispatch_case_id') || a.source?.kind !== 'claude-stream' || a.role !== 'executor_gui' || typeof a.dispatch_screen_id !== 'string' || !SCREEN_ID.test(a.dispatch_screen_id)) return 'ROLE_DISPATCH_SCREEN_BINDING';
    if (!lockedScreens(runDir).some((item) => item.id === a.dispatch_screen_id)) return 'ROLE_DISPATCH_SCREEN_NOT_IN_PLAN';
  } else {
    if (a.source?.kind !== 'claude-stream' || a.role !== 'executor_gui' || typeof a.dispatch_case_id !== 'string' || !CASE_ID_PATTERN.test(a.dispatch_case_id)) return 'ROLE_DISPATCH_CASE_BINDING';
    if (!lockedTrackedCases(runDir).some((item) => item.id === a.dispatch_case_id)) return 'ROLE_DISPATCH_CASE_NOT_IN_PLAN';
  }
  if (a.schema === 'team-qa/role-attestation/v2') {
    if (a.dispatch_attempt_id !== a.session_id || !Number.isInteger(a.dispatch_attempt_seq) || a.dispatch_attempt_seq < 2) return 'ROLE_DISPATCH_ATTEMPT_BINDING';
    const prior = priorAttemptPath(runDir, a.role, a.dispatch_attempt_seq);
    if (!existsSync(prior) || caseChain(sha256File(prior), a.dispatch_attempt_id, scopeOf(a)) !== a.dispatch_chain_sha256) return 'ROLE_DISPATCH_CHAIN';
  }
  return null;
}
// The bound form of a case-scoped claude-stream attestation: the first bound GUI dispatch of the run stays v1 at the
// legacy primary path (with its case); every later one is v2 at role-bindings/<role>/attempt-<n>.json, n the next free
// sequence, chained to the attestation before it.
export function sequenceCaseAttestation({ runDir, attestation }) {
  const a = attestation;
  requireValue(a?.source?.kind === 'claude-stream' && (typeof a.dispatch_case_id === 'string' || typeof a.dispatch_screen_id === 'string'), 'DISPATCH_CASE_ATTESTATION', a?.role);
  const primary = join(runDir, 'role-bindings', `${a.role}.json`);
  if (!existsSync(primary)) return a;
  const seq = roleAttestationPaths(runDir, a.role).length + 2;
  const prior = priorAttemptPath(runDir, a.role, seq);
  requireValue(existsSync(prior), 'ROLE_ATTEMPT_PREDECESSOR_MISSING', a.role);
  return { ...a, schema: 'team-qa/role-attestation/v2', dispatch_attempt_id: a.session_id, dispatch_attempt_seq: seq,
    dispatch_chain_sha256: caseChain(sha256File(prior), a.session_id, scopeOf(a)) };
}
// A machine-readable offer to run again (upgrade U4). Roots worded "open round 2 / run another attempt" five ways in
// the G2 canary; `teamqa run offer` checks the offer and prints one marker line the root pastes right before its
// question: TEAMQA_OFFER run=<id> round=<n> kind=round|attempt next=<n> cases=<ids> reason=<code> sha256=<file hash>.
// The cases are in the locked tracked plan; an attempt offer needs attempts left for every case (and the run budget);
// the run is not COMPLETE; the offer keeps the approved roster and target (it names their hashes). It changes no
// approval rule: a new round still has its roster and plan approved, an attempt still goes through dispatch.
export const OFFER_SCHEMA = 'team-qa/run-offer/v1';
export const OFFER_REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
export function offerMarker(offer, sha256) {
  return `TEAMQA_OFFER run=${offer.run_id} round=${offer.round} kind=${offer.kind} next=${offer.next} cases=${offer.cases.join(',')} reason=${offer.reason} sha256=${sha256}`;
}
export async function createRunOffer({ runDir, kind, cases, reason, now = () => new Date() }) {
  const roster = boundRun(runDir);
  requireValue(['round', 'attempt'].includes(kind), 'RUN_OFFER_KIND', String(kind));
  requireValue(typeof reason === 'string' && OFFER_REASON.test(reason), 'RUN_OFFER_REASON', String(reason));
  const ids = String(cases ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  requireValue(ids.length > 0 && ids.length <= 50 && new Set(ids).size === ids.length && ids.every((id) => CASE_ID_PATTERN.test(id)), 'RUN_OFFER_CASES', String(cases));
  const state = phase(runDir, roster);
  requireValue(state.phase !== 'COMPLETE', 'RUN_OFFER_COMPLETE', roster.run_id);
  const planned = new Set(lockedTrackedCases(runDir).map((item) => item.id));
  const missing = ids.filter((id) => !planned.has(id));
  requireValue(!missing.length, 'RUN_OFFER_NOT_IN_PLAN', missing.join(','));
  let next = roster.round + 1;
  if (kind === 'attempt') {
    requireValue(state.phase === 'EXECUTE', 'RUN_PHASE_REQUIRED', 'EXECUTE');
    requireValue(roster.roles.some((seat) => seat.role === 'executor_gui'), 'RUN_OFFER_ROLE', 'executor_gui');
    const budgets = ids.map((caseId) => caseDispatchBudget({ runDir, role: 'executor_gui', caseId }));
    const spent = budgets.filter((b) => b.left <= 0).map((b) => `${b.caseId} used ${b.used}/${CASE_ATTEMPTS}`);
    requireValue(!spent.length, 'RUN_OFFER_ATTEMPTS_EXHAUSTED', spent.join(','));
    requireValue(budgets[0].run_used + ids.length <= budgets[0].run_limit, 'RUN_OFFER_BUDGET_EXHAUSTED', `${budgets[0].run_used}+${ids.length}/${budgets[0].run_limit}`);
    next = Math.max(...budgets.map((b) => b.used)) + 1;
  }
  const dir = join(runDir, 'control', 'offers');
  const n = (existsSync(dir) ? readdirSync(dir).filter((name) => /^\d+\.json$/.test(name)).length : 0) + 1;
  const offer = { schema: OFFER_SCHEMA, n, run_id: roster.run_id, round: roster.round, kind, next, cases: ids, reason,
    roster_hash: roster.roster_hash, target_sha256: createHash('sha256').update(stableJson(roster.target)).digest('hex'), phase: state.phase, created_at: now().toISOString() };
  const bytes = stableJson(offer), path = join(dir, `${n}.json`);
  await writeConfirmed(path, bytes, 'teamqa.run.offer', { exclusive: true });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { offer, path, sha256, marker: offerMarker(offer, sha256) };
}
export function roleContext(role) {
  requireValue(ROLES.includes(role), 'RUN_ROLE_UNKNOWN', role);
  const folder = role.replaceAll('_', '-');
  return ['IDENTITY.md', 'SOUL.md', 'hard-rules.md', 'TOOLS.md'].map((name) => `agents/${folder}/${name}`)
    .concat(['SKILL.md', 'references/interfaces.md']).map((path) => ({ path, sha256: sha256File(join(ROOT, path)) }));
}
function verifyAttestation(runDir, a, roster) {
  rejectUnknownFields(a, ['schema', 'run_id', 'round', 'roster_hash', 'role', 'agent_id', 'session_id', 'runtime', 'context', 'source', 'graded', 'dispatch_attempt_id', 'dispatch_attempt_seq', 'dispatch_chain_sha256', 'dispatch_case_id', 'dispatch_screen_id'], 'ROLE_ATTESTATION_UNKNOWN');
  requireValue(['team-qa/role-attestation/v1','team-qa/role-attestation/v2'].includes(a.schema), 'ROLE_ATTESTATION_SCHEMA');
  // Case-scoped Claude CLI GUI dispatch (U2): claude-stream attestations name their signed case; v2 retries chain to
  // the attestation before them and their attempt id is the worker session the dispatcher requested.
  const caseScoped = a.source?.kind === 'claude-stream' && (Object.hasOwn(a, 'dispatch_case_id') || Object.hasOwn(a, 'dispatch_screen_id'));
  if (a.schema === 'team-qa/role-attestation/v2') requireValue((a.source?.kind === 'codex-native' || caseScoped) && typeof a.dispatch_attempt_id === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(a.dispatch_attempt_id) && Number.isInteger(a.dispatch_attempt_seq) && a.dispatch_attempt_seq >= 2 && a.dispatch_attempt_seq <= roleAttemptLimit(runDir, a.role) && /^[a-f0-9]{64}$/.test(a.dispatch_chain_sha256 || ''), 'ROLE_DISPATCH_ATTEMPT_BINDING');
  else requireValue(!Object.hasOwn(a, 'dispatch_attempt_id') && !Object.hasOwn(a, 'dispatch_attempt_seq') && !Object.hasOwn(a, 'dispatch_chain_sha256'), 'ROLE_DISPATCH_ATTEMPT_BINDING');
  const caseIssue = caseAttestationIssue(runDir, a);
  requireValue(!caseIssue, caseIssue, a.role);
  requireValue(a.run_id === roster.run_id && a.round === roster.round && a.roster_hash === roster.roster_hash, 'ROLE_ATTESTATION_BINDING', a.role);
  const seat = roster.roles.find((row) => row.role === a.role);
  requireValue(seat && ROLES.includes(a.role), 'ROLE_ATTESTATION_ROLE', a.role);
  requireValue(typeof a.agent_id === 'string' && a.agent_id.trim() && typeof a.session_id === 'string' && a.session_id.trim(), 'ROLE_SESSION_MISSING', a.role);
  requireValue(a.graded === true && ['codex-rollout', 'codex-stream', 'claude-stream', 'codex-native'].includes(a.source?.kind), 'ROLE_RUNTIME_UNATTESTED', a.role);
  requireValue(typeof a.source.path === 'string' && existsSync(resolve(runDir, a.source.path)) && sha256File(resolve(runDir, a.source.path)) === a.source.sha256, 'ROLE_RUNTIME_SOURCE_HASH', a.role);
  rejectUnknownFields(a.source, ['kind', 'path', 'sha256', 'stderr_path', 'stderr_sha256', 'metadata_source'], 'ROLE_SOURCE_UNKNOWN');
  const r = a.runtime;
  rejectUnknownFields(r, ['provider', 'model', 'effort', 'harness', 'version', 'sent', 'observed', ...(a.source.kind === 'codex-native' ? ['origin_version'] : [])], 'ROLE_RUNTIME_UNKNOWN');
  rejectUnknownFields(r?.sent, ['model', 'effort'], 'ROLE_RUNTIME_SENT_UNKNOWN');
  rejectUnknownFields(r?.observed, ['model', 'effort', 'session_id'], 'ROLE_RUNTIME_OBSERVED_UNKNOWN');
  const nativeEpoch = a.source.kind === 'codex-native' && r?.origin_version === seat.harness_version && r.version === a.source.metadata_source?.native?.child_version && a.source.metadata_source?.native?.parent_origin_version === seat.harness_version;
  const legacyVersion = r?.version === seat.harness_version && (a.source.kind !== 'codex-native' || !a.source.metadata_source?.native?.child_version);
  requireValue(r && r.provider === seat.provider && r.model === seat.model && r.effort === seat.effort && r.harness === seat.harness && (nativeEpoch || legacyVersion), 'ROLE_RUNTIME_CONFIG', a.role);
  requireValue(r.sent?.model === seat.model && r.sent?.effort === seat.effort && r.observed?.model === seat.model && r.observed?.effort === seat.effort && r.observed?.session_id === a.session_id, 'ROLE_RUNTIME_OBSERVATION', a.role);
  const expected = roleContext(a.role);
  requireValue(eq(a.context, seat.context) && eq(a.context, expected), 'ROLE_CONTEXT_HASH', a.role);
  requireValue(roster.catalog_source.kind === 'runtime', 'ROSTER_FIXTURE_NOT_OFFICIAL');
  verifyRoleSource(a, { runDir });
  // U1: a case-scoped GUI dispatch on a deployed target proved the build on the executor's own tab, in its stream.
  if (caseScoped && isDeployedTarget(roster.target)) executorIdentity({ stream: readFileSync(resolve(runDir, a.source.path), 'utf8'), target: roster.target });
  // The orchestration receipt proves supplied context, not model comprehension.
  return a;
}
// These checks read the root's live transcript, and a root that keeps writing (a
// detached dispatch while it waits, a gate it runs) can change the file during the read (ORIGINAL_SOURCE_CHANGED, raw
// or as a refusal's detail). The whole check runs again on a fresh read, up to five times; every other refusal stands.
const pauseSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sourceRaced = (error) => [error?.code, error?.detail].includes('ORIGINAL_SOURCE_CHANGED');
export function rereadWhileSourceChanges(read, { attempts = 5, pause = pauseSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return read(); } catch (error) { if (!sourceRaced(error) || attempt >= attempts) throw error; pause(150 * attempt); }
  }
}
export function assertRoleAttestation(options) { return rereadWhileSourceChanges(() => assertRoleAttestationOnce(options)); }
function assertRoleAttestationOnce({ runDir, role, roster = boundRun(runDir), attestationPath, attestationSha256, dispatchAttemptId, latest = false }) {
  const primary = join(runDir, 'role-bindings', `${role}.json`);
  requireValue(!(latest && (attestationPath || attestationSha256 || dispatchAttemptId)), 'ROLE_ATTEMPT_SELECTOR_MIXED', role);
  let path = attestationPath ? resolve(attestationPath) : dispatchAttemptId ? join(runDir, 'role-bindings', role, `attempt-${findDispatchAttemptSeq(runDir, role, dispatchAttemptId)}.json`) : primary;
  if (latest) {
    const candidates = [primary, ...roleAttestationPaths(runDir, role)].filter(existsSync);
    requireValue(candidates.length > 0, 'ROLE_ATTESTATION_MISSING', role);
    path = candidates.sort((a, b) => {
      const seq = p => p === primary ? 1 : Number(/attempt-(\d+)\.json$/.exec(p)?.[1] || 0);
      return seq(b) - seq(a);
    })[0];
  } else if (attestationSha256 && !attestationPath && !dispatchAttemptId) {
    requireValue(/^[a-f0-9]{64}$/.test(attestationSha256), 'ROLE_ATTESTATION_HASH_SELECTOR', role);
    const candidates = [primary, ...roleAttestationPaths(runDir, role)].filter(existsSync).filter(candidate => sha256File(candidate) === attestationSha256);
    requireValue(candidates.length === 1, 'ROLE_ATTESTATION_HASH_SELECTOR_MISMATCH', role);
    path = candidates[0];
  }
  if (attestationPath || attestationSha256 || dispatchAttemptId || latest) {
    requireValue(!(attestationPath && dispatchAttemptId) || path === join(runDir, 'role-bindings', role, `attempt-${findDispatchAttemptSeq(runDir, role, dispatchAttemptId)}.json`), 'ROLE_ATTEMPT_SELECTOR_MISMATCH', role);
    requireValue(path === primary || path.startsWith(join(runDir, 'role-bindings', role) + '/attempt-'), 'ROLE_ATTESTATION_PATH');
  }
  requireValue(existsSync(path), 'ROLE_ATTESTATION_MISSING', role);
  const a = verifyAttestation(runDir, readJson(path), roster);
  if (attestationSha256) requireValue(sha256File(path) === attestationSha256, 'ROLE_ATTESTATION_HASH', role);
  if (dispatchAttemptId) requireValue(a.schema === 'team-qa/role-attestation/v2' && a.dispatch_attempt_id === dispatchAttemptId, 'ROLE_ATTEMPT_SELECTOR_MISMATCH', role);
  if (a.schema === 'team-qa/role-attestation/v2') requireValue(path === join(runDir, 'role-bindings', role, `attempt-${a.dispatch_attempt_seq}.json`), 'ROLE_ATTEMPT_PATH_BINDING', role);
  for (const other of ROLES) {
    const candidates = [join(runDir, 'role-bindings', `${other}.json`), ...roleAttestationPaths(runDir, other)];
    for (const otherPath of candidates) {
      if (!existsSync(otherPath) || resolve(otherPath) === path) continue;
      const b = verifyAttestation(runDir, readJson(otherPath), roster);
      requireValue(a.agent_id !== b.agent_id && a.session_id !== b.session_id, 'ROLE_SESSION_REUSED', `${role}:${other}`);
    }
  }
  return a;
}
function findDispatchAttemptSeq(runDir, role, id) {
  const dir = join(runDir, 'role-bindings', role);
  for (let n = 2; n <= roleAttemptLimit(runDir, role); n += 1) {
    const path = join(dir, `attempt-${n}.json`);
    if (existsSync(path) && readJson(path).dispatch_attempt_id === id) return n;
  }
  fail(3, 'ROLE_ATTEMPT_SELECTOR_MISMATCH', role);
}
function roleAttestationPaths(runDir, role) {
  const dir = join(runDir, 'role-bindings', role);
  if (!existsSync(dir)) return [];
  const attempts = readdirSync(dir).map(name => /^attempt-(\d+)\.json$/.exec(name)).filter(match => match && Number(match[1]) >= 2);
  // Initial role binding precedes the document lock; only retries need its GUI cap.
  if (!attempts.length) return [];
  const limit = roleAttemptLimit(runDir, role);
  return attempts.filter(match => Number(match[1]) <= limit).map(match => join(dir, match[0]));
}
export async function bindRoleAttestation({ runDir, attestation }) {
  const roster = boundRun(runDir);
  verifyAttestation(runDir, attestation, roster);
  const path = attestation.schema === 'team-qa/role-attestation/v2'
    ? join(runDir, 'role-bindings', attestation.role, `attempt-${attestation.dispatch_attempt_seq}.json`)
    : join(runDir, 'role-bindings', `${attestation.role}.json`);
  requireValue(!existsSync(path), 'ROLE_ATTESTATION_EXISTS', attestation.role);
  if (attestation.schema === 'team-qa/role-attestation/v2') {
    const previousSeq = attestation.dispatch_attempt_seq - 1;
    const expectedPrior = previousSeq === 1 ? join(runDir, 'role-bindings', `${attestation.role}.json`) : join(runDir, 'role-bindings', attestation.role, `attempt-${previousSeq}.json`);
    if (existsSync(expectedPrior)) {
      const prior = readJson(expectedPrior);
      requireValue(prior.run_id === attestation.run_id && prior.round === attestation.round && prior.roster_hash === attestation.roster_hash && prior.role === attestation.role, 'ROLE_ATTEMPT_PREDECESSOR_MISMATCH', attestation.role);
    } else {
      const intentPath = previousSeq === 1 ? join(runDir, 'native-dispatch', `${attestation.role}.json`) : join(runDir, 'native-dispatch', attestation.role, `attempt-${previousSeq}`, 'intent.json');
      let closed = false;
      try {
        const { verifyNativeAttemptClosure } = await import('./native-dispatch.mjs');
        closed = verifyNativeAttemptClosure({ runDir, intent: readJson(intentPath) });
      } catch { closed = false; }
      requireValue(closed, 'ROLE_ATTEMPT_PREDECESSOR_MISSING', attestation.role);
    }
    for (const existingPath of roleAttestationPaths(runDir, attestation.role)) {
      const existing = verifyAttestation(runDir, readJson(existingPath), roster);
      requireValue(existing.dispatch_attempt_id !== attestation.dispatch_attempt_id && existing.agent_id !== attestation.agent_id && existing.session_id !== attestation.session_id, 'ROLE_ATTEMPT_REUSED', attestation.role);
    }
  }
  for (const role of ROLES) {
    const candidates = [join(runDir, 'role-bindings', `${role}.json`), ...roleAttestationPaths(runDir, role)];
    for (const otherPath of candidates) {
      if (!existsSync(otherPath) || resolve(otherPath) === resolve(path)) continue;
      const other = verifyAttestation(runDir, readJson(otherPath), roster);
      requireValue(other.agent_id !== attestation.agent_id && other.session_id !== attestation.session_id, 'ROLE_SESSION_REUSED', role);
    }
  }
  await writeConfirmed(path, stableJson(attestation), 'teamqa.role.bind');
  return assertRoleAttestation({ runDir, role: attestation.role, roster, ...(attestation.schema === 'team-qa/role-attestation/v2' ? { dispatchAttemptId: attestation.dispatch_attempt_id } : {}) });
}
function phase(runDir, roster) {
  const path = join(runDir, 'phase.json');
  requireValue(existsSync(path), 'RUN_CONTRACT_MISSING', path);
  const value = readJson(path);
  rejectUnknownFields(value, ['schema', 'run_id', 'round', 'roster_hash', 'phase'], 'RUN_CONTRACT_UNKNOWN');
  requireValue(value.schema === RUN_CONTRACT && value.run_id === roster.run_id && value.round === roster.round && value.roster_hash === roster.roster_hash && PHASES.includes(value.phase), 'RUN_CONTRACT_BINDING');
  return value;
}
export function readLockedRunDocuments(runDir, roster, { requirePublication = true } = {}) {
  const path = join(runDir, 'docs-lock.json');
  requireValue(existsSync(path), 'RUN_DOCUMENT_LOCK_MISSING');
  const lock = readJson(path);
  rejectUnknownFields(lock, ['schema', 'run_id', 'round', 'roster_hash', 'artifacts'], 'RUN_DOCUMENT_LOCK_UNKNOWN');
  requireValue(lock.schema === 'team-qa/docs-lock/v1' && lock.run_id === roster.run_id && lock.round === roster.round && lock.roster_hash === roster.roster_hash, 'RUN_DOCUMENT_LOCK_BINDING');
  rejectUnknownFields(lock.artifacts, DOCUMENT_ARTIFACTS, 'RUN_DOCUMENT_UNKNOWN');
  for (const [name, artifact] of Object.entries(lock.artifacts || {})) {
    rejectUnknownFields(artifact, ['path', 'sha256'], 'RUN_DOCUMENT_ARTIFACT_UNKNOWN', name);
    requireValue(typeof artifact.path === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256 || ''), 'RUN_DOCUMENT_ARTIFACT', name);
    // Final export bytes do not authorize execution; their readback remains mandatory at COMPLETE.
    if (requirePublication || !PUBLICATION_ARTIFACTS.includes(name))
      requireValue(existsSync(resolve(runDir, artifact.path)) && sha256File(resolve(runDir, artifact.path)) === artifact.sha256, 'RUN_DOCUMENT_STALE', name);
  }
  return lock;
}
function documentPath(runDir, lock, name) {
  requireValue(lock.artifacts?.[name], 'RUN_DOCUMENT_MISSING', name);
  return resolve(runDir, lock.artifacts[name].path);
}
function planInputs(runDir, roster, lock) {
  const source = readJson(documentPath(runDir, lock, 'source'));
  rejectUnknownFields(source, ['schema', 'run_id', 'version', 'target', 'refs'], 'SOURCE_MANIFEST_UNKNOWN');
  requireValue(source.schema === 'team-qa/source-manifest/v1' && source.run_id === roster.run_id && typeof source.version === 'string' && source.version.trim() && eq(source.target, roster.target), 'SOURCE_MANIFEST_BINDING');
  requireValue(Array.isArray(source.refs) && source.refs.length > 0 && new Set(source.refs.map((r) => r.id)).size === source.refs.length, 'SOURCE_REFS_MISSING');
  for (const ref of source.refs) {
    rejectUnknownFields(ref, ['id', 'path', 'sha256'], 'SOURCE_REF_UNKNOWN');
    requireValue(ref.id && typeof ref.path === 'string' && existsSync(resolve(runDir, ref.path)) && sha256File(resolve(runDir, ref.path)) === ref.sha256, 'SOURCE_REF_STALE', ref.id);
  }
  const dossier = readJson(documentPath(runDir, lock, 'dossier'));
  rejectUnknownFields(dossier, ['schema', 'run_id', 'source_sha256', 'analyst_attestation_sha256', 'findings'], 'DOSSIER_UNKNOWN');
  requireValue(dossier.schema === 'team-qa/analyst-dossier/v1' && dossier.run_id === roster.run_id && dossier.source_sha256 === lock.artifacts.source.sha256 && /^[a-f0-9]{64}$/.test(dossier.analyst_attestation_sha256 || ''), 'DOSSIER_BINDING');
  const analyst = assertRoleAttestation({ runDir, role: 'analyst', roster, attestationSha256: dossier.analyst_attestation_sha256 });
  requireValue(Array.isArray(dossier.findings) && dossier.findings.length > 0, 'DOSSIER_FINDINGS_MISSING');
  for (const finding of dossier.findings) {
    rejectUnknownFields(finding, ['summary', 'source_refs'], 'DOSSIER_FINDING_UNKNOWN');
    requireValue(typeof finding.summary === 'string' && finding.summary.trim() && Array.isArray(finding.source_refs) && finding.source_refs.length && finding.source_refs.every((id) => source.refs.some((r) => r.id === id)), 'DOSSIER_SOURCE_LINK');
  }
  const path = documentPath(runDir, lock, 'plan');
  const plan = loadPlan(path); valid(plan.errors);
  requireValue(plan.value.run_id === roster.run_id, 'RUN_ID_MISMATCH', 'plan');
  requireValue(plan.value.preflight, 'PREFLIGHT_SCOPE_REQUIRED');
  if (isDeployedTarget(roster.target)) requireValue(plan.value.preflight.code === false && plan.value.preflight.gui === true, 'WEB_SCOPE_GUI_ONLY');
  assertToolPreflight({ runDir, roster, stage: 'basic' });
  return { source, dossier, analyst, plan, path };
}
function signedPlan(runDir, plan, path) {
  const approvalFile = join(dirname(dirname(runDir)), 'control/approvals', basename(runDir), `plan-v${plan.value.plan_version}.json`);
  requireValue(existsSync(approvalFile), 'GATE_UNSIGNED', basename(runDir));
  const a = readJson(approvalFile);
  const roster = boundRun(runDir);
  requireValue(a.schema === 'team-qa/plan-approval/v2' && a.run_id === roster.run_id && a.round === roster.round && a.roster_hash === roster.roster_hash && a.historical_diagnostic !== true && a.current_run_graded !== false, 'GATE_LEGACY_NOT_OFFICIAL');
  const snapshot=join(runDir,'control/approvals/plan.json');requireValue(existsSync(snapshot)&&sha256File(snapshot)===sha256File(approvalFile),'PLAN_APPROVAL_SNAPSHOT_DRIFT');
  verifyPlanUserEvent(a.event,{runId:roster.run_id,round:roster.round,rosterHash:roster.roster_hash,planHash:sha256File(path)});
  const shown = loadPlanPresentation({ runDir, roster, plan: plan.value, planPath: path });
  assertPlanPresented(a.event, shown.input);
  requireValue(a.plan_sha256 === sha256File(path) && a.signed_by === 'owner' && !Number.isNaN(Date.parse(a.ts)), 'GATE_STALE', 'plan');
}
function canonicalBoard(runDir, roster, lock, tracked) {
  const path = documentPath(runDir, lock, 'board');
  const tool = resolve(process.env.TEAMQA_QA_GUI_BOARD_TOOL || join(siblingSkillRoot('qa-gui'), 'scripts/teamwork/cli.mjs'));
  const result = runAdapter([process.execPath, tool, 'validate', '--file', path]);
  requireValue(result.status === 0 && !result.error && !result.signal, 'RUN_BOARD_CONTRACT', (result.stderr || result.stdout).trim().slice(0, 400));
  const board = readJson(path);
  requireValue(board.boardId === roster.run_id && board.currentRound === roster.round, 'RUN_BOARD_BINDING');
  requireValue(eq(board.cases.map((c) => c.id).sort(), tracked.cases.map((c) => c.id).sort()), 'RUN_BOARD_CASES');
  for (const c of tracked.cases) requireValue(eq(board.cases.find((row) => row.id === c.id).sourceRefs, c.sourceRefs), 'RUN_BOARD_SOURCE_LINK', c.id);
  const template = resolve(dirname(process.env.TEAMQA_DOC_COLAB_SCRIPT || join(homedir(), '.agents/skills/doc-colab/scripts/make_doc.py')), '../assets/task-board.html');
  requireValue(documentPath(runDir, lock, 'template') === template, 'RUN_BOARD_TEMPLATE');
  return board;
}
function executeInputs(runDir, roster, lock) {
  const data = planInputs(runDir, roster, lock);
  signedPlan(runDir, data.plan, data.path);
  assertRoleAttestation({ runDir, role: 'designer', roster, latest: true });
  const tracked = loadTracked(documentPath(runDir, lock, 'tracked')); valid(tracked.errors);
  requireValue(tracked.value.schemaVersion === 2, 'TRACKED_SOURCE_SCHEMA_REQUIRED');
  const sources = new Set(data.source.refs.map((r) => r.id));
  for (const item of tracked.value.cases) requireValue(Object.hasOwn(data.plan.value.tiers, item.req_id) && item.sourceRefs.every((ref) => sources.has(ref)), 'TRACKED_SOURCE_LINK', item.id);
  const rtm = readFileSync(documentPath(runDir, lock, 'rtm'), 'utf8');
  validateRtmEdges(rtm, data.plan.value, tracked.value);
  canonicalBoard(runDir, roster, lock, tracked.value);
  if (roster.round > 1) {
    const change = readJson(documentPath(runDir, lock, 'change'));
    const selected = readJson(documentPath(runDir, lock, 'selection'));
    const expected = selectRetestCases(tracked.value, change);
    requireValue(eq(selected.caseIds, expected.caseIds) && selected.tracked_sha256 === lock.artifacts.tracked.sha256 && selected.change_sha256 === lock.artifacts.change.sha256 && selected.target_version === roster.target.version, 'RETEST_SELECTION_BINDING');
    const proof = readJson(documentPath(runDir, lock, 'fix_proof'));
    rejectUnknownFields(proof, ['schema', 'run_id', 'round', 'target_version', 'fixes'], 'RETEST_FIX_PROOF_UNKNOWN');
    for (const fix of proof.fixes || []) rejectUnknownFields(fix, ['case_id', 'artifact', 'sha256'], 'RETEST_FIX_UNKNOWN');
    requireValue(proof.schema === 'team-qa/fix-proof/v1' && proof.run_id === roster.run_id && proof.round === roster.round && proof.target_version === roster.target.version && Array.isArray(proof.fixes), 'RETEST_FIX_PROOF_BINDING');
    for (const id of change.defect_cases) requireValue(proof.fixes.some((fix) => fix.case_id === id && typeof fix.artifact === 'string' && existsSync(resolve(runDir, fix.artifact)) && sha256File(resolve(runDir, fix.artifact)) === fix.sha256), 'RETEST_FIX_PROOF_MISSING', id);
  }
  return { ...data, tracked };
}
export function assertRunContract(options) { return rereadWhileSourceChanges(() => assertRunContractOnce(options)); }
function assertRunContractOnce({ runDir, action, role, record, preDispatch = false, preflightFresh = preDispatch }) {
  requireValue(['plan', 'sign', 'design', 'execute', 'intake', 'complete', 'verify-result'].includes(action), 'RUN_ACTION_UNKNOWN', action);
  const roster = boundRun(runDir);
  if (isDeployedTarget(roster.target)) requireValue(role !== 'executor_code' && record?.source !== 'qa-code', 'WEB_CODE_DISPATCH_FORBIDDEN');
  const state = phase(runDir, roster);
  assertRoleAttestation({ runDir, role: 'test_manager', roster });
  const lock = readLockedRunDocuments(runDir, roster, { requirePublication: !['execute', 'intake', 'verify-result'].includes(action) });
  if (['plan', 'sign'].includes(action)) {
    requireValue(['PLAN', 'SIGN'].includes(state.phase), 'RUN_PHASE_REQUIRED', 'PLAN|SIGN');
    planInputs(runDir, roster, lock);
  } else if (action === 'design') {
    requireValue(['SIGN', 'DESIGN'].includes(state.phase), 'RUN_PHASE_REQUIRED', 'SIGN|DESIGN');
    const p = planInputs(runDir, roster, lock); signedPlan(runDir, p.plan, p.path);
    if (!preDispatch) assertRoleAttestation({ runDir, role: 'designer', roster, latest: true });
  } else {
    requireValue(action === 'complete' ? state.phase === 'COMPLETE' : action === 'verify-result' ? ['EXECUTE', 'COMPLETE'].includes(state.phase) : state.phase === 'EXECUTE', 'RUN_PHASE_REQUIRED', action === 'complete' ? 'COMPLETE' : 'EXECUTE');
    executeInputs(runDir, roster, lock);
    if (isDeployedTarget(roster.target)) {
      const binding = readJson(join(runDir, 'binding.json'));
      try { assertWebBinding(binding, { target: roster.target, runDir, requireProof: false }); }
      catch (error) { requireValue(false, 'WEB_BINDING_INVALID', error.message); }
    }
  }
  if (action === 'complete') {
    requireValue(state.phase === 'COMPLETE', 'RUN_PHASE_REQUIRED', 'COMPLETE');
    completeReadback(runDir, roster, lock);
  }
  if (role && !preDispatch) assertRoleAttestation({ runDir, role, roster, ...(role === 'designer' ? { latest: true } : {}) });
  const laneRole = role ?? (record?.source === 'qa-code' ? 'executor_code' : record?.source === 'qa-gui' ? 'executor_gui' : null);
  if (['executor_code', 'executor_gui'].includes(laneRole)) {
    const p = loadPlan(documentPath(runDir, lock, 'plan'));
    assertToolPreflight({ runDir, roster, stage: 'execute', role: laneRole, requirements: p.value.preflight, requireFresh: preflightFresh });
  }
  if (record && ['pass', 'fail'].includes(record.verdict)) {
    const executor = record.source === 'qa-code' ? 'executor_code' : record.source === 'qa-gui' ? 'executor_gui' : null;
    requireValue(executor, 'CHILD_ROLE_REQUIRED');
    const bindingFile = join(runDir, 'binding.json');
    requireValue(existsSync(bindingFile), 'BINDING_MISSING');
    const binding = readJson(bindingFile);
    if (isDeployedTarget(roster.target)) {
      try { assertWebBinding(binding, { target: roster.target, runDir, requireProof: false }); }
      catch (error) { requireValue(false, 'WEB_BINDING_INVALID', error.message); }
    } else requireValue(binding.run_uuid && binding.requirements_hash && binding.exact_final_sha, 'BINDING_CURRENT_REQUIRED');
    const tracked = loadTracked(documentPath(runDir, lock, 'tracked'));
    const planned = tracked.value.cases.find((c) => c.id === record.case_id);
    requireValue(planned && record.run_id === roster.run_id && record.lane === planned.lane, 'CHILD_CASE_BINDING', record.case_id);
    const targetLock = { governed: true, declared: roster.target };
    const issues = [evidenceIssue(record, join(runDir, 'board.jsonl')), dualVerdictIssue(record, targetLock), childVerdictIssue(record, join(runDir, 'board.jsonl'), targetLock, binding, planned.req_id), attemptSequenceIssue(record, targetLock)].filter(Boolean);
    requireValue(issues.length === 0, 'CHILD_EVIDENCE_GATE', issues.join(';'));

    requireValue(eq(record.target, roster.target), 'CHILD_TARGET_MISMATCH');
    if (isDeployedTarget(roster.target)) requireValue(record.target_binding_sha256 === binding.target_binding_sha256 && record.target_kind === 'deployed-build', 'WEB_RECORD_BINDING_MISMATCH');
    requireValue(record.child_verdict, 'CHILD_VERDICT_MISSING');
    const child = readJson(resolve(runDir, record.child_verdict.artifact));
    const p = child.dispatch_proof;
    const a = assertRoleAttestation({ runDir, role: executor, roster,
      ...(p?.attestation_path ? { attestationPath: p.attestation_path, attestationSha256: p.attestation_sha256 } : {}),
      ...(p?.dispatch_attempt_id ? { dispatchAttemptId: p.dispatch_attempt_id } : {}) });
    if (p?.schema === 'team-qa/child-dispatch-proof/v1') {
      const validated = verifyChildDispatchProof(p, { stage: 'post', attestation: a });
      requireValue(validated.authorized && p.role === executor && p.run_id === roster.run_id && p.round === roster.round && p.roster_hash === roster.roster_hash, 'CHILD_DISPATCH_PROOF_MISMATCH', record.case_id);
      requireValue(typeof p.attestation_path === 'string' && existsSync(p.attestation_path) && readJson(p.attestation_path).session_id === a.session_id, 'CHILD_ATTESTATION_HASH', record.case_id);
    } else {
      requireValue(p && p.run_id === roster.run_id && p.round === roster.round && p.roster_hash === roster.roster_hash && p.role === executor && p.agent_id === a.agent_id && p.session_id === a.session_id && p.graded === true && eq(p.source, a.source) && eq(p.runtime, a.runtime) && eq(p.context, a.context), 'CHILD_DISPATCH_PROOF_MISMATCH', record.case_id);
    }
  }
  return { runDir, roster, state, lock };
}
export async function lockRunDocuments({ runDir, artifacts }) {
  const roster = boundRun(runDir);
  assertRoleAttestation({ runDir, role: 'test_manager', roster });
  const lock = { schema: 'team-qa/docs-lock/v1', run_id: roster.run_id, round: roster.round, roster_hash: roster.roster_hash, artifacts };
  // Immutable snapshots: each affected lock is explicitly replaced after review.
  const file = join(runDir, 'docs-lock.json');
  rejectUnknownFields(artifacts, DOCUMENT_ARTIFACTS, 'RUN_DOCUMENT_UNKNOWN');
  for (const [name, artifact] of Object.entries(artifacts || {})) rejectUnknownFields(artifact, ['path', 'sha256'], 'RUN_DOCUMENT_ARTIFACT_UNKNOWN', name);
  if (existsSync(file)) await writeConfirmed(join(runDir, 'archive', `docs-lock-${sha256File(file)}.json`), readFileSync(file, 'utf8'), 'teamqa.docs.archive');
  for (const [name, artifact] of Object.entries(artifacts || {})) {
    requireValue(typeof artifact?.path === 'string' && existsSync(resolve(runDir, artifact.path)) && sha256File(resolve(runDir, artifact.path)) === artifact.sha256, 'RUN_DOCUMENT_STALE', name);
  }
  await writeConfirmed(file, stableJson(lock), 'teamqa.docs.lock');
  readLockedRunDocuments(runDir, roster);
  return lock;
}
// A transition reads the root's live transcript before it writes the phase; when the only refusal is that the
// transcript changed during the read, the transition runs again (seen on `run transition --to DESIGN`).
export async function transitionRun(options) {
  for (let attempt = 1; ; attempt++) {
    try { return await transitionRunOnce(options); } catch (error) { if (!sourceRaced(error) || attempt >= 5) throw error; pauseSync(150 * attempt); }
  }
}
async function transitionRunOnce({ runDir, to }) {
  const roster = boundRun(runDir);
  requireValue(PHASES.includes(to), 'RUN_PHASE_UNKNOWN', to);
  assertRoleAttestation({ runDir, role: 'test_manager', roster });
  const current = existsSync(join(runDir, 'phase.json')) ? phase(runDir, roster) : null;
  requireValue(PHASES.indexOf(to) === (current ? PHASES.indexOf(current.phase) + 1 : 0), 'RUN_PHASE_SEQUENCE', `${current?.phase || 'START'}->${to}`);
  const lock = readLockedRunDocuments(runDir, roster, { requirePublication: to === 'COMPLETE' });
  if (to === 'PLAN' || to === 'SIGN') planInputs(runDir, roster, lock);
  if (to === 'DESIGN') { const p = planInputs(runDir, roster, lock); signedPlan(runDir, p.plan, p.path); assertRoleAttestation({ runDir, role: 'designer', roster, latest: true }); }
  if (to === 'EXECUTE' || to === 'COMPLETE') executeInputs(runDir, roster, lock);
  if (to === 'COMPLETE') {
    completeReadback(runDir, roster, lock);
    const board = loadBoard(join(runDir, 'board.jsonl')); valid(board.errors);
    const tracked = loadTracked(documentPath(runDir, lock, 'tracked'));
    const latest = latestAttemptByCase(board.records);
    requireValue(!latest.issue, 'RUN_ATTEMPT_HISTORY_INVALID', latest.issue);
    requireValue(tracked.value.cases.every((c) => ['pass', 'fail'].includes(latest.latestByCase.get(c.id)?.verdict)), 'RUN_COVERAGE_INCOMPLETE');
    for (const record of board.records) assertRunContract({ runDir, action: 'intake', record });
  }
  const next = { schema: RUN_CONTRACT, run_id: roster.run_id, round: roster.round, roster_hash: roster.roster_hash, phase: to };
  if (current) await writeConfirmed(join(runDir, 'archive', `phase-${current.phase}.json`), stableJson(current), 'teamqa.phase.archive');
  await writeConfirmed(join(runDir, 'phase.json'), stableJson(next), 'teamqa.phase.transition');
  phase(runDir, roster);
  return next;
}

export function assertArtifactPath(contract, name, path) {
  requireValue(realpathSync(documentPath(contract.runDir, contract.lock, name)) === realpathSync(resolve(path)), 'RUN_DOCUMENT_PATH_MISMATCH', name);
}

function completeReadback(runDir, roster, lock) {
  const board = documentPath(runDir, lock, 'board');
  // U5: an unattended run whose board review stayed FAIL after the repair rounds completes with its blocked delivery
  // (board-delivery.mjs) in place of the published board; a run with a published board keeps every readback.
  const delivered = lock.artifacts.board_render || lock.artifacts.board_payload || lock.artifacts.board_notion;
  const blocked = delivered ? null : verifyBlockedBoardDelivery({ runDir, roster, boardPath: board });
  if (blocked) requireValue(!lock.artifacts.board_quality && !lock.artifacts.board_snapshot && !lock.artifacts.board_write, 'BOARD_DELIVERY_CONFLICT', 'a blocked board has no delivery artifacts');
  // B0: a Notion delivery through the Notion MCP is proved by its receipt; its quality seal sits on the projection.
  const notion = !blocked && lock.artifacts.board_notion ? verifyNotionReceipt({ runDir, receiptPath: documentPath(runDir, lock, 'board_notion'), boardPath: board }) : null;
  const artifact = blocked ? null : notion ? notion.projection.path : documentPath(runDir, lock, lock.artifacts.board_render ? 'board_render' : 'board_payload');
  if (!blocked) requireValue(realpathSync(documentPath(runDir, lock, 'board_quality')) === realpathSync(artifact + '.quality.json'), 'RUN_BOARD_QUALITY_PATH');
  const renderedWith = !blocked && !notion && lock.artifacts.board_render ? readJson(artifact + '.quality.json').renderer : null;
  if (blocked || notion) { /* no delivery to read back, or the Notion receipt above */ }
  else if (renderedWith === 'native') verifyBoardDelivery({ file: board, artifactPath: artifact, renderer: 'native' });
  else if (lock.artifacts.board_render) boardIntegrityVerify(['--file', board, '--artifact', documentPath(runDir, lock, 'board_render')], true);
  else {
    const args = ['--file', board, '--snapshot', documentPath(runDir, lock, 'board_snapshot'), '--payload', artifact];
    if (lock.artifacts.board_evidence_map) args.push('--evidence-map', documentPath(runDir, lock, 'board_evidence_map'));
    boardComparePage(args);
  }
  const canonical = readJson(board);
  const records = loadBoard(join(runDir, 'board.jsonl')); valid(records.errors);
  const latest = latestAttemptByCase(records.records);
  requireValue(!latest.issue, 'RUN_ATTEMPT_HISTORY_INVALID', latest.issue);
  for (const c of canonical.cases) {
    const r = latest.latestByCase.get(c.id);
    requireValue(r && ['pass', 'fail'].includes(r.verdict), 'RUN_COVERAGE_INCOMPLETE', c.id);
    requireValue(c.functionVerdict === String(r.function_verdict).toUpperCase() && c.uiVerdict === String(r.ui_visual_verdict).toUpperCase(), 'RUN_BOARD_VERDICT_MISMATCH', c.id);
    assertRunContract({ runDir, action: 'verify-result', record: r });
  }
}

// The RTM tokens (requirement header, gap marker) come from report-tokens.mjs; legacy RTM files parse too.
export function validateRtmEdges(text, plan, tracked) {
  const cells = (line) => line.split('|').slice(1, -1).map((value) => value.trim());
  const lines = text.split(/\r?\n/);
  const header = lines.find((line) => line.startsWith('| Source |'));
  requireValue(header, 'RTM_SOURCE_LINK', 'header');
  const columns = cells(header);
  const fields = ['Source', 'Source system', 'Source key', 'Source title', 'Case', RTM_REQUIREMENT, 'Tier', 'Priority'];
  const indexes = fields.map((field) => field === RTM_REQUIREMENT ? rtmRequirementIndex(columns) : columns.indexOf(field));
  requireValue(indexes.every((i) => i >= 0), 'RTM_SOURCE_LINK', 'columns');
  const rows = lines.filter((line) => /^\|[^-].*\|$/.test(line) && line !== header).map(cells).filter((row) => !isRtmEmpty(row[columns.indexOf('Case')]));
  const escaped = (value) => String(value ?? '').replaceAll('|', '&#124;').replaceAll(/\r?\n/g, ' ');
  const expected = sourceTraceabilityRows(tracked).filter((row) => row.caseId !== null).map((row) => [row.sourceRef, row.sourceSystem, row.externalKey, row.sourceTitle, row.caseId, row.requirement, plan.tiers[row.requirement], row.priority].map(escaped));
  requireValue(eq(rows.map((row) => indexes.map((i) => row[i])), expected), 'RTM_SOURCE_LINK', 'edges');
}
