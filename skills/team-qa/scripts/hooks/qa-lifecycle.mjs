import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readContinuationBinding, readContinuation, automaticContinuationReason } from '../lib/continuation.mjs';
import { appendScrollLedger, readJson, sha256, sha256File, stableJson, writeAtomic, writeConfirmed, runAdapter } from '../lib/core.mjs';
import { inspectDragonAdmission } from '../lib/dragon-admission.mjs';
import { assertRunContract } from '../lib/run-contract.mjs';
import { verifyProviderInterface } from '../lib/roster.mjs';
import { readFirstOriginalLine, verifyNativeHost } from '../lib/native-host.mjs';
import { SPACE_CREATE_PAGE_TOOL, inspectBoardWrite } from '../lib/board-write-admission.mjs';
import { admitNotionWrite, boardWriteKind, notionToolKind, plannedCall, recordNotionResult } from '../lib/board-notion.mjs';
import { claudeHostSource, isClaudeTranscriptPath, lastClaudeAssistantText } from '../lib/host-transcript.mjs';
import { dragonStatusUrl } from '../lib/dragon-endpoint.mjs';
import { dragonStatusVerdict } from '../lib/dragon-requirements.mjs';
import { loadOwnerGrant } from '../lib/owner-grant.mjs';
import { WAIT_MARKER, startsWithWaitMarker } from '../lib/report-tokens.mjs';

const deny = code => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: code } });
const nativeTool = name => /^mcp__.*dragon.*__dragon_rpc$/i.test(name || '');
const NATIVE_SPACE_CREATE_PAGE_TOOL = 'mcp__codex_apps__chatgpt_space__create_page';
// Every board write a registered run can make (upgrade B0): the sealed Space create_page, the planned Notion calls of
// `teamqa board publish`, and nothing else. Other Notion, Claude Docs, Google Drive and Space writes are refused, so a
// board can no longer be written by hand next to the canonical one.
function directBoardWrite(name) {
  if (name === SPACE_CREATE_PAGE_TOOL || name === NATIVE_SPACE_CREATE_PAGE_TOOL) return 'space-create-page';
  const kind = boardWriteKind(name);
  return kind === 'space-write' ? 'unsupported-space-write' : kind;
}
const shellDragonRoute = input => /^(?:Bash|exec_command|mcp__.*__exec_command)$/.test(input.tool_name || '') && /qa_do\.mjs/.test(input.tool_input?.cmd || input.tool_input?.command || '');
// A session whose binding cannot be used (it drifted from its run: a new round, the run deleted, another Team QA
// runtime; or the binding file is unreadable) keeps Dragon and board writes refused. Every other call goes ahead with
// a warning naming the way out, and a Stop is not continued; nothing is recorded in the run.
function unusableBinding(input, code, registryDir) {
  const warning = `Team QA: this session's run binding no longer matches its run (${code}). Dragon calls and board writes stay refused; other calls go ahead. `
    + `Register the session again for the run's current round, or end the binding: teamqa continuation unregister --session ${input.session_id} --registry ${registryDir}`;
  if (input.hook_event_name === 'PreToolUse') return nativeTool(input.tool_name) || directBoardWrite(input.tool_name) || shellDragonRoute(input) ? deny(code) : { systemMessage: warning };
  return input.hook_event_name === 'Stop' ? { systemMessage: warning } : {};
}
const toolResponse = (input) => input.tool_response ?? input.tool_output ?? input.output;
function unwrap(output) {
  for (let n = 0; n < 5; n++) {
    if (typeof output === 'string') { output = JSON.parse(output); continue; }
    if (Array.isArray(output?.content)) {
      const content = output.content.filter(c => c.type === 'text');
      if (output.isError || content.length !== 1) throw new Error('DRAGON_RESULT_INVALID');
      output = JSON.parse(content[0].text); continue;
    }
    return output;
  }
  throw new Error('DRAGON_RESULT_INVALID');
}
function eventPath(dir, input, suffix = 'event') {
  let cursor = null;
  if (input.hook_event_name === 'Stop' && input.transcript_path && existsSync(input.transcript_path)) cursor = statSync(input.transcript_path).size;
  return join(dir, sha256(stableJson([input.hook_event_name, input.session_id, input.transcript_path, input.turn_id, input.tool_use_id || input.agent_id || '', input.stop_hook_active === true, cursor, input.last_assistant_message])) + `.${suffix}.json`);
}
async function immutable(path, value) {
  const bytes = stableJson(value);
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== bytes) throw new Error('HOOK_EVENT_CONFLICT');
    return;
  }
  await writeConfirmed(path, bytes, 'teamqa.hook.event', { exclusive: true });
}
function events(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith('.event.json')).map(n => readJson(join(dir, n))).sort((a,b) => a.at.localeCompare(b.at));
}
export function readNativeHookMetadata(path) {
  if (isClaudeTranscriptPath(path)) return { sessionId: claudeHostSource(path).session_id, host: 'claude' };
  const actual = realpathSync(path), sessions = realpathSync(join(homedir(), '.codex/sessions'));
  if (!actual.startsWith(sessions + sep)) throw new Error('NATIVE_HOOK_SOURCE_UNTRUSTED');
  const event = JSON.parse(readFirstOriginalLine(actual)), payload = event?.payload;
  if (event?.type !== 'session_meta' || typeof payload?.id !== 'string' || !payload.id) throw new Error('NATIVE_HOOK_METADATA_INVALID');
  return { sessionId: payload.id, parentThreadId: payload.parent_thread_id,
    spawnParentThreadId: payload.source?.subagent?.thread_spawn?.parent_thread_id,
    agentPath: payload.source?.subagent?.thread_spawn?.agent_path };
}
function directChildPath(parent, child) {
  if (!isAbsolute(parent || '') || !isAbsolute(child || '')) return false;
  const rel = relative(parent, child);
  return Boolean(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.includes(sep)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rel));
}
function registeredChild(metadata, parent, { registryDir, lookup, verifyHost }) {
  if (!parent || parent !== metadata.parentThreadId || parent !== metadata.spawnParentThreadId) return null;
  const binding = lookup({ registryDir, sessionId: parent });
  if (!binding || binding.session_id !== parent) return null;
  try {
    const roster = readJson(join(binding.run_dir, 'roster.json'));
    const host = roster.roles?.find(role => role.role === 'test_manager')?.native_host;
    const actual = verifyHost(host);
    if (actual.session_id !== parent || !directChildPath(actual.agent_path, metadata.agentPath)) return null;
  } catch { return null; }
  return { binding, caller: { sessionId: metadata.sessionId, kind: 'child', parentSessionId: parent, agentPath: metadata.agentPath } };
}
function resolveHookOwner(input, { registryDir, lookup, readNativeMetadata = readNativeHookMetadata, verifyHost = verifyNativeHost }) {
  if (input.hook_event_name === 'SubagentStop') {
    if (typeof input.transcript_path !== 'string' || typeof input.agent_transcript_path !== 'string'
      || typeof input.agent_id !== 'string' || !input.agent_id) return null;
    let parentMetadata, childMetadata;
    try {
      parentMetadata = readNativeMetadata(input.transcript_path);
      childMetadata = readNativeMetadata(input.agent_transcript_path);
    } catch { return null; }
    if (parentMetadata?.sessionId !== input.session_id || childMetadata?.sessionId !== input.agent_id) return null;
    return registeredChild(childMetadata, input.session_id, { registryDir, lookup, verifyHost });
  }
  let metadata = null;
  if (typeof input.transcript_path === 'string') {
    try { metadata = readNativeMetadata(input.transcript_path); }
    catch { return null; }
  }
  if (metadata?.sessionId === input.session_id) {
    const binding = lookup({ registryDir, sessionId: input.session_id });
    if (binding) return { binding, caller: { sessionId: input.session_id, kind: 'root' } };
  }
  if (!metadata) {
    const binding = lookup({ registryDir, sessionId: input.session_id });
    return binding ? { binding, caller: { sessionId: input.session_id, kind: 'root' } } : null;
  }
  if (metadata.host === 'claude') return null;
  const parent = metadata.parentThreadId;
  if (![metadata.sessionId, parent].includes(input.session_id)) return null;
  return registeredChild(metadata, parent, { registryDir, lookup, verifyHost });
}
function browserState(binding, prior) {
  const target = readJson(join(binding.run_dir, 'roster.json')).target;
  const session = { sessionId: binding.browser_session_id, runId: binding.run_id, owner: binding.session_id, targetUrl: target.preview_url, target, created: false };
  for (const e of prior.filter(e => e.type === 'dragon-result' && e.confirmed)) {
    if (e.request?.params?.sessionId !== session.sessionId) continue;
    if (e.request.method === 'session.create') Object.assign(session, e.session, { created: true });
    if (e.request.method === 'openTab' && session.created) session.tabId = e.tabId;
    if (e.request.method === 'session.close') session.closed = true;
  }
  return session;
}
function policyForRun(runDir) {
  const path = join(runDir, 'native-gui-policy.json');
  if (!existsSync(path)) return null;
  const policy = readJson(path), target = readJson(join(runDir, 'roster.json')).target;
  if (policy.target?.url !== target.preview_url || (target.kind === 'deployed-build'
    ? policy.target.kind !== 'deployed-build' || policy.target.target_binding_sha256 !== target.target_binding_sha256
    : policy.target.commit !== target.version)) throw new Error('DRAGON_TARGET_SCOPE_MISMATCH');
  return policy;
}
function executionAllowed(runDir) {
  try { assertRunContract({ runDir, action: 'execute', role: 'executor_gui', preDispatch: true }); return true; }
  catch { return false; }
}
function childInspector({ request, policy, session }) {
  const gui = verifyProviderInterface({ skill: 'qa-gui' });
  const code = 'const m=await import(process.argv[1]);let raw="";for await(const c of process.stdin)raw+=c;process.stdout.write(JSON.stringify(m.validateNativeGuiRequest(JSON.parse(raw))));';
  const result = runAdapter([process.execPath, '--input-type=module', '-e', code, join(gui.root, 'scripts/lib/native-gui-trajectory.mjs')], {
    input: JSON.stringify({ request, policy, lockedPolicy: { policy: { ...session.policy, forbidSyntheticDOM: session.forbidSyntheticDOM }, session, expired: false } }), timeout: 10000 });
  if (result.status !== 0 || result.error || result.signal) throw new Error('DRAGON_CHILD_INSPECTION_FAILED');
  return JSON.parse(result.stdout);
}
export function livePolicyMatches(raw, session) {
  const effective = raw?.result;
  if (raw?.ok !== true || !effective || effective.ok === false || effective.expired !== false
    || !effective.policy || effective.policy.forbidSyntheticDOM !== false || effective.policy.requireTrusted !== true
    || !Array.isArray(effective.policy.allowedInput) || !effective.policy.allowedInput.includes('pointer') || !effective.policy.allowedInput.includes('key')) return false;
  const withoutLock = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => key !== 'locked'));
  return stableJson(withoutLock(effective.policy)) === stableJson(withoutLock(session.policy));
}

function liveSession(session, policy) {
  const gui = verifyProviderInterface({ skill: 'qa-gui' });
  const result = runAdapter([process.execPath, join(gui.root, 'scripts/qa_do.mjs'), '--method', 'session.list'], { timeout: 6000 });
  if (result.status !== 0 || result.error || result.signal) return false;
  const raw = unwrap(result.stdout), active = raw?.result?.sessions?.find(s => s.sessionId === session.sessionId);
  if (!(raw.ok === true && active?.alive === true && active.expired === false && active.circuitOpen === false && active.browserInstanceId === session.browserInstanceId && active.forbidSyntheticDOM === false && active.policy?.requireTrusted === true)) return false;
  const effective = runAdapter([process.execPath, join(gui.root, 'scripts/qa_do.mjs'), '--method', 'session.getPolicy', '--params', JSON.stringify({ sessionId: session.sessionId })], { timeout: 6000 });
  if (effective.status !== 0 || effective.error || effective.signal) return false;
  try { if (!livePolicyMatches(unwrap(effective.stdout), session)) return false; }
  catch { return false; }
  const status = runAdapter(['/usr/bin/curl', '--fail', '--silent', '--max-time', '3', dragonStatusUrl()], { timeout: 4000 });
  if (status.status !== 0 || status.error || status.signal) return false;
  const runtime = JSON.parse(status.stdout);
  // Public v1 (T1): the bridge and the extension each meet requirements.json; they need not be the same version.
  // A native GUI policy names the extension release its receipts carry (env.build.extVersion), so that is what stays pinned.
  return dragonStatusVerdict(runtime, undefined, { ownerGrant: loadOwnerGrant() }).ok === true && runtime.extension?.browserInstanceId === session.browserInstanceId
    && (!policy || runtime.extension?.version === policy.dragon.version);
}

// One trusted Dragon input at a time: browser-input.pending.json names the admitted input until its PostToolUse.
// An input whose PostToolUse never comes (the user refused the call, or the turn was interrupted) no longer blocks the
// run: a Stop or Interrupt of the same caller and turn after it means the call is over; so does a time longer than any
// role of the roster may run (its longest caps.timeout_ms, at least INPUT_IN_FLIGHT_MAX_MS). The next input records
// it as abandoned (<event>.input-abandoned.json, naming it in its own admission) and goes ahead. The abandoned input
// keeps its admission; with no confirmed result it never counts as a verified operation.
export const INPUT_IN_FLIGHT_MAX_MS = 5 * 60 * 1000;
const TURN_END = { stop: 'STOP_AFTER_INPUT', interrupt: 'INTERRUPT_AFTER_INPUT', 'worker-stop': 'STOP_AFTER_INPUT', 'worker-interrupt': 'INTERRUPT_AFTER_INPUT' };
function inputBoundMs(binding) {
  let caps = [];
  try { caps = readJson(join(binding.run_dir, 'roster.json')).roles?.map(role => role.caps?.timeout_ms).filter(v => Number.isInteger(v) && v > 0 && v <= 1800000) || []; } catch { caps = []; }
  return Math.max(INPUT_IN_FLIGHT_MAX_MS, ...caps);
}
function abandonedInput(pendingPath, prior, binding, nowMs) {
  let record = null;
  try { record = JSON.parse(readFileSync(pendingPath, 'utf8')); } catch { record = null; }
  let admittedAt = Date.parse(record?.at);
  if (!Number.isFinite(admittedAt)) { try { admittedAt = statSync(pendingPath).mtimeMs; } catch { return null; } }
  const caller = record?.caller?.sessionId ?? binding.session_id;
  const ended = prior.find(e => TURN_END[e.type] && Date.parse(e.at) >= admittedAt && (e.caller?.sessionId ?? binding.session_id) === caller
    && (!record?.turnId || !e.turnId || e.turnId === record.turnId));
  if (ended) return { toolUseId: record?.toolUseId ?? null, reason: TURN_END[ended.type], at: record?.at ?? null };
  if (nowMs - admittedAt > inputBoundMs(binding)) return { toolUseId: record?.toolUseId ?? null, reason: 'IN_FLIGHT_TIMEOUT', at: record?.at ?? null };
  return null;
}

export async function handleQaHook(input, { registryDir, decide = readContinuation, inspect = inspectDragonAdmission, live = liveSession,
  lookup = readContinuationBinding, readNativeMetadata = readNativeHookMetadata, verifyHost = verifyNativeHost,
  inspectChild = childInspector, inspectWrite = inspectBoardWrite, permitExecution = executionAllowed, loadPolicy = policyForRun, ledger = appendScrollLedger, now = Date.now } = {}) {
  let owner;
  try { owner = resolveHookOwner(input, { registryDir, lookup, readNativeMetadata, verifyHost }); }
  catch (error) { return unusableBinding(input, error?.code || error?.message || 'CONTINUATION_BINDING_UNREADABLE', registryDir); }
  if (!owner) return {};
  const { binding, caller } = owner;
  const dir = join(binding.run_dir, 'hook-events');
  mkdirSync(dir, { recursive: true });
  const prior = events(dir), event = input.hook_event_name, path = eventPath(dir, input);
  const at = new Date(now()).toISOString();
  if (existsSync(path)) return event === 'PreToolUse' ? deny('DRAGON_DUPLICATE_TOOL_USE') : readJson(path).output || {};
  if (event === 'Interrupt') {
    await immutable(path, { type: caller.kind === 'child' ? 'worker-interrupt' : 'interrupt', at, turnId: input.turn_id, caller, output: {} });
    return {};
  }
  if (event === 'SubagentStop' || event === 'Stop' && caller.kind === 'child') {
    await immutable(path, { type: 'worker-stop', at, turnId: input.turn_id, agentId: input.agent_id, caller, output: {} });
    return {};
  }
  if (event === 'Stop') {
    if (prior.some(e => e.type === 'interrupt' && e.turnId === input.turn_id)) return {};
    const earlier = prior.filter(e => e.type === 'stop' && e.decision?.disposition === 'CONTINUE');
    let decision;
    try { decision = decide({ runDir: binding.run_dir }); }
    catch (error) { decision = { disposition: 'CONTINUE', code: error.code || 'CONTINUATION_GATE_UNAVAILABLE', incomplete: true, progress: 'unverified', runId: binding.run_id, next: { caseId: '__contract__', kind: 'prepare', action: 'Diagnose the reported gate error without executing dependent product work.' } }; }
    const caps = readJson(join(binding.run_dir, 'roster.json')).roles?.map(role => role.caps?.timeout_ms).filter(v => Number.isInteger(v) && v > 0 && v <= 1800000) || [];
    const waitBudget = caps.length ? Math.max(...caps) : 120000;
    const exhausted = [...new Set(earlier.map(e => e.decision.next?.caseId))].filter(id => {
      const same = earlier.filter(e => e.decision.next?.caseId === id && (e.decision.progressByCase?.[id] || e.decision.progress) === (decision.progressByCase?.[id] || decision.progress));
      const firstWait = same.find(e => e.decision.next?.kind === 'wait');
      if (firstWait && now() - Date.parse(firstWait.at) < waitBudget) return same.filter(e => e.decision.next?.kind !== 'wait').length >= 3;
      return same.length >= 3;
    });
    if (exhausted.length) {
      try { decision = decide({ runDir: binding.run_dir, exhausted }); }
      catch (error) { decision = { disposition: 'WAIT', code: error.code || 'CONTINUATION_GATE_UNAVAILABLE', incomplete: true, runId: binding.run_id, next: null }; }
    }
    // Claude Code Stop input may omit last_assistant_message; read it from the original transcript.
    const claudeStop = input.last_assistant_message === undefined && typeof input.transcript_path === 'string' && isClaudeTranscriptPath(input.transcript_path);
    const lastMessage = input.last_assistant_message ?? (claudeStop ? lastClaudeAssistantText(input.transcript_path) : undefined);
    // One automatic WAIT correction per blocked code, on every host: Claude Code now sends last_assistant_message on
    // each Stop, so the guard cannot depend on reading the transcript. A Stop that continues an earlier hook block
    // (stop_hook_active) after a correction of the same code only reports.
    // A WAIT report starts with the marker SKILL.md names (report-tokens.mjs; the legacy marker is accepted too),
    // markdown emphasis around it included.
    const repeated = input.stop_hook_active === true && prior.some(e => e.type === 'stop' && e.correction === true && e.decision?.code === decision.code);
    const correction = decision.disposition === 'WAIT' && !repeated && !startsWithWaitMarker(lastMessage);
    const output = decision.disposition === 'CONTINUE' || correction ? { decision: 'block', reason: automaticContinuationReason(correction
      ? { ...decision, next: { kind: 'report', action: `Report ${WAIT_MARKER} with blocked operations, evidence, owner and recovery condition. Do not resume blocked work or claim completion.` } } : decision) }
      : decision.disposition === 'WAIT' ? { systemMessage: `QA ${WAIT_MARKER}: ${decision.code}. Blocked work and its recovery condition remain in the run evidence.` } : {};
    await immutable(path, { type: 'stop', at, turnId: input.turn_id, decision, output, ...(correction ? { correction: true } : {}) });
    await ledger({ cwd: dirname(dirname(binding.run_dir)), runId: binding.run_id, caseId: `hook:${decision.next?.caseId || decision.disposition}`, status: decision.disposition.toLowerCase(), evidence: [path], digest: decision.code, tries: earlier.filter(e => e.decision.next?.caseId === decision.next?.caseId).length + 1 });
    return output;
  }
  const writeKind = directBoardWrite(input.tool_name);
  if (writeKind) {
    if (event === 'PostToolUse' && writeKind.startsWith('notion-create') && plannedCall({ runDir: binding.run_dir, toolInput: input.tool_input })) {
      recordNotionResult({ runDir: binding.run_dir, toolName: input.tool_name, toolUseId: input.tool_use_id, toolInput: input.tool_input, toolResponse: toolResponse(input) });
    }
    if (event !== 'PreToolUse') return {};
    const result = writeKind === 'space-create-page'
      ? inspectWrite({ runDir: binding.run_dir, toolName: SPACE_CREATE_PAGE_TOOL, toolInput: input.tool_input })
      : writeKind === 'notion-create-database' || writeKind === 'notion-create-pages'
        ? admitNotionWrite({ runDir: binding.run_dir, toolName: input.tool_name, toolInput: input.tool_input })
        : { allowed: false, code: writeKind === 'unsupported-space-write' ? 'BOARD_CONNECTOR_UNSUPPORTED_PROJECTION' : 'BOARD_WRITE_NOT_PLANNED' };
    await immutable(path, { type: 'board-admission', at, toolUseId: input.tool_use_id, caller,
      toolName: input.tool_name, requestHash: sha256(stableJson(input.tool_input ?? null)), allowed: result.allowed === true,
      code: result.code, evidence: result.allowed ? result : undefined, output: {} });
    return result.allowed ? {} : deny(result.code || 'BOARD_WRITE_ADMISSION_FAILED');
  }
  if (event === 'PostToolUse' && notionToolKind(input.tool_name) === 'read' && plannedCall({ runDir: binding.run_dir, toolInput: input.tool_input })) {
    recordNotionResult({ runDir: binding.run_dir, toolName: input.tool_name, toolUseId: input.tool_use_id, toolInput: input.tool_input, toolResponse: toolResponse(input) });
    return {};
  }
  if (!nativeTool(input.tool_name)) {
    if (event === 'PreToolUse' && shellDragonRoute(input)) return deny('DRAGON_USE_REGISTERED_MCP');
    return {};
  }
  const request = input.tool_input, session = browserState(binding, prior);
  if (event === 'PreToolUse') {
    let policy = null;
    try { policy = loadPolicy(binding.run_dir); } catch { /* A missing policy cannot authorize input. */ }
    const roster = readJson(join(binding.run_dir, 'roster.json'));
    const admission = { request, session, targetUrl: roster.target.preview_url, executionAllowed: false, policy, childInspector: inspectChild };
    let result = inspect(admission);
    // Only a validated trusted action needs the full execution contract.
    if (!result.allowed && result.code === 'DRAGON_EXECUTION_NOT_ALLOWED' && permitExecution(binding.run_dir) === true) {
      result = inspect({ ...admission, executionAllowed: true });
    }
    if (!result.allowed) return deny(result.code);
    if (result.requiresLive && !live(session, policy)) return deny('DRAGON_SESSION_STALE');
    const pending = join(dir, 'browser-input.pending.json');
    let supersedes = null;
    if (result.mutating) {
      if (existsSync(pending)) {
        supersedes = abandonedInput(pending, prior, binding, now());
        if (!supersedes) return deny('DRAGON_INPUT_IN_FLIGHT');
        try { renameSync(pending, eventPath(dir, input, 'input-abandoned')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; /* a parallel hook moved it first */ }
      }
      try { writeAtomic(pending, stableJson({ toolUseId: input.tool_use_id, requestHash: sha256(stableJson(request)), at, turnId: input.turn_id ?? null, caller }), { exclusive: true }); }
      catch (e) { if (e.code === 'EEXIST') return deny('DRAGON_INPUT_IN_FLIGHT'); throw e; }
    }
    await immutable(path, { type: 'dragon-admission', at, toolUseId: input.tool_use_id, caller, requestHash: sha256(stableJson(request)), ...(supersedes ? { supersedes } : {}), output: {} });
    return {};
  }
  if (event === 'PostToolUse') {
    const admitted = prior.find(e => e.type === 'dragon-admission' && e.toolUseId === input.tool_use_id);
    if (!admitted || admitted.caller?.sessionId !== caller.sessionId || admitted.caller?.kind !== caller.kind
      || admitted.requestHash !== sha256(stableJson(request))) return { systemMessage: 'QA execution receipt is unbound; the operation cannot count as verified.' };
    let raw;
    try { raw = unwrap(input.tool_response); } catch { raw = null; }
    const result = raw?.result;
    let confirmed = raw?.ok === true && result && result.ok !== false && result.completed !== false && result.human_needed !== true && !result.error && !raw.error;
    if (request.method === 'session.create') confirmed &&= result.sessionId === session.sessionId && result.forbidSyntheticDOM === false && result.policy?.requireTrusted === true && Boolean(result.nonce && result.browserInstanceId);
    if (request.method === 'openTab') confirmed &&= Number.isInteger(result.tabId);
    const record = { type: 'dragon-result', at, toolUseId: input.tool_use_id, caller, request, confirmed: Boolean(confirmed), responseHash: sha256(stableJson(input.tool_response)), output: {} };
    if (confirmed && request.method === 'session.create') record.session = Object.fromEntries(['sessionId','nonce','browserInstanceId','forbidSyntheticDOM','policy'].map(k => [k,result[k]]));
    if (confirmed && request.method === 'openTab') record.tabId = result.tabId;
    await immutable(path, record);
    const pending = join(dir, 'browser-input.pending.json');
    if (existsSync(pending) && readJson(pending).toolUseId === input.tool_use_id) renameSync(pending, eventPath(dir, input, 'input-completed'));
    return {};
  }
  return {};
}

// Through realpath, so a hook command that names the script by a linked path still runs it (see plugin-gate.mjs).
const isMain = () => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) {
  let input;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--registry') throw new Error('HOOK_REGISTRY_REQUIRED');
    let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('HOOK_INPUT_TOO_LARGE'); }
    input = JSON.parse(raw);
    process.stdout.write(JSON.stringify(await handleQaHook(input, { registryDir: args[1] })) + '\n');
  } catch (error) {
    const code = error.code || error.message || 'QA_HOOK_FAILED';
    process.stdout.write(JSON.stringify(input?.hook_event_name === 'PreToolUse' ? deny(code) : { systemMessage: `QA ${WAIT_MARKER}: hook error ${code}` }) + '\n');
  }
}
