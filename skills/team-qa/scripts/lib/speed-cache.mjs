// The action cache in a Team QA run (upgrade R3, flag `action_cache`), on top of QA GUI's scripts/lib/action-cache.mjs.
//
// - `teamqa speed cache-store --run <id> --case <case>` stores the trusted `do` steps a case's executor took from the
//   start page to its first screenshot, only when the case's latest board record passed (verdict pass, QA GUI child
//   verdict pass). It reads them from the stream bound to the case's own attestation (hash checked) and writes the run's
//   output cache runs/<id>/speed/action-cache.next.json: the store the signed plan pins plus this run's entries. The
//   pinned store itself is never rewritten; a later plan pins the new file.
// - At a GUI case dispatch, the case's fingerprint (app, origin, start route, build, viewport, locale, role) is looked
//   up in the pinned store: `shadow` only logs HIT/MISS/EXPIRED, `on` also gives the executor the cached steps
//   (lib/speed-collect.mjs speedPromptSection). Sweeps and assertions always run for real; no verdict is cached.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { appendSpeedDecision, DECISION_SCHEMA } from './cost-ladder.mjs';
import { pinnedStore, runSpeedPolicy, speedMode } from './speed.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const CACHE_OUTPUT = 'speed/action-cache.next.json';
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function planValue(runDir, policy) {
  const text = readFileSync(resolve(runDir, policy.source.path), 'utf8');
  return JSON.parse(text.slice(text.indexOf('TEAMQA_PLAN_START') + 'TEAMQA_PLAN_START'.length, text.indexOf('TEAMQA_PLAN_END')));
}
function lockedDoc(runDir, name) {
  try { const ref = readJson(join(runDir, 'docs-lock.json')).artifacts?.[name]; return ref ? readJson(resolve(runDir, ref.path)) : null; } catch { return null; }
}

// The seven fingerprint signals of one case of the run, all known before it runs.
export function caseSignals(runDir, policy, caseId) {
  const plan = planValue(runDir, policy);
  const tracked = lockedDoc(runDir, 'tracked');
  const planned = tracked?.cases?.find((c) => c.id === caseId) ?? null;
  const lane = (plan.lanes ?? []).find((l) => Array.isArray(l?.scope) && l.scope.includes(planned?.req_id)) ?? null;
  let target = null;
  try { target = readJson(join(runDir, 'binding.json')).target ?? null; } catch { target = null; }
  if (!target) { try { target = readJson(join(runDir, 'roster.json')).target ?? null; } catch { target = null; } }
  const board = lockedDoc(runDir, 'board');
  let origin = null, route = null;
  try { const u = new URL(target.preview_url); origin = u.origin; route = u.hash.startsWith('#/') ? `${u.pathname}${u.hash}` : u.pathname; } catch {}
  return { app: plan.app ?? null, origin, route, build: target?.frontend_build?.id ?? target?.version ?? null, viewport: board?.viewport ?? null,
    locale: typeof planned?.data?.locale === 'string' ? planned.data.locale : 'default', role: lane?.account ?? 'default' };
}

// The latest attestation bound to a case-scoped GUI dispatch of this case, and its stream text (hash checked).
function caseStream(runDir, caseId) {
  const files = [join(runDir, 'role-bindings', 'executor_gui.json')];
  const dir = join(runDir, 'role-bindings', 'executor_gui');
  if (existsSync(dir)) files.push(...readdirSync(dir).filter((n) => /^attempt-\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map((n) => join(dir, n)));
  const bound = files.filter((f) => existsSync(f)).map((f) => readJson(f)).filter((a) => a.dispatch_case_id === caseId).at(-1);
  if (!bound) throw Object.assign(new Error(`SPEED_CACHE_NO_ATTESTATION ${caseId}`), { code: 'SPEED_CACHE_NO_ATTESTATION' });
  const text = readFileSync(resolve(runDir, bound.source.path), 'utf8');
  if (sha256(Buffer.from(text, 'utf8')) !== bound.source.sha256) throw Object.assign(new Error(`SPEED_CACHE_STREAM_DRIFT ${bound.source.path}`), { code: 'SPEED_CACHE_STREAM_DRIFT' });
  return text;
}

// The `do` steps of the executor's successful `do` calls before its first screenshot, in order. Fix round 1 (D7): never
// a detector's steps (a probe trial is its own call; a `do` with a detector label or a page helper call is left out) nor
// a step run after the environment was forced (envSet), so a replay repeats no risky action and no U-state setup.
const DETECTOR_LABEL = /^(t|u|w|o|x):/;
const detectorDo = (steps) => steps.some((s) => s && typeof s === 'object' && (typeof s.call === 'string' || (typeof s.as === 'string' && DETECTOR_LABEL.test(s.as))));
export function stepsBeforeFirstScreenshot(calls) {
  const ordered = [...calls.values()].sort((a, b) => a.i - b.i);
  const first = ordered.find((c) => c.method === 'screenshot');
  const forcedAt = ordered.find((c) => ['envSet', 'env.set'].includes(c.method) || (c.method === 'dragon_rpc' && c.params?.method === 'env.set'))?.i ?? Infinity;
  return ordered.filter((c) => c.method === 'do' && (!first || c.i < first.i) && c.i < forcedAt && !c.error && c.json?.ok === true && Array.isArray(c.params?.steps) && !detectorDo(c.params.steps))
    .flatMap((c) => c.params.steps);
}

function latestRecord(runDir, caseId) {
  const path = join(runDir, 'board.jsonl');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r.case_id === caseId && r.verdict !== 'pending').at(-1) ?? null;
}

export async function cacheStore({ runDir, caseId, tools, streamCalls, now = new Date().toISOString(), secrets = [] }) {
  const policy = runSpeedPolicy(runDir);
  const mode = speedMode(policy, 'action_cache');
  if (mode === 'off') throw Object.assign(new Error('SPEED_FLAG_OFF action_cache is off in the signed plan'), { code: 'SPEED_FLAG_OFF' });
  const record = latestRecord(runDir, caseId);
  const run = { run_id: basename(runDir), case_id: caseId, gate_verdict: String(record?.child_verdict?.verdict ?? '').toUpperCase(),
    function_verdict: String(record?.verdict ?? '').toUpperCase(), ui_verdict: String(record?.verdict ?? '').toUpperCase(), receipt_sha256: record?.child_verdict?.sha256 ?? '' };
  const pinned = pinnedStore(policy, 'action_cache_store');
  const output = join(runDir, CACHE_OUTPUT);
  const cache = existsSync(output) ? readJson(output) : JSON.parse(pinned.bytes.toString('utf8'));
  const steps = stepsBeforeFirstScreenshot(streamCalls(caseStream(runDir, caseId)));
  const stored = tools.storeFromPassedRun({ cache, signals: caseSignals(runDir, policy, caseId), to: { state: `${caseId}:first-state` }, steps, run, now, secrets });
  const errors = tools.actionCacheErrors(stored.cache);
  if (errors.length) throw Object.assign(new Error(`SPEED_CACHE_INVALID ${errors.join(',')}`), { code: 'SPEED_CACHE_INVALID' });
  mkdirSync(join(runDir, 'speed'), { recursive: true });
  const text = `${JSON.stringify(stored.cache, null, 2)}\n`;
  writeFileSync(output, text);
  await appendSpeedDecision(runDir, { schema: DECISION_SCHEMA, kind: 'action_cache', mode, case_id: caseId, at: now, reason: 'STORED',
    fingerprint_sha256: stored.entry.fingerprint_sha256, steps: stored.entry.steps.length, stripped: stored.stripped });
  return { output: CACHE_OUTPUT, sha256: sha256(Buffer.from(text, 'utf8')), entry: stored.entry, stripped: stored.stripped };
}

// The dispatch-time lookup: logs the result; returns the entry only under `on` with a hit.
export async function cacheLookup({ runDir, caseId, tools, now = new Date().toISOString() }) {
  const policy = runSpeedPolicy(runDir);
  const mode = speedMode(policy, 'action_cache');
  if (mode === 'off') return null;
  let cache;
  try { cache = JSON.parse(pinnedStore(policy, 'action_cache_store').bytes.toString('utf8')); } catch (error) { cache = null; await appendSpeedDecision(runDir, { schema: DECISION_SCHEMA, kind: 'action_cache', mode, case_id: caseId, at: now, reason: error.code ?? 'STORE_UNREADABLE' }); return null; }
  const found = tools.lookupActions({ cache, signals: caseSignals(runDir, policy, caseId), to: { state: `${caseId}:first-state` }, now });
  await appendSpeedDecision(runDir, { schema: DECISION_SCHEMA, kind: 'action_cache', mode, case_id: caseId, at: now, reason: found.reason,
    fingerprint_sha256: found.hit?.fingerprint_sha256 ?? null });
  return mode === 'on' ? found.hit : null;
}
