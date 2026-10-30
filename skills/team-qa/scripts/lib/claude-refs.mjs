// Original tool-call refs from a Claude Code root transcript (eval compat 3, part B1).
// The deployed-build lane proves its identity and tool readiness with refs into the root orchestrator transcript:
// {path, call_line, result_line, call_sha256, result_sha256, host}. This module only locates those lines; every
// ref it returns is still verified by the existing readers (lib/tool-preflight.mjs, lib/deployed-target.mjs).
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail, readJson, sha256 } from './core.mjs';
import { claudeHostSource, claudeProjectsRoot, claudeToolPair, isClaudeTranscriptPath, visibleClaudeAssistantText } from './host-transcript.mjs';
import { scanOriginalSource } from './original-source.mjs';

// Same tool-name rule as the Dragon reader (lib/tool-preflight.mjs dragon()).
export const DRAGON_RPC_TOOL = /^mcp__.*dragon.*__dragon_rpc$/i;
// The default status command; the preflight follows TEAMQA_DRAGON_STATUS_URL through lib/dragon-endpoint.mjs (eval compat 9).
export const DRAGON_STATUS_COMMAND = 'curl --fail --silent http://127.0.0.1:9233/status';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refFail = (code, detail = '') => fail(3, code, detail, 'ungraded');

// Claude Code stores a project's sessions under ~/.claude/projects/<launch directory, every non-alphanumeric as '-'>/.
export function claudeProjectDirName(path) { return String(path).replace(/[^A-Za-z0-9]/g, '-'); }

function realOrNull(path) { try { return realpathSync(path); } catch { return null; } }
function rootTranscripts(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name)).filter(isClaudeTranscriptPath).map(path => realpathSync(path));
}

// The run's root transcript. After roster approval it is always the approving session (the only session whose
// refs the verifiers accept); before approval an explicit --transcript wins, otherwise the one transcript of the
// current project directory (or the session named by CLAUDE_CODE_SESSION_ID) that `accept` recognises.
export function locateRootTranscript({ runDir, transcript, accept = () => true, expected = 'the expected calls', cwd = process.cwd(), env = process.env } = {}) {
  const approval = runDir ? join(runDir, 'control', 'approvals', 'roster.json') : null;
  const envSession = SESSION_ID.test(env.CLAUDE_CODE_SESSION_ID || '') ? env.CLAUDE_CODE_SESSION_ID.toLowerCase() : null;
  if (approval && existsSync(approval)) {
    const source = readJson(approval).event?.source?.path;
    if (typeof source !== 'string' || !isClaudeTranscriptPath(source)) refFail('CLAUDE_REFS_HOST_NOT_CLAUDE', 'roster approval is not bound to a Claude Code root transcript');
    const root = realpathSync(source), session = claudeHostSource(root).session_id;
    if (transcript !== undefined && realOrNull(transcript) !== root) refFail('CLAUDE_REFS_HOST_NOT_ORCHESTRATOR', `approved root session is ${session}`);
    if (envSession && envSession !== session.toLowerCase()) refFail('CLAUDE_REFS_HOST_NOT_ORCHESTRATOR', `this command runs in session ${envSession}; approved root session is ${session}`);
    return { path: root, session_id: session, located_by: 'roster-approval' };
  }
  if (transcript !== undefined) {
    if (!isClaudeTranscriptPath(transcript)) refFail('CLAUDE_REFS_TRANSCRIPT_UNTRUSTED', 'expected ~/.claude/projects/<project>/<session-id>.jsonl');
    const path = realpathSync(transcript);
    return { path, session_id: claudeHostSource(path).session_id, located_by: 'flag' };
  }
  const projects = claudeProjectsRoot();
  if (!projects) refFail('CLAUDE_REFS_TRANSCRIPT_NOT_FOUND', `no ~/.claude/projects holds ${expected}; pass --transcript`);
  if (envSession) {
    const named = readdirSync(projects).map(dir => join(projects, dir, `${envSession}.jsonl`)).filter(path => existsSync(path) && isClaudeTranscriptPath(path)).map(path => realpathSync(path));
    const accepted = named.filter(accept);
    if (accepted.length === 1) return { path: accepted[0], session_id: claudeHostSource(accepted[0]).session_id, located_by: 'session-env' };
    if (accepted.length > 1) refFail('CLAUDE_REFS_TRANSCRIPT_AMBIGUOUS', accepted.join(','));
  }
  // Nearest project directory of the working directory or an ancestor (the session may have been started above it).
  let dir = null;
  for (let at = cwd; ; at = dirname(at)) {
    const candidate = join(projects, claudeProjectDirName(at));
    if (existsSync(candidate)) { dir = candidate; break; }
    if (dirname(at) === at) break;
  }
  const accepted = rootTranscripts(dir).filter(accept);
  if (accepted.length === 0) refFail('CLAUDE_REFS_TRANSCRIPT_NOT_FOUND', `no root transcript of this project holds ${expected}; pass --transcript`);
  if (accepted.length > 1) refFail('CLAUDE_REFS_TRANSCRIPT_AMBIGUOUS', `${accepted.length} root transcripts match; pass --transcript`);
  return { path: accepted[0], session_id: claudeHostSource(accepted[0]).session_id, located_by: 'project-directory' };
}

// The marker-bound scan of the run's root transcript, parsed once: discovery keeps the scan of every candidate that
// shows `marker` as visible root assistant text (cheap byte prefilter first) and the caller reuses it.
export function locateMarkedTranscript({ runDir, transcript, marker }) {
  const scans = new Map();
  const scan = path => { if (!scans.has(path)) scans.set(path, scanClaudeTranscript(path, { marker })); return scans.get(path); };
  const located = locateRootTranscript({ runDir, transcript, expected: `the visible marker ${marker}`,
    accept: path => readFileSync(path, 'utf8').includes(marker) && scan(path).marker_line !== null });
  const scanned = scan(located.path);
  if (scanned.marker_line === null) refFail('CLAUDE_REFS_MARKER_NOT_FOUND', marker);
  return { located, scan: scanned };
}

function toolKind(name) {
  if (name === 'Bash') return 'bash';
  if (typeof name === 'string' && DRAGON_RPC_TOOL.test(name)) return 'dragon';
  return null;
}
function resultTexts(content) {
  if (typeof content === 'string') return [content];
  return Array.isArray(content) ? content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text) : [];
}

// A call/result pair is usable only when it is the root's own, complete and successful. The first failing rule wins.
function classify(record) {
  const { call, result } = record;
  if (call.entry.isSidechain === true) return 'CLAUDE_REF_SIDECHAIN';
  if (call.entry.message.content.length !== 1) return 'CLAUDE_REF_CALL_SHAPE';
  if (!result) return 'CLAUDE_REF_RESULT_MISSING';
  if (result.entry.isSidechain === true) return 'CLAUDE_REF_SIDECHAIN';
  const blocks = result.entry.message?.content;
  if (!Array.isArray(blocks) || blocks.length !== 1) return 'CLAUDE_REF_PAIR';
  if (blocks[0].is_error === true) return 'CLAUDE_REF_ERROR';
  const pair = claudeToolPair(call.entry, result.entry);
  // A persisted preview is usable only when the line still holds the original result (toolUseResult).
  if (pair.error && resultTexts(blocks[0].content).some(text => text.trimStart().startsWith('<persisted-output>'))) return 'CLAUDE_REF_PERSISTED_OUTPUT';
  if (pair.error) return 'CLAUDE_REF_PAIR';
  record.pair = pair;
  if (record.kind === 'bash') {
    if (pair.output.exit_code !== 0) return 'CLAUDE_REF_ERROR';
    return null;
  }
  if (!pair.input || typeof pair.input.method !== 'string' || !pair.input.params || typeof pair.input.params !== 'object' || Array.isArray(pair.input.params)) return 'CLAUDE_REF_CALL_SHAPE';
  if (pair.output.isError) return 'CLAUDE_REF_ERROR';
  const text = pair.output.content.filter(c => c.type === 'text');
  if (text.length !== 1) return 'CLAUDE_REF_RESULT_SHAPE';
  let value;
  try { value = JSON.parse(text[0].text); } catch { return 'CLAUDE_REF_TRUNCATED'; }
  if (value?.truncated === true || value?.isTruncated === true) return 'CLAUDE_REF_TRUNCATED';
  if (value?.ok !== true || value.error) return 'CLAUDE_REF_RPC_ERROR';
  record.value = value;
  return null;
}

function scanOnce(path, marker) {
  const calls = new Map();
  let records = [], markerLine = null, invalidLine = null;
  scanOriginalSource(path, (raw, index) => {
    if (!raw) return;
    let entry;
    try { entry = JSON.parse(raw); } catch { if (invalidLine === null) invalidLine = index; return; }
    const content = entry?.message?.content;
    if (marker !== undefined && entry?.type === 'assistant' && visibleClaudeAssistantText(entry)?.includes(marker)) {
      // Only calls after the latest marker count; a call on the marker line itself has no earlier binding.
      markerLine = index; calls.clear(); records = [];
      return;
    }
    if (entry?.type === 'assistant' && Array.isArray(content)) {
      if (marker !== undefined && markerLine === null) return;
      for (const use of content) {
        const kind = use?.type === 'tool_use' && typeof use.id === 'string' ? toolKind(use.name) : null;
        if (!kind) continue;
        const record = { kind, id: use.id, name: use.name, method: kind === 'dragon' ? use.input?.method : undefined,
          params: kind === 'dragon' ? use.input?.params : undefined, command: kind === 'bash' ? use.input?.command : undefined,
          call: { index, sha256: sha256(raw), entry }, result: null };
        calls.set(use.id, record); records.push(record);
      }
      return;
    }
    if (entry?.type === 'user' && Array.isArray(content)) {
      for (const block of content) {
        const record = block?.type === 'tool_result' ? calls.get(block.tool_use_id) : undefined;
        if (record && !record.result) record.result = { index, sha256: sha256(raw), entry };
      }
    }
  });
  return { records, markerLine, invalidLine };
}

// One pass over the original transcript. With `marker`, only Bash and Dragon calls after the latest visible marker
// line are returned; without it, every one in the file. Each record carries `problem` (null when usable).
export function scanClaudeTranscript(path, { marker } = {}) {
  path = realpathSync(path);
  let scanned;
  for (let attempt = 0; ; attempt++) {
    try { scanned = scanOnce(path, marker); break; }
    catch (error) { if (error?.code !== 'ORIGINAL_SOURCE_CHANGED' || attempt >= 2) throw error; }
  }
  const { records, markerLine, invalidLine } = scanned;
  // The verifier parses every line before its binding marker; an unreadable earlier line can never verify.
  if (marker !== undefined && markerLine !== null && invalidLine !== null && invalidLine < markerLine) refFail('CLAUDE_REFS_RAW_INVALID', `line ${invalidLine + 1}`);
  for (const record of records) record.problem = classify(record);
  return { path, marker_line: markerLine === null ? null : markerLine + 1, records };
}

export function claudeRef(path, record, host = claudeHostSource(path)) {
  return { path, call_line: record.call.index + 1, result_line: record.result.index + 1,
    call_sha256: record.call.sha256, result_sha256: record.result.sha256, host };
}

export function requireUsable(record, what) {
  if (!record) refFail('CLAUDE_REFS_CALL_MISSING', what);
  if (record.problem) refFail(record.problem, `${what} at line ${record.call.index + 1}`);
  return record;
}

const SESSION_KEYS = ['sessionId', 'nonce', 'browserInstanceId'];
export function sameSession(params, session) { return Boolean(params) && SESSION_KEYS.every(key => typeof params[key] === 'string' && params[key] === session[key]); }
export function sessionOf(params) { return Object.fromEntries(SESSION_KEYS.map(key => [key, params?.[key]])); }

// The passive identity triple: among the root's page reads (getPageIdentity or getPageHtml), getNetwork and getTabInfo
// calls after the marker (on the given session and tab, when known), the last three must be page read → getNetwork →
// getTabInfo, in that order, on one session triple and tab, and each must be usable. Older attempts never stand in for
// a failed latest one. getPageIdentity with getNetwork {summary:true} is the compact pair (upgrade U1).
export const PAGE_READS = ['getPageIdentity', 'getPageHtml'];
export function passiveTriple(records, { session, tabId } = {}) {
  const passive = records.filter(r => r.kind === 'dragon' && [...PAGE_READS, 'getNetwork', 'getTabInfo'].includes(r.method)
    && (!session || sameSession(r.params, session)) && (tabId === undefined || r.params?.tabId === tabId));
  const [page, network, tab] = passive.slice(-3);
  if (passive.length < 3 || !PAGE_READS.includes(page.method) || network.method !== 'getNetwork' || tab.method !== 'getTabInfo') {
    refFail('WEB_IDENTITY_SEQUENCE', `the last passive calls after the marker${session ? ` on session ${session.sessionId} tab ${tabId}` : ''} must be getPageIdentity (or getPageHtml) → getNetwork → getTabInfo; found ${passive.slice(-3).map(r => r.method).join(' → ') || 'none'}`);
  }
  for (const [record, what] of [[page, page.method], [network, 'getNetwork'], [tab, 'getTabInfo']]) requireUsable(record, what);
  const triple = sessionOf(page.params);
  if (!SESSION_KEYS.every(key => typeof triple[key] === 'string' && triple[key]) || !Number.isInteger(page.params.tabId)
    || !sameSession(network.params, triple) || !sameSession(tab.params, triple) || network.params.tabId !== page.params.tabId || tab.params.tabId !== page.params.tabId) {
    refFail('WEB_IDENTITY_SESSION_DRIFT', `${page.method}, getNetwork and getTabInfo must use one session triple and tabId`);
  }
  return { page, network, tab, session: triple, tabId: page.params.tabId };
}

// HTML of a usable getPageHtml record, as the Dragon reader extracts it (plain string or the evidence envelope).
export function pageHtml(record) {
  const result = record.value?.result;
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof result.value === 'string') return result.value;
  refFail('WEB_IDENTITY_HTML', `getPageHtml at line ${record.call.index + 1} returned no HTML`);
}
