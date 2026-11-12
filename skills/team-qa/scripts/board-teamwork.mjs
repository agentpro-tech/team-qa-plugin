import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emit,
  fail,
  outputJson,
  parseFlags,
  readJson,
  runAdapter,
  safeRunId,
  sha256File,
  stableJson,
  sha256,
  writeConfirmed,
} from './lib/core.mjs';
import { loadTracked } from './lib/validators.mjs';
import { TRACKED_PLAN_SCHEMA_VERSION } from './lib/source-traceability.mjs';
import { selectBoardDestination } from './lib/board-destination.mjs';
import { sealBoardDelivery, verifyBoardDelivery, verifyBoardReview } from './lib/board-quality.mjs';
import { siblingSkillRoot } from './lib/install-layout.mjs';
import { isClaudeTranscriptPath } from './lib/host-transcript.mjs';
import {
  NOTION_RECEIPT_SCHEMA, auditBoardWrites, buildNotionPlan, inputHash, notionPaths, parseCreateDatabase, parseCreatePages,
  parseQuery, plannedResults, plansOf, readPlan, resolvePlaceholders, stepRecord,
} from './lib/board-notion.mjs';
import { COLAB_RECEIPT_SCHEMA, colabConfig, publishColabRun } from './lib/board-colab.mjs';

function qaBoardTool() {
  const path = resolve(process.env.TEAMQA_QA_GUI_BOARD_TOOL
    ?? join(
      siblingSkillRoot('qa-gui'),
      'scripts', 'teamwork', 'cli.mjs',
    ));
  if (!existsSync(path)) fail(5, 'QA_GUI_BOARD_TOOL_UNAVAILABLE', path, 'ungraded');
  return [process.execPath, path];
}

function qaBoardRenderer() {
  const path = resolve(process.env.TEAMQA_QA_GUI_BOARD_RENDERER
    ?? join(
      siblingSkillRoot('qa-gui'),
      'scripts', 'teamwork', 'doc-colab-renderer.mjs',
    ));
  if (!existsSync(path)) fail(5, 'QA_GUI_BOARD_RENDERER_UNAVAILABLE', path, 'ungraded');
  return path;
}

function docColabScript() {
  return resolve(process.env.TEAMQA_DOC_COLAB_SCRIPT
    ?? join(homedir(), '.agents', 'skills', 'doc-colab', 'scripts', 'make_doc.py'));
}

function docColabRoot() {
  return dirname(dirname(docColabScript()));
}

// A file path, not URL.pathname: the latter keeps %20 for a space ("Application Support"), and the adapter was then
// reported missing.
export function notionBoardAdapter() {
  return resolve(process.env.TEAMQA_NOTION_BOARD_ADAPTER
    ?? fileURLToPath(new URL('./adapters/notion-board-env.mjs', import.meta.url)));
}

function execute(command, code, options = {}) {
  const result = runAdapter(command, { cwd: options.cwd ?? process.cwd(), env: options.env, timeout: options.timeout ?? 30_000 });
  if (result.status !== 0 || result.signal || result.error) {
    const detail = (result.error || result.stderr || result.stdout || `exit=${result.status}`).trim().split('\n')[0];
    fail(options.exitCode ?? 1, code, detail, options.verdict ?? 'fail');
  }
  return result;
}

function validateFile(path) {
  const result = execute([...qaBoardTool(), 'validate', '--file', path], 'BOARD_GATE_FAILED');
  return outputJson(result, 'BOARD_GATE_READBACK_INVALID');
}

function verifyQualityReview(file, reviewPath) {
  if (!reviewPath) fail(5, 'BOARD_QUALITY_REVIEW_REQUIRED', '--quality-review <authenticated-review-receipt>', 'ungraded');
  return verifyBoardReview({ file, receiptPath: boardPath(reviewPath) });
}

function sealQualityDelivery(file, artifactPath, renderer, reviewPath, projectionOptions = {}) {
  sealBoardDelivery({ file, reviewPath, artifactPath, renderer, projectionOptions });
  verifyBoardDelivery({ file, artifactPath, renderer });
}

function boardPath(value) {
  const path = resolve(value);
  if (!existsSync(path)) fail(2, 'BOARD_FILE_MISSING', path);
  return path;
}

function nextRevisionOutput(file) {
  const board = readJson(file, { label: 'qa-board.json', invalidCode: 'BOARD_JSON_INVALID' });
  const revision = board.rev ?? board.revision;
  if (!Number.isInteger(revision) || revision < 0) fail(1, 'BOARD_REVISION_INVALID', String(revision));
  return `${file}.rev-${revision + 1}.json`;
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function extractDocData(html) {
  const scriptStart = html.indexOf('<script id="doc-data">');
  if (scriptStart < 0) fail(1, 'BOARD_RENDER_READBACK_INVALID', 'DOC_DATA script missing');
  const bodyStart = html.indexOf('>', scriptStart) + 1;
  const bodyEnd = html.indexOf('</script>', bodyStart);
  if (bodyStart <= 0 || bodyEnd < 0) fail(1, 'BOARD_RENDER_READBACK_INVALID', 'DOC_DATA boundary missing');
  const body = html.slice(bodyStart, bodyEnd).trim();
  const prefix = 'window.DOC_DATA = ';
  if (!body.startsWith(prefix) || !body.endsWith(';')) fail(1, 'BOARD_RENDER_READBACK_INVALID', 'DOC_DATA assignment invalid');
  try { return JSON.parse(body.slice(prefix.length, -1).trim().replaceAll('<\\/', '</')); }
  catch { fail(1, 'BOARD_RENDER_READBACK_INVALID', 'DOC_DATA invalid'); }
}

export function boardInit(args) {
  const options = parseFlags(args, {
    '--run': { key: 'runId', required: true },
    '--title': { key: 'title', required: true },
    '--out': { key: 'out' },
    '--language': { key: 'language' },
    '--environment': { key: 'environment' },
    '--database': { key: 'database' },
    '--viewport': { key: 'viewport' },
    '--round': { key: 'round' },
    '--scope': { key: 'scope' },
    '--actor': { key: 'actor' },
    '--at': { key: 'at' },
    '--tracked': { key: 'tracked' },
    '--evidence-policy': { key: 'evidencePolicy' },
  });
  const runId = safeRunId(options.runId);
  // QA GUI evidence policy v1 (R1f): the board asks QA GUI's gate for its screenshot and recording checks.
  if (options.evidencePolicy !== undefined && options.evidencePolicy !== '1') fail(2, 'BOARD_EVIDENCE_POLICY_INVALID', options.evidencePolicy);
  const out = resolve(options.out ?? join(process.cwd(), 'runs', runId, 'qa-board.json'));
  mkdirSync(dirname(out), { recursive: true });
  const command = [...qaBoardTool(), 'init', '--out', out, '--board-id', runId, '--title', options.title];
  for (const [flag, key] of [['--language', 'language'], ['--environment', 'environment'], ['--database', 'database'], ['--viewport', 'viewport'], ['--round', 'round'], ['--scope', 'scope'], ['--actor', 'actor'], ['--at', 'at'], ['--evidence-policy', 'evidencePolicy']]) {
    if (options[key]) command.push(flag, options[key]);
  }
  let tracked = null;
  let seedDir = null;
  try {
    if (options.tracked) {
      const trackedPath = resolve(options.tracked);
      tracked = loadTracked(trackedPath);
      if (tracked.errors.length > 0) {
        const [code, ...detail] = tracked.errors[0].split(' ');
        fail(2, code, detail.join(' '));
      }
      if (tracked.value.schemaVersion === TRACKED_PLAN_SCHEMA_VERSION) {
        seedDir = mkdtempSync(join(tmpdir(), 'teamqa-source-seed-'));
        const seedPath = join(seedDir, 'source-seed.json');
        const seed = {
          seedVersion: 'qa-source-seed/v1',
          sourceItems: structuredClone(tracked.value.sourceItems),
          cases: tracked.value.cases.map((item) => ({
            id: item.id,
            title: item.title,
            requirement: item.req_id,
            requirements: [item.req_id],
            sourceRefs: structuredClone(item.sourceRefs),
            steps: structuredClone(item.steps),
            expected: item.expected,
            kind: item.kind,
            states: structuredClone(item.states),
          })),
        };
        writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`, { flag: 'wx' });
        const observedSeed = readJson(seedPath, { label: 'source-seed.json' });
        if (!jsonEqual(observedSeed, seed)) fail(1, 'BOARD_SOURCE_SEED_READBACK_MISMATCH');
        command.push('--source-seed', seedPath);
      }
    }
    execute(command, 'BOARD_INIT_FAILED');
  } finally {
    if (seedDir) rmSync(seedDir, { recursive: true, force: true });
  }
  const gate = validateFile(out);
  if (tracked?.value.schemaVersion === TRACKED_PLAN_SCHEMA_VERSION) {
    const board = readJson(out, { label: 'qa-board.json', invalidCode: 'BOARD_JSON_INVALID' });
    if (!jsonEqual(board.sourceItems, tracked.value.sourceItems)) fail(1, 'BOARD_SOURCE_READBACK_MISMATCH', 'sourceItems');
    if (!Array.isArray(board.cases)) fail(1, 'BOARD_SOURCE_READBACK_MISMATCH', 'cases');
    const observedCases = board.cases.map((item) => ({ id: item.id, sourceRefs: item.sourceRefs }));
    const expectedCases = tracked.value.cases.map((item) => ({ id: item.id, sourceRefs: item.sourceRefs }));
    if (!jsonEqual(observedCases, expectedCases)) fail(1, 'BOARD_SOURCE_READBACK_MISMATCH', 'cases');
  }
  emit(
    'pass',
    `board=${out}`,
    `revision=${gate.rev ?? gate.revision}`,
    `sha256=${gate.sha256}`,
    ...(tracked?.value.schemaVersion === TRACKED_PLAN_SCHEMA_VERSION ? [`sources=${tracked.value.sourceItems.length}`, `cases=${tracked.value.cases.length}`] : []),
    'effect=confirmed',
  );
}

export function boardValidate(args) {
  const options = parseFlags(args, { '--file': { key: 'file', required: true } });
  const path = boardPath(options.file);
  const gate = validateFile(path);
  emit('pass', `board=${path}`, `revision=${gate.rev ?? gate.revision}`, `sha256=${gate.sha256}`);
}

export function boardIntegrityVerify(args, quiet = false) {
  const options = parseFlags(args, {
    '--file': { key: 'file', required: true },
    '--artifact': { key: 'artifact', required: true },
  });
  const file = boardPath(options.file);
  const artifact = boardPath(options.artifact);
  verifyBoardDelivery({ file, artifactPath: artifact, renderer: 'doc-colab' });
  const gate = validateFile(file);
  const result = execute([
    process.execPath,
    qaBoardRenderer(),
    file,
    '--verify-existing', artifact,
    '--doc-colab-root', docColabRoot(),
  ], 'BOARD_INTEGRITY_FAILED');
  const verdicts = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^verdict=(pass|fail|ungraded)(?:\s|$)/.test(line));
  if (verdicts.length !== 1 || !/^verdict=pass(?:\s|$)/.test(verdicts[0])) {
    fail(1, 'BOARD_INTEGRITY_VERDICT_INVALID');
  }
  const board = readJson(file, { label: 'qa-board.json', invalidCode: 'BOARD_JSON_INVALID' });
  let rendered;
  try { rendered = extractDocData(readFileSync(artifact, 'utf8')); }
  catch (error) { if (error?.code) throw error; fail(1, 'BOARD_RENDER_READBACK_INVALID', String(error.message ?? error)); }
  if (!jsonEqual(rendered.qaBoard, board)) fail(1, 'BOARD_RENDER_CANONICAL_MISMATCH');
  if (!quiet) emit(
    'pass',
    `board=${file}`,
    `artifact=${artifact}`,
    `revision=${gate.rev ?? gate.revision}`,
    `sha256=${gate.sha256}`,
    `artifact_sha256=${sha256File(artifact)}`,
    'integrity=verified',
  );
}

export function boardRender(args, quiet = false) {
  const options = parseFlags(args, {
    '--file': { key: 'file', required: true },
    '--out': { key: 'out' },
    '--renderer': { key: 'renderer' },
    '--quality-review': { key: 'qualityReview' },
  });
  const file = boardPath(options.file);
  verifyQualityReview(file, options.qualityReview);
  const renderer = options.renderer ?? 'native';
  if (renderer !== 'native') fail(2, 'BOARD_RENDERER_UNKNOWN', renderer);
  const gate = validateFile(file);
  const board = readJson(file, { label: 'qa-board.json', invalidCode: 'BOARD_JSON_INVALID' });
  const out = resolve(options.out ?? join(process.cwd(), 'collab', `team-qa-${board.boardId}`, 'qa-board', 'index.html'));
  mkdirSync(dirname(out), { recursive: true });
  const script = docColabScript();
  if (!existsSync(script)) fail(5, 'DOC_COLAB_UNAVAILABLE', script, 'ungraded');
  execute(['python3', script, '--template', 'task-board', '--data', file, '--out', out], 'BOARD_RENDER_FAILED');
  let rendered;
  try { rendered = extractDocData(readFileSync(out, 'utf8')); }
  catch (error) { if (error?.code) throw error; fail(1, 'BOARD_RENDER_READBACK_INVALID', String(error.message ?? error)); }
  if (!jsonEqual(rendered.qaBoard, board)) fail(1, 'BOARD_RENDER_CANONICAL_MISMATCH');
  sealQualityDelivery(file, out, 'doc-colab', options.qualityReview);
  if (!quiet) emit('pass', `renderer=${renderer}`, `board=${file}`, `artifact=${out}`, `sha256=${gate.sha256}`, `artifact_sha256=${sha256File(out)}`, 'effect=confirmed');
}

export function boardApply(args) {
  const options = parseFlags(args, {
    '--file': { key: 'file', required: true },
    '--change': { key: 'change', required: true },
    '--out': { key: 'out' },
    '--actor': { key: 'actor', required: true },
    '--actor-role': { key: 'actorRole' },
  });
  const file = boardPath(options.file);
  const change = boardPath(options.change);
  const out = resolve(options.out ?? nextRevisionOutput(file));
  const command = [...qaBoardTool(), 'apply', '--file', file, '--change', change, '--out', out];
  for (const [flag, key] of [['--actor', 'actor'], ['--actor-role', 'actorRole']]) if (options[key]) command.push(flag, options[key]);
  execute(command, 'BOARD_APPLY_FAILED');
  const gate = validateFile(out);
  emit('pass', `board=${out}`, `revision=${gate.rev ?? gate.revision}`, `sha256=${gate.sha256}`, 'effect=confirmed');
}

export function boardSync(args) {
  const options = parseFlags(args, {
    '--file': { key: 'file', required: true },
    '--snapshot': { key: 'snapshot' },
    '--actor': { key: 'actor', required: true },
    '--renderer': { key: 'renderer' },
    '--mode': { key: 'mode' },
    '--actor-role': { key: 'actorRole' },
    '--at': { key: 'at' },
    '--qa-changes': { key: 'qaChanges' },
    '--out': { key: 'out' },
    '--notion-source-map': { key: 'notionSourceMap' },
    '--quality-review': { key: 'qualityReview' },
  });
  if (options.renderer !== 'notion') fail(2, 'NOTION_OPT_IN_REQUIRED', '--renderer notion');
  const file = boardPath(options.file);
  const mode = options.mode ?? 'pull';
  if (!['pull', 'push'].includes(mode)) fail(2, 'NOTION_SYNC_MODE_UNKNOWN', mode);
  if (mode === 'push') {
    verifyQualityReview(file, options.qualityReview);
    const snapshot = resolve(options.snapshot ?? `${file}.notion-export.json`);
    const sourceMapArgs = options.notionSourceMap
      ? ['--notion-source-map', boardPath(options.notionSourceMap)]
      : [];
    execute([...qaBoardTool(), 'export-notion', '--file', file, '--out', snapshot, ...sourceMapArgs], 'NOTION_EXPORT_FAILED');
    sealQualityDelivery(file, snapshot, 'notion', options.qualityReview, {
      notionSourceMap: options.notionSourceMap ? readJson(boardPath(options.notionSourceMap)) : {},
    });
    const adapter = notionBoardAdapter();
    if (!existsSync(adapter)) fail(5, 'NOTION_BOARD_UNAVAILABLE', adapter, 'ungraded');
    const adapterEnv = { TEAMQA_BOARD_SNAPSHOT: snapshot, TEAMQA_BOARD_PATH: file };
    execute([process.execPath, adapter, 'probe'], 'NOTION_BOARD_UNAVAILABLE', { exitCode: 5, verdict: 'ungraded', env: adapterEnv });
    execute([process.execPath, adapter, 'push'], 'NOTION_PUSH_FAILED', { env: adapterEnv, timeout: 60_000 });
    const readback = `${snapshot}.readback.json`;
    execute([process.execPath, adapter, 'readback', '--out', readback], 'NOTION_READBACK_FAILED', { env: adapterEnv, timeout: 60_000 });
    verifyBoardDelivery({ file, artifactPath: snapshot, renderer: 'notion' });
    const compare = execute([...qaBoardTool(), 'compare-notion', '--file', file, '--snapshot', readback, ...sourceMapArgs], 'NOTION_COMPARE_FAILED');
    const result = outputJson(compare, 'NOTION_COMPARE_READBACK_INVALID');
    emit('pass', 'renderer=notion', 'mode=push', `board=${file}`, `snapshot=${snapshot}`, `readback=${readback}`, `mismatches=${result.mismatches.length}`, 'effect=confirmed');
    return;
  }
  if (!options.snapshot) fail(2, 'ARG_REQUIRED', '--snapshot');
  const snapshot = boardPath(options.snapshot);
  const out = resolve(options.out ?? nextRevisionOutput(file));
  const command = [...qaBoardTool(), 'sync-notion', '--file', file, '--snapshot', snapshot, '--out', out, '--actor', options.actor];
  for (const [flag, key] of [['--actor-role', 'actorRole'], ['--at', 'at'], ['--qa-changes', 'qaChanges']]) if (options[key]) command.push(flag, options[key]);
  execute(command, 'NOTION_SYNC_FAILED');
  const gate = validateFile(out);
  emit('pass', 'renderer=notion', `board=${out}`, `revision=${gate.rev ?? gate.revision}`, `sha256=${gate.sha256}`, 'quality=not-reviewed', 'effect=confirmed');
}

export function boardOpen(args) {
  const options = parseFlags(args, { '--file': { key: 'file', required: true }, '--canonical': { key: 'canonical' } });
  const file = boardPath(options.file);
  const isQaArtifact = readFileSync(file, 'utf8').includes('qaBoard') || existsSync(`${file}.doc-colab-lock.json`);
  if (isQaArtifact && !options.canonical) fail(5, 'BOARD_OPEN_CANONICAL_REQUIRED', file, 'ungraded');
  if (options.canonical) boardIntegrityVerify(['--file', options.canonical, '--artifact', file], true);
  let command = ['open'];
  if (process.env.TEAMQA_OPEN_CMD) {
    try { command = JSON.parse(process.env.TEAMQA_OPEN_CMD); }
    catch { fail(2, 'OPEN_COMMAND_INVALID'); }
    if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string')) fail(2, 'OPEN_COMMAND_INVALID');
  }
  execute([...command, file], 'BOARD_OPEN_FAILED');
  emit('pass', `artifact=${file}`, options.canonical ? 'qa_integrity=verified' : 'qa_integrity=not-applicable', 'effect=confirmed');
}

export function boardPrepare(args) {
  const options = parseFlags(args, {
    '--file': { key: 'file', required: true },
    '--capabilities': { key: 'capabilities', required: true },
    '--out': { key: 'out', required: true },
    '--evidence-map': { key: 'evidenceMap' },
    '--quality-review': { key: 'qualityReview' },
  });
  const file = boardPath(options.file);
  verifyQualityReview(file, options.qualityReview);
  validateFile(file);
  const renderer = selectBoardDestination(readJson(boardPath(options.capabilities)));
  if (renderer === 'doc-colab') {
    const html = `${resolve(options.out)}.html`;
    boardRender(['--file', file, '--out', html, '--renderer', 'native', '--quality-review', options.qualityReview], true);
    boardIntegrityVerify(['--file', file, '--artifact', html], true);
    emit('pass', 'renderer=doc-colab', `artifact=${html}`, 'stage=verified-local');
    return;
  }
  const command = [...qaBoardTool(), renderer === 'space' ? 'export-page' : 'export-notion', '--file', file, '--out', resolve(options.out)];
  if (options.evidenceMap && renderer === 'space') command.push('--evidence-map', boardPath(options.evidenceMap));
  execute(command, 'BOARD_PREPARE_FAILED');
  sealQualityDelivery(file, resolve(options.out), renderer, options.qualityReview, {
    ...(renderer === 'space' ? { evidenceMap: options.evidenceMap ? readJson(boardPath(options.evidenceMap)) : {} } : {}),
  });
  emit('pass', `renderer=${renderer}`, `payload=${resolve(options.out)}`, 'stage=prepared', 'effect=not-committed');
}

export function boardComparePage(args, quiet = false) {
  const options = parseFlags(args, {
    '--file': { key: 'file', required: true }, '--snapshot': { key: 'snapshot', required: true },
    '--payload': { key: 'payload', required: true },
    '--out': { key: 'out' }, '--evidence-map': { key: 'evidenceMap' },
  });
  const file = boardPath(options.file);
  const delivery = verifyBoardDelivery({ file, artifactPath: boardPath(options.payload), renderer: 'space' });
  const projectionOptions = delivery.projectionOptions ?? {};
  if (options.evidenceMap) {
    const supplied = readJson(boardPath(options.evidenceMap));
    if (stableJson(supplied) !== stableJson(projectionOptions.evidenceMap ?? {})) {
      fail(1, 'BOARD_PAGE_QUALITY_PROJECTION_MISMATCH');
    }
  }
  validateFile(file);
  const command = [...qaBoardTool(), 'compare-page', '--file', file, '--snapshot', boardPath(options.snapshot)];
  if (options.out) command.push('--out', resolve(options.out));
  if (!options.evidenceMap && Object.keys(projectionOptions.evidenceMap ?? {}).length) {
    fail(2, 'ARG_REQUIRED', '--evidence-map matching sealed payload projection');
  }
  if (options.evidenceMap) command.push('--evidence-map', boardPath(options.evidenceMap));
  const result = execute(command, 'BOARD_PAGE_READBACK_FAILED');
  const observed = outputJson(result, 'BOARD_PAGE_READBACK_INVALID');
  if (observed.protocol !== 'qa-gui/page-readback/v1' || observed.operation !== 'compare-page'
      || observed.ok !== true || observed.matchPercent !== 100
      || typeof observed.pageId !== 'string' || !observed.pageId.trim()
      || typeof observed.url !== 'string' || !/^https:\/\//.test(observed.url)
      || !Array.isArray(observed.mismatches) || observed.mismatches.length !== 0
      || typeof observed.seal !== 'string' || !/^[a-f0-9]{64}$/.test(observed.seal)) {
    fail(1, 'BOARD_PAGE_READBACK_UNCONFIRMED');
  }
  if (!quiet) emit('pass', 'renderer=space', 'integrity=verified', 'quality=verified', 'effect=confirmed', `page=${observed.pageId}`);
  return observed;
}

// ---- One command for board delivery (upgrade B0) ---------------------------------------------------------------------
// `board publish` replaces the hand-run chain (validate, review check, render or export, seal, write, readback). HTML
// goes through the Doc-Colab renderer when it is installed, otherwise QA GUI's native renderer (the plugin ships no
// Doc-Colab). Notion goes through the hosted Notion MCP as exact planned calls (lib/board-notion.mjs).
const TEAMQA_VERSION = () => readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const runDirOf = (runId) => join(process.cwd(), 'runs', safeRunId(runId));

// The board a run delivers: the locked canonical board when the run has a document lock, otherwise the revision with
// the highest `rev` among the run's qa-board*.json files.
export function currentBoardPath(runDir) {
  const lockPath = join(runDir, 'docs-lock.json');
  if (existsSync(lockPath)) {
    const ref = readJson(lockPath).artifacts?.board;
    if (ref?.path) return resolve(runDir, ref.path);
  }
  const candidates = (existsSync(runDir) ? readdirSync(runDir) : [])
    .filter((name) => /^qa-board\.json(?:\.rev-\d+\.json)*$/.test(name))
    .map((name) => ({ path: join(runDir, name), rev: readJson(join(runDir, name)).rev ?? readJson(join(runDir, name)).revision }))
    .filter((c) => Number.isInteger(c.rev)).sort((a, b) => b.rev - a.rev);
  if (!candidates.length) fail(2, 'BOARD_FILE_MISSING', join(runDir, 'qa-board.json'));
  return candidates[0].path;
}

// The root transcript of a Claude Code run: the original file whose typed line approved the roster.
export function rootTranscript(runDir, explicit) {
  if (explicit) return resolve(explicit);
  const approval = join(runDir, 'control', 'approvals', 'roster.json');
  if (!existsSync(approval)) return null;
  const path = readJson(approval).event?.source?.path;
  return typeof path === 'string' && isClaudeTranscriptPath(path) ? path : null;
}

function archiveNotionDir(runDir) {
  const { dir } = notionPaths(runDir);
  if (!existsSync(dir)) return null;
  const target = join(runDir, 'archive', `board-notion-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(dir, target);
  return target;
}

async function writeJsonOnce(path, value, label) {
  mkdirSync(dirname(path), { recursive: true });
  await writeConfirmed(path, stableJson(value), label, { exclusive: true });
}
async function writeJson(path, value, label) {
  mkdirSync(dirname(path), { recursive: true });
  await writeConfirmed(path, stableJson(value), label);
}

async function lockNext(runDir, plan, step, captures) {
  const p = notionPaths(runDir);
  const record = stepRecord({ runId: plan.run_id, step, captures });
  await writeJson(p.next, record, 'teamqa.board.notion.next');
  await writeJson(join(p.dir, 'next-input.json'), record.input, 'teamqa.board.notion.next');
  return record;
}
// The sealed HTML board of the current revision. A Doc-Colab publish reuses the one already sealed for this revision.
function htmlDelivery(runDir, file, qualityReview, { reuse = false } = {}) {
  const out = join(runDir, 'board-html', `rev-${readJson(file).rev}`, 'index.html');
  if (existsSync(out)) {
    if (!reuse) fail(3, 'BOARD_OUTPUT_EXISTS', out);
    verifyBoardDelivery({ file, artifactPath: out });
    return { out, renderer: 'sealed', reused: true };
  }
  mkdirSync(dirname(out), { recursive: true });
  let renderer = 'doc-colab';
  if (existsSync(docColabScript())) {
    boardRender(['--file', file, '--out', out, '--renderer', 'native', '--quality-review', qualityReview], true);
    boardIntegrityVerify(['--file', file, '--artifact', out], true);
  } else {
    renderer = 'native';
    const tool = resolve(join(dirname(qaBoardTool()[1]), 'native-renderer.mjs'));
    execute([process.execPath, tool, file, '--out', out], 'BOARD_RENDER_FAILED');
    sealQualityDelivery(file, out, 'native', qualityReview);
  }
  return { out, renderer, reused: false };
}

// C8: the board on Doc-Colab. The HTML board is sealed first (same quality gate as --to html); then the run's
// Doc-Colab task board and overview page are created or updated (a run first published by 1.17 keeps its single doc),
// evidence uploaded, and everything read back and compared with the board.
// The receipt and the readback stay in runs/<id>/board-colab/, one pair per board revision.
async function publishBoardColab({ options, runDir, file }) {
  const html = htmlDelivery(runDir, file, options.qualityReview, { reuse: true });
  const cfg = colabConfig({ url: options.colabUrl, keyFile: options.colabKeyFile });
  const board = readJson(file);
  const dir = join(runDir, 'board-colab');
  const latest = join(dir, 'receipt.json');
  const prior = existsSync(latest) ? readJson(latest) : null;
  const known = prior?.schema === COLAB_RECEIPT_SCHEMA ? Object.fromEntries(Object.values(prior.evidence || {}).map((e) => [e.sha256, e.url])) : {};
  const runId = safeRunId(options.runId);
  const result = await publishColabRun({ board, boardFile: file, runDir, runId, version: TEAMQA_VERSION(), canonicalSha256: sha256File(file),
    channel: options.channel, cfg, known });
  mkdirSync(dir, { recursive: true });
  const readbackPath = join(dir, `readback-rev-${board.rev}.json`);
  await writeJson(readbackPath, result.readback, 'teamqa.board.colab.readback');
  const receiptPath = join(dir, `receipt-rev-${board.rev}.json`);
  const receipt = { schema: COLAB_RECEIPT_SCHEMA, run_id: runId, version: TEAMQA_VERSION(),
    board: { path: file, sha256: sha256File(file) }, artifact: { path: html.out, sha256: sha256File(html.out) },
    readback: { path: readbackPath, sha256: sha256File(readbackPath) },
    form: result.form, doc: { id: result.id, url: result.url, rev: result.rev, ...(result.overviewUrl ? { overview: result.overviewUrl } : {}) }, channel: options.channel || null, evidence: result.urls,
    comparison: { matchPercent: result.comparison.matchPercent, matchedFields: result.comparison.matchedFields, totalFields: result.comparison.totalFields },
    verified_at: new Date().toISOString() };
  await writeJson(receiptPath, receipt, 'teamqa.board.colab.receipt');
  copyFileSync(receiptPath, latest);
  emit('pass', 'to=colab', `form=${result.form}`, `doc=${result.id}`, `url=${result.url}`, ...(result.overviewUrl ? [`overview=${result.overviewUrl}`] : []), `rev=${result.rev}`, `evidence=${Object.keys(result.urls).length}`,
    `artifact=${html.out}`, `receipt=${receiptPath}`, 'integrity=verified', 'effect=confirmed');
  console.log(`board-link.json: provider "colab", url "${result.url}", artifact "${relative(runDir, html.out)}", artifact_sha256 "${receipt.artifact.sha256}", snapshot "${relative(runDir, readbackPath)}", snapshot_sha256 "${receipt.readback.sha256}", payload "${relative(runDir, receiptPath)}", payload_sha256 "${sha256File(receiptPath)}"`);
}

export async function boardPublish(args) {
  const options = parseFlags(args, {
    '--run': { key: 'runId', required: true },
    '--to': { key: 'to', required: true },
    '--parent': { key: 'parent' },
    '--file': { key: 'file' },
    '--quality-review': { key: 'qualityReview' },
    '--session': { key: 'session' },
    '--channel': { key: 'channel' },
    '--colab-url': { key: 'colabUrl' },
    '--colab-key-file': { key: 'colabKeyFile' },
  });
  const runDir = runDirOf(options.runId);
  if (!existsSync(runDir)) fail(2, 'RUN_DIR_MISSING', runDir);
  const file = options.file ? boardPath(options.file) : currentBoardPath(runDir);
  verifyQualityReview(file, options.qualityReview);
  validateFile(file);
  if (options.to === 'html') {
    const { out, renderer } = htmlDelivery(runDir, file, options.qualityReview);
    emit('pass', 'to=html', `renderer=${renderer}`, `board=${file}`, `artifact=${out}`, `artifact_sha256=${sha256File(out)}`,
      `lock=board_render:${out},board_quality:${out}.quality.json`, 'integrity=verified', 'effect=confirmed');
    return;
  }
  if (options.to === 'colab') return publishBoardColab({ options, runDir, file });
  if (options.to !== 'notion') fail(2, 'BOARD_PUBLISH_TARGET', 'html|notion|colab');
  if (!options.parent) fail(2, 'ARG_REQUIRED', '--parent <Notion page id or URL>');
  const archived = archiveNotionDir(runDir);
  const p = notionPaths(runDir);
  mkdirSync(p.dir, { recursive: true });
  const projectionPath = join(p.dir, 'projection.json');
  execute([...qaBoardTool(), 'export-notion-mcp', '--file', file, '--out', projectionPath, '--version', TEAMQA_VERSION(), '--run', safeRunId(options.runId)], 'BOARD_PREPARE_FAILED');
  sealQualityDelivery(file, projectionPath, 'notion-mcp', options.qualityReview, { version: TEAMQA_VERSION(), runId: safeRunId(options.runId) });
  const plan = buildNotionPlan({ projection: readJson(projectionPath), projectionPath, boardPath: file, runId: safeRunId(options.runId), parentPageId: options.parent });
  await writeJsonOnce(p.plan, plan, 'teamqa.board.notion.plan');
  await writeJsonOnce(p.state, { captures: {}, database_urls: {}, next_index: 0, results: [], readback_hashes: [], session: rootTranscript(runDir, options.session) }, 'teamqa.board.notion.state');
  const record = await lockNext(runDir, plan, plan.steps[0], {});
  emit('pass', 'to=notion', 'renderer=notion-mcp', 'stage=planned', `step=1/${plan.steps.length + plan.readback.length}`,
    `tool=notion-${record.tool}`, `input=${join(p.dir, 'next-input.json')}`, ...(archived ? [`archived=${archived}`] : []), 'effect=not-committed');
  console.log(`next: call notion-${record.tool} with the JSON of ${join(p.dir, 'next-input.json')} as its input, unchanged; then run: teamqa board publish-next --run ${safeRunId(options.runId)}`);
}

function successfulResult(runDir, transcript, input, code) {
  const results = plannedResults({ runDir, transcriptPath: transcript, input });
  const ok = results.filter((r) => !r.isError);
  if (ok.length > 1) fail(3, 'BOARD_NOTION_DUPLICATE_WRITE', `${ok.length} successful calls for one planned step`);
  if (ok.length === 1) return ok[0];
  if (results.length) fail(1, 'BOARD_NOTION_STEP_FAILED', String(results.at(-1).text || '').slice(0, 300));
  fail(5, code, 'the planned call has no result yet: make it with next-input.json unchanged', 'ungraded');
}

export async function boardPublishNext(args) {
  const options = parseFlags(args, { '--run': { key: 'runId', required: true }, '--session': { key: 'session' } });
  const runDir = runDirOf(options.runId);
  const p = notionPaths(runDir);
  const plan = readPlan(runDir);
  const state = readJson(p.state);
  const transcript = options.session ? resolve(options.session) : state.session;
  const total = plan.steps.length + plan.readback.length;
  if (existsSync(p.receipt)) fail(3, 'BOARD_NOTION_ALREADY_VERIFIED', p.receipt);
  // Write steps, in order.
  while (state.next_index < plan.steps.length) {
    const step = plan.steps[state.next_index];
    const input = resolvePlaceholders(step.input, state.captures);
    const result = successfulResult(runDir, transcript, input, 'BOARD_NOTION_STEP_RESULT_MISSING');
    if (step.tool === 'create-database') {
      const parsed = parseCreateDatabase(result.text);
      if (!parsed.dataSourceId) fail(1, 'BOARD_NOTION_RESULT_INVALID', 'create-database returned no data source');
      state.captures[step.capture] = parsed.dataSourceId;
      state.database_urls[step.capture] = parsed.databaseUrl;
    } else {
      const parsed = parseCreatePages(result.text);
      if (!parsed.pages || parsed.pages.length !== step.external_ids.length) fail(1, 'BOARD_NOTION_RESULT_INVALID', `create-pages returned ${parsed.pages?.length ?? 'no'} pages for ${step.external_ids.length} rows`);
    }
    state.results.push({ n: step.n, tool: step.tool, input_sha256: inputHash(input), source: result.source });
    state.next_index += 1;
    if (state.next_index < plan.steps.length) {
      await writeJson(p.state, state, 'teamqa.board.notion.state');
      const record = await lockNext(runDir, plan, plan.steps[state.next_index], state.captures);
      emit('pass', 'to=notion', 'stage=writing', `step=${record.n}/${total}`, `tool=notion-${record.tool}`, `input=${join(p.dir, 'next-input.json')}`, 'effect=not-committed');
      console.log(`next: call notion-${record.tool} with the JSON of ${join(p.dir, 'next-input.json')} as its input, unchanged; then run: teamqa board publish-next --run ${plan.run_id}`);
      return;
    }
  }
  // Readback: every planned query, each with its own result.
  const queries = plan.readback.map((q) => ({ ...q, input: resolvePlaceholders(q.input, state.captures) }));
  state.readback_hashes = queries.map((q) => inputHash(q.input));
  await writeJson(p.state, state, 'teamqa.board.notion.state');
  const readback = { cases: { mode: 'rows', results: [] }, defects: { mode: 'rows', results: [] } };
  const sources = [];
  for (const q of queries) {
    const results = plannedResults({ runDir, transcriptPath: transcript, input: q.input }).filter((r) => !r.isError);
    if (!results.length) {
      const record = await lockNext(runDir, plan, plan.readback.find((r) => r.n === q.n), state.captures);
      emit('pass', 'to=notion', 'stage=readback', `step=${record.n}/${total}`, 'tool=notion-query-data-sources', `input=${join(p.dir, 'next-input.json')}`, 'effect=not-committed');
      console.log(`next: call notion-query-data-sources with the JSON of ${join(p.dir, 'next-input.json')} as its input, unchanged; then run: teamqa board publish-next --run ${plan.run_id}`);
      return;
    }
    const latest = results.at(-1), parsed = parseQuery(latest.text);
    if (!parsed.results) fail(1, 'BOARD_NOTION_READBACK_INVALID', `query ${q.n} returned no results array`);
    if (parsed.hasMore && q === queries.filter((x) => x.database === q.database).at(-1)) fail(1, 'BOARD_NOTION_UNEXPECTED_ROWS', `${q.database} has more rows than the board`);
    readback[q.database].results.push(...parsed.results);
    sources.push({ n: q.n, input_sha256: inputHash(q.input), source: latest.source });
  }
  await writeJsonOnce(p.readback, readback, 'teamqa.board.notion.readback');
  verifyBoardDelivery({ file: plan.board.path, artifactPath: plan.projection.path, renderer: 'notion-mcp' });
  if (sha256File(plan.board.path) !== plan.board.sha256) fail(3, 'BOARD_NOTION_BOARD_CHANGED', plan.board.path);
  const compare = execute([...qaBoardTool(), 'compare-notion-mcp', '--file', plan.board.path, '--readback', p.readback, '--version', TEAMQA_VERSION(), '--run', plan.run_id], 'BOARD_NOTION_READBACK_MISMATCH');
  const comparison = outputJson(compare, 'BOARD_NOTION_READBACK_INVALID');
  if (comparison.ok !== true || comparison.matchPercent !== 100) fail(1, 'BOARD_NOTION_READBACK_MISMATCH', JSON.stringify(comparison.mismatches || []).slice(0, 300));
  const receipt = { schema: NOTION_RECEIPT_SCHEMA, run_id: plan.run_id, board: plan.board, projection: plan.projection,
    plan: { path: p.plan, sha256: sha256File(p.plan) }, readback: { path: p.readback, sha256: sha256File(p.readback) },
    captures: state.captures, database_urls: state.database_urls, provenance: plan.provenance,
    comparison: { matchPercent: comparison.matchPercent, matchedFields: comparison.matchedFields, totalFields: comparison.totalFields, rows: comparison.rows },
    writes: state.results, reads: sources, verified_at: new Date().toISOString() };
  await writeJsonOnce(p.receipt, receipt, 'teamqa.board.notion.receipt');
  emit('pass', 'to=notion', 'renderer=notion-mcp', 'integrity=verified', 'effect=confirmed', `cases=${state.database_urls.cases}`, `defects=${state.database_urls.defects}`,
    `receipt=${p.receipt}`, `lock=board_notion:${p.receipt},board_quality:${plan.projection.path}.quality.json`);
}

// A stored Notion delivery verified again: same board, sealed projection, readback unchanged and still 100%, and every
// recorded result source unchanged (hook record or original transcript line).
export function verifyNotionReceipt({ runDir, receiptPath, boardPath: expectedBoard }) {
  const r = readJson(receiptPath);
  if (r.schema !== NOTION_RECEIPT_SCHEMA) fail(3, 'BOARD_NOTION_RECEIPT_INVALID', receiptPath);
  if (expectedBoard && resolve(expectedBoard) !== resolve(r.board.path)) fail(3, 'BOARD_NOTION_RECEIPT_BOARD', expectedBoard);
  for (const ref of [r.board, r.projection, r.plan, r.readback]) if (!existsSync(ref.path) || sha256File(ref.path) !== ref.sha256) fail(3, 'BOARD_NOTION_RECEIPT_DRIFT', ref.path);
  verifyBoardDelivery({ file: r.board.path, artifactPath: r.projection.path, renderer: 'notion-mcp' });
  for (const item of [...r.writes, ...r.reads]) {
    const s = item.source;
    if (s.kind === 'hook') { if (!existsSync(s.path) || sha256File(s.path) !== s.sha256) fail(3, 'BOARD_NOTION_RESULT_DRIFT', s.path); continue; }
    const lines = readFileSync(s.path, 'utf8').split('\n');
    if (sha256(lines[s.call_line - 1] ?? '') !== s.call_sha256 || sha256(lines[s.result_line - 1] ?? '') !== s.result_sha256) fail(3, 'BOARD_NOTION_RESULT_DRIFT', `${s.path}:${s.call_line}`);
  }
  const compare = execute([...qaBoardTool(), 'compare-notion-mcp', '--file', r.board.path, '--readback', r.readback.path, '--version', TEAMQA_VERSION(), '--run', r.run_id], 'BOARD_NOTION_READBACK_MISMATCH');
  const comparison = outputJson(compare, 'BOARD_NOTION_READBACK_INVALID');
  if (comparison.ok !== true) fail(1, 'BOARD_NOTION_READBACK_MISMATCH');
  return r;
}

// Board writes of a root transcript: planned Notion calls and everything else (nonconforming).
export function boardAudit(args) {
  const options = parseFlags(args, { '--session': { key: 'session' }, '--run': { key: 'runId' } });
  const runDir = options.runId ? runDirOf(options.runId) : null;
  const transcript = options.session ? resolve(options.session) : runDir && rootTranscript(runDir);
  if (!transcript || !existsSync(transcript)) fail(2, 'ARG_REQUIRED', '--session <root transcript> (or --run of a Claude Code run)');
  const result = auditBoardWrites({ transcriptPath: transcript, plans: runDir ? plansOf(runDir) : [] });
  console.log(stableJson({ schema: 'team-qa/board-audit/v1', transcript, ...result }).trim());
  if (result.nonconforming) process.exitCode = 1;
}
