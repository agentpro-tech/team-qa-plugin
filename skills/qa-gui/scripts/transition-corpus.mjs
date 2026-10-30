#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/;
const LIFECYCLE_PHASES = ['before', 'action', 'network', 'readback', 'refresh', 'postcondition'];
const CORPUS_FIELDS = [
  'schema', 'registry_sha256', 'incident_id', 'case_id', 'machine_id', 'build',
  'machine', 'state_receipts', 'transition_runs', 'evidence_manifest',
];
const RECEIPT_FIELDS = [
  'schema', 'registry_sha256', 'corpus_sha256', 'incident_id', 'case_id', 'machine_id',
  'build', 'state_count', 'transition_total', 'transition_covered', 'coverage_pct',
  'evidence_count', 'execution_status', 'semantic_verdict', 'created_at', 'integrity',
];

export class TransitionCorpusError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}:${detail}` : code);
    this.code = code;
  }
}

const fail = (code, detail = '') => { throw new TransitionCorpusError(code, detail); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function exactKeys(value, expected, code, allow = []) {
  if (!object(value)) fail(code, 'OBJECT_REQUIRED');
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !expected.includes(key) && !allow.includes(key));
  if (unknown.length) fail(code, unknown.join(','));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) fail(code.replace('UNKNOWN', 'MISSING'), missing.join(','));
}

function safeRelative(value, code) {
  if (!nonBlank(value) || value.includes('\\') || path.isAbsolute(value)
    || value.split('/').includes('..') || path.posix.normalize(value) !== value || value === '.') fail(code);
}

function readJson(file, code) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (error) { fail(code, error.message); }
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) }; } catch (error) { fail(`${code}_JSON`, error.message); }
}

function boundFile(root, relative, code) {
  safeRelative(relative, `${code}_PATH`);
  const rootReal = fs.realpathSync(root);
  const candidate = path.resolve(rootReal, relative);
  if (!candidate.startsWith(`${rootReal}${path.sep}`)) fail(`${code}_OUTSIDE_ROOT`);
  let stat;
  try { stat = fs.lstatSync(candidate); } catch (error) { fail(`${code}_MISSING`, error.message); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${code}_NOT_REGULAR`);
  const real = fs.realpathSync(candidate);
  if (real !== candidate || !real.startsWith(`${rootReal}${path.sep}`)) fail(`${code}_SYMLINK`);
  return { path: real, bytes: fs.readFileSync(real) };
}

function validateRawAssertion(value, code) {
  exactKeys(value, ['id', 'verdict', 'evidence'], `${code}_UNKNOWN_FIELD`);
  if (!nonBlank(value.id) || value.verdict !== 'PASS' || !nonBlank(value.evidence)) fail(code);
}

function validateManifest(corpus, root) {
  if (!Array.isArray(corpus.evidence_manifest) || corpus.evidence_manifest.length === 0) fail('EVIDENCE_MANIFEST_EMPTY');
  const manifest = new Map();
  for (const entry of corpus.evidence_manifest) {
    exactKeys(entry, ['path', 'sha256'], 'EVIDENCE_MANIFEST_UNKNOWN_FIELD');
    safeRelative(entry.path, 'EVIDENCE_MANIFEST_PATH');
    if (!SHA256.test(entry.sha256 || '') || manifest.has(entry.path)) fail('EVIDENCE_MANIFEST_ENTRY', entry.path || 'missing');
    const file = boundFile(root, entry.path, 'EVIDENCE_MANIFEST_FILE');
    if (sha256(file.bytes) !== entry.sha256) fail('EVIDENCE_MANIFEST_HASH', entry.path);
    manifest.set(entry.path, entry.sha256);
  }
  return manifest;
}

function requireManifest(manifest, pathValue, shaValue, code) {
  if (!manifest.has(pathValue)) fail(`${code}_MISSING`, pathValue);
  if (shaValue && manifest.get(pathValue) !== shaValue) fail(`${code}_HASH`, pathValue);
}

function validateStateReceipt(receipt, { corpus, state, manifest, root }) {
  const required = [
    'schema', 'caseId', 'state', 'capturedAt', 'url', 'build', 'viewport', 'domHash',
    'dragon', 'screenshot', 'function', 'ui', 'preflight', 'network', 'readback', 'lifecycle',
  ];
  exactKeys(receipt, required, 'STATE_RECEIPT_UNKNOWN_FIELD', ['equivalentTo', 'equivalenceReason']);
  if (receipt.schema !== 'qa-gui/state-receipt/v1') fail('STATE_RECEIPT_SCHEMA', state);
  if (receipt.caseId !== corpus.case_id) fail('STATE_RECEIPT_CASE', state);
  if (receipt.state !== state) fail('STATE_RECEIPT_STATE', state);
  if (receipt.build !== corpus.build) fail('STATE_RECEIPT_BUILD', state);
  if (!nonBlank(receipt.capturedAt) || !Number.isFinite(Date.parse(receipt.capturedAt))
    || !nonBlank(receipt.url) || !nonBlank(receipt.viewport) || !SHA256.test(receipt.domHash || '')) fail('STATE_RECEIPT_BINDING', state);

  exactKeys(receipt.dragon, ['sessionId', 'actionId', 'browserInstanceId', 'tabId', 'innerOk'], 'STATE_RECEIPT_DRAGON_UNKNOWN_FIELD');
  if (receipt.dragon.innerOk !== true || ['sessionId', 'actionId', 'browserInstanceId', 'tabId'].some((field) => !nonBlank(receipt.dragon[field]))) fail('STATE_RECEIPT_DRAGON', state);
  exactKeys(receipt.screenshot, ['path', 'sha256'], 'STATE_RECEIPT_SCREENSHOT_UNKNOWN_FIELD');
  if (!SHA256.test(receipt.screenshot.sha256 || '')) fail('STATE_RECEIPT_SCREENSHOT_HASH', state);
  requireManifest(manifest, receipt.screenshot.path, receipt.screenshot.sha256, 'STATE_RECEIPT_SCREENSHOT');
  const shot = boundFile(root, receipt.screenshot.path, 'STATE_RECEIPT_SCREENSHOT_FILE');
  if (sha256(shot.bytes) !== receipt.screenshot.sha256) fail('STATE_RECEIPT_SCREENSHOT_HASH', state);

  exactKeys(receipt.function, ['verdict', 'assertions'], 'STATE_RECEIPT_FUNCTION_UNKNOWN_FIELD');
  if (receipt.function.verdict !== 'PASS' || !Array.isArray(receipt.function.assertions) || receipt.function.assertions.length === 0) fail('STATE_RECEIPT_FUNCTION', state);
  for (const assertion of receipt.function.assertions) {
    exactKeys(assertion, ['requirement_id', 'verdict', 'evidence_ref'], 'STATE_RECEIPT_ASSERTION_UNKNOWN_FIELD');
    if (!nonBlank(assertion.requirement_id) || assertion.verdict !== 'PASS') fail('STATE_RECEIPT_ASSERTION', state);
    requireManifest(manifest, assertion.evidence_ref, null, 'STATE_RECEIPT_ASSERTION_EVIDENCE');
  }
  exactKeys(receipt.ui, ['verdict', 'uiSanity', 'a11y', 'console', 'network'], 'STATE_RECEIPT_UI_UNKNOWN_FIELD');
  if (receipt.ui.verdict !== 'PASS') fail('STATE_RECEIPT_UI', state);
  for (const field of ['uiSanity', 'a11y', 'console', 'network']) validateRawAssertion(receipt.ui[field], `STATE_RECEIPT_UI:${state}:${field}`);
  validateRawAssertion(receipt.preflight, `STATE_RECEIPT_PREFLIGHT:${state}`);
  if (!Array.isArray(receipt.network)) fail('STATE_RECEIPT_NETWORK', state);
  exactKeys(receipt.readback, ['value', 'evidence_ref'], 'STATE_RECEIPT_READBACK_UNKNOWN_FIELD');
  requireManifest(manifest, receipt.readback.evidence_ref, null, 'STATE_RECEIPT_READBACK_EVIDENCE');
  if (!object(receipt.lifecycle)) fail('LIFECYCLE_REQUIRED', state);
  const unknownPhases = Object.keys(receipt.lifecycle).filter((phase) => !LIFECYCLE_PHASES.includes(phase));
  if (unknownPhases.length) fail('LIFECYCLE_PHASE_UNKNOWN', `${state}:${unknownPhases.join(',')}`);
  for (const phase of LIFECYCLE_PHASES) {
    if (!Object.hasOwn(receipt.lifecycle, phase)) fail('LIFECYCLE_PHASE_MISSING', `${state}:${phase}`);
    const value = receipt.lifecycle[phase];
    exactKeys(value, ['verdict', 'evidence_ref'], 'LIFECYCLE_ASSERTION_UNKNOWN_FIELD', ['id', 'evidence', 'writes_data', 'expect_net']);
    if (value.verdict !== 'PASS' || !nonBlank(value.evidence_ref)) fail('LIFECYCLE_PHASE_VERDICT', `${state}:${phase}`);
    requireManifest(manifest, value.evidence_ref, null, 'LIFECYCLE_EVIDENCE');
  }
  return receipt;
}

function seal(value) {
  const clean = structuredClone(value);
  delete clean.integrity;
  return { ...clean, integrity: sha256(canonical(clean)) };
}

export function verifyTransitionCorpus({ corpusPath, createdAt = new Date().toISOString() }) {
  const absolute = path.resolve(corpusPath);
  const root = path.dirname(absolute);
  const read = readJson(absolute, 'TRANSITION_CORPUS_UNREADABLE');
  const corpus = read.value;
  exactKeys(corpus, CORPUS_FIELDS, 'TRANSITION_CORPUS_UNKNOWN_FIELD');
  if (corpus.schema !== 'qa-gui/transition-corpus/v1') fail('TRANSITION_CORPUS_SCHEMA');
  if (!SHA256.test(corpus.registry_sha256 || '')) fail('TRANSITION_CORPUS_REGISTRY_SHA');
  for (const field of ['incident_id', 'case_id', 'machine_id', 'build']) if (!nonBlank(corpus[field])) fail('TRANSITION_CORPUS_FIELD', field);
  exactKeys(corpus.machine, ['initial_state', 'states', 'transitions'], 'STATE_MACHINE_UNKNOWN_FIELD');
  if (!Array.isArray(corpus.machine.states) || corpus.machine.states.length === 0
    || corpus.machine.states.some((state) => !nonBlank(state))
    || new Set(corpus.machine.states).size !== corpus.machine.states.length
    || !corpus.machine.states.includes(corpus.machine.initial_state)) fail('STATE_MACHINE_STATES');
  if (!Array.isArray(corpus.machine.transitions) || corpus.machine.transitions.length === 0) fail('STATE_MACHINE_TRANSITIONS_EMPTY');
  const transitionById = new Map();
  for (const transition of corpus.machine.transitions) {
    exactKeys(transition, ['id', 'from', 'action', 'to'], 'STATE_MACHINE_TRANSITION_UNKNOWN_FIELD');
    if ([transition.id, transition.from, transition.action, transition.to].some((value) => !nonBlank(value))
      || transitionById.has(transition.id)
      || !corpus.machine.states.includes(transition.from)
      || !corpus.machine.states.includes(transition.to)) fail('STATE_MACHINE_TRANSITION', transition.id || 'missing');
    transitionById.set(transition.id, transition);
  }

  const manifest = validateManifest(corpus, root);
  if (!Array.isArray(corpus.state_receipts) || corpus.state_receipts.length !== corpus.machine.states.length) fail('STATE_RECEIPT_DENOMINATOR');
  const stateEntries = new Map();
  const receipts = new Map();
  const seenScreenshots = new Map();
  for (const entry of corpus.state_receipts) {
    exactKeys(entry, ['state', 'file', 'sha256'], 'STATE_RECEIPT_ENTRY_UNKNOWN_FIELD');
    if (!corpus.machine.states.includes(entry.state) || stateEntries.has(entry.state) || !SHA256.test(entry.sha256 || '')) fail('STATE_RECEIPT_ENTRY', entry.state || 'missing');
    requireManifest(manifest, entry.file, entry.sha256, 'STATE_RECEIPT_MANIFEST');
    const file = boundFile(root, entry.file, 'STATE_RECEIPT_FILE');
    if (sha256(file.bytes) !== entry.sha256) fail('STATE_RECEIPT_FILE_HASH', entry.state);
    const receipt = validateStateReceipt(JSON.parse(file.bytes.toString('utf8')), { corpus, state: entry.state, manifest, root });
    if (seenScreenshots.has(receipt.screenshot.sha256)) {
      const prior = seenScreenshots.get(receipt.screenshot.sha256);
      const expectedEquivalent = `${prior.caseId}:${prior.state}`;
      if (receipt.equivalentTo !== expectedEquivalent || !nonBlank(receipt.equivalenceReason) || receipt.domHash !== prior.domHash) fail('SCREENSHOT_REUSE', entry.state);
    } else {
      seenScreenshots.set(receipt.screenshot.sha256, { caseId: receipt.caseId, state: receipt.state, domHash: receipt.domHash });
    }
    stateEntries.set(entry.state, entry);
    receipts.set(entry.file, receipt);
  }
  const missingStates = corpus.machine.states.filter((state) => !stateEntries.has(state));
  if (missingStates.length) fail('STATE_COVERAGE_MISSING', missingStates.join(','));

  if (!Array.isArray(corpus.transition_runs)) fail('TRANSITION_RUNS_TYPE');
  const covered = new Set();
  for (const run of corpus.transition_runs) {
    exactKeys(run, ['transition_id', 'from_receipt', 'to_receipt'], 'TRANSITION_RUN_UNKNOWN_FIELD');
    const transition = transitionById.get(run.transition_id);
    if (!transition || covered.has(run.transition_id)) fail('TRANSITION_RUN_ID', run.transition_id || 'missing');
    const from = stateEntries.get(transition.from);
    const to = stateEntries.get(transition.to);
    if (run.from_receipt !== from?.file || run.to_receipt !== to?.file
      || receipts.get(run.from_receipt)?.state !== transition.from
      || receipts.get(run.to_receipt)?.state !== transition.to) fail('TRANSITION_RUN_BINDING', run.transition_id);
    covered.add(run.transition_id);
  }
  const missingTransitions = [...transitionById.keys()].filter((id) => !covered.has(id));
  if (missingTransitions.length > 0) fail('TRANSITION_COVERAGE_MISSING', missingTransitions.join(','));
  const coveragePct = Math.round((covered.size / transitionById.size) * 100);
  return seal({
    schema: 'qa-gui/transition-corpus-receipt/v1',
    registry_sha256: corpus.registry_sha256,
    corpus_sha256: sha256(read.bytes),
    incident_id: corpus.incident_id,
    case_id: corpus.case_id,
    machine_id: corpus.machine_id,
    build: corpus.build,
    state_count: stateEntries.size,
    transition_total: transitionById.size,
    transition_covered: covered.size,
    coverage_pct: coveragePct,
    evidence_count: manifest.size,
    execution_status: 'completed',
    semantic_verdict: 'PASS',
    created_at: createdAt,
  });
}

export function verifyTransitionCorpusReceipt(receipt, { corpusBytes }) {
  exactKeys(receipt, RECEIPT_FIELDS, 'TRANSITION_RECEIPT_UNKNOWN_FIELD');
  if (receipt.schema !== 'qa-gui/transition-corpus-receipt/v1') fail('TRANSITION_RECEIPT_SCHEMA');
  if (receipt.corpus_sha256 !== sha256(corpusBytes)) fail('TRANSITION_RECEIPT_CORPUS_HASH');
  if (receipt.execution_status !== 'completed' || receipt.semantic_verdict !== 'PASS'
    || receipt.transition_total < 1 || receipt.transition_covered !== receipt.transition_total
    || receipt.coverage_pct !== 100) fail('TRANSITION_RECEIPT_VERDICT');
  if (!SHA256.test(receipt.registry_sha256 || '') || !SHA256.test(receipt.integrity || '')) fail('TRANSITION_RECEIPT_HASH');
  const clean = structuredClone(receipt);
  delete clean.integrity;
  if (sha256(canonical(clean)) !== receipt.integrity) fail('TRANSITION_RECEIPT_INTEGRITY');
  return receipt;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--corpus', '--out'].includes(flag) || !value) fail('USAGE');
    args[flag.slice(2)] = value;
  }
  if (Object.keys(args).length !== 2) fail('USAGE');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpusPath = path.resolve(args.corpus);
  const output = path.resolve(args.out);
  if (fs.existsSync(output)) fail('OUTPUT_EXISTS', output);
  const receipt = verifyTransitionCorpus({ corpusPath });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  const observed = readJson(output, 'OUTPUT_READBACK').value;
  verifyTransitionCorpusReceipt(observed, { corpusBytes: fs.readFileSync(corpusPath) });
  process.stdout.write(`TRANSITION_CORPUS_PASS states=${receipt.state_count} transitions=${receipt.transition_covered}/${receipt.transition_total} receipt=${output}\n`);
}

const isMain = process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
if (isMain) main().catch((error) => {
  const message = error instanceof TransitionCorpusError ? error.message : `INTERNAL:${error.message}`;
  process.stderr.write(`TRANSITION_CORPUS_FAIL ${message}\n`);
  process.exitCode = error?.code === 'USAGE' ? 2 : 20;
});
