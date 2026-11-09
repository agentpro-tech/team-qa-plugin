// Upgrade R1d: what QA GUI accepts from the Dragon R1a surface (forced environment states, sensors, frame window,
// paint snapshot), and the checks of a state receipt's `env` block. Pure; Node built-ins only.
// Interface: Dragon docs/r1a-environment-and-sensors.md (also `help.environmentContract`). QA GUI only reads what
// Dragon recorded; it never forces state itself (HR1: forced states live at the environment layer only).

// The eval lane names a Dragon build `<release>-qa.<git sha>` (e.g. 1.6.9-qa.f108af9). The extension manifest cannot
// carry the suffix, so receipts of a lane build report the plain release in env.build.extVersion.
const LANE_BUILD = /^(\d+\.\d+\.\d+)-(qa)\.([0-9a-f]{7,40})$/;
export function laneBuild(version) {
  const m = LANE_BUILD.exec(typeof version === 'string' ? version : '');
  return m ? { version, base: m[1], lane: m[2], sha: m[3] } : null;
}

// RPCs of the R1a surface. Actions pass the session gate and carry a receipt whose input.kind is "env"; reads do not.
export const DRAGON_R1A_ACTIONS = Object.freeze(['env.set', 'env.release', 'env.reset', 'sensors.start', 'sensors.stop', 'frames.start', 'frames.mark', 'frames.stop']);
export const DRAGON_R1A_READS = Object.freeze(['env.get', 'sensors.read', 'paintSnapshot']);
// The MCP tools Dragon names after their RPC (env.set -> envSet). Each is a thin proxy: flat arguments, same result.
export const DRAGON_R1A_TOOLS = Object.freeze({
  envSet: 'env.set', envGet: 'env.get', envRelease: 'env.release', envReset: 'env.reset',
  sensorsStart: 'sensors.start', sensorsRead: 'sensors.read', sensorsStop: 'sensors.stop',
  framesStart: 'frames.start', framesMark: 'frames.mark', framesStop: 'frames.stop', paintSnapshot: 'paintSnapshot',
});
// Parameters each R1a RPC takes (besides tabId, the session triple and correlation labels).
export const DRAGON_R1A_PARAMS = Object.freeze({
  'env.set': ['network', 'cpu', 'timezone', 'locale', 'media', 'animation', 'requests', 'role', 'caseId', 'ttlMs'],
  'env.get': ['readback', 'cpu'],
  'env.release': ['ruleId', 'requestId'],
  'env.reset': [],
  'sensors.start': ['kinds', 'watch', 'maxTargets', 'stream'],
  'sensors.read': ['since', 'max', 'kinds'],
  'sensors.stop': [],
  'frames.start': ['maxWidth', 'maxHeight', 'quality', 'everyNthFrame', 'maxMs', 'maxFrames'],
  'frames.mark': ['label', 't'],
  'frames.stop': ['keep', 'edges', 'maxKeep'],
  paintSnapshot: ['selector', 'nth', 'all'],
});

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const RECORD_KEYS = ['v', 'caseId', 'role', 'network', 'cpu', 'timezone', 'locale', 'media', 'animation', 'requests', 'probes', 'verified', 'setAt', 'expiresAt'];
const RULE_ACTIONS = ['hold', 'delay', 'fail', 'respond'];
const DIMENSIONS = ['network', 'cpu', 'timezone', 'locale', 'media', 'animation'];

// The closed receipt.env.conditions record (Dragon env-core.js validateConditionsRecord, same rules).
export function conditionsRecordErrors(r) {
  const errors = [];
  const err = (m) => errors.push(`env.conditions.${m}`);
  if (!object(r)) return ['env.conditions must be an object'];
  for (const key of RECORD_KEYS) if (!Object.hasOwn(r, key)) err(`missing ${key}`);
  for (const key of Object.keys(r)) if (!RECORD_KEYS.includes(key)) err(`unknown key ${key}`);
  if (r.v !== 1) err('v must equal 1');
  if (!(r.caseId === null || (typeof r.caseId === 'string' && r.caseId.length <= 120))) err('caseId must be a short string or null');
  if (!['test', 'evidence'].includes(r.role)) err('role must be test or evidence');
  const nullOr = (key, check) => { if (r[key] !== null && !check(r[key])) err(`${key} has an unexpected shape`); };
  nullOr('network', (n) => object(n) && typeof n.offline === 'boolean' && finite(n.latencyMs) && (n.downloadKbps === null || finite(n.downloadKbps))
    && (n.uploadKbps === null || finite(n.uploadKbps)) && (n.urlPattern === null || typeof n.urlPattern === 'string') && Object.keys(n).length === 5);
  nullOr('cpu', (n) => object(n) && finite(n.rate) && Object.keys(n).length === 1);
  nullOr('timezone', (n) => typeof n === 'string' && n.length <= 64);
  nullOr('locale', (n) => typeof n === 'string' && n.length <= 40);
  nullOr('media', (n) => object(n) && Object.keys(n).length === 6 && Object.values(n).every((v) => v === null || typeof v === 'string'));
  nullOr('animation', (n) => object(n) && finite(n.playbackRate) && Object.keys(n).length === 1);
  if (!Array.isArray(r.requests) || r.requests.length > 16 || !r.requests.every((q) => object(q) && typeof q.id === 'string' && typeof q.urlPattern === 'string'
    && RULE_ACTIONS.includes(q.action) && (q.status === null || finite(q.status)) && (q.errorReason === null || typeof q.errorReason === 'string')
    && Number.isInteger(q.matched) && Object.keys(q).length === 6)) err('requests has an unexpected shape');
  if (!object(r.probes) || typeof r.probes.sensors !== 'boolean' || typeof r.probes.frames !== 'boolean' || Object.keys(r.probes).length !== 2) err('probes has an unexpected shape');
  if (!(r.verified === null || typeof r.verified === 'boolean')) err('verified must be boolean or null');
  for (const key of ['setAt', 'expiresAt']) if (!(r[key] === null || finite(r[key]))) err(`${key} must be a number or null`);
  return errors;
}

// Something is forced (a dimension away from its default, or a request rule). Sensors and frames alone are not.
export function conditionsForced(r) {
  if (!object(r)) return false;
  return DIMENSIONS.some((dim) => r[dim] !== null && r[dim] !== undefined && !(dim === 'cpu' && r.cpu?.rate === 1))
    || (Array.isArray(r.requests) && r.requests.length > 0);
}
// Every dimension back at its default, no request rule, no sensors and no frame window.
export function conditionsAtDefault(r) {
  return object(r) && !conditionsForced(r) && r.probes?.sensors === false && r.probes?.frames === false;
}
// The page runs at its own speed: no CPU throttle and no animation playback rate (a network condition does not slow the
// page clock). A transient finding is confirmed only on real-speed repeats.
export function realSpeed(r) {
  if (r == null) return true;
  return !(finite(r.cpu?.rate) && r.cpu.rate > 1) && r.animation == null;
}

// The raw env.reset result (or its dragon_rpc envelope) verified: ok, atDefault, no mismatch, the record at default.
export function envResetVerdict(raw) {
  const r = object(raw) && object(raw.result) && Object.hasOwn(raw, 'ok') && !Object.hasOwn(raw, 'atDefault') ? raw.result : raw;
  if (!object(r) || typeof r.ok !== 'boolean') return { verified: false, code: 'ENV_RESET_EVIDENCE_INVALID' };
  if (r.code === 'ENV_RESET_UNVERIFIED' || r.ok !== true || r.atDefault !== true) return { verified: false, code: 'ENV_RESET_UNVERIFIED' };
  if ((Array.isArray(r.mismatches) && r.mismatches.length) || (Array.isArray(r.errors) && r.errors.length)) return { verified: false, code: 'ENV_RESET_UNVERIFIED' };
  if (r.conditions !== undefined && (conditionsRecordErrors(r.conditions).length || !conditionsAtDefault(r.conditions) || r.conditions.verified === false)) {
    return { verified: false, code: 'ENV_RESET_UNVERIFIED' };
  }
  return { verified: true, code: null };
}

const ENV_KEYS = ['conditions', 'reset'];
const TRANSIENT_PROBE = 'transient';
/**
 * One state receipt's `env` block: {conditions: <receipt.env.conditions of the action behind the state> | null,
 * reset?: {evidence_ref}} (references/transient-rules.md). A receipt without `env` is graded as before, unless it names a
 * transient probe (the probe ran sensors and frames, so the case must end with a verified reset).
 * @param locate (rel) -> {absolute} of an evidence-manifest entry, or null
 * @param read   (absolute) -> Buffer
 * @returns {issues:[{message, ungraded:true}], requiresReset, reset: null | {verified, code}}
 */
export function stateEnvIssues({ receipt, caseId, state, locate, read }) {
  const issues = [];
  const bad = (code, detail = '') => issues.push({ message: `${code}:${caseId}:${state}${detail ? `:${detail}` : ''}`, ungraded: true });
  const probes = Array.isArray(receipt?.probes) ? receipt.probes : [];
  const probed = probes.some((p) => p?.kind === TRANSIENT_PROBE);
  if (!object(receipt) || !Object.hasOwn(receipt, 'env')) {
    if (probed) bad('ENV_BLOCK_REQUIRED', 'a transient probe needs the env block of its state');
    return { issues, requiresReset: probed, reset: null };
  }
  const env = receipt.env;
  if (!object(env) || Object.keys(env).some((k) => !ENV_KEYS.includes(k)) || !Object.hasOwn(env, 'conditions')) {
    bad('ENV_CONDITIONS_INVALID', 'env must be {conditions, reset?}');
    return { issues, requiresReset: true, reset: null };
  }
  const c = env.conditions;
  if (c !== null) {
    const errors = conditionsRecordErrors(c);
    if (errors.length) bad('ENV_CONDITIONS_INVALID', errors[0].replace(/[^A-Za-z0-9_. -]/g, '_'));
    else {
      if (c.role === 'evidence') bad('ENV_EVIDENCE_TAB_VERDICT', 'the tab is an evidence tab: take no verdict from it');
      if (conditionsForced(c) && c.verified !== true) bad('ENV_CONDITIONS_UNVERIFIED', `verified=${c.verified}`);
      if (c.caseId !== null && c.caseId !== caseId) bad('ENV_CONDITIONS_CASE_MISMATCH', c.caseId);
    }
  }
  let reset = null;
  if (Object.hasOwn(env, 'reset')) {
    const ref = env.reset?.evidence_ref;
    const entry = object(env.reset) && Object.keys(env.reset).every((k) => k === 'evidence_ref') && typeof ref === 'string' ? locate(ref) : null;
    let raw = null;
    if (entry) { try { raw = JSON.parse(read(entry.absolute).toString('utf8')); } catch { raw = null; } }
    reset = entry ? envResetVerdict(raw) : { verified: false, code: 'ENV_RESET_EVIDENCE_INVALID' };
    const ended = object(raw?.result) ? raw.result.endedCase : raw?.endedCase;
    if (reset.verified && ended != null && ended !== caseId) reset = { verified: false, code: 'ENV_RESET_CASE_MISMATCH' };
    if (!reset.verified) bad(reset.code, String(ref ?? 'missing'));
  }
  return { issues, requiresReset: true, reset };
}

// The case-level rule: a case that ran with env conditions or a transient probe ends with a verified env.reset, named by
// one of its state receipts (normally the last). Without it the case cannot PASS.
export function caseEnvResetIssues({ caseId, states }) {
  const list = Array.isArray(states) ? states : [];
  if (!list.some((s) => s?.requiresReset)) return [];
  if (list.some((s) => s?.reset?.verified === true) && !list.some((s) => s?.reset && s.reset.verified !== true)) return [];
  if (list.some((s) => s?.reset)) return []; // a named reset that failed was already reported on its state
  return [{ message: `ENV_RESET_MISSING:${caseId}:the case ran with env conditions or a probe and names no verified env.reset`, ungraded: true }];
}
