// Deployed-build identity for a Claude Code root (eval compat 3, part B1).
//   teamqa web identity draft --run <id> [--round <n>] --project-id <p> --environment <Local|Test|Staging|Production>
//                             --preview-url <url> --backend-origin <origin> [--transcript <root.jsonl>]
//   teamqa web identity prove --run <id> [--round <n>] [--transcript <root.jsonl>]
// draft turns the root's latest scout page read (getPageIdentity or getPageHtml) into the 8-field identity and the
// exact chat marker; prove binds the root's marked page read → getNetwork → getTabInfo calls into identity/proof.json
// and identity/target.json and
// replays them through the same verifiers every later preflight runs (readDeployedIdentityObservation,
// assertDeployedIdentityProof). Nothing here relaxes those verifiers.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TeamQAError, fail, parseFlags, readJson, safeRunId, sha256, stableJson, writeConfirmed } from './core.mjs';
import { assertDeployedIdentityProof, canonicalDeployedJson, canonicalDeployedTarget, deployedTargetBindingSha256,
  deployedTargetIdentity, deployedTargetShapeErrors, isDeployedTarget } from './deployed-target.mjs';
import { deployedIdentityBootstrapMarker, passivePageObservation, readDeployedIdentityObservation } from './tool-preflight.mjs';
import { claudeRef, locateMarkedTranscript, locateRootTranscript, PAGE_READS, pageHtml, passiveTriple, requireUsable, sameSession, scanClaudeTranscript,
  sessionOf } from './claude-refs.mjs';

export const DRAFT_FILE = 'identity/target.draft.json';
export const PROOF_FILE = 'identity/proof.json';
export const TARGET_FILE = 'identity/target.json';
const DRAFT_FIELDS = ['project_id', 'preview_url', 'version', 'kind', 'environment', 'backend_origin', 'frontend_build', 'asset_manifest_sha256', 'target_binding_sha256'];
const ENVIRONMENTS = ['Local', 'Test', 'Staging', 'Production'];
const bad = (code, detail = '') => fail(2, code, detail);
const blocked = (code, detail = '') => fail(3, code, detail, 'ungraded');

// TEAMQA_TARGET_* declares a 3-field Git target lock (lib/target-lock.mjs); a deployed run must not have it.
export function refuseTargetEnv(env = process.env) {
  const set = Object.keys(env).filter(key => key.startsWith('TEAMQA_TARGET_')).sort();
  if (set.length) bad('WEB_TARGET_ENV_SET', `unset ${set.join(', ')}: they force a Git target lock`);
}
export function parseRound(value) {
  if (value === undefined) return 1;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) bad('ROUND_INVALID', value);
  return Number(value);
}
export function runDirectory(runId, cwd = process.cwd()) { return join(cwd, 'runs', safeRunId(runId)); }
const display = (path, cwd = process.cwd()) => relative(cwd, path) || '.';

// Writes `content` unless the file already holds other bytes; identical bytes are an idempotent success.
export async function writeOnce(path, content, tool, code) {
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== content) blocked(code, `${display(path)} already exists with different bytes`);
    return { path, sha256: sha256(content), written: false };
  }
  await writeConfirmed(path, content, tool);
  return { path, sha256: sha256(content), written: true };
}

// One JSON result line on stdout; a failure keeps its stable code and exit status.
export async function jsonCommand(command, run) {
  try {
    console.log(JSON.stringify({ ok: true, command, ...(await run()) }));
  } catch (error) {
    const known = error instanceof TeamQAError;
    console.log(JSON.stringify({ ok: false, command, code: known ? error.code : 'INTERNAL_ERROR',
      ...(known ? (error.detail ? { detail: error.detail } : {}) : { detail: String(error?.code || error?.message || error).split('\n')[0] }) }));
    process.exitCode = known ? error.exitCode || 1 : 1;
  }
}

function previewUrl(value) {
  let url;
  try { url = new URL(value); } catch { bad('WEB_IDENTITY_PREVIEW_URL', value); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) bad('WEB_IDENTITY_PREVIEW_URL', value);
  return url.href;
}
function backendOrigin(value) {
  let url;
  try { url = new URL(value); } catch { bad('WEB_IDENTITY_BACKEND_ORIGIN', value); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || ![url.origin, url.origin + '/'].includes(value)) bad('WEB_IDENTITY_BACKEND_ORIGIN', `${value} is not a bare origin such as ${url.origin}`);
  return url.origin;
}

// The tab URL of a page read: the first usable getTabInfo on its session and tab after it, else the last before it.
function tabUrlOf(page, records) {
  const tabs = records.filter(r => r.kind === 'dragon' && r.method === 'getTabInfo' && !r.problem && sameSession(r.params, sessionOf(page.params)) && r.params?.tabId === page.params?.tabId);
  const after = tabs.find(r => r.call.index > page.call.index), before = tabs.filter(r => r.call.index < page.call.index).at(-1);
  const tab = after || before;
  return tab && tab.value.result?.tabId === page.params.tabId ? tab.value.result.url : undefined;
}

export async function draftIdentity(args) {
  const o = parseFlags(args, { '--run': { key: 'run', required: true }, '--round': { key: 'round' }, '--project-id': { key: 'projectId', required: true },
    '--environment': { key: 'environment', required: true }, '--preview-url': { key: 'previewUrl', required: true },
    '--backend-origin': { key: 'backendOrigin', required: true }, '--transcript': { key: 'transcript' } });
  refuseTargetEnv();
  const runId = safeRunId(o.run), round = parseRound(o.round), runDir = runDirectory(runId);
  if (o.projectId.trim() !== o.projectId) bad('WEB_IDENTITY_PROJECT_ID', o.projectId);
  if (!ENVIRONMENTS.includes(o.environment)) bad('WEB_IDENTITY_ENVIRONMENT', `${o.environment} (expected ${ENVIRONMENTS.join('|')})`);
  const preview = previewUrl(o.previewUrl), backend = backendOrigin(o.backendOrigin);
  // Scout read: no marker, no provenance. The latest root page read (getPageIdentity or getPageHtml) whose tab shows
  // exactly the preview URL.
  const scouts = new Map();
  const scout = path => {
    if (!scouts.has(path)) {
      const records = scanClaudeTranscript(path).records;
      const pages = records.filter(r => r.kind === 'dragon' && PAGE_READS.includes(r.method) && tabUrlOf(r, records) === preview);
      scouts.set(path, { records, page: pages.at(-1) });
    }
    return scouts.get(path);
  };
  const located = locateRootTranscript({ runDir, transcript: o.transcript, expected: `a page read (getPageIdentity or getPageHtml) of a tab at ${preview}`,
    accept: path => { const text = readFileSync(path, 'utf8'); return PAGE_READS.some(method => text.includes(method)) && Boolean(scout(path).page); } });
  const { page } = scout(located.path);
  if (!page) blocked('WEB_IDENTITY_SCOUT_MISSING', `no root getPageIdentity or getPageHtml on a tab at ${preview}`);
  requireUsable(page, `scout ${page.method}`);
  const observed = passivePageObservation({ method: page.method, params: page.params ?? {}, result: page.method === 'getPageHtml' ? pageHtml(page) : page.value?.result }, preview);
  const draft = { project_id: o.projectId, preview_url: observed.preview_url, version: observed.frontend_build.id, kind: 'deployed-build',
    environment: o.environment, backend_origin: backend, frontend_build: { kind: observed.frontend_build.kind, id: observed.frontend_build.id },
    asset_manifest_sha256: observed.asset_manifest_sha256 };
  draft.target_binding_sha256 = deployedTargetBindingSha256(draft);
  const marker = deployedIdentityBootstrapMarker({ run_id: runId, round, target: draft });
  const file = join(runDir, DRAFT_FILE);
  await writeOnce(file, stableJson(draft), 'teamqa.web.identity.draft', 'WEB_IDENTITY_DRAFT_EXISTS');
  return { run_id: runId, round, target_binding_sha256: draft.target_binding_sha256, draft: display(file), frontend_build: draft.frontend_build,
    transcript: located.path, scout: { call_line: page.call.index + 1, result_line: page.result.index + 1 }, marker,
    next: [`Paste this exact line as visible assistant chat text (not through Bash): ${marker}`,
      `Then, on one Dragon session triple (sessionId, nonce, browserInstanceId) and one tabId, logged in so the page calls ${backend}, reload the tab at ${draft.preview_url} and call mcp__Dragon_Browser__dragon_rpc one call at a time (never in parallel), all within 300 s: getPageIdentity {sessionId,nonce,browserInstanceId,tabId} → getNetwork {sessionId,nonce,browserInstanceId,tabId,summary:true} → getTabInfo {sessionId,nonce,browserInstanceId,tabId} (getPageHtml {…,maxLength} and a getNetwork without summary, maxBytes<=200000, are still accepted). These must be the last page-read/getNetwork/getTabInfo calls after the marker. The tab URL must stay exactly ${draft.preview_url} and the network window must hold a 2xx/3xx request to ${backend} made within the 300 s before the page read.`,
      `Then run: teamqa web identity prove --run ${runId} --round ${round}`] };
}

function readDraft(runDir) {
  const file = join(runDir, DRAFT_FILE);
  if (!existsSync(file)) blocked('WEB_IDENTITY_DRAFT_MISSING', display(file));
  const draft = readJson(file, { invalidExit: 3, invalidCode: 'WEB_IDENTITY_DRAFT_INVALID' });
  const errors = deployedTargetShapeErrors({ ...draft, identity_proof: { path: PROOF_FILE, sha256: '0'.repeat(64) } });
  if (stableJson(Object.keys(draft)) !== stableJson(DRAFT_FIELDS) || errors.length || stableJson(draft) !== readFileSync(file, 'utf8')) {
    blocked('WEB_IDENTITY_DRAFT_INVALID', errors.join(',') || 'draft bytes are not the canonical draft');
  }
  return draft;
}

export async function proveIdentity(args) {
  const o = parseFlags(args, { '--run': { key: 'run', required: true }, '--round': { key: 'round' }, '--transcript': { key: 'transcript' } });
  refuseTargetEnv();
  const runId = safeRunId(o.run), round = parseRound(o.round), runDir = runDirectory(runId);
  const draft = readDraft(runDir);
  const marker = deployedIdentityBootstrapMarker({ run_id: runId, round, target: draft });
  const { scan } = locateMarkedTranscript({ runDir, transcript: o.transcript, marker });
  const { page, network, tab } = passiveTriple(scan.records);
  const ref = record => claudeRef(scan.path, record);
  const source = { ...ref(page), tab_source: ref(tab), network_source: ref(network) };
  const proof = { schema: 'team-qa/deployed-identity-proof/v1', target_binding_sha256: draft.target_binding_sha256,
    identity: deployedTargetIdentity(draft), sources: [source] };
  const proofBytes = stableJson(proof), proofSha256 = sha256(proofBytes);
  const target = canonicalDeployedTarget({ ...draft, identity_proof: { path: PROOF_FILE, sha256: proofSha256 } });
  const targetBytes = stableJson(target);
  for (const [name, bytes, code] of [[PROOF_FILE, proofBytes, 'WEB_IDENTITY_PROOF_EXISTS'], [TARGET_FILE, targetBytes, 'WEB_IDENTITY_TARGET_EXISTS']]) {
    if (existsSync(join(runDir, name)) && readFileSync(join(runDir, name), 'utf8') !== bytes) blocked(code, `${display(join(runDir, name))} already exists with different bytes`);
  }
  // Replay through the lane's own verifiers before anything final is written: a content-addressed staging copy keeps a
  // failed attempt from occupying identity/proof.json.
  const staging = join(runDir, 'identity', 'staging', `proof-${proofSha256}.json`);
  mkdirSync(join(runDir, 'identity', 'staging'), { recursive: true });
  await writeConfirmed(staging, proofBytes, 'teamqa.web.identity.stage');
  verifyIdentityTarget({ runDir, runId, round, target: { ...target, identity_proof: { path: relative(runDir, staging), sha256: proofSha256 } } });
  await writeOnce(join(runDir, PROOF_FILE), proofBytes, 'teamqa.web.identity.proof', 'WEB_IDENTITY_PROOF_EXISTS');
  await writeOnce(join(runDir, TARGET_FILE), targetBytes, 'teamqa.web.identity.target', 'WEB_IDENTITY_TARGET_EXISTS');
  verifyIdentityTarget({ runDir, runId, round, target: readJson(join(runDir, TARGET_FILE)) });
  rmSync(staging, { force: true });
  return { run_id: runId, round, target_binding_sha256: target.target_binding_sha256, proof: { path: PROOF_FILE, sha256: proofSha256 },
    target: display(join(runDir, TARGET_FILE)), transcript: scan.path, marker_line: scan.marker_line,
    refs: Object.fromEntries([[page.method, page], ['getNetwork', network], ['getTabInfo', tab]].map(([k, r]) => [k, { call_line: r.call.index + 1, result_line: r.result.index + 1 }])),
    next: [`Embed ${display(join(runDir, TARGET_FILE))} verbatim as the roster request target: node <team-qa>/scripts/roster.mjs select --catalog <catalog.json> --request <request.json> --target ${display(join(runDir, TARGET_FILE))} --out <roster.candidate.json>`] };
}

// The same checks the basic preflight applies to roster.target, against a draft roster for this run and round.
export function verifyIdentityTarget({ runDir, runId, round, target }) {
  const roster = { run_id: runId, round, target, catalog_source: { kind: 'runtime' } };
  try {
    return assertDeployedIdentityProof(target, { runDir, verifyOriginalSource: ref => readDeployedIdentityObservation(ref, { roster, runDir }) });
  } catch (error) {
    if (error instanceof TeamQAError) throw error;
    blocked('WEB_IDENTITY_PROOF_INVALID', String(error?.message || error).split('\n')[0]);
  }
}

// roster.mjs select --target <file>: embed the proven target exactly (key order included), never a re-typed copy.
export function embedRosterTarget(request, file) {
  const target = readJson(file);
  if (isDeployedTarget(target)) {
    const errors = deployedTargetShapeErrors(target, 'roster');
    if (errors.length) fail(3, 'ROSTER_TARGET_INVALID', errors.join(','));
    if (JSON.stringify(canonicalDeployedTarget(target)) !== JSON.stringify(target)) fail(3, 'ROSTER_TARGET_NOT_CANONICAL', 'use identity/target.json as written by teamqa web identity prove');
  }
  if (request && typeof request === 'object' && Object.hasOwn(request, 'target') && canonicalDeployedJson(request.target) !== canonicalDeployedJson(target)) {
    fail(3, 'ROSTER_TARGET_CONFLICT', 'request.target differs from --target');
  }
  request.target = target;
  return request;
}

export async function webIdentityCommand(args) {
  const [action, ...rest] = args;
  if (action === 'draft') return jsonCommand('web identity draft', () => draftIdentity(rest));
  if (action === 'prove') return jsonCommand('web identity prove', () => proveIdentity(rest));
  fail(2, 'COMMAND_UNKNOWN', `web identity ${action ?? ''}`.trim());
}
