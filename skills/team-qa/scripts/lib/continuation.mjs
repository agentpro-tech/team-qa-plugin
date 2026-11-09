import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fail, readJson, rejectUnknownFields, sha256, sha256File, stableJson, writeConfirmed, runAdapter } from './core.mjs';
import { assertApprovedRoster, verifyProviderInterface } from './roster.mjs';
import { assertRunContract } from './run-contract.mjs';
import { loadBoard, loadTracked, evidenceIssue } from './validators.mjs';
import { attemptId, latestAttemptByCase } from './attempt-sequence.mjs';
import { targetIdentityIssue } from './target-lock.mjs';
import { withOriginalSourceRead } from './original-source.mjs';

export const AUTOMATIC_CONTINUATION = 'TEAMQA_AUTOMATIC_CONTINUATION';
export const CONTINUATION_SCHEMA = 'team-qa/continuation-decision/v1';
const need = (v, code) => { if (!v) fail(3, code, '', 'ungraded'); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const hash = v => /^[a-f0-9]{64}$/.test(v || '');
const safeId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
function runtimeHash() {
  return sha256(stableJson(['continuation.mjs', 'original-source.mjs', 'dragon-admission.mjs', 'run-contract.mjs', 'roster.mjs', 'host-transcript.mjs', '../hooks/qa-lifecycle.mjs']
    .map(path => [path, sha256File(new URL(path, import.meta.url))])));
}

function proofPresent(ref, runDir) {
  if (!object(ref) || Object.keys(ref).some(k => !['path', 'sha256'].includes(k)) || !hash(ref.sha256) || typeof ref.path !== 'string') return false;
  try {
    const path = realpathSync(resolve(runDir, ref.path));
    return path.startsWith(realpathSync(runDir) + sep) && statSync(path).isFile() && statSync(path).size > 0 && sha256File(path) === ref.sha256;
  } catch { return false; }
}

// Pure scheduling decision. The reader below supplies validated contract/evidence facts.
export function decideContinuation({ cases, records = [], validRecord = () => null, validBlocker = () => false, complete = false, contractError = null, exhausted = [], maxAttempts = 3 }) {
  need(Array.isArray(cases) && cases.length > 0 && new Set(cases.map(c => c.id)).size === cases.length, 'CONTINUATION_CASES_REQUIRED');
  need(Number.isInteger(maxAttempts) && maxAttempts > 0 && maxAttempts <= 3, 'CONTINUATION_ATTEMPT_CAP');
  const history = { histories: new Map(), latestByCase: new Map(), issues: new Map() };
  for (const c of cases) {
    const rows = records.filter(record => record?.case_id === c.id);
    const local = latestAttemptByCase(rows, validRecord);
    history.histories.set(c.id, local.histories.get(c.id) || []);
    if (local.issue) history.issues.set(c.id, local.issue);
    else {
      const latest = local.latestByCase.get(c.id);
      const rawLatest = rows.filter(record => record?.verdict !== 'pending').at(-1);
      const validation = rawLatest && ['pass', 'fail'].includes(rawLatest.verdict) && !latest ? validRecord(rawLatest) : null;
      if (validation) history.issues.set(c.id, validation);
      else if (latest) history.latestByCase.set(c.id, latest);
    }
  }
  // Per-case validation keeps one malformed chain from suppressing independent
  // work; explicit attempt IDs remain globally unique across the board.
  const ids = new Map();
  for (const record of records) {
    if (record?.verdict === 'pending' || typeof record?.case_id !== 'string') continue;
    const id = attemptId(record), owners = ids.get(id) || new Set();
    owners.add(record.case_id); ids.set(id, owners);
  }
  for (const [id, owners] of ids) if (owners.size > 1) {
    for (const caseId of owners) history.issues.set(caseId, `ATTEMPT_HISTORY_DUPLICATE_ID ${id}`);
  }
  const globalHistory = latestAttemptByCase(records, validRecord);
  if (globalHistory.issue && history.issues.size === 0) {
    for (const c of cases) history.issues.set(c.id, globalHistory.issue);
  }
  const ready = [], running = [], diagnose = [], blocked = [], unresolved = [];
  for (const c of cases) {
    const historyIssue = history.issues.get(c.id);
    if (historyIssue) {
      unresolved.push(c.id);
      blocked.push({ caseId: c.id, kind: 'history', code: historyIssue, owner: 'run controller', unblockCondition: 'Repair the affected append-only attempt history while preserving every existing row.' });
      const attempts = (history.histories.get(c.id) || []).filter(r => r.verdict !== 'pending').length;
      if (!exhausted.includes(c.id) && attempts < maxAttempts) diagnose.push({ caseId: c.id, kind: 'diagnose', action: 'Inspect the affected history and proof, preserve all existing rows, and determine whether a valid subsequent attempt can be appended through the approved intake path.' });
      continue;
    }
    const latest = history.latestByCase.get(c.id);
    if (latest && ['pass', 'fail'].includes(latest.verdict) && !c.work?.remainingChecks?.length) continue;
    unresolved.push(c.id);
    const work = c.work;
    const attempts = (history.histories.get(c.id) || []).filter(r => r.verdict !== 'pending').length;
    if (exhausted.includes(c.id) || attempts >= maxAttempts) {
      blocked.push({ caseId: c.id, kind: 'execution', code: 'CONTINUATION_RECOVERY_EXHAUSTED', owner: 'run controller', unblockCondition: 'New evidence or a revised authorized recovery approach is required.' });
    } else if (work?.state === 'blocked' && validBlocker(work.blocker, c)) {
      blocked.push({ caseId: c.id, ...work.blocker });
    } else if (work?.state === 'running') {
      running.push({ caseId: c.id, kind: 'wait', action: 'Observe the assigned worker and verify its result.', workerSessionId: work.workerSessionId });
    } else {
      ready.push({ caseId: c.id, kind: 'execute', action: work?.nextAction || 'Execute the remaining approved case checks and collect their evidence.' });
    }
  }
  if (contractError) {
    const permission = /(?:GATE_(?:UNSIGNED|STALE|LEGACY)|ROSTER_(?:UNAPPROVED|NOT_APPROVED)|USER_APPROVAL_REQUIRED|PLAN_APPROVAL|HUMAN_EVENT_)/.test(contractError);
    return { schema: CONTINUATION_SCHEMA, disposition: permission || exhausted.includes('__contract__') ? 'WAIT' : 'CONTINUE', code: contractError, incomplete: true,
      next: permission || exhausted.includes('__contract__') ? null : { caseId: '__contract__', kind: 'diagnose', action: 'Inspect the reported error and original evidence. Restore only authorized run preparation within the existing scope; preserve contracts and approval gates. Do not execute dependent product cases.' }, blocked, unresolved };
  }
  const next = ready[0] || running[0] || diagnose[0];
  if (next) return { schema: CONTINUATION_SCHEMA, disposition: 'CONTINUE', code: next.kind === 'wait' ? 'WORKER_PENDING' : next.kind === 'diagnose' ? 'CASE_HISTORY_DIAGNOSIS_REQUIRED' : 'CASE_WORK_REMAINING', incomplete: true, next, blocked, unresolved };
  if (unresolved.length) return { schema: CONTINUATION_SCHEMA, disposition: 'WAIT', code: 'ALL_REMAINING_WORK_BLOCKED', incomplete: true, next: null, blocked, unresolved };
  if (!complete) return { schema: CONTINUATION_SCHEMA, disposition: exhausted.includes('__completion__') ? 'WAIT' : 'CONTINUE', code: 'FORMAL_COMPLETION_PENDING', incomplete: true,
    next: exhausted.includes('__completion__') ? null : { caseId: '__completion__', kind: 'verify', action: 'Verify coverage, formal evidence and required report readback through the existing COMPLETE gate.' }, blocked: [], unresolved: [] };
  return { schema: CONTINUATION_SCHEMA, disposition: 'COMPLETE', code: 'RUN_COMPLETE_VERIFIED', incomplete: false, next: null, blocked: [], unresolved: [] };
}

function lockedPath(runDir, lock, key) {
  const ref = lock.artifacts?.[key];
  need(ref && typeof ref.path === 'string' && hash(ref.sha256), 'CONTINUATION_DOCUMENT_REQUIRED');
  const path = resolve(runDir, ref.path);
  need(existsSync(path) && sha256File(path) === ref.sha256, 'CONTINUATION_DOCUMENT_DRIFT');
  return path;
}

export function readContinuation({ runDir, exhausted = [] }) {
  return withOriginalSourceRead(()=>readContinuationSource({runDir,exhausted}));
}

function readContinuationSource({ runDir, exhausted }) {
  runDir = realpathSync(runDir);
  const roster = assertApprovedRoster({ runDir });
  const lock = readJson(join(runDir, 'docs-lock.json'));
  need(lock.run_id === roster.run_id && lock.round === roster.round && lock.roster_hash === roster.roster_hash, 'CONTINUATION_LOCK_BINDING');
  const tracked = loadTracked(lockedPath(runDir, lock, 'tracked'));
  need(!tracked.errors.length, 'CONTINUATION_TRACKED_INVALID');
  const canonicalPath = lockedPath(runDir, lock, 'board');
  const gui = verifyProviderInterface({ skill: 'qa-gui' });
  const validation = runAdapter([process.execPath, join(gui.root, 'scripts/teamwork/cli.mjs'), 'validate', '--file', canonicalPath], { timeout: 10000 });
  need(validation.status === 0 && !validation.error && !validation.signal, 'CONTINUATION_CANONICAL_INVALID');
  const canonical = readJson(canonicalPath);
  need(canonical.boardId === roster.run_id && canonical.currentRound === roster.round, 'CONTINUATION_BOARD_BINDING');
  need(stableJson(canonical.cases.map(c => c.id).sort()) === stableJson(tracked.value.cases.map(c => c.id).sort()), 'CONTINUATION_CASE_SCOPE');
  const boardPath = join(runDir, 'board.jsonl');
  const board = existsSync(boardPath) ? loadBoard(boardPath) : { records: [], errors: [] };
  need(!board.errors.length, 'CONTINUATION_RECORD_INVALID');
  const declared = { governed: true, declared: roster.target };
  for (const row of board.records) {
    const planned = tracked.value.cases.find(c => c.id === row.case_id);
    need(planned && row.run_id === roster.run_id && row.lane === planned.lane && stableJson(row.sourceRefs) === stableJson(planned.sourceRefs), 'CONTINUATION_RECORD_SCOPE');
    need(!targetIdentityIssue(row, declared), 'CONTINUATION_TARGET_DRIFT');
  }
  const validRecord = row => {
    if (!['pass', 'fail'].includes(row.verdict)) return null;
    try { assertRunContract({ runDir, action: 'verify-result', record: row }); return evidenceIssue(row, boardPath); }
    catch (e) { return e.code || 'CONTINUATION_RESULT_UNVERIFIED'; }
  };
  let contractError = null, complete = false;
  try { assertRunContract({ runDir, action: 'execute', preDispatch: true }); }
  catch (e) { contractError = e.code || 'CONTINUATION_CONTRACT_UNVERIFIED'; }
  const state = readJson(join(runDir, 'phase.json'));
  if (state.phase === 'COMPLETE') {
    try { assertRunContract({ runDir, action: 'complete' }); complete = true; contractError = null; }
    catch (e) { contractError = e.code || 'CONTINUATION_COMPLETE_UNVERIFIED'; }
  }
  const decision = decideContinuation({ cases: canonical.cases, records: board.records, validRecord, complete, contractError, exhausted,
    validBlocker: (blocker, c) => object(blocker) && c.work.evidence?.length > 0 && c.work.evidence.every(ref => proofPresent(ref, runDir)) });
  const verified = board.records.filter(row => ['pass', 'fail'].includes(row.verdict) && !validRecord(row));
  const progressByCase = Object.fromEntries(canonical.cases.map(c => [c.id, sha256(stableJson(verified.filter(row => row.case_id === c.id)
    .map(row => [row.attempt, row.verdict, row.child_verdict?.sha256])))]));
  return { ...decision, runId: roster.run_id, round: roster.round, rosterHash: roster.roster_hash,
    progress: sha256(stableJson({ phase: state.phase, results: verified.map(row => [row.case_id, row.attempt, row.verdict, row.child_verdict?.sha256]) })), progressByCase, planHash: lock.artifacts.plan?.sha256 };
}

// A binding that no longer matches its run: another Team QA runtime, the run directory gone, or its roster, round or
// target changed (a new round). The hook then refuses only Dragon and board writes for the session and lets other calls
// through with a warning; `register` again binds the new round, `unregister` ends the binding.
export const BINDING_DRIFT_CODES = ['CONTINUATION_RUNTIME_DRIFT', 'CONTINUATION_RUN_MISSING', 'CONTINUATION_SCOPE_DRIFT'];
const bindingPath = (registryDir, sessionId) => { need(safeId(sessionId), 'CONTINUATION_SESSION_INVALID'); return join(resolve(registryDir), `${sessionId}.json`); };
function bindingDrift(binding) {
  if (binding.runtime_sha256 !== runtimeHash()) return 'CONTINUATION_RUNTIME_DRIFT';
  const rosterPath = join(binding.run_dir, 'roster.json');
  if (!existsSync(rosterPath)) return 'CONTINUATION_RUN_MISSING';
  let roster;
  try { roster = JSON.parse(readFileSync(rosterPath, 'utf8')); } catch { return 'CONTINUATION_SCOPE_DRIFT'; }
  if (binding.roster_sha256 !== sha256File(rosterPath) || binding.round !== roster?.round || binding.target_sha256 !== sha256(stableJson(roster?.target))) return 'CONTINUATION_SCOPE_DRIFT';
  return null;
}
// The archive folder next to the registry keeps every binding taken out of use; a binding is never deleted.
function archiveBinding(path) {
  const dir = join(dirname(path), 'archive');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archived = join(dir, `${basename(path, '.json')}.${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`);
  const sha256 = sha256File(path);
  renameSync(path, archived);
  return { archived, sha256 };
}

export async function registerContinuation({ runDir, sessionId, registryDir }) {
  runDir = realpathSync(runDir); registryDir = resolve(registryDir);
  need(safeId(sessionId) && basename(dirname(runDir)) === 'runs', 'CONTINUATION_REGISTRATION_SCOPE');
  const rosterPath = join(runDir, 'roster.json'), roster = readJson(rosterPath);
  const host = roster.roles?.find(r => r.role === 'test_manager')?.native_host;
  need(roster.run_id === basename(runDir) && Number.isInteger(roster.round), 'CONTINUATION_REGISTRATION_HOST');
  if (host) {
    need(host.session_id === sessionId, 'CONTINUATION_REGISTRATION_HOST');
    const { verifyNativeHost } = await import('./native-host.mjs');
    verifyNativeHost(host);
  } else {
    // CLI-seat rosters (for example a Claude Code root with `claude -p` workers) bind the
    // root session that carried the verified human roster approval.
    const { orchestratorSessionId } = await import('./roster.mjs');
    assertApprovedRoster({ runDir });
    need(orchestratorSessionId(runDir) === sessionId, 'CONTINUATION_REGISTRATION_HOST');
  }
  const record = { schema: 'team-qa/continuation-binding/v1', session_id: sessionId, run_dir: runDir,
    run_id: roster.run_id, round: roster.round, roster_sha256: sha256File(rosterPath), target_sha256: sha256(stableJson(roster.target)),
    browser_session_id: `teamqa-${roster.run_id}-${sessionId.slice(0, 8)}`,
    runtime_sha256: runtimeHash(), created_at: new Date().toISOString() };
  const path = join(registryDir, `${sessionId}.json`);
  // A binding that still matches its run is kept; one that drifted (a new round, another runtime, the run gone) is
  // archived and replaced, after the checks above verified this registration again.
  let replaced = null;
  if (existsSync(path)) {
    let drift = null;
    try { drift = inspectContinuationBinding({ registryDir, sessionId }).drift; } catch { drift = null; }
    need(drift, 'CONTINUATION_ALREADY_REGISTERED');
    replaced = { ...archiveBinding(path), drift };
  }
  await writeConfirmed(path, stableJson(record), 'teamqa.continuation.register', { exclusive: true });
  return { path, sha256: sha256File(path), record, ...(replaced ? { replaced } : {}) };
}

// Ends a session's binding: the binding file moves to the archive folder next to it. The session's hooks then treat it as
// unregistered ({}); its run's evidence stays where it is.
export function unregisterContinuation({ registryDir, sessionId }) {
  const path = bindingPath(registryDir, sessionId);
  need(existsSync(path) && statSync(path).isFile(), 'CONTINUATION_NOT_REGISTERED');
  return { session_id: sessionId, ...archiveBinding(path) };
}

// The binding of a session and whether it drifted from its run. A malformed binding file still throws.
export function inspectContinuationBinding({ registryDir, sessionId }) {
  const path = bindingPath(registryDir, sessionId);
  if (!existsSync(path)) return null;
  const binding = readJson(path);
  rejectUnknownFields(binding, ['schema','session_id','run_dir','run_id','round','roster_sha256','target_sha256','browser_session_id','runtime_sha256','created_at'], 'CONTINUATION_BINDING_FIELDS');
  need(binding.schema === 'team-qa/continuation-binding/v1' && binding.session_id === sessionId && typeof binding.run_dir === 'string' && binding.run_id === basename(binding.run_dir), 'CONTINUATION_BINDING_INVALID');
  need(binding.browser_session_id === `teamqa-${binding.run_id}-${sessionId.slice(0, 8)}`, 'CONTINUATION_BROWSER_OWNER');
  return { binding, path, drift: bindingDrift(binding) };
}

export function readContinuationBinding({ registryDir, sessionId }) {
  const found = inspectContinuationBinding({ registryDir, sessionId });
  if (!found) return null;
  if (found.drift) fail(3, found.drift, '', 'ungraded');
  return found.binding;
}

export function automaticContinuationReason(decision) {
  return AUTOMATIC_CONTINUATION + '\n' + stableJson({ run_id: decision.runId, disposition: decision.disposition, code: decision.code, next: decision.next, authority: 'existing_verified_scope_only' });
}
