// Parallel GUI lanes (upgrade R3, flag `parallel_gui_lanes`). With the flag off, GUI lanes run one after another as
// before and nothing here applies. With it on, a lane with `parallel_ok: true` may run at the same time as another
// such lane only when each names its own test account or tenant (`account`), data namespace (`data_namespace`) and
// Dragon session (`dragon_session`, the prefix of the Dragon sessionId its executor creates), and no two parallel
// lanes share any of the three. `plan validate` refuses a plan that breaks this; a GUI case dispatch that would run
// beside a running GUI case of the same lane, of a lane that is not parallel_ok, or of a lane sharing an account,
// namespace or session is refused (DISPATCH_PARALLEL_LANES_REFUSED). `shadow` refuses nothing and records what `on`
// would have decided in decisions.jsonl.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendSpeedDecision, DECISION_SCHEMA } from './cost-ladder.mjs';
import { runSpeedPolicy, speedMode } from './speed.mjs';

export const LANE_IDENTITY_FIELDS = Object.freeze(['account', 'data_namespace', 'dragon_session']);
const norm = (value) => String(value).trim().toLowerCase();
const SHARED = { account: 'PLAN_PARALLEL_LANE_SHARED_ACCOUNT', data_namespace: 'PLAN_PARALLEL_LANE_SHARED_NAMESPACE', dragon_session: 'PLAN_PARALLEL_LANE_SHARED_SESSION' };

// Errors of the plan's parallel lanes, whatever the flag says (the caller decides whether they refuse).
export function parallelLaneErrors(planValue) {
  const lanes = Array.isArray(planValue?.lanes) ? planValue.lanes : [];
  const errors = [];
  const parallel = lanes.map((lane, index) => ({ lane, index })).filter(({ lane }) => lane?.parallel_ok === true);
  for (const { lane, index } of parallel) {
    for (const field of LANE_IDENTITY_FIELDS) if (typeof lane[field] !== 'string' || !lane[field].trim()) errors.push(`PLAN_PARALLEL_LANE_IDENTITY lanes[${index}].${field}`);
  }
  for (let i = 0; i < parallel.length; i += 1) for (let j = i + 1; j < parallel.length; j += 1) {
    const a = parallel[i], b = parallel[j];
    for (const field of LANE_IDENTITY_FIELDS) {
      if (typeof a.lane[field] === 'string' && typeof b.lane[field] === 'string' && a.lane[field].trim() && norm(a.lane[field]) === norm(b.lane[field])) {
        errors.push(`${SHARED[field]} lanes[${a.index}] lanes[${b.index}]`);
      }
    }
  }
  return errors;
}

// The lane errors `plan validate` refuses: only under parallel_gui_lanes on.
export function planParallelErrors(planValue) {
  return planValue?.speed?.parallel_gui_lanes === 'on' ? parallelLaneErrors(planValue) : [];
}

function readPlanValue(runDir, policy) {
  const text = readFileSync(resolve(runDir, policy.source.path), 'utf8');
  const start = text.indexOf('TEAMQA_PLAN_START'), end = text.indexOf('TEAMQA_PLAN_END');
  return JSON.parse(text.slice(start + 'TEAMQA_PLAN_START'.length, end));
}
function trackedCases(runDir) {
  try {
    const ref = JSON.parse(readFileSync(join(runDir, 'docs-lock.json'), 'utf8')).artifacts?.tracked;
    return JSON.parse(readFileSync(resolve(runDir, ref.path), 'utf8')).cases ?? [];
  } catch { return []; }
}
const alive = (pid) => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };

// The other GUI case dispatches of the run that are running now (state starting or running, process alive).
export function runningGuiCases(runDir, { exceptAttempt = null } = {}) {
  const dir = join(runDir, 'dispatch', 'executor_gui');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name !== exceptAttempt).flatMap((name) => {
    try {
      const state = JSON.parse(readFileSync(join(dir, name, 'state.json'), 'utf8'));
      const pid = state.status === 'running' ? state.pid : null;
      return ['starting', 'running'].includes(state.status) && typeof state.case_id === 'string' && (pid === null ? state.status === 'starting' : alive(pid))
        ? [{ attempt: name, case_id: state.case_id }] : [];
    } catch { return []; }
  });
}

// Checked when a GUI case dispatch starts. Returns null to go ahead, or the refusal (under `on` only).
export async function parallelDispatchIssue({ runDir, caseId, attempt }) {
  let policy;
  try { policy = runSpeedPolicy(runDir); } catch { return null; }
  const mode = speedMode(policy, 'parallel_gui_lanes');
  if (mode === 'off') return null;
  const running = runningGuiCases(runDir, { exceptAttempt: attempt });
  if (!running.length) return null;
  const planValue = readPlanValue(runDir, policy);
  const lanes = Array.isArray(planValue.lanes) ? planValue.lanes : [];
  const cases = trackedCases(runDir);
  const laneOf = (id) => { const req = cases.find((c) => c.id === id)?.req_id; const index = lanes.findIndex((l) => Array.isArray(l?.scope) && l.scope.includes(req)); return index < 0 ? null : { lane: lanes[index], index }; };
  const mine = laneOf(caseId);
  const errors = [];
  for (const other of running) {
    const theirs = laneOf(other.case_id);
    if (!mine || !theirs) { errors.push(`no plan lane for ${!mine ? caseId : other.case_id}`); continue; }
    if (mine.index === theirs.index) { errors.push(`same lane ${mine.lane.id} as running case ${other.case_id}`); continue; }
    for (const side of [mine, theirs]) if (side.lane.parallel_ok !== true) errors.push(`lane ${side.lane.id} is not parallel_ok`);
    errors.push(...parallelLaneErrors(planValue).filter((e) => e.includes(`lanes[${mine.index}]`) || e.includes(`lanes[${theirs.index}]`)));
  }
  const unique = [...new Set(errors)];
  await appendSpeedDecision(runDir, { schema: DECISION_SCHEMA, kind: 'parallel_lanes', mode, case_id: caseId, at: new Date().toISOString(),
    lane: mine?.lane.id ?? null, beside: running.map((r) => r.case_id), allowed: unique.length === 0, errors: unique });
  return mode === 'on' && unique.length ? `DISPATCH_PARALLEL_LANES_REFUSED ${unique.join('; ')}` : null;
}

/**
 * Fix round 2 (D7): what a case of a parallel GUI lane really used, checked at its collect. Under parallel_gui_lanes
 * `on`, every Dragon sessionId in the case's attested stream must start with its lane's `dragon_session`, and the lane's
 * `account` must appear in what the executor sent Dragon (the sign-in it typed) or be the draft's `account`; otherwise
 * collect refuses the case (PARALLEL_LANE_USE_UNPROVEN). `shadow` records what `on` would decide and refuses nothing;
 * `off`, or a lane that is not parallel_ok, checks nothing.
 */
export async function parallelLaneUseIssues({ runDir, caseId, calls, draft = null }) {
  let policy;
  try { policy = runSpeedPolicy(runDir); } catch { return []; }
  const mode = speedMode(policy, 'parallel_gui_lanes');
  if (mode === 'off') return [];
  const planValue = readPlanValue(runDir, policy);
  const lanes = Array.isArray(planValue.lanes) ? planValue.lanes : [];
  const req = trackedCases(runDir).find((c) => c.id === caseId)?.req_id;
  const lane = lanes.find((l) => Array.isArray(l?.scope) && l.scope.includes(req));
  if (!lane || lane.parallel_ok !== true) return [];
  const list = [...(calls?.values?.() ?? calls ?? [])];
  const sessions = new Set(list.map((c) => c?.params?.sessionId).filter((v) => typeof v === 'string' && v));
  const issues = [];
  const prefix = String(lane.dragon_session ?? '');
  if (!sessions.size) issues.push(`PARALLEL_LANE_SESSION_UNPROVEN:${caseId}`);
  for (const id of sessions) if (!prefix || !id.startsWith(prefix)) issues.push(`PARALLEL_LANE_SESSION_MISMATCH:${caseId}:${id}`);
  const account = norm(lane.account ?? '');
  const typed = list.some((c) => account && JSON.stringify(c?.params ?? {}).toLowerCase().includes(account));
  if (!account || !(typed || norm(draft?.account ?? '') === account)) issues.push(`PARALLEL_LANE_ACCOUNT_UNPROVEN:${caseId}:${lane.id}`);
  await appendSpeedDecision(runDir, { schema: DECISION_SCHEMA, kind: 'parallel_lanes', check: 'use', mode, case_id: caseId, at: new Date().toISOString(), lane: lane.id ?? null,
    sessions: [...sessions], allowed: issues.length === 0, errors: issues });
  return mode === 'on' ? issues : [];
}
