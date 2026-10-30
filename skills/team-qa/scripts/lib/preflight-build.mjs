// teamqa preflight build (eval compat 3, part B1): writes runs/<id>/preflight.json from the original refs of a
// Claude Code root transcript and accepts it only when assertToolPreflight verifies it for the requested stage.
//   teamqa preflight build --run <id> --stage basic|plan|execute [--roster <file>] [--image <png>] [--video <mp4>]
//                          [--current] [--transcript <root.jsonl>] [--repo-root <dir> --source-path <file>]
// Refs come from the root's calls after the latest visible `TEAMQA_PREFLIGHT run=<id> round=<n> roster=<hash>` line.
// --current keeps the existing preflight.json and replaces only what dispatch checks for freshness: current_identity,
// gui.read and, when the stage checks the GUI lane, the screenshot (plus recording) taken on the same session and tab.
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseFlags, readJson, runAdapter, safeRunId, sha256, sha256File, stableJson, writeConfirmed } from './core.mjs';
import { isDeployedTarget, WEB_CONTRACT_SHA256 } from './deployed-target.mjs';
import { readContract } from './release-truth.mjs';
import { assertToolPreflight, readDragonToolEvidence } from './tool-preflight.mjs';
import { verifyProviderInterface } from './roster.mjs';
import { loadPlan } from './validators.mjs';
import { claudeHostSource } from './host-transcript.mjs';
import { claudeRef, locateMarkedTranscript, passiveTriple, requireUsable, sameSession, sessionOf } from './claude-refs.mjs';
import { dragonRuntimeDir, dragonStatusCommand, isDragonStatusCommand } from './dragon-endpoint.mjs';
import { jsonCommand, refuseTargetEnv, runDirectory } from './web-identity.mjs';
import { siblingSkillRoot } from './install-layout.mjs';

const bad = (code, detail = '') => fail(2, code, detail);
const blocked = (code, detail = '') => fail(3, code, detail, 'ungraded');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DRAGON_FILES = ['server.js', 'mcp-server.mjs', 'package.json'];
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function lastDragon(records, method, keep = () => true) {
  return records.filter(r => r.kind === 'dragon' && r.method === method && keep(r)).at(-1);
}
function pin(path, code) {
  if (!path || !existsSync(path)) blocked(code, `${path ?? '(none)'} is missing`);
  const real = realpathSync(path);
  return { path: real, sha256: sha256File(real) };
}
function planScope(runDir) {
  const plan = loadPlan(join(runDir, 'test-plan.md'));
  if (plan.errors.length) blocked('PREFLIGHT_PLAN_INVALID', plan.errors.join(';'));
  if (!plan.value.preflight) blocked('PREFLIGHT_SCOPE_REQUIRED', 'test-plan.md declares no preflight scope');
  return plan.value.preflight;
}
function childPin(skill) {
  let root;
  try { root = verifyProviderInterface({ skill }).root; }
  catch (error) { blocked('PREFLIGHT_BUILD_CHILD_RUNTIME', `${skill}: ${error.code || String(error.message || error).split('\n')[0]}`); }
  return { skill, source_sha256: sha256File(join(root, 'SOURCE.json')), manifest_sha256: sha256File(join(root, 'package-manifest.json')) };
}
function dragonFiles(required) {
  // The runtime serving this run: ~/.dragon-browser/runtime/current, or an isolated eval lane's release (eval compat 11).
  const runtime = dragonRuntimeDir();
  const paths = DRAGON_FILES.map(name => join(runtime, name));
  if (!paths.every(path => existsSync(path))) {
    if (required) blocked('PREFLIGHT_BUILD_DRAGON_RUNTIME', `${runtime} must hold server.js, mcp-server.mjs and package.json`);
    return [];
  }
  return paths.map(path => pin(path, 'PREFLIGHT_BUILD_DRAGON_RUNTIME'));
}
function runtimeSection({ deployed, fixture, guiLane }) {
  return { node_version: process.version, contract_sha256: deployed ? WEB_CONTRACT_SHA256 : readContract().contract_sha256,
    children: fixture ? [] : ['qa-code', 'qa-gui'].map(childPin), dragon_files: dragonFiles(!fixture && (deployed || guiLane)) };
}

// Session, tab and the stage's GUI calls from the latest marker block. `base` (for --current) fixes the session and
// tab of the existing chain; otherwise the block must hold the whole chain: status → session.create → openTab → read.
function guiCalls(records, { target, deployed, base, screenshot, recording, ref }) {
  let session, tabId, chain = null;
  if (base) ({ session, tabId } = base);
  else {
    const status = requireUsable(records.filter(r => r.kind === 'bash' && isDragonStatusCommand(r.command)).at(-1), `Bash ${dragonStatusCommand()}`);
    const created = requireUsable(lastDragon(records, 'session.create'), 'dragon_rpc session.create');
    session = sessionOf(created.value.result);
    const open = requireUsable(lastDragon(records, 'openTab', r => sameSession(r.params, session) && r.params.url === target.preview_url), `dragon_rpc openTab ${target.preview_url} on the created session`);
    tabId = open.value.result?.tabId;
    if (!Number.isInteger(tabId)) blocked('PREFLIGHT_BUILD_TAB', 'openTab returned no tabId');
    chain = { status: ref(status), session: ref(created), open: ref(open) };
  }
  // `fresh` holds the result times of the calls a dispatch-time check requires to be at most five minutes old.
  const calls = { chain, fresh: [] }, fresh = record => { calls.fresh.push(Date.parse(record.result.entry.timestamp)); return record; };
  if (deployed) {
    const { page, network, tab } = passiveTriple(records, { session, tabId });
    [page, network, tab].forEach(fresh);
    calls.read = { ...ref(page), tab_source: ref(tab) };
    calls.current = { ...ref(page), tab_source: ref(tab), network_source: ref(network) };
  } else {
    calls.read = ref(fresh(requireUsable(lastDragon(records, 'do', r => sameSession(r.params, session) && r.params.tabId === tabId), 'dragon_rpc do read on the session tab')));
  }
  if (screenshot) {
    const shot = fresh(requireUsable(lastDragon(records, 'screenshot', r => sameSession(r.params, session) && r.params.tabId === tabId), 'dragon_rpc screenshot on the session tab'));
    calls.screenshot = { ref: ref(shot), savedTo: shot.value.result?.savedTo };
  }
  if (recording) {
    const start = fresh(requireUsable(lastDragon(records, 'startRecording', r => sameSession(r.params, session) && r.params.tabId === tabId), 'dragon_rpc startRecording on the session tab'));
    const id = start.value.result?.id;
    const stop = fresh(requireUsable(lastDragon(records, 'stopRecording', r => sameSession(r.params, session) && r.params.id === id), 'dragon_rpc stopRecording of that recording'));
    const assemble = fresh(requireUsable(lastDragon(records, 'assembleRecording', r => sameSession(r.params, session) && r.params.id === id), 'dragon_rpc assembleRecording of that recording'));
    calls.recording = { start: ref(start), recording: ref(stop), assemble: ref(assemble), video: assemble.value.result?.video };
  }
  return calls;
}

// Git lane only: the latest QA Code gate0 run of each tier (runner when its receipt carries native test runners).
function codeChecks(records, { fixture, ref }) {
  const root = fixture ? realpathSync(process.env.TEAMQA_PREFLIGHT_TEST_QA_CODE_ROOT || siblingSkillRoot('qa-code')) : verifyProviderInterface({ skill: 'qa-code' }).root;
  const prefix = `bash '${join(root, 'scripts', 'gate0.sh').replaceAll("'", "'\\''")}' `;
  const runs = records.filter(r => r.kind === 'bash' && typeof r.command === 'string' && r.command.startsWith(prefix));
  if (!runs.length) blocked('PREFLIGHT_BUILD_CODE_MISSING', `no root Bash call of ${prefix.trim()} after the marker`);
  requireUsable(runs.at(-1), 'latest QA Code gate0 run');
  const byTier = {};
  for (const run of runs.filter(r => !r.problem)) {
    let receipt;
    try { receipt = JSON.parse(run.pair.output.output); } catch { continue; }
    byTier[receipt?.native_test_runners?.records?.coverage ? 'runner' : 'scanner'] = { run, receipt };
  }
  return ['scanner', 'runner'].map(tier => {
    const found = byTier[tier];
    if (!found) blocked('PREFLIGHT_BUILD_CODE_MISSING', `no usable ${tier} gate0 run after the marker`);
    const config = /--config '([^']*)'/.exec(found.run.command)?.[1];
    // The verifier matches each checker by its reported path, so the pin keeps that exact spelling.
    const tools = (found.receipt.runtime?.checkers || []).map(checker => ({ path: checker.path, sha256: pin(checker.path, 'PREFLIGHT_BUILD_CODE_TOOL').sha256 }));
    return { tier, command: found.run.command, runtime: root, evidence: ref(found.run), ...(config ? { config: { path: config, sha256: sha256File(config) } } : {}), tools };
  });
}

function gitAccess(repoRoot, sourcePath) {
  if (!sourcePath || sourcePath.startsWith('-') || sourcePath.includes('..')) bad('PREFLIGHT_BUILD_SOURCE_PATH', sourcePath ?? '(missing)');
  const repo = realpathSync(repoRoot);
  const read = runAdapter(['git', '-C', repo, 'show', `HEAD:${sourcePath}`]);
  if (read.status !== 0 || !read.stdout.trim()) blocked('PREFLIGHT_BUILD_TARGET_READ', `${sourcePath} at HEAD of ${repo}`);
  return { kind: 'git', repo_root: repo, source_path: sourcePath, source_sha256: sha256(read.stdout) };
}

function media(calls, { image, video }) {
  const out = {};
  if (calls.screenshot) out.image = pin(image ? resolve(image) : calls.screenshot.savedTo, 'PREFLIGHT_BUILD_IMAGE');
  if (calls.recording) out.video = pin(video ? resolve(video) : calls.recording.video, 'PREFLIGHT_BUILD_VIDEO');
  return out;
}

export async function buildPreflight(args) {
  const o = parseFlags(args, { '--run': { key: 'run', required: true }, '--stage': { key: 'stage', required: true }, '--roster': { key: 'roster' },
    '--image': { key: 'image' }, '--video': { key: 'video' }, '--current': { key: 'current', boolean: true }, '--transcript': { key: 'transcript' },
    '--repo-root': { key: 'repoRoot' }, '--source-path': { key: 'sourcePath' } });
  if (!['basic', 'plan', 'execute'].includes(o.stage)) bad('PREFLIGHT_BUILD_STAGE', o.stage);
  const runId = safeRunId(o.run), runDir = runDirectory(runId);
  if (!existsSync(runDir)) blocked('PREFLIGHT_BUILD_RUN_MISSING', relative(process.cwd(), runDir));
  const rosterFile = o.roster ? resolve(o.roster) : join(runDir, 'roster.json');
  if (!existsSync(rosterFile)) blocked('PREFLIGHT_BUILD_ROSTER_MISSING', relative(process.cwd(), rosterFile));
  const candidate = readJson(rosterFile), roster = { ...candidate, roster_hash: sha256File(rosterFile) };
  if (roster.run_id !== runId || !Number.isInteger(roster.round) || roster.round < 1 || !roster.target || typeof roster.target !== 'object') blocked('PREFLIGHT_BUILD_ROSTER', 'roster must be the candidate or approved roster of this run');
  const deployed = isDeployedTarget(roster.target), fixture = roster.catalog_source?.kind === 'fixture';
  if (deployed) refuseTargetEnv();
  const requirements = o.stage === 'basic' ? undefined : planScope(runDir);
  const guiLane = Boolean(requirements?.gui), recording = Boolean(requirements?.recording);
  const marker = `TEAMQA_PREFLIGHT run=${roster.run_id} round=${roster.round} roster=${roster.roster_hash}`;
  const { scan } = locateMarkedTranscript({ runDir, transcript: o.transcript, marker });
  const host = claudeHostSource(scan.path), ref = record => claudeRef(scan.path, record, host);
  const dest = join(runDir, 'preflight.json');
  let p, calls = null;
  if (o.current) {
    if (!existsSync(dest)) blocked('PREFLIGHT_BUILD_CURRENT_BASE', 'no preflight.json to refresh; build it without --current first');
    const base = readJson(dest);
    if (base.schema !== 'team-qa/tool-preflight/v1' || base.run_id !== roster.run_id || base.round !== roster.round || base.roster_hash !== roster.roster_hash || !eq(base.target, roster.target)) {
      blocked('PREFLIGHT_BUILD_CURRENT_BASE', 'preflight.json belongs to another run, round, roster or target; rebuild without --current');
    }
    const chain = base.target_access?.kind === 'dragon' ? base.target_access.gui : base.gui;
    if (!chain?.session || !chain?.open) blocked('PREFLIGHT_BUILD_CURRENT_BASE', 'preflight.json holds no Dragon session; rebuild without --current');
    const evidence = (r, method) => readDragonToolEvidence(r, { roster, runDir }, method);
    const session = sessionOf(evidence(chain.session, 'session.create').result), tabId = evidence(chain.open, 'openTab').result.tabId;
    calls = guiCalls(scan.records, { target: roster.target, deployed, base: { session, tabId }, screenshot: guiLane, recording: guiLane && recording, ref });
    p = structuredClone(base);
    if (deployed) p.current_identity = calls.current;
    if (p.target_access?.kind === 'dragon') p.target_access.gui.read = calls.read;
    if (guiLane && !p.gui) p.gui = { status: chain.status, session: chain.session, open: chain.open };
    if (p.gui) p.gui.read = calls.read;
    if (guiLane) {
      const files = media(calls, o);
      Object.assign(p.gui, { screenshot: calls.screenshot.ref, image: files.image });
      if (calls.recording) Object.assign(p.gui, { start: calls.recording.start, recording: calls.recording.recording, assemble: calls.recording.assemble, video: files.video });
    }
  } else {
    const useDragon = deployed || !o.repoRoot;
    calls = useDragon || guiLane ? guiCalls(scan.records, { target: roster.target, deployed, screenshot: guiLane, recording: guiLane && recording, ref }) : null;
    const chain = calls ? { ...calls.chain, read: calls.read } : null;
    const targetAccess = useDragon ? { kind: 'dragon', gui: chain } : gitAccess(o.repoRoot, o.sourcePath);
    let gui;
    if (guiLane) {
      const files = media(calls, o);
      gui = { ...chain, screenshot: calls.screenshot.ref, image: files.image,
        ...(calls.recording ? { start: calls.recording.start, recording: calls.recording.recording, assemble: calls.recording.assemble, video: files.video } : {}) };
    }
    const qaCode = !deployed && requirements?.code ? codeChecks(scan.records, { fixture, ref }) : undefined;
    p = { schema: 'team-qa/tool-preflight/v1', run_id: roster.run_id, round: roster.round, roster_hash: roster.roster_hash, target: candidate.target,
      runtime: runtimeSection({ deployed, fixture, guiLane }), target_access: targetAccess, ...(qaCode ? { qa_code: qaCode } : {}), ...(gui ? { gui } : {}),
      ...(deployed ? { current_identity: calls.current } : {}) };
  }
  // Verify a content-addressed candidate inside the run first; preflight.json changes only to a verified file.
  const bytes = stableJson(p), digest = sha256(bytes), candidatePath = join(runDir, 'preflight-candidates', `${digest}.json`);
  await writeConfirmed(candidatePath, bytes, 'teamqa.preflight.candidate');
  const role = o.stage === 'execute' && deployed ? 'executor_gui' : undefined, requireFresh = Boolean(o.current) || o.stage === 'execute';
  const verdict = assertToolPreflight({ runDir, roster, stage: o.stage, role, requirements, file: relative(runDir, candidatePath), requireFresh });
  if (!verdict.verified) blocked('PREFLIGHT_BUILD_NOT_VERIFIED', JSON.stringify(verdict.lanes));
  if (existsSync(dest) && readFileSync(dest, 'utf8') !== bytes) {
    const previous = readFileSync(dest, 'utf8');
    await writeConfirmed(join(runDir, 'archive', `preflight-${sha256(previous)}.json`), previous, 'teamqa.preflight.archive');
  }
  if (!existsSync(dest) || readFileSync(dest, 'utf8') !== bytes) await writeConfirmed(dest, bytes, 'teamqa.preflight.build');
  rmSync(candidatePath, { force: true });
  // Dispatch re-checks the same samples: each must still be at most preflight_max_age_ms old then.
  const fresh = calls?.fresh.length ? new Date(Math.min(...calls.fresh) + readJson(join(ROOT, 'references/roster-policy.json')).preflight_max_age_ms).toISOString() : null;
  const next = o.stage === 'basic' ? (existsSync(join(runDir, 'control', 'approvals', 'roster.json')) ? 'Basic preflight verified for the approved roster.'
    : `Show the roster (node <team-qa>/scripts/roster.mjs show --file ${relative(process.cwd(), rosterFile)}) verbatim in chat; roster.mjs approve re-runs this basic preflight.`)
    : o.stage === 'plan' ? `teamqa run show-plan --run ${runId}` : `Dispatch now, before ${fresh}: node <team-qa>/scripts/roster.mjs dispatch --run-dir ${relative(process.cwd(), runDir)} --role executor_gui --prompt <prompt> --out <attestation.json>`;
  return { run_id: roster.run_id, round: roster.round, stage: o.stage, roster_hash: roster.roster_hash, current: Boolean(o.current), require_fresh: requireFresh,
    verdict, preflight: { path: relative(process.cwd(), dest), sha256: digest }, transcript: scan.path, marker_line: scan.marker_line,
    ...(requireFresh ? { fresh_until: fresh } : {}), next };
}

export function preflightBuildCommand(args) {
  return jsonCommand('preflight build', () => buildPreflight(args));
}
