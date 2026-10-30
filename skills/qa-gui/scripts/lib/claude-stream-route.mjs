// Claude Code GUI executor route check for deployed-build (qa-gui/receipt/web-v1) receipts.
//
// On a Claude Code root, Team QA dispatches the GUI Executor as a `claude -p` child and attests
// it with `source.kind = 'claude-stream'`: the child's stream-json stdout, hashed into the role
// attestation. Team QA's `assertRoleAttestation` has already verified that attestation (approved
// roster seat, model/effort, context packet, independent session, the seat's locked single-server
// Dragon `mcp_config`, and QA Code's provider parser with `allowedMcpServers`). QA GUI accepts it
// on the web lane only after this independent, deterministic check of the stream itself.
//
// This proves the executor's MCP route. It is not native GUI policy v2 compliance: this lane has
// no pinned Dragon session/tab, capability or read allowlist, trusted-receipt, privacy-mask or
// recording-delivery check. See references/release-receipt-web-v1.md.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const CLAUDE_STREAM_ROUTE_RULE = 'qa-gui/claude-stream-dragon-route/v1';
// Server names Team QA's roster accepts for the executor_gui mcp_config (roster.mjs mcpRoute).
export const DRAGON_ROUTE_SERVERS = Object.freeze(['dragon', 'Dragon_Browser']);
// Built-in tools that reach the web without Dragon, or delegate to an agent whose calls this stream
// does not attest. Team QA's Claude dispatcher already disallows all four.
export const FOREIGN_ROUTE_TOOLS = Object.freeze(['WebFetch', 'WebSearch', 'Task', 'Agent']);
// Lexical rule for Bash `command` strings, applied after removing quotes and backslashes (the
// shell joins adjacent quoted fragments). Browser automation, browser binaries, Chrome DevTools
// Protocol, and OS browser launchers. HTTP clients such as curl are not browsers and stay allowed.
export const FOREIGN_BROWSER_COMMAND_PATTERNS = Object.freeze([
  /\bplaywright\b/i,
  /\bpuppeteer\b/i,
  /\bselenium\b/i,
  /\bwebdriver(?:io)?\b/i,
  /\bwdio\b/i,
  /\b(?:chrome|gecko|safari|msedge|edge)driver\b/i,
  /\bcypress\b/i,
  /\bchromium(?:-browser)?\b/i,
  /\bgoogle[- ]chrome\b/i,
  /\bchrome-headless-shell\b/i,
  /--headless\b/i,
  /\bfirefox\b/i,
  /\bmicrosoft[- ]edge\b/i,
  /\bmsedge\b/i,
  /\bsafari\b/i,
  /--remote-debugging-(?:port|pipe|address)\b/i,
  /\bchrome-remote-interface\b/i,
  /\bdevtools-protocol\b/i,
  /\bcdp\b/i,
  /:9222\b/,
  /\bosascript\b/i,
  /\bxdg-open\b/i,
  /\bsensible-browser\b/i,
  /\bx-www-browser\b/i,
  /(?:^|[;&|()`])\s*open\s+\S/im,
]);

const SHA256 = /^[a-f0-9]{64}$/;
const INVALID = 'TEAMQA_WEB_CLAUDE_STREAM_INVALID';
const FOREIGN = 'TEAMQA_WEB_CLAUDE_FOREIGN_BROWSER_ROUTE';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const detail = (value) => String(value).replace(/[^A-Za-z0-9_.:+=@/-]/g, '_').slice(0, 96);

// A Dragon RPC succeeded under the same rule as Team QA's preflight Dragon operation check.
export function dragonRpcSucceeded(envelope) {
  if (!isObject(envelope) || envelope.ok !== true || envelope.error
    || envelope.truncated === true || envelope.isTruncated === true) return false;
  const result = envelope.result;
  return result !== null && typeof result === 'object' && result.ok !== false && result.completed !== false
    && !result.human_needed && !result.error
    && !(Array.isArray(result.results) && result.results.some((item) => item?.ok === false));
}

// Claude Code 2.1.311 omits is_error on successful MCP tool results; true or any non-boolean fails.
function decodeToolResult(block) {
  if (block.is_error !== undefined && block.is_error !== false) return null;
  let text = null;
  if (typeof block.content === 'string') text = block.content;
  else if (Array.isArray(block.content)) {
    const texts = block.content.filter((item) => item?.type === 'text');
    if (texts.length === 1 && typeof texts[0].text === 'string') text = texts[0].text;
  }
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function foreignBrowserCommand(command) {
  if (typeof command !== 'string') return null;
  const lexical = command.replace(/["'\\]/g, '');
  for (const pattern of FOREIGN_BROWSER_COMMAND_PATTERNS) {
    const match = pattern.exec(lexical);
    if (match) return match[0].trim().toLowerCase();
  }
  return null;
}

// Pure and deterministic. Every non-empty line must be a JSON object. Rules, in report order:
// 1. at least one system/init event, before any assistant, user or result event;
// 2. every init, every result and every event carrying session_id names the attested session;
// 3. every init lists exactly one MCP server, the roster's Dragon route, with status "connected",
//    and exposes no mcp__ tool of another server;
// 4. no tool use, executed or denied, in any assistant event (subagent events included) drives a
//    web route outside Dragon: an mcp__ tool of another server, a server_tool_use/mcp_tool_use
//    block, a FOREIGN_ROUTE_TOOLS tool, or a Bash command matching FOREIGN_BROWSER_COMMAND_PATTERNS;
//    tool ids are unique and each tool_result follows its tool_use once;
// 5. exactly one result event, subtype "success" with is_error false, and no assistant or user
//    event after it;
// 6. at least one mcp__<route>__dragon_rpc call with a string method whose tool_result is not an
//    error and decodes to a successful Dragon envelope.
export function inspectClaudeStreamDragonRoute({ stream, sessionId, server } = {}) {
  const errors = [];
  const summary = { events: 0, init_events: 0, tool_uses: 0, dragon_rpc_calls: 0, dragon_rpc_ok: 0 };
  // Dragon sessions the executor itself used in successful dragon_rpc calls: their params.sessionId, and the session a
  // successful session.create returned. A case-scoped receipt (upgrade U2) requires the case's state receipts to name one.
  const sessions = new Set();
  const add = (code, info) => errors.push(info === undefined ? code : `${code}:${detail(info)}`);
  if (typeof stream !== 'string' || typeof sessionId !== 'string' || !sessionId || !DRAGON_ROUTE_SERVERS.includes(server)) {
    add(INVALID, 'input');
    return { errors, summary };
  }
  const prefix = `mcp__${server}__`;
  const dragonRpc = `${prefix}dragon_rpc`;
  const events = [];
  for (const [index, line] of stream.split('\n').entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { event = null; }
    if (!isObject(event)) { add(INVALID, `line=${index + 1}`); continue; }
    events.push({ line: index + 1, event });
  }
  summary.events = events.length;
  const isInit = (event) => event.type === 'system' && event.subtype === 'init';
  const inits = events.filter(({ event }) => isInit(event));
  summary.init_events = inits.length;
  const firstTurn = events.find(({ event }) => ['assistant', 'user', 'result'].includes(event.type));
  if (!inits.length || (firstTurn && firstTurn.line < inits[0].line)) add(INVALID, 'init');

  const drift = events.find(({ event }) => (isInit(event) || event.type === 'result' || Object.hasOwn(event, 'session_id'))
    && event.session_id !== sessionId);
  if (drift) add('TEAMQA_WEB_CLAUDE_STREAM_SESSION', `line=${drift.line}`);

  for (const { line, event } of inits) {
    const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : null;
    if (!servers || servers.length !== 1 || !isObject(servers[0]) || servers[0].name !== server) {
      add('TEAMQA_WEB_CLAUDE_MCP_ROUTE_MISMATCH', `line=${line}:${servers ? servers.map((item) => item?.name).join('+') : 'none'}`);
    } else if (servers[0].status !== 'connected') {
      add('TEAMQA_WEB_CLAUDE_DRAGON_NOT_CONNECTED', `line=${line}:${servers[0].status}`);
    }
    if (!Array.isArray(event.tools) || event.tools.some((tool) => typeof tool !== 'string')) add(INVALID, `line=${line}:tools`);
    else {
      const foreign = event.tools.filter((tool) => tool.startsWith('mcp__') && !tool.startsWith(prefix)).sort();
      if (foreign.length) add('TEAMQA_WEB_CLAUDE_MCP_ROUTE_MISMATCH', `line=${line}:${foreign[0]}`);
    }
  }

  const uses = new Map();
  const answered = new Set();
  for (const { line, event } of events) {
    if (event.type === 'assistant') {
      const content = event.message?.content;
      if (!Array.isArray(content)) { add(INVALID, `line=${line}:assistant`); continue; }
      for (const block of content) {
        if (!isObject(block)) { add(INVALID, `line=${line}:block`); continue; }
        if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') { add(FOREIGN, `line=${line}:${block.type}:${block.name}`); continue; }
        if (block.type !== 'tool_use') continue;
        summary.tool_uses += 1;
        if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || uses.has(block.id)) { add(INVALID, `line=${line}:tool_use`); continue; }
        uses.set(block.id, { name: block.name, input: block.input });
        if (block.name.startsWith('mcp__')) {
          if (!block.name.startsWith(prefix)) add(FOREIGN, `line=${line}:${block.name}`);
          else if (block.name === dragonRpc) summary.dragon_rpc_calls += 1;
        } else if (FOREIGN_ROUTE_TOOLS.includes(block.name)) add(FOREIGN, `line=${line}:${block.name}`);
        else if (block.name === 'Bash') {
          if (!isObject(block.input) || typeof block.input.command !== 'string') { add(INVALID, `line=${line}:Bash`); continue; }
          const token = foreignBrowserCommand(block.input.command);
          if (token) add(FOREIGN, `line=${line}:Bash:${token}`);
        }
      }
    } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (!isObject(block) || block.type !== 'tool_result') continue;
        const use = uses.get(block.tool_use_id);
        if (!use || answered.has(block.tool_use_id)) { add(INVALID, `line=${line}:tool_result`); continue; }
        answered.add(block.tool_use_id);
        const envelope = use.name === dragonRpc ? decodeToolResult(block) : null;
        if (use.name === dragonRpc && isObject(use.input) && typeof use.input.method === 'string' && use.input.method
          && dragonRpcSucceeded(envelope)) {
          summary.dragon_rpc_ok += 1;
          if (typeof use.input.params?.sessionId === 'string' && use.input.params.sessionId) sessions.add(use.input.params.sessionId);
          if (use.input.method === 'session.create' && typeof envelope.result?.sessionId === 'string' && envelope.result.sessionId) sessions.add(envelope.result.sessionId);
        }
      }
    }
  }

  const finals = events.filter(({ event }) => event.type === 'result');
  const final = finals.length === 1 ? finals[0] : null;
  if (!final || final.event.subtype !== 'success' || final.event.is_error !== false
    || events.some(({ line, event }) => ['assistant', 'user'].includes(event.type) && line > final.line)) {
    add('TEAMQA_WEB_CLAUDE_STREAM_INCOMPLETE', final ? `${final.event.subtype}` : `results=${finals.length}`);
  }
  if (summary.dragon_rpc_ok === 0) add('TEAMQA_WEB_CLAUDE_DRAGON_CALL_REQUIRED');
  return { errors, summary, sessions: [...sessions].sort() };
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function read(path, code) {
  try { return readFileSync(path); } catch { throw new Error(code); }
}

// Throws the first stable error code, or returns the route summary recorded in teamqa_provenance.
// `attestation` is the output of Team QA's assertRoleAttestation; `runDir` is the real run directory
// that holds role-bindings/executor_gui.json.
export function assertClaudeStreamWebRoute(attestation, { runDir, targetBindingSha256, withSessions = false } = {}) {
  const fail = (code) => { throw new Error(code); };
  const a = attestation, source = a?.source;
  if (!isObject(a) || a.role !== 'executor_gui' || a.graded !== true || source?.kind !== 'claude-stream'
    || a.runtime?.provider !== 'anthropic' || a.runtime?.harness !== 'claude'
    || typeof a.session_id !== 'string' || !a.session_id || typeof source.path !== 'string' || !source.path
    || !SHA256.test(source.sha256 || '') || !SHA256.test(a.roster_hash || '')
    || typeof runDir !== 'string' || !isAbsolute(runDir) || !SHA256.test(targetBindingSha256 || '')) fail('TEAMQA_WEB_CLAUDE_ATTESTATION_SHAPE');

  const rosterRaw = read(join(runDir, 'roster.json'), 'TEAMQA_WEB_CLAUDE_ROSTER_DRIFT');
  if (sha256(rosterRaw) !== a.roster_hash) fail('TEAMQA_WEB_CLAUDE_ROSTER_DRIFT');
  let roster = null;
  try { roster = JSON.parse(rosterRaw); } catch { fail('TEAMQA_WEB_CLAUDE_ROSTER_DRIFT'); }
  if (roster?.target?.kind !== 'deployed-build' || roster.target.target_binding_sha256 !== targetBindingSha256) fail('TEAMQA_WEB_CLAUDE_TARGET_MISMATCH');

  const seats = Array.isArray(roster.roles) ? roster.roles.filter((seat) => seat?.role === 'executor_gui') : [];
  const seat = seats.length === 1 ? seats[0] : null, pin = seat?.mcp_config;
  if (!seat || seat.harness !== 'claude' || seat.provider !== 'anthropic' || !isObject(pin)
    || typeof pin.path !== 'string' || !isAbsolute(pin.path) || !SHA256.test(pin.sha256 || '')) fail('TEAMQA_WEB_CLAUDE_ROUTE_REQUIRED');
  const configRaw = read(pin.path, 'TEAMQA_WEB_CLAUDE_ROUTE_DRIFT');
  if (sha256(configRaw) !== pin.sha256) fail('TEAMQA_WEB_CLAUDE_ROUTE_DRIFT');
  let config = null;
  try { config = JSON.parse(configRaw); } catch { config = null; }
  const servers = isObject(config) && Object.keys(config).length === 1 && isObject(config.mcpServers) ? Object.keys(config.mcpServers) : [];
  if (servers.length !== 1 || !DRAGON_ROUTE_SERVERS.includes(servers[0])) fail('TEAMQA_WEB_CLAUDE_ROUTE_REQUIRED');

  let streamPath = null, raw = null;
  try {
    streamPath = realpathSync(resolve(runDir, source.path));
    if (!lstatSync(streamPath).isFile()) throw new Error('not a regular file');
    raw = readFileSync(streamPath);
  } catch { fail('TEAMQA_WEB_CLAUDE_STREAM_DRIFT'); }
  if (!inside(runDir, streamPath) || sha256(raw) !== source.sha256) fail('TEAMQA_WEB_CLAUDE_STREAM_DRIFT');

  const inspected = inspectClaudeStreamDragonRoute({ stream: raw.toString('utf8'), sessionId: a.session_id, server: servers[0] });
  if (inspected.errors.length) fail(inspected.errors[0]);
  return { rule: CLAUDE_STREAM_ROUTE_RULE, mcp_server: servers[0], mcp_config_sha256: pin.sha256, dragon_rpc_ok: inspected.summary.dragon_rpc_ok,
    ...(withSessions ? { dragon_sessions: inspected.sessions } : {}) };
}

// A case-scoped web receipt (--case; Team QA case-scoped GUI dispatch, upgrade U2): the case is on the board, executed,
// and every state receipt of it names a Dragon session the attested executor of that case used itself.
export function caseEvidenceSessionIssues({ data, caseId, evidenceRoot, sessions }) {
  const testCase = (Array.isArray(data.cases) ? data.cases : []).find((entry) => entry?.id === caseId);
  if (!testCase || testCase.status === 'TODO') return [`TEAMQA_CASE_NOT_EXECUTED:${caseId}`];
  if (!Array.isArray(sessions) || sessions.length === 0) return [`TEAMQA_CASE_EXECUTOR_SESSIONS_MISSING:${caseId}`];
  const links = Array.isArray(testCase.stateReceipts) ? testCase.stateReceipts : [];
  if (links.length === 0) return [`TEAMQA_CASE_EVIDENCE_MISSING:${caseId}`];
  let root;
  try { root = realpathSync(resolve(evidenceRoot)); } catch { return [`TEAMQA_CASE_EVIDENCE_UNREADABLE:${caseId}`]; }
  const problems = [];
  for (const link of links) {
    const parts = String(link?.file ?? '').split('/');
    let receipt = null;
    if (!parts.some((part) => part === '' || part === '.' || part === '..')) {
      try { receipt = JSON.parse(readFileSync(resolve(root, ...parts), 'utf8')); } catch { receipt = null; }
    }
    const session = receipt?.dragon?.sessionId;
    if (typeof session !== 'string' || !session) problems.push(`TEAMQA_CASE_EVIDENCE_UNREADABLE:${caseId}:${link?.state ?? '?'}`);
    else if (!sessions.includes(session)) problems.push(`TEAMQA_CASE_EVIDENCE_SESSION_FOREIGN:${caseId}:${link?.state ?? '?'}`);
  }
  return problems;
}
