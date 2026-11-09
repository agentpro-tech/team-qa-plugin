// Timing receipts and the decision log (upgrade R0, BA "Team QA full-feature upgrade").
//
// Where the time of a run goes, read only from what the run already keeps: the root's original Claude Code transcript,
// each worker attempt's own transcript (its session id is the attempt id) and the dispatch state files. Every tool
// call becomes one step (kind, tool, role, case, phase, start, duration); the time between a tool result (or a user
// line) and the next assistant line is a model step. Phases come from the root's `run transition --to` calls.
//
// The decision log lists the branch points a cheaper decision model could later be measured against (R2b): which
// case or role the root dispatched next, a re-run offer, a phase change, a board publish, and each GUI action of an
// executor, with the model time spent before it and a digest of what it had just observed.
import * as screenPlanModule from './screen-checks.mjs';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './core.mjs';
import { readSpeedDecisions, speedMarkdown, speedSummary } from './cost-ladder.mjs';

export const TIMING_SCHEMA = 'team-qa/run-timing/v1';
export const DECISIONS_SCHEMA = 'team-qa/run-decisions/v1';

const dirs = (path) => (existsSync(path) ? readdirSync(path).filter((name) => { try { return statSync(join(path, name)).isDirectory(); } catch { return false; } }).sort() : []);
function readJsonSafe(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

// The step kind of one tool call.
export function stepKind(name, input = {}) {
  const n = String(name || '');
  if (/dragon/i.test(n)) return n.endsWith('__do') ? 'dragon.do' : /dragon_rpc$/.test(n) && input?.method ? `dragon.${String(input.method)}` : 'dragon';
  if (/notion/i.test(n)) return 'notion';
  if (n === 'Bash' || /exec_command$/.test(n)) {
    const cmd = String(input?.command ?? input?.cmd ?? '');
    if (/qa_do\.mjs/.test(cmd)) return 'dragon.qa_do';
    if (/qa-gate\.mjs/.test(cmd)) return 'gate.qa-gui';
    if (/(?:^|[\s/])(?:qa-code|verdict-validate)/.test(cmd)) return 'gate.qa-code';
    if (/roster\.mjs\s+(?:dispatch|wait)/.test(cmd)) return 'dispatch';
    if (/board-quality\.mjs/.test(cmd)) return 'board.review';
    const teamqa = /teamqa(?:\.mjs)?\s+([a-z-]+)(?:\s+([a-z-]+))?/.exec(cmd);
    if (teamqa) return `teamqa.${teamqa[1]}${teamqa[2] ? `.${teamqa[2]}` : ''}`;
    if (/\bsleep\s+\d/.test(cmd)) return 'wait.sleep';
    return 'shell';
  }
  if (n === 'Read' && /\.(?:png|jpe?g|webp|gif)$/i.test(String(input?.file_path || ''))) return 'vision.read';
  if (['Read', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit'].includes(n)) return 'files';
  if (n === 'Agent' || n === 'Task') return 'subagent';
  return 'tool';
}

// Steps of one Claude Code transcript (root or worker).
export function transcriptSteps(path, { source, role, caseId = null } = {}) {
  const steps = [], calls = new Map();
  let lastInputAt = null, lastObservation = null;
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { steps, actions: [] }; }
  const actions = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.isSidechain === true) continue;
    const at = ms(e.timestamp);
    const content = e.message?.content;
    if (e.type === 'assistant') {
      if (lastInputAt !== null && at !== null && at >= lastInputAt) {
        steps.push({ source, role, case_id: caseId, kind: 'model', tool: null, started_at: new Date(lastInputAt).toISOString(), duration_ms: at - lastInputAt });
        lastInputAt = null;
      }
      if (Array.isArray(content)) for (const c of content) {
        if (c?.type !== 'tool_use' || typeof c.id !== 'string') continue;
        calls.set(c.id, { name: c.name, input: c.input ?? {}, at });
        const kind = stepKind(c.name, c.input);
        if (kind.startsWith('dragon')) actions.push({ source, role, case_id: caseId, at: at !== null ? new Date(at).toISOString() : null, tool: c.name, kind, observation_sha256: lastObservation });
      }
      continue;
    }
    if (e.type === 'user') {
      if (at !== null) lastInputAt = at;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type !== 'tool_result' || !calls.has(c.tool_use_id)) continue;
        const call = calls.get(c.tool_use_id);
        calls.delete(c.tool_use_id);
        const kind = stepKind(call.name, call.input);
        if (kind.startsWith('dragon')) lastObservation = sha256(JSON.stringify(c.content ?? '')).slice(0, 16);
        if (call.at === null || at === null || at < call.at) continue;
        steps.push({ source, role, case_id: caseId, kind, tool: call.name, started_at: new Date(call.at).toISOString(), duration_ms: at - call.at, is_error: c.is_error === true });
      }
    }
  }
  return { steps, actions };
}

// Branch points of the root: dispatches, re-run offers, phase changes, board deliveries, from its Bash calls.
export function rootDecisions(path) {
  const out = [];
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return out; }
  let lastInputAt = null;
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.isSidechain === true) continue;
    const at = ms(e.timestamp);
    if (e.type === 'user' && at !== null) { lastInputAt = at; continue; }
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c?.type !== 'tool_use' || c.name !== 'Bash') continue;
      const cmd = String(c.input?.command || '');
      let point = null, chosen = null;
      let m;
      if ((m = /roster\.mjs\s+dispatch\b.*?--role\s+(\S+)(?:.*?--case-id\s+(\S+))?/.exec(cmd))) { point = 'dispatch'; chosen = { role: m[1], case_id: m[2] ?? null }; }
      else if ((m = /teamqa(?:\.mjs)?\s+run\s+offer\b.*?--kind\s+(\S+).*?--cases\s+(\S+)/.exec(cmd))) { point = 'rerun-offer'; chosen = { kind: m[1], cases: m[2].split(',') }; }
      else if ((m = /teamqa(?:\.mjs)?\s+run\s+transition\b.*?--to\s+(\w+)/.exec(cmd))) { point = 'phase'; chosen = { to: m[1] }; }
      else if ((m = /teamqa(?:\.mjs)?\s+board\s+(publish|publish-next|deliver-blocked)\b/.exec(cmd))) { point = 'board'; chosen = { action: m[1] }; }
      if (!point) continue;
      out.push({ point, chosen, at: at !== null ? new Date(at).toISOString() : null, model_ms: lastInputAt !== null && at !== null && at >= lastInputAt ? at - lastInputAt : null });
    }
  }
  return out;
}

// Phase windows from the root's transitions: PLAN until the first transition, then each target phase.
export function phaseWindows(decisions, start) {
  const windows = [{ phase: 'PLAN', from: start }];
  for (const d of decisions) if (d.point === 'phase' && d.at) windows.push({ phase: d.chosen.to, from: ms(d.at) });
  return windows;
}
function phaseAt(windows, iso) {
  const t = ms(iso);
  let phase = windows[0]?.phase ?? null;
  for (const w of windows) if (t !== null && w.from !== null && t >= w.from) phase = w.phase;
  return phase;
}

// Nearest-rank percentile of a list of numbers.
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
function summarize(steps, key) {
  const groups = {};
  for (const s of steps) {
    const k = s[key] ?? '(none)';
    (groups[k] ??= []).push(s.duration_ms);
  }
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, list]) => [k, {
    count: list.length, total_ms: list.reduce((a, b) => a + b, 0), p50_ms: percentile(list, 50), p95_ms: percentile(list, 95) }]));
}

// The worker transcript of an attempt: <projects>/<any project>/<attempt id>.jsonl.
export function findSessionTranscript(projectsRoot, sessionId) {
  if (!projectsRoot || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  for (const project of dirs(projectsRoot)) {
    const path = join(projectsRoot, project, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

// R2a: each recorded adjudication is a branch point too (which outcome the adjudicator chose for one executed attempt,
// from an input with this digest, and how long the call took). Present only when the run has adjudications.
export function adjudicatorDecisions(runDir) {
  const out = [];
  for (const caseId of dirs(join(runDir, 'adjudication'))) for (const attempt of dirs(join(runDir, 'adjudication', caseId))) {
    const r = readJsonSafe(join(runDir, 'adjudication', caseId, attempt, 'result.json'));
    if (r?.schema !== 'team-qa/adjudication/v1') continue;
    out.push({ point: 'adjudicate', case_id: r.case_id, executor_attempt: r.executor_attempt, at: r.started_at ?? null, input_sha256: r.input_sha256 ?? null,
      options: ['CONFIRM', 'CONTEST', 'ABSTAIN'], chosen: r.outcome, latency_ms: Number.isInteger(r.duration_ms) ? r.duration_ms : null, attempt: r.engine?.attempt ?? null });
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function runTiming({ runDir, runId, rootTranscript = null, projectsRoot = null }) {
  const steps = [], actions = [], attempts = [];
  const decisions = rootTranscript ? rootDecisions(rootTranscript) : [];
  if (rootTranscript) {
    const r = transcriptSteps(rootTranscript, { source: 'root', role: 'root' });
    steps.push(...r.steps); actions.push(...r.actions);
  }
  for (const role of dirs(join(runDir, 'dispatch'))) {
    for (const attempt of dirs(join(runDir, 'dispatch', role))) {
      const state = readJsonSafe(join(runDir, 'dispatch', role, attempt, 'state.json'));
      const caseId = state?.case_id ?? null;
      const started = state?.started_at ?? state?.created_at ?? null, ended = state?.ended_at ?? null;
      const transcript = findSessionTranscript(projectsRoot, attempt);
      // The kind of a screen check (fix round 1, D1) or an adjudication (R2a, off the case's critical path), so the eval
      // can report each apart from the case dispatches (a run with neither keeps the receipt it had).
      const kind = role === 'adjudicator' ? 'adjudication' : state?.screen_id ? 'screen-check' : null;
      attempts.push({ role, ...(kind ? { kind } : {}), attempt, case_id: caseId, ...(state?.screen_id ? { screen_id: state.screen_id } : {}), status: state?.status ?? null, started_at: started, ended_at: ended,
        duration_ms: started && ended && ms(ended) >= ms(started) ? ms(ended) - ms(started) : null, transcript: transcript ? 'found' : 'missing' });
      if (transcript) {
        const r = transcriptSteps(transcript, { source: `${role}/${attempt}`, role, caseId });
        steps.push(...r.steps); actions.push(...r.actions);
      }
    }
  }
  const times = [...steps.map((s) => ms(s.started_at)), ...attempts.map((a) => ms(a.started_at))].filter((t) => t !== null);
  const ends = [...steps.map((s) => ms(s.started_at) + s.duration_ms), ...attempts.map((a) => ms(a.ended_at))].filter((t) => Number.isFinite(t));
  const start = times.length ? Math.min(...times) : null, end = ends.length ? Math.max(...ends) : null;
  const windows = phaseWindows(decisions, start);
  for (const s of steps) s.phase = phaseAt(windows, s.started_at);
  for (const a of attempts) a.phase = phaseAt(windows, a.started_at);
  // The adjudicator's attempts carry their case too (R2a) but are not the executor's time on it: they have their own
  // rows by role and in the decision log.
  const caseSteps = steps.filter((s) => s.case_id && s.role !== 'adjudicator');
  const caseAttempts = attempts.filter((a) => a.case_id && a.duration_ms !== null && a.role !== 'adjudicator');
  const adjudications = adjudicatorDecisions(runDir);
  const byCase = {};
  for (const a of caseAttempts) { const row = byCase[a.case_id] ??= { attempts: 0, total_ms: 0 }; row.attempts += 1; row.total_ms += a.duration_ms; }
  // Fix round 2 (E9): a screen check's time counts against every case on that screen (the plan's screens), next to
  // case_p50, so the guard sees what the screen checks cost each case; the run's wall time is reported beside it.
  const screenMs = {};
  for (const a of attempts) if (a.kind === 'screen-check' && a.screen_id && a.duration_ms !== null) screenMs[a.screen_id] = (screenMs[a.screen_id] ?? 0) + a.duration_ms;
  let screensOfCase = {};
  if (Object.keys(screenMs).length) {
    try { const { runScreenPlan } = screenPlanModule; for (const sc of runScreenPlan(runDir).screens) for (const id of sc.cases) (screensOfCase[id] ??= []).push(sc.id); } catch { screensOfCase = {}; }
  }
  const withScreens = Object.fromEntries(Object.entries(byCase).map(([id, r]) => [id, r.total_ms + (screensOfCase[id] ?? []).reduce((n, sid) => n + (screenMs[sid] ?? 0), 0)]));
  return {
    schema: TIMING_SCHEMA, run_id: runId,
    wall: { started_at: start !== null ? new Date(start).toISOString() : null, ended_at: end !== null ? new Date(end).toISOString() : null, duration_ms: start !== null && end !== null ? end - start : null },
    sources: { root_transcript: rootTranscript ? 'found' : 'missing', worker_transcripts: { found: attempts.filter((a) => a.transcript === 'found').length, missing: attempts.filter((a) => a.transcript === 'missing').length } },
    summary: {
      by_role: summarize(steps, 'role'), by_phase: summarize(steps, 'phase'), by_kind: summarize(steps, 'kind'), by_case_step: summarize(caseSteps, 'case_id'),
      attempts_by_role: summarize(attempts.filter((a) => a.duration_ms !== null).map((a) => ({ ...a })), 'role'),
      ...(attempts.some((a) => a.kind) ? { attempts_by_kind: summarize(attempts.filter((a) => a.duration_ms !== null).map((a) => ({ ...a, kind: a.kind ?? (a.case_id ? 'case' : 'role') })), 'kind') } : {}),
      cases: Object.fromEntries(Object.entries(byCase).sort().map(([id, r]) => [id, r])),
      case_p50_ms: percentile(Object.values(byCase).map((r) => r.total_ms), 50), case_p95_ms: percentile(Object.values(byCase).map((r) => r.total_ms), 95),
      // A run without screen checks keeps the receipt it had (its wall time is `wall.duration_ms`).
      ...(Object.keys(screenMs).length ? { screen_checks_ms: screenMs, case_with_screens_p50_ms: percentile(Object.values(withScreens), 50), case_with_screens_p95_ms: percentile(Object.values(withScreens), 95),
        run_wall_ms: start !== null && end !== null ? end - start : null } : {}),
    },
    attempts, steps,
    decisions: { schema: DECISIONS_SCHEMA, root: decisions, gui_actions: actions, ...(adjudications.length ? { adjudicator: adjudications } : {}) },
    // Upgrade R3: the speed flag decisions of the run (decisions.jsonl), only when it has some (every flag off: none).
    ...speedSection(runDir),
  };
}
function speedSection(runDir) {
  const decisions = readSpeedDecisions(runDir);
  return decisions.length ? { speed: { decisions, summary: speedSummary(decisions) } } : {};
}

const secs = (v) => (v === null || v === undefined ? 'n/a' : `${(v / 1000).toFixed(1)} s`);
const mins = (v) => (v === null || v === undefined ? 'n/a' : `${(v / 60000).toFixed(1)}`);

// The report section. Missing sources are said, never counted as zero time.
export function timingMarkdown(timing) {
  if (!timing) return '';
  const s = timing.summary;
  const roleRows = Object.entries(s.by_role).map(([role, r]) => `| ${role} | ${r.count} | ${mins(r.total_ms)} | ${secs(r.p50_ms)} | ${secs(r.p95_ms)} |`);
  const kindRows = Object.entries(s.by_kind).sort((a, b) => b[1].total_ms - a[1].total_ms).slice(0, 12).map(([kind, r]) => `| ${kind} | ${r.count} | ${mins(r.total_ms)} | ${secs(r.p50_ms)} | ${secs(r.p95_ms)} |`);
  const phaseRows = Object.entries(s.by_phase).map(([phase, r]) => `| ${phase} | ${r.count} | ${mins(r.total_ms)} |`);
  const caseRows = Object.entries(s.cases).map(([id, r]) => `| ${id} | ${r.attempts} | ${mins(r.total_ms)} |`);
  const missing = [timing.sources.root_transcript === 'missing' ? 'the root transcript' : null,
    timing.sources.worker_transcripts.missing ? `${timing.sources.worker_transcripts.missing} worker transcript(s)` : null].filter(Boolean);
  return ['', '## Time', '',
    `Wall time ${mins(timing.wall.duration_ms)} min. Per GUI case (all attempts): P50 ${mins(s.case_p50_ms)} min, P95 ${mins(s.case_p95_ms)} min.${s.case_with_screens_p50_ms !== undefined ? ` With the screen checks of its screens: P50 ${mins(s.case_with_screens_p50_ms)} min, P95 ${mins(s.case_with_screens_p95_ms)} min.` : ''}${missing.length ? ` Not read: ${missing.join(' and ')} (their steps are BLOCKED here, not zero).` : ''}`,
    '', '| Role | Steps | Minutes | P50 step | P95 step |', '|---|---|---|---|---|', ...roleRows,
    '', '| Step kind | Steps | Minutes | P50 | P95 |', '|---|---|---|---|---|', ...kindRows,
    '', '| Phase | Steps | Minutes |', '|---|---|---|', ...phaseRows,
    ...(caseRows.length ? ['', '| Case | Attempts | Minutes |', '|---|---|---|', ...caseRows] : []), ''].join('\n') + speedMarkdown(timing.speed);
}
