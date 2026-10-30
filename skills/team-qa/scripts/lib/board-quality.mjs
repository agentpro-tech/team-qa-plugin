import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fail, readJson, rejectUnknownFields, sha256, sha256File, stableJson } from './core.mjs';
import { scanOriginalSource } from './original-source.mjs';
import { verifyProviderInterface, isolatedClaudeEnv } from './roster.mjs';
import { nativeHostSource, verifyNativeHost, nativeCreationEpoch } from './native-host.mjs';
import { isClaudeTranscriptPath, claudeHostSource, verifyClaudeHost } from './host-transcript.mjs';
import { claudeReviewArgv, claudeBashResults, claudeFirstUserText, claudeReviewerErrors, claudeSourcesOrdered } from './board-review-claude.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const requireValue = (ok, code, detail = '') => { if (!ok) fail(3, code, detail, 'ungraded'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (value, keys, code) => rejectUnknownFields(value, keys, code);
const policyPath = join(ROOT, 'references/board-review-policy.json');
const protocolPath = join(ROOT, 'references/board-review-protocol.md');
const dispatchPath = join(ROOT, 'references/board-review-dispatch.md');
// Claude Code host route (board-review-claude.mjs): packet and facts travel inline, the reviewer has no tools.
const protocolClaudePath = join(ROOT, 'references/board-review-protocol.claude.md');
const dispatchClaudePath = join(ROOT, 'references/board-review-dispatch.claude.md');
const claudeModulePath = join(ROOT, 'scripts/lib/board-review-claude.mjs');
const helperPath = fileURLToPath(import.meta.url);
const cliPath = join(ROOT, 'scripts/board-quality.mjs');
const policy = () => readJson(policyPath);
const gateHash = () => sha256([helperPath, cliPath, policyPath, protocolPath, dispatchPath, protocolClaudePath, dispatchClaudePath, claudeModulePath]
  .map(sha256File).join('\n'));
const isClaudeHost = (source) => isClaudeTranscriptPath(source?.path ?? source);
const hostSource = (path) => (isClaudeTranscriptPath(path) ? claudeHostSource(path) : nativeHostSource(path));
const verifyHost = (source) => (isClaudeHost(source) ? verifyClaudeHost(source) : verifyNativeHost(source));

function writeOnce(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  requireValue(!existsSync(path), 'BOARD_QUALITY_OUTPUT_EXISTS', path);
  writeFileSync(path, bytes, { flag: 'wx' });
  requireValue(readFileSync(path, 'utf8') === bytes, 'BOARD_QUALITY_WRITE_READBACK', path);
}
function fileRef(path) {
  requireValue(typeof path === 'string' && existsSync(path), 'BOARD_QUALITY_FILE_REQUIRED', String(path || ''));
  return { path: realpathSync(path), sha256: sha256File(path) };
}
function verifyRef(ref, code) {
  exact(ref, ['path','sha256'], code);
  requireValue(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256 || '')
    && existsSync(ref.path) && realpathSync(ref.path) === ref.path && sha256File(ref.path) === ref.sha256, code);
  return ref.path;
}
function childCall(skill, file, method, args) {
  const provider = verifyProviderInterface({ skill });
  const module = join(provider.root, file);
  requireValue(existsSync(module), 'BOARD_QUALITY_PROVIDER_INTERFACE', module);
  const code = 'const m=await import(process.argv[1]);let raw="";for await(const c of process.stdin)raw+=c;process.stdout.write(JSON.stringify(await m[process.argv[2]](JSON.parse(raw))));';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, module, method], {
    input: JSON.stringify(args), encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  requireValue(r.status === 0 && !r.error, 'BOARD_QUALITY_PROVIDER_FAILED', String(r.stderr || r.error || '').slice(0, 300));
  try { return JSON.parse(r.stdout); } catch { requireValue(false, 'BOARD_QUALITY_PROVIDER_RESULT'); }
}
const gui = (method, args) => childCall('qa-gui', 'scripts/teamwork/board-quality.mjs', method, args);
function pins() {
  const guiProvider = verifyProviderInterface({ skill: 'qa-gui' });
  const codeProvider = verifyProviderInterface({ skill: 'qa-code' });
  return { qa_gui: guiProvider.source, qa_code: codeProvider.source, gate_sha256: gateHash() };
}
export function checkBoardQuality({ file }) {
  const canonical = fileRef(file), data = readJson(canonical.path);
  const result = gui('inspectBoardQuality', data);
  requireValue(result?.verdict === 'PASS', 'BOARD_QUALITY_FAILED', JSON.stringify(result?.errors || result));
  return { canonical, data, result };
}
function literalRead(path, maxOutputTokens) {
  requireValue(typeof path === 'string' && path.startsWith('/') && !/[\0\n\r'`$]/.test(path), 'BOARD_REVIEW_READ_PATH');
  return `text(await tools.exec_command(${JSON.stringify({ cmd: `cat '${path}'`, login: false, max_output_tokens: maxOutputTokens })}));`;
}
function template(path, values) {
  return readFileSync(path, 'utf8').replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, key) => {
    requireValue(Object.hasOwn(values, key), 'BOARD_REVIEW_TEMPLATE_FIELD', key);
    return values[key];
  });
}
function reviewValues({ data, canonical, result, factsPath, packetPath, rubric, limits }) {
  const binding = `TEAMQA_BOARD_REVIEW board=${data.boardId} revision=${data.rev} sha256=${canonical.sha256}`;
  const reviewShape = { schema: 'qa-gui/board-review/v1', ruleVersion: result.ruleVersion,
    canonicalSha256: canonical.sha256, coveredCaseIds: data.cases.map(c => c.id),
    coveredDefectIds: data.defects.map(d => d.id), criteria: result.reviewCriteria.map(id => ({
      id, verdict: 'PASS|FAIL|UNGRADED', rationale: '<specific reason>', anchors: [{ path: '<canonical JSON pointer>', quote: '<verbatim quote>' }],
    })), verdict: 'PASS|FAIL|UNGRADED' };
  return { binding, canonicalSha256: canonical.sha256, ruleVersion: result.ruleVersion,
    factsRead: literalRead(factsPath, limits.max_output_tokens), packetRead: literalRead(packetPath, limits.max_output_tokens),
    providerRubric: readFileSync(rubric.path, 'utf8'), reviewShape: JSON.stringify(reviewShape, null, 2) };
}
// Review packet (context.md) and spawn message for the root's host. Claude: facts inline in the packet, packet inline
// in the message (facts.json still carries the exact facts bytes).
function reviewTexts(host, values, factsBytes) {
  if (!isClaudeHost(host)) return { packet: template(protocolPath, values), message: template(dispatchPath, values) };
  const packet = template(protocolClaudePath, { ...values, factsText: factsBytes });
  return { packet, message: template(dispatchClaudePath, { ...values, packetText: packet }) };
}
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function prepareCode(request, node) {
  const providers = ['qa-gui', 'qa-code'].map(skill => verifyProviderInterface({ skill }));
  const argv = ['/usr/bin/env', `TEAMQA_QA_GUI_ROOT=${providers[0].root}`, `TEAMQA_QA_CODE_ROOT=${providers[1].root}`,
    `TEAMQA_ALLOW_LOCAL_CANDIDATE=${process.env.TEAMQA_ALLOW_LOCAL_CANDIDATE === 'yes' ? 'yes' : 'no'}`,
    node, cliPath, 'prepare'];
  for (const [key, flag] of [['file','--file'],['outDir','--out-dir'],['parentSourcePath','--parent-source'],
    ['authorSourcePath','--author-source'],['taskName','--task-name'],['model','--model'],['effort','--effort']]) argv.push(flag, request[key]);
  return `text(await tools.exec_command(${JSON.stringify({ cmd: argv.map(shellQuote).join(' '), login: false, max_output_tokens: 6000 })}));`;
}
function prepareArgv(request, node) {
  const providers = ['qa-gui', 'qa-code'].map(skill => verifyProviderInterface({ skill }));
  const argv = ['/usr/bin/env', `TEAMQA_QA_GUI_ROOT=${providers[0].root}`, `TEAMQA_QA_CODE_ROOT=${providers[1].root}`,
    `TEAMQA_ALLOW_LOCAL_CANDIDATE=${process.env.TEAMQA_ALLOW_LOCAL_CANDIDATE === 'yes' ? 'yes' : 'no'}`,
    node, cliPath, 'prepare'];
  for (const [key, flag] of [['file','--file'],['outDir','--out-dir'],['parentSourcePath','--parent-source'],
    ['authorSourcePath','--author-source'],['taskName','--task-name'],['model','--model'],['effort','--effort']]) argv.push(flag, request[key]);
  return argv;
}
// Exact Bash command lines a Claude Code root must run (the attestation matches them literally).
export function claudePrepareCommand(request, node) { return prepareArgv(request, node).map(shellQuote).join(' '); }
export function claudeDispatchCommand(intentPath, node) { return [node, cliPath, 'dispatch', '--intent', intentPath].map(shellQuote).join(' '); }
export function boardReviewPrepareCode(request) {
  exact(request, ['file','outDir','parentSourcePath','authorSourcePath','taskName','model','effort'], 'BOARD_REVIEW_PREPARE_FIELDS');
  const resolved = { ...request, file: realpathSync(request.file), outDir: resolve(request.outDir),
    parentSourcePath: realpathSync(request.parentSourcePath), authorSourcePath: realpathSync(request.authorSourcePath) };
  if (isClaudeTranscriptPath(resolved.parentSourcePath)) return claudePrepareCommand(resolved, realpathSync(process.execPath));
  return prepareCode(resolved, realpathSync(process.execPath));
}
export function prepareBoardReview({ file, outDir, parentSourcePath, authorSourcePath, taskName, model, effort }) {
  const checked = checkBoardQuality({ file }), limits = policy();
  const host = hostSource(parentSourcePath), author = hostSource(authorSourcePath);
  requireValue(same(host, author), 'BOARD_REVIEW_AUTHOR_MUST_BE_PARENT');
  requireValue(/^[a-z][a-z0-9_]{0,63}$/.test(taskName || '') && typeof model === 'string' && model.trim()
    && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort), 'BOARD_REVIEW_RUNTIME_REQUIRED');
  const dir = resolve(outDir);
  requireValue(!existsSync(dir), 'BOARD_REVIEW_DIRECTORY_EXISTS', dir);
  const provider = verifyProviderInterface({ skill: 'qa-gui' });
  const rubric = fileRef(join(provider.root, 'references/board-quality.md'));
  const facts = { canonicalSha256: checked.canonical.sha256, ruleVersion: checked.result.ruleVersion,
    board: gui('boardReviewFacts', checked.data) };
  const factsBytes = stableJson(facts);
  requireValue(Buffer.byteLength(factsBytes) <= limits.facts_max_bytes, 'BOARD_REVIEW_FACTS_TOO_LARGE', String(Buffer.byteLength(factsBytes)));
  const factsPath = join(dir, 'facts.json'), packetPath = join(dir, 'context.md');
  const values = reviewValues({ ...checked, factsPath, packetPath, rubric, limits });
  const texts = reviewTexts(host, values, factsBytes);
  writeOnce(factsPath, factsBytes);
  writeOnce(packetPath, texts.packet);
  const intent = { schema: 'team-qa/board-review-intent/v1', created_at: new Date().toISOString(), canonical: checked.canonical,
    boardId: checked.data.boardId, revision: checked.data.rev, ruleVersion: checked.result.ruleVersion, host, author,
    pins: pins(), rubric, facts: fileRef(factsPath), packet: fileRef(packetPath), caps: limits, prepare: { node: fileRef(process.execPath) },
    spawn: { task_name: taskName, model, reasoning_effort: effort, fork_turns: 'none', message: texts.message } };
  const intentPath = join(dir, 'intent.json');
  writeOnce(intentPath, stableJson(intent));
  if (isClaudeHost(host)) return { intentPath, intentSha256: sha256File(intentPath), dispatch_command: claudeDispatchCommand(intentPath, intent.prepare.node.path) };
  return { intentPath, intentSha256: sha256File(intentPath), spawn: intent.spawn };
}
function loadIntent(intentPath, file) {
  const i = readJson(intentPath);
  exact(i, ['schema','created_at','canonical','boardId','revision','ruleVersion','host','author','pins','rubric','facts','packet','caps','spawn','prepare'], 'BOARD_REVIEW_INTENT_FIELDS');
  requireValue(i.schema === 'team-qa/board-review-intent/v1' && same(i.pins, pins()) && same(i.caps, policy()), 'BOARD_REVIEW_RULES_DRIFT');
  const canonical = verifyRef(i.canonical, 'BOARD_REVIEW_CANONICAL_DRIFT');
  if (file) requireValue(realpathSync(file) === canonical, 'BOARD_REVIEW_CANONICAL_PATH');
  for (const ref of [i.rubric, i.facts, i.packet]) verifyRef(ref, 'BOARD_REVIEW_CONTEXT_DRIFT');
  verifyHost(i.host); verifyHost(i.author);
  requireValue(same(i.host, i.author), 'BOARD_REVIEW_AUTHOR_MUST_BE_PARENT');
  exact(i.prepare, ['node'], 'BOARD_REVIEW_PREPARE_FIELDS'); verifyRef(i.prepare.node, 'BOARD_REVIEW_NODE_DRIFT');
  exact(i.spawn, ['task_name','model','reasoning_effort','fork_turns','message'], 'BOARD_REVIEW_SPAWN_FIELDS');
  requireValue(i.spawn.fork_turns === 'none' && /^[a-z][a-z0-9_]{0,63}$/.test(i.spawn.task_name)
    && typeof i.spawn.model === 'string' && i.spawn.model.trim()
    && ['low','medium','high','xhigh','max','ultra'].includes(i.spawn.reasoning_effort), 'BOARD_REVIEW_SPAWN_FIELDS');
  const checked = checkBoardQuality({ file: canonical });
  requireValue(checked.data.boardId === i.boardId && checked.data.rev === i.revision && checked.result.ruleVersion === i.ruleVersion, 'BOARD_REVIEW_BOARD_BINDING');
  const facts = { canonicalSha256: i.canonical.sha256, ruleVersion: i.ruleVersion, board: gui('boardReviewFacts', checked.data) };
  requireValue(readFileSync(i.facts.path, 'utf8') === stableJson(facts), 'BOARD_REVIEW_FACTS_DRIFT');
  requireValue(Buffer.byteLength(stableJson(facts)) <= i.caps.facts_max_bytes, 'BOARD_REVIEW_FACTS_TOO_LARGE');
  const provider = verifyProviderInterface({ skill: 'qa-gui' });
  requireValue(same(i.rubric, fileRef(join(provider.root, 'references/board-quality.md'))), 'BOARD_REVIEW_RUBRIC_DRIFT');
  const dir = dirname(realpathSync(intentPath));
  requireValue(i.facts.path === join(dir, 'facts.json') && i.packet.path === join(dir, 'context.md'), 'BOARD_REVIEW_CONTEXT_PATH');
  const values = reviewValues({ ...checked, factsPath: i.facts.path, packetPath: i.packet.path, rubric: i.rubric, limits: i.caps });
  const texts = reviewTexts(i.host, values, readFileSync(i.facts.path, 'utf8'));
  requireValue(readFileSync(i.packet.path, 'utf8') === texts.packet && i.spawn.message === texts.message, 'BOARD_REVIEW_PROTOCOL_DRIFT');
  return { intent: i, data: checked.data };
}
function lineSource(path, line, raw) { return { path, line: line + 1, sha256: sha256(raw) }; }
export function locateBoardReviewSources({ intentPath }) {
  if (isClaudeHost(readJson(intentPath).host)) return claudeSources({ intentPath: realpathSync(intentPath) });
  const i = readJson(intentPath), path = i.host.path;
  const hash = sha256File(intentPath), prepare = [], spawn = [];
  scanOriginalSource(path,(raw, index) => {
    if (!raw) return;
    const e = JSON.parse(raw), p = e.payload;
    if (e.type !== 'response_item' || !p) return;
    if (p.type === 'custom_tool_call_output' && JSON.stringify(p.output).includes(`TEAMQA_NATIVE_PREPARED sha256=${hash}`)) {if(prepare.length<2)prepare.push(lineSource(path, index, raw));}
    if (p.type === 'function_call' && p.namespace === 'collaboration' && p.name === 'spawn_agent') {
      let args; try { args = JSON.parse(p.arguments); } catch { return; }
      if (args.task_name === i.spawn.task_name && spawn.length<2) spawn.push(lineSource(path, index, raw));
    }
  });
  requireValue(prepare.length === 1 && spawn.length === 1, 'BOARD_REVIEW_SOURCE_AMBIGUOUS', `prepare=${prepare.length} spawn=${spawn.length}`);
  return { prepare_source: prepare[0], parent_source: spawn[0] };
}
function replayReview({ intentPath, childSourcePath, parentSource, prepareSource, file }) {
  if (isClaudeHost(readJson(intentPath).host)) return replayClaudeReview({ intentPath, childSourcePath, parentSource, prepareSource, file });
  const { intent: i, data } = loadIntent(intentPath, file);
  let prepareRaw='';
  scanOriginalSource(i.host.path,(raw,index)=>{if(index===prepareSource.line-1)prepareRaw=raw;});
  requireValue(prepareSource.path === i.host.path && Number.isInteger(prepareSource.line)
    && sha256(prepareRaw) === prepareSource.sha256, 'BOARD_REVIEW_PREPARE_SOURCE');
  const output = JSON.parse(prepareRaw),calls=[];
  scanOriginalSource(i.host.path,raw=>{
    if(!raw)return;
    const e=JSON.parse(raw);
    if(e.type==='response_item'&&e.payload?.type==='custom_tool_call'&&e.payload.call_id===output.payload?.call_id&&calls.length<2)calls.push(e);
  });
  const request = { file: i.canonical.path, outDir: dirname(intentPath), parentSourcePath: i.host.path,
    authorSourcePath: i.author.path, taskName: i.spawn.task_name, model: i.spawn.model, effort: i.spawn.reasoning_effort };
  requireValue(calls.length === 1 && calls[0].payload.name === 'exec'
    && String(calls[0].payload.input || '').trim() === prepareCode(request, i.prepare.node.path), 'BOARD_REVIEW_PREPARE_RECIPE');
  const epoch = nativeCreationEpoch({ childSourcePath, parentSource, host: i.host });
  const parsed = childCall('qa-code', 'scripts/lib/provider-execution.mjs', 'parseCodexNativeExecution', {
    childSourcePath, parentSource, expected: { intent_sha256: sha256File(intentPath), prepare_source: prepareSource,
      parent_session_id: i.host.session_id, task_name: i.spawn.task_name, agent_path: i.host.agent_path + '/' + i.spawn.task_name,
      context_marker: `TEAMQA_BOARD_REVIEW board=${i.boardId} revision=${i.revision} sha256=${i.canonical.sha256}`,
      model: i.spawn.model, reasoning_effort: i.spawn.reasoning_effort, message: i.spawn.message,
      context_packet_path: i.packet.path, context_packet_sha256: i.packet.sha256, facts_path: i.facts.path, facts_sha256: i.facts.sha256,
      harness_version: i.host.version, ...epoch, created_at: i.created_at, caps: { timeout_ms: i.caps.timeout_ms, max_turns: 1 }, trajectory_mode: 'readonly' },
  });
  requireValue(parsed.provenance_verified === true && parsed.errors?.length === 0, 'BOARD_REVIEW_NATIVE_PROOF', (parsed.errors || []).join(','));
  requireValue(parsed.session_id !== i.author.session_id && parsed.session_id !== i.host.session_id, 'BOARD_REVIEW_NOT_INDEPENDENT');
  requireValue(parsed.verdictText.trim().split(/\s+/u).length <= i.caps.max_response_words, 'BOARD_REVIEW_RESPONSE_CAP');
  let review; try { review = JSON.parse(parsed.verdictText); } catch { requireValue(false, 'BOARD_REVIEW_JSON_REQUIRED'); }
  const validation = gui('validateBoardReview', { data, review, canonicalSha256: i.canonical.sha256 });
  return { intent: i, review, validation, parsed };
}
// ---------- Claude Code host route ----------
const CLAUDE_DISPATCH_FIELDS = ['schema','intent','session_id','harness','argv','stdout','stderr','exit_code','started_at','ended_at'];
const claudeDispatchPath = (intentPath) => join(dirname(intentPath), 'claude-dispatch.json');
const claudeParse = (dispatch) => childCall('qa-code', 'scripts/lib/provider-execution.mjs', 'parseProviderExecution', {
  provider: 'anthropic', stdout: readFileSync(dispatch.stdout.path, 'utf8'), stderr: readFileSync(dispatch.stderr.path, 'utf8') });
function claudeHarness() {
  const found = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8', timeout: 5000 });
  requireValue(found.status === 0 && found.stdout.trim(), 'BOARD_REVIEW_CLAUDE_BINARY');
  const path = realpathSync(found.stdout.trim());
  const version = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 10000 });
  requireValue(version.status === 0 && /\d+\.\d+\.\d+/.test(version.stdout), 'BOARD_REVIEW_CLAUDE_VERSION');
  return { path, sha256: sha256File(path), version: /\d+\.\d+\.\d+/.exec(version.stdout)[0] };
}
// `board-quality dispatch`: one isolated, tool-less `claude -p` reviewer for a Claude-host intent.
export function dispatchBoardReviewClaude({ intentPath }) {
  intentPath = realpathSync(intentPath);
  const { intent: i } = loadIntent(intentPath);
  requireValue(isClaudeHost(i.host), 'BOARD_REVIEW_DISPATCH_HOST');
  const receiptPath = claudeDispatchPath(intentPath);
  requireValue(!existsSync(receiptPath), 'BOARD_REVIEW_ALREADY_DISPATCHED', receiptPath);
  const harness = claudeHarness(), sessionId = randomUUID(), dir = join(dirname(intentPath), 'claude-dispatch', sessionId);
  mkdirSync(dir, { recursive: true });
  const argv = claudeReviewArgv({ model: i.spawn.model, effort: i.spawn.reasoning_effort, sessionId });
  const started = new Date().toISOString();
  const r = spawnSync(harness.path, argv, { cwd: dirname(intentPath), input: i.spawn.message, encoding: 'utf8',
    timeout: i.caps.timeout_ms, maxBuffer: 16 * 1024 * 1024, env: isolatedClaudeEnv() });
  const stdoutPath = join(dir, 'stdout.jsonl'), stderrPath = join(dir, 'stderr.txt');
  writeOnce(stdoutPath, r.stdout || ''); writeOnce(stderrPath, r.stderr || '');
  const receipt = { schema: 'team-qa/board-review-claude-dispatch/v1', intent: fileRef(intentPath), session_id: sessionId, harness, argv,
    stdout: fileRef(stdoutPath), stderr: fileRef(stderrPath), exit_code: r.status, started_at: started, ended_at: new Date().toISOString() };
  writeOnce(receiptPath, stableJson(receipt));
  requireValue(r.status === 0 && !r.error, 'BOARD_REVIEW_DISPATCH_FAILED', String(r.error || r.status));
  const parsed = claudeParse(receipt);
  const childSourcePath = parsed.metadata_source?.path || null;
  return { intentSha256: receipt.intent.sha256, sessionId, childSourcePath, receiptPath, errors: parsed.errors || [] };
}
function claudeDispatchReceipt(intentPath) {
  const path = claudeDispatchPath(intentPath);
  requireValue(existsSync(path), 'BOARD_REVIEW_DISPATCH_MISSING', path);
  const d = readJson(path);
  exact(d, CLAUDE_DISPATCH_FIELDS, 'BOARD_REVIEW_DISPATCH_FIELDS');
  requireValue(d.schema === 'team-qa/board-review-claude-dispatch/v1' && verifyRef(d.intent, 'BOARD_REVIEW_DISPATCH_INTENT') === intentPath
    && d.exit_code === 0, 'BOARD_REVIEW_DISPATCH_RECEIPT');
  verifyRef(d.stdout, 'BOARD_REVIEW_DISPATCH_STREAM'); verifyRef(d.stderr, 'BOARD_REVIEW_DISPATCH_STREAM');
  return d;
}
function claudeSources({ intentPath }) {
  const i = readJson(intentPath), d = claudeDispatchReceipt(intentPath), intentSha = sha256File(intentPath);
  const request = { file: i.canonical.path, outDir: dirname(intentPath), parentSourcePath: i.host.path,
    authorSourcePath: i.author.path, taskName: i.spawn.task_name, model: i.spawn.model, effort: i.spawn.reasoning_effort };
  const prepareCommand = claudePrepareCommand(request, i.prepare.node.path), dispatchCommand = claudeDispatchCommand(intentPath, i.prepare.node.path);
  const prepare = claudeBashResults(i.host.path, `TEAMQA_NATIVE_PREPARED sha256=${intentSha}`).filter(h => h.command.trim() === prepareCommand && h.exitCode === 0);
  const dispatch = claudeBashResults(i.host.path, `TEAMQA_BOARD_REVIEW_DISPATCHED intent=${intentSha} session=${d.session_id}`)
    .filter(h => h.command.trim() === dispatchCommand && h.exitCode === 0);
  requireValue(prepare.length === 1, 'BOARD_REVIEW_PREPARE_RECIPE', `prepare=${prepare.length}`);
  requireValue(dispatch.length === 1, 'BOARD_REVIEW_DISPATCH_SOURCE', `dispatch=${dispatch.length}`);
  requireValue(claudeSourcesOrdered(prepare[0], dispatch[0]), 'BOARD_REVIEW_SOURCE_ORDER');
  return { prepare_source: prepare[0].result, parent_source: dispatch[0].result };
}
function replayClaudeReview({ intentPath, childSourcePath, parentSource, prepareSource, file }) {
  intentPath = realpathSync(intentPath);
  const { intent: i, data } = loadIntent(intentPath, file);
  const sources = claudeSources({ intentPath });
  requireValue(same(sources.prepare_source, prepareSource), 'BOARD_REVIEW_PREPARE_SOURCE');
  requireValue(same(sources.parent_source, parentSource), 'BOARD_REVIEW_PARENT_SOURCE');
  const d = claudeDispatchReceipt(intentPath), raw = claudeParse(d);
  requireValue(typeof childSourcePath === 'string' && existsSync(childSourcePath) && isClaudeTranscriptPath(childSourcePath), 'BOARD_REVIEW_CHILD_SOURCE');
  const metaPath = raw.metadata_source?.path && existsSync(raw.metadata_source.path) ? realpathSync(raw.metadata_source.path) : null;
  const parsed = { ...raw, metadata_source: raw.metadata_source ? { ...raw.metadata_source, path: metaPath } : null };
  const child = claudeFirstUserText(childSourcePath);
  const errors = claudeReviewerErrors({ intent: i, dispatch: d, parsed, child, childSourcePath: realpathSync(childSourcePath) });
  requireValue(errors.length === 0, 'BOARD_REVIEW_CLAUDE_PROOF', errors.join(','));
  requireValue(parsed.verdictText.trim().split(/\s+/u).length <= i.caps.max_response_words, 'BOARD_REVIEW_RESPONSE_CAP');
  let review; try { review = JSON.parse(parsed.verdictText); } catch { requireValue(false, 'BOARD_REVIEW_JSON_REQUIRED'); }
  const validation = gui('validateBoardReview', { data, review, canonicalSha256: i.canonical.sha256 });
  return { intent: i, review, validation, parsed: { session_id: parsed.session_id, stream_sha256: parsed.stream_sha256, verdictText: parsed.verdictText } };
}

export function attestBoardReview({ intentPath, childSourcePath, out }) {
  intentPath = realpathSync(intentPath); childSourcePath = realpathSync(childSourcePath);
  const sources = locateBoardReviewSources({ intentPath });
  const result = replayReview({ intentPath, childSourcePath, parentSource: sources.parent_source, prepareSource: sources.prepare_source });
  const receipt = { schema: 'team-qa/board-quality-review/v1', canonical: result.intent.canonical, ruleVersion: result.intent.ruleVersion,
    intent: fileRef(intentPath), childSourcePath, ...sources, reviewerSessionId: result.parsed.session_id,
    childStreamSha256: result.parsed.stream_sha256, review: result.review, validation: result.validation, verdict: result.validation.verdict };
  writeOnce(resolve(out), stableJson(receipt));
  return receipt;
}
// An authenticated review receipt of `file`, whatever its verdict (upgrade U5: a blocked delivery keeps FAIL/UNGRADED
// reviews as evidence). verifyBoardReview additionally requires PASS, as delivery always did.
export function verifyBoardReview({ file, receiptPath }) {
  const r = verifyBoardReviewEvidence({ file, receiptPath });
  requireValue(r.validation.verdict === 'PASS', 'BOARD_QUALITY_REVIEW_NOT_PASS', JSON.stringify(r.validation.errors));
  return r;
}
export function verifyBoardReviewEvidence({ file, receiptPath }) {
  requireValue(typeof receiptPath === 'string' && existsSync(receiptPath), 'BOARD_QUALITY_REVIEW_REQUIRED');
  const r = readJson(receiptPath);
  exact(r, ['schema','canonical','ruleVersion','intent','childSourcePath','prepare_source','parent_source','reviewerSessionId','childStreamSha256','review','validation','verdict'], 'BOARD_REVIEW_RECEIPT_FIELDS');
  requireValue(r.schema === 'team-qa/board-quality-review/v1', 'BOARD_REVIEW_RECEIPT_SCHEMA');
  const intentPath = verifyRef(r.intent, 'BOARD_REVIEW_INTENT_DRIFT');
  const result = replayReview({ intentPath, childSourcePath: r.childSourcePath, parentSource: r.parent_source, prepareSource: r.prepare_source, file });
  requireValue(same(r.canonical, result.intent.canonical) && r.ruleVersion === result.intent.ruleVersion
    && r.reviewerSessionId === result.parsed.session_id && r.childStreamSha256 === result.parsed.stream_sha256
    && same(r.review, result.review) && same(r.validation, result.validation) && r.verdict === result.validation.verdict, 'BOARD_REVIEW_RECEIPT_DRIFT');
  return r;
}
function verifyProjection({ file, artifactPath, renderer, projectionOptions }) {
  const result = gui('verifyBoardProjection', { file, artifactPath, renderer: renderer === 'space' ? 'page' : renderer, projectionOptions });
  requireValue(result?.verdict === 'PASS', 'BOARD_DELIVERY_PROJECTION_MISMATCH', JSON.stringify(result?.errors || result));
}
function projectionSource(renderer, options) {
  if (renderer !== 'doc-colab') return null;
  const root = realpathSync(options.docColabRoot || process.env.DOC_COLAB_SKILL_ROOT || join(homedir(), '.agents/skills/doc-colab'));
  const sourcePath = join(root, 'SOURCE.json'), source = readJson(sourcePath);
  const anchor = readJson(join(homedir(), '.agents/skills/doc-colab/SOURCE.json'));
  requireValue(source.schema === 'agentpro/local-skill-source/v1' && source.skill === 'doc-colab'
    && source.repo === anchor.repo && source.subtree === 'skill/doc-colab'
    && /^[a-f0-9]{40}$/.test(source.commit || ''), 'BOARD_DOC_COLAB_SOURCE');
  for (const name of ['scripts/make_doc.py', 'assets/task-board.html']) {
    const committed = spawnSync('git', ['-C', source.repo, 'show', `${source.commit}:${source.subtree}/${name}`], { encoding: 'utf8', timeout: 10000 });
    requireValue(committed.status === 0 && source.files?.[name] === sha256(committed.stdout)
      && sha256File(join(root, name)) === source.files[name], 'BOARD_DOC_COLAB_SOURCE_DRIFT', name);
  }
  return { root, source: fileRef(sourcePath) };
}
export function sealBoardDelivery({ file, reviewPath, artifactPath, renderer, projectionOptions = {} }) {
  requireValue(['space','notion','native','doc-colab'].includes(renderer), 'BOARD_QUALITY_RENDERER');
  const review = verifyBoardReview({ file, receiptPath: reviewPath });
  const provider = projectionSource(renderer, projectionOptions);
  if (provider) projectionOptions = { ...projectionOptions, docColabRoot: provider.root };
  verifyProjection({ file, artifactPath, renderer, projectionOptions });
  const receipt = { schema: 'team-qa/board-quality-delivery/v1', canonical: fileRef(file), artifact: fileRef(artifactPath),
    renderer, projectionOptions, projectionSource: provider, ruleVersion: review.ruleVersion, review: fileRef(reviewPath), verdict: 'PASS' };
  writeOnce(resolve(artifactPath) + '.quality.json', stableJson(receipt));
  return receipt;
}
export function verifyBoardDelivery({ file, artifactPath, renderer }) {
  requireValue(typeof artifactPath === 'string' && existsSync(artifactPath + '.quality.json'), 'BOARD_QUALITY_DELIVERY_REQUIRED');
  const r = readJson(artifactPath + '.quality.json');
  exact(r, ['schema','canonical','artifact','renderer','projectionOptions','projectionSource','ruleVersion','review','verdict'], 'BOARD_DELIVERY_RECEIPT_FIELDS');
  requireValue(r.schema === 'team-qa/board-quality-delivery/v1' && r.verdict === 'PASS'
    && ['space','notion','native','doc-colab'].includes(r.renderer) && (!renderer || renderer === r.renderer), 'BOARD_DELIVERY_RECEIPT_SCHEMA');
  requireValue(realpathSync(file) === verifyRef(r.canonical, 'BOARD_DELIVERY_CANONICAL_DRIFT')
    && realpathSync(artifactPath) === verifyRef(r.artifact, 'BOARD_DELIVERY_ARTIFACT_DRIFT'), 'BOARD_DELIVERY_PATH_BINDING');
  const review = verifyBoardReview({ file, receiptPath: verifyRef(r.review, 'BOARD_DELIVERY_REVIEW_DRIFT') });
  requireValue(review.ruleVersion === r.ruleVersion, 'BOARD_DELIVERY_RULES_DRIFT');
  requireValue(same(r.projectionSource, projectionSource(r.renderer, r.projectionOptions)), 'BOARD_DELIVERY_PROVIDER_DRIFT');
  verifyProjection({ file, artifactPath, renderer: r.renderer, projectionOptions: r.projectionOptions });
  return r;
}
