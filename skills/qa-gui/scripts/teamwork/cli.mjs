#!/usr/bin/env node
import crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

import { exportPage, comparePage } from './page-exporter.mjs';

import { validateCanonical } from './canonical.mjs';
import { hardenDocColabPacket } from './doc-colab-hardener.mjs';
import { renderDocColabBoard } from './doc-colab-renderer.mjs';
import { applyNotionPull, compareNotionRows, mapCanonicalRows } from './notion-sync.mjs';
import { migrateCanonicalSourceTraceability } from './source-traceability-migration.mjs';

const CURRENT_SCHEMA_VERSION = 6;
const SOURCE_SEED_VERSION = 'qa-source-seed/v1';
const SOURCE_SEED_FIELDS = Object.freeze(['seedVersion', 'sourceItems', 'cases']);
const SOURCE_SEED_CASE_FIELDS = Object.freeze([
  'id', 'title', 'requirement', 'requirements', 'sourceRefs', 'steps', 'expected',
  'priority', 'assignee', 'kind', 'states',
]);
const DEFAULT_PROSE = Object.freeze({
  vi: Object.freeze({ scope: 'Phạm vi QA ban đầu', risk: 'QA chưa được chạy.' }),
  en: Object.freeze({ scope: 'Initial QA scope', risk: 'QA has not run.' }),
  ko: Object.freeze({ scope: '초기 QA 범위', risk: 'QA가 아직 실행되지 않았습니다.' }),
  ja: Object.freeze({ scope: '初回のQA範囲', risk: 'QAはまだ実行されていません。' }),
});

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const value = rest[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    options[token.slice(2)] = value;
  }
  return { command, options };
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${key} is required`);
  return value;
}

function readJson(file, label = 'JSON') {
  try { return JSON.parse(readFileSync(path.resolve(file), 'utf8')); }
  catch (error) { throw new Error(`${label} invalid: ${error.message}`); }
}

function writeNewJson(file, value) {
  const target = path.resolve(file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  return target;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(readFileSync(path.resolve(file))).digest('hex');
}

function validated(file) {
  const target = path.resolve(file);
  const data = readJson(target, 'canonical');
  const result = validateCanonical(data);
  if (!result.ok) throw new Error(result.errors.map((entry) => `${entry.path}: ${entry.message}`).join('\n'));
  return { target, data, sha256: sha256File(target) };
}

function asRows(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.rows)) return snapshot.rows;
  throw new Error('Notion snapshot must be an array or {rows:[]}');
}

function notionOptions(options) {
  if (!options['notion-source-map']) return {};
  const notionSourcePages = readJson(options['notion-source-map'], 'Notion source map');
  if (!notionSourcePages || typeof notionSourcePages !== 'object' || Array.isArray(notionSourcePages)) {
    throw new Error('Notion source map must be an object keyed by canonical source id');
  }
  return { notionSourcePages };
}

function rejectUnknownFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label}: unknown field ${unknown[0]}`);
}

function sourceSeed(options, language) {
  if (!options['source-seed']) return { sourceItems: [], cases: [] };
  const seed = readJson(options['source-seed'], 'source seed');
  rejectUnknownFields(seed, SOURCE_SEED_FIELDS, 'source seed');
  if (seed.seedVersion !== SOURCE_SEED_VERSION) throw new Error(`source seed.seedVersion must be ${SOURCE_SEED_VERSION}`);
  if (!Array.isArray(seed.sourceItems)) throw new Error('source seed.sourceItems must be an array');
  if (!Array.isArray(seed.cases)) throw new Error('source seed.cases must be an array');
  const prose = language === 'vi'
    ? { function: 'Chưa chạy.', ui: 'Chưa chạy.' }
    : { function: 'Not run.', ui: 'Not run.' };
  const cases = seed.cases.map((entry, index) => {
    const label = `source seed.cases[${index}]`;
    rejectUnknownFields(entry, SOURCE_SEED_CASE_FIELDS, label);
    for (const key of ['id', 'title', 'requirement']) {
      if (typeof entry[key] !== 'string' || entry[key].trim().length === 0) throw new Error(`${label}.${key} is required`);
    }
    if (!Array.isArray(entry.sourceRefs) || entry.sourceRefs.length === 0) throw new Error(`${label}.sourceRefs requires at least one explicit source reference`);
    const steps = Array.isArray(entry.steps)
      ? entry.steps.map((step, stepIndex) => `${stepIndex + 1}. ${step}`).join('\n')
      : entry.steps;
    return {
      id: entry.id,
      title: entry.title,
      requirement: entry.requirement,
      ...(entry.requirements ? { requirements: structuredClone(entry.requirements) } : {}),
      sourceRefs: structuredClone(entry.sourceRefs),
      ...(typeof steps === 'string' && steps.trim().length > 0 ? { steps } : {}),
      ...(typeof entry.expected === 'string' && entry.expected.trim().length > 0 ? { expected: entry.expected } : {}),
      status: 'TODO',
      priority: entry.priority || 'P2',
      assignee: entry.assignee || 'qa-agent',
      functionVerdict: 'UNGRADED',
      uiVerdict: 'UNGRADED',
      humanSummary: prose,
      machine: { rule: 'UNGRADED', selector: 'source-seed-not-run' },
      kind: entry.kind || 'static',
      states: structuredClone(entry.states || []),
      stateReceipts: [],
      results: [],
      evidence: [],
      comments: [],
      history: [],
    };
  });
  return { sourceItems: structuredClone(seed.sourceItems), cases };
}

function commandInit(options) {
  const at = options.at || new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) throw new Error('--at must be an ISO date-time');
  const round = Number(options.round || 1);
  if (!Number.isInteger(round) || round < 1) throw new Error('--round must be a positive integer');
  const environment = options.environment || 'LOCAL';
  const database = options.database || 'not-applicable';
  const title = required(options, 'title');
  // Public v1: a board is in English unless --language says otherwise (vi is supported).
  const language = options.language || 'en';
  const prose = DEFAULT_PROSE[language] || DEFAULT_PROSE.en;
  // Deployed-build (web-v1) board: the verified target binding replaces the Git commit
  // (references/release-receipt-web-v1.md).
  const targetBinding = options['target-binding-sha256'];
  if (targetBinding !== undefined && options.commit !== undefined) {
    throw new Error('--commit and --target-binding-sha256 are exclusive: a deployed-build board has no commit');
  }
  const seeded = sourceSeed(options, language);
  const canonical = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    canonicalVersion: 'qa-board-teamwork/v2',
    boardKind: 'team-qa-board',
    rev: 0,
    boardId: required(options, 'board-id'),
    title,
    boardCreated: at,
    language,
    deepCheck: options['deep-check'] || 'available',
    app: options.app || title,
    envDb: `${environment} / ${database}`,
    viewport: options.viewport || '1280x800',
    runUuid: options['run-uuid'] || crypto.randomUUID(),
    ...(targetBinding !== undefined ? { targetBindingSha256: targetBinding } : { commit: options.commit || '0'.repeat(40) }),
    build: options.build || 'UNVERIFIED-PLAN',
    env: environment,
    db: database,
    role: options.role || 'qa-agent',
    testProfile: options['test-profile'] || 'plan-not-run',
    evidenceManifest: [],
    currentRound: round,
    sourceItems: seeded.sourceItems,
    cases: seeded.cases,
    defects: [],
    rounds: [{ round, startedAt: at, scope: options.scope || prose.scope }],
    coverage: [],
    untested: [],
    release: { verdict: 'NO-GO', risks: [prose.risk] },
  };
  const validation = validateCanonical(canonical);
  if (!validation.ok) throw new Error(validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join('\n'));
  const output = writeNewJson(required(options, 'out'), canonical);
  return { ok: true, operation: 'init', file: output, rev: canonical.rev, sha256: sha256File(output) };
}

function commandMigrateSources(options) {
  const input = path.resolve(required(options, 'file'));
  const output = path.resolve(required(options, 'out'));
  if (input === output) throw new Error('migrate-sources refuses to overwrite the input canonical');
  const legacy = readJson(input, 'legacy canonical');
  const mapping = readJson(required(options, 'mapping'), 'source traceability mapping');
  const migrated = migrateCanonicalSourceTraceability(legacy, mapping);
  writeNewJson(output, migrated);
  return {
    ok: true,
    operation: 'migrate-sources',
    file: output,
    schemaVersion: migrated.schemaVersion,
    sources: migrated.sourceItems.length,
    cases: migrated.cases.length,
    sha256: sha256File(output),
  };
}

function commandValidate(options) {
  const { target, data, sha256 } = validated(required(options, 'file'));
  return { ok: true, operation: 'validate', file: target, rev: data.rev, sha256 };
}

function commandRender(options) {
  const file = required(options, 'file');
  const output = path.resolve(required(options, 'out'));
  mkdirSync(path.dirname(output), { recursive: true });
  const result = renderDocColabBoard({ input: file, output, docColabRoot: options['doc-colab-root'] });
  return { ok: true, operation: 'render', file: path.resolve(file), output: result.output, sha256: sha256File(result.output) };
}

function commandApply(options) {
  const file = path.resolve(required(options, 'file'));
  const output = path.resolve(required(options, 'out'));
  if (file === output) throw new Error('apply refuses to overwrite the input canonical');
  const canonical = validated(file).data;
  const packet = readJson(required(options, 'change'), 'Doc-Colab packet');
  const actor = required(options, 'actor');
  const result = hardenDocColabPacket({
    canonical,
    packet,
    evidenceDir: options['evidence-dir'] || path.join(path.dirname(output), 'evidence'),
    input: file,
    output,
    context: {
      actor,
      now: options.at || new Date().toISOString(),
      qaActors: String(options['qa-actors'] || (options['actor-role'] === 'qa' ? actor : '')).split(',').filter(Boolean),
    },
  });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  writeNewJson(output, result.data);
  return { ok: true, operation: 'apply', file: output, rev: result.data.rev, evidenceFiles: result.evidenceFiles, sha256: sha256File(output) };
}

function pageProjection(options) {
  const { data, sha256 } = validated(required(options, 'file'));
  const map = options['evidence-map'] ? readJson(options['evidence-map'], 'evidence map') : {};
  return exportPage(data, sha256, map);
}

function commandExportPage(options) {
  const payload = pageProjection(options);
  const output = writeNewJson(required(options, 'out'), payload);
  return { ok: true, operation: 'export-page', output, canonical: payload.canonical, sha256: sha256File(output) };
}

function commandComparePage(options) {
  const expected = pageProjection(options);
  const snapshot = readJson(required(options, 'snapshot'), 'Page readback snapshot');
  const receipt = comparePage(expected, snapshot);
  if (options.out) writeNewJson(options.out, receipt);
  if (!receipt.ok) {
    const error = new Error('Page comparison is not 100% (changed content or stale canonical revision)');
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

function commandExportNotion(options) {
  const { data } = validated(required(options, 'file'));
  const rows = mapCanonicalRows(data, notionOptions(options));
  const output = writeNewJson(required(options, 'out'), rows);
  return { ok: true, operation: 'export-notion', output, rows: rows.length, sha256: sha256File(output) };
}

function commandCompareNotion(options) {
  const { data } = validated(required(options, 'file'));
  const rows = asRows(readJson(required(options, 'snapshot'), 'Notion snapshot'));
  const comparison = compareNotionRows(data, rows, notionOptions(options));
  if (comparison.matchPercent !== 100) {
    const error = new Error('Notion comparison is not 100%');
    error.receipt = comparison;
    throw error;
  }
  return { ok: true, operation: 'compare-notion', ...comparison };
}

function commandSyncNotion(options) {
  const file = path.resolve(required(options, 'file'));
  const output = path.resolve(required(options, 'out'));
  if (file === output) throw new Error('sync-notion refuses to overwrite the input canonical');
  const { data } = validated(file);
  const actor = required(options, 'actor');
  const at = options.at || new Date().toISOString();
  const rows = asRows(readJson(required(options, 'snapshot'), 'Notion snapshot')).map((row) => ({
    ...row,
    editedBy: row.editedBy || actor,
    editedAt: row.editedAt || at,
  }));
  const result = applyNotionPull(data, rows, {
    qaActors: String(options['qa-actors'] || (options['actor-role'] === 'qa' ? actor : '')).split(',').filter(Boolean),
  });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  writeNewJson(output, result.data);
  return { ok: true, operation: 'sync-notion', file: output, rev: result.data.rev, applied: result.applied, sha256: sha256File(output) };
}

function dispatch(command, options) {
  if (command === 'init') return commandInit(options);
  if (command === 'migrate-sources') return commandMigrateSources(options);
  if (command === 'validate') return commandValidate(options);
  if (command === 'render') return commandRender(options);
  if (command === 'apply') return commandApply(options);
  if (command === 'export-page') return commandExportPage(options);
  if (command === 'compare-page') return commandComparePage(options);
  if (command === 'export-notion') return commandExportNotion(options);
  if (command === 'compare-notion') return commandCompareNotion(options);
  if (command === 'sync-notion') return commandSyncNotion(options);
  throw new Error(`unknown teamwork command ${command || '<missing>'}`);
}

function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(dispatch(command, options))}\n`);
  } catch (error) {
    if (error.receipt) process.stderr.write(`${JSON.stringify({ ok: false, ...error.receipt })}\n`);
    else process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (isDirectExecution(import.meta.url)) main();
