// Upgrade integration: QA GUI's detectors in `teamqa web collect` (references/executor-evidence.md, QA GUI
// references/team-qa-detectors.md). The GUI executor ran each detector as Dragon calls by recipe; this module hands the
// calls of its attested stream, state by state, to QA GUI's stream detectors, which rebuild the probe receipts with the
// detectors' own engines. Team QA only carries the results into the run: the probe files and their cells, the kept
// frames and sweep captures hash for hash, the Dragon conditions of each state and the case's env.reset. It grades
// nothing; QA GUI's gate grades every receipt again from the files.
import { basename, isAbsolute, join } from 'node:path';
import { UX_FORCED_RULES, caseDetectorPlan } from './detector-dispatch.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SHA256 = /^[a-f0-9]{64}$/;
// Dragon's R1a MCP tools are named after their RPC (envSet -> env.set).
const R1A_TOOLS = { envSet: 'env.set', envGet: 'env.get', envRelease: 'env.release', envReset: 'env.reset', sensorsStart: 'sensors.start', sensorsRead: 'sensors.read',
  sensorsStop: 'sensors.stop', framesStart: 'frames.start', framesMark: 'frames.mark', framesStop: 'frames.stop', framesTrial: 'frames.trial', helpersDefine: 'helpers.define', paintSnapshot: 'paintSnapshot' };
export const rpcName = (method) => R1A_TOOLS[method] ?? method;
// The R1a calls that touch a tab's environment: after one of them the case must end with a verified env.reset.
const TOUCH = ['env.set', 'sensors.start', 'frames.start'];
const succeeded = (c) => !c.error && c.json?.ok === true && c.json?.result?.ok !== false;

/** A stream call (web-collect streamCalls) as QA GUI's stream detectors read it. */
export function detectorCall(c) {
  return { method: rpcName(c.method), params: c.params ?? {}, result: c.json?.result ?? null, ok: succeeded(c), called_at: c.called_at ?? null, at: c.at ?? null };
}

// The Dragon receipts of a call: `receipt`, `receipts[]` and each `do` step's `receipt`.
const receiptsOf = (c) => { const r = c?.json?.result; return !object(r) ? [] : [r.receipt, ...(Array.isArray(r.receipts) ? r.receipts : []), ...(Array.isArray(r.results) ? r.results.map((x) => x?.receipt) : [])].filter(object); };
const ACTION_STEPS = ['click', 'clickSelector', 'clickXY', 'type', 'fill', 'key', 'hover', 'scroll', 'drag', 'select', 'clear', 'chord', 'dialog'];

/**
 * The Dragon environment of a case on its tabs: whether anything touched it (envSet, sensors or a frame window), the
 * conditions record in force at a call of the stream (the latest one, up to that call, that an R1a result or an action
 * or capture receipt carried; a
 * receipt of a trusted action without one means everything was at its defaults), and the case's last env.reset when no
 * R1a call touched the tab after it.
 */
export function caseEnvironment(ordered, tabIds) {
  const tabs = new Set([...tabIds].map(String));
  const mine = ordered.filter((c) => tabs.has(String(c.params?.tabId ?? '')));
  // A frames.trial closes what it opened before it answers; only one that says it left something open touches the tab.
  const touches = (c) => (TOUCH.includes(rpcName(c.method)) && succeeded(c)) || (rpcName(c.method) === 'frames.trial' && c.json?.result?.after?.atDefault !== true && !c.error);
  const touched = mine.some(touches);
  const conditionsAt = (index) => {
    let current = null;
    for (const c of mine) {
      if (c.i > index || !succeeded(c)) continue;
      const result = c.json.result;
      if (rpcName(c.method).match(/^(env|sensors|frames)\./) && Object.hasOwn(result, 'conditions')) { current = result.conditions ?? null; continue; }
      const receipts = receiptsOf(c);
      const recorded = receipts.map((r) => r.env?.conditions).filter((x) => x !== undefined).at(-1);
      if (recorded !== undefined) current = recorded;
      else if (c.method === 'do' && Array.isArray(c.params?.steps) && c.params.steps.some((s) => object(s) && ACTION_STEPS.some((k) => Object.hasOwn(s, k))) && receipts.length) current = null;
    }
    return current;
  };
  const resets = mine.filter((c) => rpcName(c.method) === 'env.reset');
  const reset = resets.at(-1) ?? null;
  const after = reset ? mine.some((c) => c.i > reset.i && touches(c)) : false;
  return { touched, conditionsAt, reset: reset && !after ? reset : null };
}

// A Dragon without R1a (older than the R1a interface) cannot force a U-rule state or run the transient probe; the
// screen checks and the exploration need no R1a. The stream, not the executor's word, says which Dragon it was.
export const R1A_UNAVAILABLE = 'DRAGON_R1A_UNAVAILABLE';
const R1A_DETECTORS = Object.freeze(['transient', 'ux', 'entry', ...UX_FORCED_RULES]);
// Round G (G5): the frames.trial calls of the entry probe (labelled entry:<screenId>); never the main action's probe.
const ENTRY_TRIAL = /^entry(?::|$)/;
const isEntryTrialOp = (op) => op?.kind === 'rpc' && op.method === 'frames.trial' && ENTRY_TRIAL.test(String(op.params?.correlationId ?? ''));
const R1A_METHODS = new Set(Object.values(R1A_TOOLS));
// The R1a calls that act on the page; a case with no planned detector may make none of them.
export const UNPLANNED_R1A = ['env.set', 'env.release', 'sensors.start', 'frames.start', 'frames.mark', 'frames.trial', 'paintSnapshot'];
// The MCP tools that make them, withheld from a case dispatch with no detector section.
export const R1A_ACTING_TOOLS = Object.entries(R1A_TOOLS).filter(([, m]) => UNPLANNED_R1A.includes(m)).map(([t]) => t);
// Only an unknown method or tool shows R1a missing; a "tab not found" or any other failure of an R1a call does not.
const NO_SUCH_METHOD = /Unknown method|No such tool/i;

/**
 * What the stream shows of Dragon R1a: `available` when an R1a call succeeded or `help` named its environmentContract;
 * `missing` when `help` had none or an R1a call failed as unknown (Dragon's `Unknown method`, the CLI's `No such tool`).
 * R1a is unavailable only when it is shown missing and never shown available. `help` is large: its result is read from
 * the output the host saved (streamCalls); a help result that could not be read shows nothing.
 */
export function dragonR1a(ordered) {
  let available = false, missing = false;
  for (const c of ordered) {
    const method = rpcName(c.method);
    if (method === 'help' && !c.error && object(c.json)) {
      const help = object(c.json.result) ? c.json.result : c.json;
      if (help.environmentContract) available = true; else if (Array.isArray(help.rpcMethods) || typeof help.text === 'string' || help.version) missing = true;
    } else if (R1A_METHODS.has(method)) {
      if (succeeded(c)) available = true;
      else if (NO_SUCH_METHOD.test(String(c.text ?? ''))) missing = true;
    }
  }
  return { available, missing, unavailable: missing && !available };
}

const claimsOf = (state) => (object(state?.detectors?.unavailable) ? state.detectors.unavailable : {});

/**
 * Everything the detectors give one drafted case, before buildCaseEvidence writes it: per state the probe receipts
 * (transient, width-sweep, overlay-check), the U1/U2/U3 results and the issues; the files to copy (kept frames, sweep
 * captures), the exploration, the case's environment, and the case-level issues of a detector the case needed that
 * did not run. On a Dragon the stream shows without R1a, what needs R1a is reported and the forced U rules say UNGRADED
 * with the reason; a claim the stream does not back is refused. Null without QA GUI's stream detectors (collect then
 * runs as before).
 */
export async function caseDetectorResults({ draft, calls, shots, tools, plannedCase, tracked = null, explorationPolicy = null, dir = 'evidence/qa-gui', exists, fileSha, screens = [] }) {
  if (!tools) return null;
  const caseId = draft.case_id;
  const ordered = [...calls.values()].sort((a, b) => a.i - b.i);
  const anchors = draft.states.map((s) => shots.get(s)?.call?.i).filter(Number.isFinite).sort((a, b) => a - b);
  const files = [], issues = [], states = new Map(), tabIds = new Set(), transientNa = new Set();
  // What the case needed (Team QA's plan for it), and whether this Dragon could run what needs R1a.
  const plan = caseDetectorPlan({ plannedCase, tracked, explorationPolicy, classify: tools.classifyAction, repeatability: tools.transientRepeatability });
  // The screen checks of this case's screens (run once per screen, in their own dispatch), folded by QA GUI.
  const folded = tools.foldScreenChecks ? tools.foldScreenChecks({ caseId, states: draft.states.filter((s) => shots.get(s)?.call).map((s) => ({ state: s.state, url: shots.get(s).call.json?.result?.dom?.url ?? '' })), screens }) : null;
  const r1a = dragonR1a(ordered), noR1a = r1a.unavailable;
  const claimed = new Set(), uxSaid = new Set();
  // Without R1a the plan's forced U rules say UNGRADED on the state the executor said it of (else the first captured).
  const saysUx = (s) => Object.entries(claimsOf(s)).some(([k, v]) => (k === 'ux' || UX_FORCED_RULES.includes(k)) && v === R1A_UNAVAILABLE);
  const uxState = noR1a ? (draft.states.find((s) => shots.get(s)?.call && saysUx(s)) ?? draft.states.find((s) => shots.get(s)?.call))?.state ?? null : null;
  const onTab = (c, tabId) => String(c.params?.tabId ?? '') === String(tabId ?? '');
  const opsOf = (lo, hi, tabId) => tools.dragonOps(ordered.filter((c) => c.i > lo && c.i < hi && onTab(c, tabId)).map(detectorCall));
  // A probe's kept frames, copied hash for hash into the case's evidence, as files of the state it is folded into.
  const frameRefFor = (state, bad) => (stop, frame) => {
    const name = typeof frame?.file === 'string' ? frame.file : null;
    const from = name && (isAbsolute(name) ? name : typeof stop?.dir === 'string' ? join(stop.dir, name) : null);
    if (!from || !exists(from)) { bad(`PROBE_FRAME_MISSING:${frame?.seq}`); return null; }
    const digest = fileSha(from);
    if (SHA256.test(String(frame.sha256 ?? '')) && frame.sha256 !== digest) { bad(`PROBE_FRAME_HASH_MISMATCH:${frame.seq}`); return null; }
    const rel = `${dir}/${caseId}/frames/${String(stop.windowId ?? 'window')}/${basename(name)}`;
    if (!files.some((f) => f.rel === rel)) files.push({ from, rel, sha256: digest, evidence_type: 'gui-frame', state });
    return rel;
  };
  // G5: the screen this case is on (its screen checks are folded above), whose entry it probes.
  const entryScreen = typeof tools.entryProbeFromOps === 'function' ? screens.find((x) => typeof x?.screenId === 'string') ?? null : null;
  let exploration = null;
  for (const s of draft.states) {
    const shot = shots.get(s)?.call;
    if (!shot) continue;
    const tabId = shot.params?.tabId;
    tabIds.add(tabId);
    const prev = anchors.filter((i) => i < shot.i).at(-1) ?? -1, next = anchors.find((i) => i > shot.i) ?? Infinity;
    const lead = opsOf(prev, shot.i, tabId), after = opsOf(shot.i, next, tabId);
    const out = { probes: [], ux: [], uxRequired: [], issues: [], explore: null };
    const bad = (code) => out.issues.push(`${code}:${caseId}:${s.state}`);
    // A detector the executor says Dragon could not run: honoured only for one that needs R1a, on a Dragon the stream
    // shows without it. Any other claim is refused, and what it would skip counts as not run.
    for (const [detector, reason] of Object.entries(claimsOf(s))) {
      const why = reason !== R1A_UNAVAILABLE ? 'REASON_UNKNOWN' : !R1A_DETECTORS.includes(detector) ? 'NEEDS_NO_R1A'
        : r1a.available ? 'R1A_RECORDED' : !r1a.missing ? 'NOT_SHOWN' : null;
      if (why) out.issues.push(`DETECTOR_UNAVAILABLE_REFUSED:${caseId}:${s.state}:${detector}:${why}`);
      else { out.issues.push(`DETECTOR_UNAVAILABLE:${caseId}:${s.state}:${detector}:${reason}`); claimed.add(UX_FORCED_RULES.includes(detector) ? 'ux' : detector); }
    }
    // R1d: the probe around the action that led to this state, its kept frames copied hash for hash.
    const frameRef = frameRefFor(s.state, bad);
    // D3: the probe's frames.trial calls come after stopRecording, so after the case's screenshots: a state that names
    // the probe takes them from anywhere after the previous state on its tab. Fix round 2 (E3): a trial labelled
    // `correlationId: "transient:<state>"` is that state's alone; unlabelled trials go to a state only when it is the
    // only one of the case that names the probe.
    const tail = s.transient ? opsOf(prev, Infinity, tabId) : null;
    const trialOf = (op) => op.kind === 'rpc' && op.method === 'frames.trial';
    const label = (op) => (typeof op.params?.correlationId === 'string' && op.params.correlationId.startsWith('transient:') ? op.params.correlationId.slice('transient:'.length) : null);
    const alone = draft.states.filter((x) => x.transient).length === 1;
    const own = tail ? tail.filter((op) => !isEntryTrialOp(op) && (!trialOf(op) || label(op) === s.state || (label(op) === null && alone))) : null;
    const probeOps = own && own.some(trialOf) ? own : lead.filter((op) => !isEntryTrialOp(op));
    const transient = noR1a ? null : tools.transientProbeFromOps(probeOps, { caseId, state: s.state, action: object(s.transient?.action) ? s.transient.action : null,
      repeatable: s.transient?.repeatable !== false, frameRef, ...(object(plan.transient) ? { plan: { kinds: plan.transient.kinds, reset: plan.transient.reset } } : {}),
      ...(typeof s.transient?.repeatable === 'boolean' ? { claimed: s.transient.repeatable } : {}) });
    if (transient?.receipt) out.probes.push({ kind: 'transient', receipt: transient.receipt });
    for (const code of transient?.issues ?? []) bad(code);
    // Fix round 3 (F4): Dragon's destructive gate refused every trial (QA GUI says `na`): the probe is N/A, reported.
    if (typeof transient?.na === 'string' && transient.na) transientNa.add(transient.na);
    else if (s.transient && !transient?.receipt && !noR1a) bad('TRANSIENT_NOT_RECORDED');
    // R1c: the action rules of the forced state, graded by QA GUI's graders from the labelled reads. Without R1a no
    // state could be forced: the rules the plan or the draft names say UNGRADED with the reason (not required, so the
    // state keeps the verdict it had before).
    const rules = (Array.isArray(s.ux) ? s.ux : []).filter((rule) => UX_FORCED_RULES.includes(rule));
    if (noR1a) {
      const open = UX_FORCED_RULES.filter((rule) => (rules.includes(rule) || (s.state === uxState && plan.ux.includes(rule))) && !uxSaid.has(rule));
      if (open.length) { out.ux = tools.uxUnavailableResults(open, R1A_UNAVAILABLE); for (const rule of open) uxSaid.add(rule); }
    } else if (rules.length) {
      const requests = [...lead, ...after].filter((op) => op.kind === 'rpc' && op.method === 'getNetwork' && op.ok).flatMap((op) => op.result?.requests ?? []);
      const writes = requests.filter((r) => object(r) && r.method && ['Fetch', 'XHR', undefined].includes(r.type)).map((r) => ({ method: r.method, url: r.url, status: r.status, t: r.t, ...(r.failed ? { failed: true } : {}) }));
      out.ux = tools.uxActionResultsFromOps(lead, { rules, writes });
      out.uxRequired = rules;
    }
    // R1e: the width sweep and the overlay check of the screen this state is on, from its screen check (QA GUI's fold).
    const fromScreens = folded?.states.get(s.state);
    for (const probe of fromScreens?.probes ?? []) out.probes.push({ kind: probe.kind, receipt: probe.receipt, screenId: probe.screenId });
    out.issues.push(...(fromScreens?.issues ?? []));
    // R1e/R1b: the frontier exploration, followed through QA GUI's explorer (its reads proven by QA GUI's helper).
    const explored = await tools.explorationFromOps(after, { policy: explorationPolicy ?? {}, budget: 30, helpers: true });
    for (const code of explored?.issues ?? []) bad(code);
    if (explored && !explored.issues?.length) { out.explore = explored; exploration = { state: s.state, ...explored }; }
    else if (s.explore && !explored) bad('EXPLORATION_NOT_RECORDED');
    states.set(s.state, out);
    issues.push(...out.issues);
  }
  // Round G (G5): the entry probe of the case's screen, folded into the state that screen's checks were folded into
  // (else the first captured state). Its trials are anywhere on the case's tabs.
  let entryRan = false;
  if (entryScreen && !noR1a && states.size) {
    const into = [...states.entries()].find(([, out]) => out.probes.some((p) => p.screenId === entryScreen.screenId))?.[0] ?? [...states.keys()][0];
    const out = states.get(into);
    const bad = (code) => { const full = `${code}:${caseId}:${into}`; out.issues.push(full); issues.push(full); };
    const entryOps = tools.dragonOps(ordered.filter((c) => [...tabIds].some((t) => onTab(c, t))).map(detectorCall));
    const probed = tools.entryProbeFromOps(entryOps, { caseId, state: into, frameRef: frameRefFor(into, bad) });
    if (probed?.receipt) { out.probes.push({ kind: 'entry', receipt: probed.receipt, screenId: entryScreen.screenId }); entryRan = true; }
    for (const code of probed?.issues ?? []) bad(code);
  }
  // What the case needed and did not run (no state with the screen checks, no transient probe in a behavioral case, a
  // forced U rule no state names) keeps it from PASS. What needs R1a on a Dragon without it is reported, not held
  // against the case; the missing exploration is reported only.
  const caseIssues = [], notes = [];
  const ran = [...states.values()];
  const has = (kind) => ran.some((x) => x.probes.some((p) => p.kind === kind));
  if (folded) { caseIssues.push(...folded.issues.filter((code) => !caseIssues.includes(code))); notes.push(...folded.notes); }
  if (plan.transient && !noR1a && !has('transient') && !transientNa.size) caseIssues.push(`DETECTOR_NOT_RUN:${caseId}:transient`);
  if (entryScreen && !noR1a && !entryRan) caseIssues.push(`DETECTOR_NOT_RUN:${caseId}:entry`);
  // Dogfood 05/11 run 5: a case its plan gave no detector ran a guessed probe, and the trial deleted a second record.
  // Such a case may call no R1a tool that acts on the page (env.reset to clean up stays allowed); the dispatch also
  // withholds those tools (roster.mjs), so this catches the generic RPC route.
  if (!plan.transient && !plan.ux.length && !plan.explore && !entryScreen) {
    const used = [...new Set(ordered.map((c) => rpcName(c.method)).filter((m) => UNPLANNED_R1A.includes(m)))];
    if (used.length) caseIssues.push(`DETECTOR_UNPLANNED:${caseId}:${used.join(',')}`);
  }
  for (const reason of transientNa) notes.push(`DETECTOR_NA:${caseId}:transient:${reason}`);
  // A write with no reset path in the plan is not repeated at all (QA GUI's decision): the probe is N/A, reported.
  if (plan.transientNa) notes.push(`DETECTOR_NA:${caseId}:transient:${plan.transientNa}`);
  for (const rule of noR1a ? [] : plan.ux) if (!draft.states.some((s) => Array.isArray(s.ux) && s.ux.includes(rule))) caseIssues.push(`DETECTOR_NOT_RUN:${caseId}:${rule}`);
  if (noR1a) {
    if (plan.transient && !claimed.has('transient')) notes.push(`DETECTOR_UNAVAILABLE:${caseId}:transient:${R1A_UNAVAILABLE}`);
    if (plan.ux.length && !claimed.has('ux')) notes.push(`DETECTOR_UNAVAILABLE:${caseId}:ux:${R1A_UNAVAILABLE}`);
    if (entryScreen && !claimed.has('entry')) notes.push(`DETECTOR_UNAVAILABLE:${caseId}:entry:${R1A_UNAVAILABLE}`);
  }
  // E6 (fix round 2): on a Dragon without R1a the exploration (its helpers need R1a) is skipped and reported as such.
  const exploreMissing = plan.explore && !exploration ? [noR1a ? `DETECTOR_UNAVAILABLE:${caseId}:explore:${R1A_UNAVAILABLE}` : `DETECTOR_NOT_RUN:${caseId}:explore`] : [];
  // TQ-4, fix round 2 (E7): the requests a Dragon request rule really answered or failed (env.get's request log on the
  // case's tabs, outcome `responded:<status>` or `failed:<reason>`), each one request, with its rule, method, path,
  // status and time. A held or released write reached the server and is a real call: it is never excused.
  const forcedRequests = [];
  for (const c of ordered) {
    if (rpcName(c.method) !== 'env.get' || !succeeded(c) || !tabIds.has(c.params?.tabId)) continue;
    for (const entry of Array.isArray(c.json.result.requests) ? c.json.result.requests : []) {
      const m = /^(responded):(\d{3})$|^(failed):(.+)$/.exec(String(entry?.outcome ?? ''));
      if (!object(entry) || !entry.ruleId || typeof entry.url !== 'string' || !m) continue;
      const one = { ruleId: entry.ruleId, method: typeof entry.method === 'string' ? entry.method.toUpperCase() : null, url: entry.url.split(/[?#]/)[0], status: m[2] ? Number(m[2]) : null, failed: Boolean(m[3]), t: Number.isFinite(entry.t) ? entry.t : null };
      if (!forcedRequests.some((f) => f.ruleId === one.ruleId && f.url === one.url && f.method === one.method && f.status === one.status && f.t === one.t)) forcedRequests.push(one);
    }
  }
  return { states, files, issues: [...issues, ...caseIssues.filter((code) => !issues.includes(code)), ...notes, ...exploreMissing], caseIssues, exploration, env: caseEnvironment(ordered, tabIds), r1a, forcedRequests };
}
