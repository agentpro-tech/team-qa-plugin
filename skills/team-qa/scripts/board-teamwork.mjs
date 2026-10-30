import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
} from './lib/core.mjs';
import { loadTracked } from './lib/validators.mjs';
import { TRACKED_PLAN_SCHEMA_VERSION } from './lib/source-traceability.mjs';
import { selectBoardDestination } from './lib/board-destination.mjs';
import { sealBoardDelivery, verifyBoardDelivery, verifyBoardReview } from './lib/board-quality.mjs';
import { siblingSkillRoot } from './lib/install-layout.mjs';

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

function notionBoardAdapter() {
  return resolve(process.env.TEAMQA_NOTION_BOARD_ADAPTER
    ?? new URL('./adapters/notion-board-env.mjs', import.meta.url).pathname);
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
  });
  const runId = safeRunId(options.runId);
  const out = resolve(options.out ?? join(process.cwd(), 'runs', runId, 'qa-board.json'));
  mkdirSync(dirname(out), { recursive: true });
  const command = [...qaBoardTool(), 'init', '--out', out, '--board-id', runId, '--title', options.title];
  for (const [flag, key] of [['--language', 'language'], ['--environment', 'environment'], ['--database', 'database'], ['--viewport', 'viewport'], ['--round', 'round'], ['--scope', 'scope'], ['--actor', 'actor'], ['--at', 'at']]) {
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
