#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACT_DIR = path.join(ROOT, 'contracts', 'escaped-defect-defense', 'v1');
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const ESCAPED_DEFECT_LAYERS = Object.freeze(['qa-code', 'qa-gui', 'team-qa', 'team-code']);
export const ESCAPED_DEFECT_CONTRACT_SHA256 = '5dde665f641a5a2d51e2307cd1b56902e7b0eb667787059edb59ee609dd72f32';

const REGISTRY_FIELDS = [
  'schema', 'registry_id', 'source_revision', 'defects',
];
const DEFECT_FIELDS = [
  'incident_id', 'title', 'source', 'affected_component', 'escaped_gate', 'severity',
  'reproduction', 'expected', 'observed', 'root_cause_class', 'affected_layers',
  'regression_tests', 'owner', 'closure_evidence',
];
const SOURCE_FIELDS = ['kind', 'ref', 'sha256'];
const BINDING_FIELDS = [
  'layer', 'case_id', 'requirement_id', 'verification_lane', 'case_kind',
  'fixture', 'positive_test', 'mutation_test', 'gate',
  'fixture_sha256', 'positive_test_sha256', 'mutation_test_sha256', 'gate_sha256',
];
const EVIDENCE_FIELDS = ['layer', 'kind', 'path', 'sha256'];
const RECEIPT_FIELDS = [
  'schema', 'contract_sha256', 'registry_sha256', 'root_map_sha256', 'registry_id',
  'source_revision', 'defect_count', 'binding_count', 'coverage_pct', 'layers',
  'defects', 'execution_status', 'semantic_verdict', 'created_at', 'integrity',
];

export class GateWiringError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}:${detail}` : code);
    this.code = code;
  }
}

const fail = (code, detail = '') => { throw new GateWiringError(code, detail); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function exactKeys(value, expected, code) {
  if (!object(value)) fail(code, 'OBJECT_REQUIRED');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonical(actual) !== canonical(wanted)) {
    const unknown = actual.filter((key) => !wanted.includes(key));
    const missing = wanted.filter((key) => !actual.includes(key));
    if (unknown.length) fail(code, unknown.join(','));
    fail(`${code.replace('UNKNOWN', 'MISSING')}`, missing.join(','));
  }
}

function readJsonBytes(file, code) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (error) { fail(code, error.message); }
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) }; } catch (error) { fail(`${code}_JSON`, error.message); }
}

export function readEscapedDefectContract() {
  const manifest = readJsonBytes(path.join(CONTRACT_DIR, 'CONTRACT.json'), 'CONTRACT_UNREADABLE').value;
  const observed = {};
  for (const name of fs.readdirSync(CONTRACT_DIR).filter((item) => item.endsWith('.schema.json')).sort()) {
    const bytes = fs.readFileSync(path.join(CONTRACT_DIR, name));
    const schema = JSON.parse(bytes.toString('utf8'));
    observed[schema.title] = sha256(bytes);
  }
  if (canonical(observed) !== canonical(manifest.schemas)) fail('CONTRACT_SCHEMA_HASH');
  if (sha256(canonical(observed)) !== manifest.contract_sha256) fail('CONTRACT_DIGEST');
  if (manifest.contract_sha256 !== ESCAPED_DEFECT_CONTRACT_SHA256) fail('CONTRACT_PIN');
  return manifest;
}

function assertString(value, code) {
  if (!nonBlank(value)) fail(code);
}

function assertSha(value, code) {
  if (!SHA256.test(value || '')) fail(code);
}

function safeRelative(value, code) {
  assertString(value, code);
  if (value.includes('\\') || path.isAbsolute(value) || value.split('/').includes('..') || path.posix.normalize(value) !== value || value === '.') fail(code);
}

export function validateEscapedDefectRegistry(registry) {
  exactKeys(registry, REGISTRY_FIELDS, 'REGISTRY_UNKNOWN_FIELD');
  if (registry.schema !== 'agentpro/escaped-defect-registry/v1') fail('REGISTRY_SCHEMA');
  assertString(registry.registry_id, 'REGISTRY_ID');
  assertString(registry.source_revision, 'REGISTRY_SOURCE_REVISION');
  if (!Array.isArray(registry.defects) || registry.defects.length === 0) fail('REGISTRY_DEFECTS_EMPTY');
  const incidentIds = new Set();
  const caseIds = new Set();
  for (const defect of registry.defects) {
    exactKeys(defect, DEFECT_FIELDS, 'DEFECT_UNKNOWN_FIELD');
    if (!TOKEN.test(defect.incident_id || '') || incidentIds.has(defect.incident_id)) fail('DEFECT_INCIDENT_ID', defect.incident_id || 'missing');
    incidentIds.add(defect.incident_id);
    for (const field of ['title', 'affected_component', 'escaped_gate', 'expected', 'observed', 'root_cause_class', 'owner']) assertString(defect[field], `DEFECT_FIELD:${defect.incident_id}:${field}`);
    exactKeys(defect.source, SOURCE_FIELDS, 'DEFECT_SOURCE_UNKNOWN_FIELD');
    assertString(defect.source.kind, `DEFECT_SOURCE_KIND:${defect.incident_id}`);
    assertString(defect.source.ref, `DEFECT_SOURCE_REF:${defect.incident_id}`);
    assertSha(defect.source.sha256, `DEFECT_SOURCE_SHA:${defect.incident_id}`);
    if (!['P0', 'P1', 'P2'].includes(defect.severity)) fail('DEFECT_SEVERITY', defect.incident_id);
    if (!Array.isArray(defect.reproduction) || defect.reproduction.length === 0 || defect.reproduction.some((step) => !nonBlank(step))) fail('DEFECT_REPRODUCTION', defect.incident_id);
    if (!Array.isArray(defect.affected_layers) || defect.affected_layers.length === 0
      || new Set(defect.affected_layers).size !== defect.affected_layers.length
      || defect.affected_layers.some((layer) => !ESCAPED_DEFECT_LAYERS.includes(layer))) fail('DEFECT_AFFECTED_LAYERS', defect.incident_id);
    if (!Array.isArray(defect.regression_tests) || defect.regression_tests.length === 0) fail('DEFECT_REGRESSIONS_EMPTY', defect.incident_id);
    const bindingLayers = new Set();
    for (const binding of defect.regression_tests) {
      exactKeys(binding, BINDING_FIELDS, 'BINDING_UNKNOWN_FIELD');
      if (!ESCAPED_DEFECT_LAYERS.includes(binding.layer) || bindingLayers.has(binding.layer)) fail('BINDING_LAYER', `${defect.incident_id}:${binding.layer || 'missing'}`);
      bindingLayers.add(binding.layer);
      for (const field of ['case_id', 'requirement_id']) assertString(binding[field], `BINDING_FIELD:${defect.incident_id}:${binding.layer}:${field}`);
      if (caseIds.has(binding.case_id)) fail('BINDING_CASE_DUPLICATE', binding.case_id);
      caseIds.add(binding.case_id);
      if (!['code', 'gui', 'machine', 'multi'].includes(binding.verification_lane)) fail('BINDING_LANE', `${defect.incident_id}:${binding.layer}`);
      if (!['static', 'behavioral'].includes(binding.case_kind)) fail('BINDING_CASE_KIND', `${defect.incident_id}:${binding.layer}`);
      for (const field of ['fixture', 'positive_test', 'mutation_test', 'gate']) safeRelative(binding[field], `BINDING_PATH_UNSAFE:${defect.incident_id}:${binding.layer}:${field}`);
      for (const field of ['fixture_sha256', 'positive_test_sha256', 'mutation_test_sha256', 'gate_sha256']) assertSha(binding[field], `BINDING_HASH:${defect.incident_id}:${binding.layer}:${field}`);
    }
    const affectedLayers = [...defect.affected_layers].sort();
    const boundLayers = [...bindingLayers].sort();
    if (canonical(boundLayers) !== canonical(affectedLayers)) fail('REGRESSION_LAYER_COVERAGE', defect.incident_id);
    if (!Array.isArray(defect.closure_evidence) || defect.closure_evidence.length === 0) fail('CLOSURE_EVIDENCE_EMPTY', defect.incident_id);
    for (const evidence of defect.closure_evidence) {
      exactKeys(evidence, EVIDENCE_FIELDS, 'CLOSURE_EVIDENCE_UNKNOWN_FIELD');
      if (!affectedLayers.includes(evidence.layer)) fail('CLOSURE_EVIDENCE_LAYER', `${defect.incident_id}:${evidence.layer || 'missing'}`);
      assertString(evidence.kind, `CLOSURE_EVIDENCE_KIND:${defect.incident_id}`);
      safeRelative(evidence.path, `CLOSURE_EVIDENCE_PATH_UNSAFE:${defect.incident_id}:${evidence.layer}`);
      assertSha(evidence.sha256, `CLOSURE_EVIDENCE_HASH:${defect.incident_id}:${evidence.layer}`);
    }
  }
  return registry;
}

function validateRootMap(rootMap) {
  exactKeys(rootMap, ['schema', 'roots'], 'ROOT_MAP_UNKNOWN_FIELD');
  if (rootMap.schema !== 'agentpro/escaped-defect-root-map/v1') fail('ROOT_MAP_SCHEMA');
  if (!object(rootMap.roots) || Object.keys(rootMap.roots).length === 0) fail('ROOT_MAP_EMPTY');
  for (const [layer, root] of Object.entries(rootMap.roots)) {
    if (!ESCAPED_DEFECT_LAYERS.includes(layer)) fail('ROOT_MAP_LAYER', layer);
    if (!path.isAbsolute(root || '')) fail('ROOT_MAP_ABSOLUTE', layer);
    let stat;
    try { stat = fs.statSync(fs.realpathSync(root)); } catch (error) { fail('ROOT_MAP_UNREADABLE', `${layer}:${error.message}`); }
    if (!stat.isDirectory()) fail('ROOT_MAP_DIRECTORY', layer);
  }
  return rootMap;
}

function boundFile(root, relative, code) {
  const rootReal = fs.realpathSync(root);
  const candidate = path.resolve(rootReal, relative);
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${path.sep}`)) fail(`${code}_OUTSIDE_ROOT`);
  let lstat;
  try { lstat = fs.lstatSync(candidate); } catch (error) { fail(`${code}_MISSING`, error.message); }
  if (lstat.isSymbolicLink() || !lstat.isFile()) fail(`${code}_NOT_REGULAR`);
  const real = fs.realpathSync(candidate);
  if (real !== candidate || !real.startsWith(`${rootReal}${path.sep}`)) fail(`${code}_SYMLINK`);
  return { path: real, bytes: fs.readFileSync(real) };
}

function seal(value) {
  const clean = structuredClone(value);
  delete clean.integrity;
  return { ...clean, integrity: sha256(canonical(clean)) };
}

export function inspectGateWiring({ registryPath, rootMapPath, createdAt = new Date().toISOString() }) {
  const contract = readEscapedDefectContract();
  const registryRead = readJsonBytes(path.resolve(registryPath), 'REGISTRY_UNREADABLE');
  const rootsRead = readJsonBytes(path.resolve(rootMapPath), 'ROOT_MAP_UNREADABLE');
  const registry = validateEscapedDefectRegistry(registryRead.value);
  const rootMap = validateRootMap(rootsRead.value);
  const summaries = [];
  const observedLayers = new Set();
  let bindingCount = 0;
  for (const defect of registry.defects) {
    const bindings = [];
    for (const binding of defect.regression_tests) {
      const root = rootMap.roots[binding.layer];
      if (!root) fail('ROOT_MAP_MISSING_LAYER', binding.layer);
      for (const [field, hashField] of [
        ['fixture', 'fixture_sha256'],
        ['positive_test', 'positive_test_sha256'],
        ['mutation_test', 'mutation_test_sha256'],
        ['gate', 'gate_sha256'],
      ]) {
        const { bytes } = boundFile(root, binding[field], `BINDING_FILE:${defect.incident_id}:${binding.layer}:${field}`);
        if (sha256(bytes) !== binding[hashField]) fail('BINDING_HASH_MISMATCH', `${defect.incident_id}:${binding.layer}:${field}`);
      }
      const gateSource = boundFile(root, binding.gate, `BINDING_GATE:${defect.incident_id}:${binding.layer}`).bytes.toString('utf8');
      if (!gateSource.includes(binding.positive_test)) fail('GATE_POSITIVE_UNWIRED', `${defect.incident_id}:${binding.layer}`);
      if (!gateSource.includes(binding.mutation_test)) fail('GATE_MUTATION_UNWIRED', `${defect.incident_id}:${binding.layer}`);
      observedLayers.add(binding.layer);
      bindingCount += 1;
      bindings.push({
        layer: binding.layer,
        case_id: binding.case_id,
        requirement_id: binding.requirement_id,
        fixture_sha256: binding.fixture_sha256,
        positive_test_sha256: binding.positive_test_sha256,
        mutation_test_sha256: binding.mutation_test_sha256,
        gate_sha256: binding.gate_sha256,
      });
    }
    for (const evidence of defect.closure_evidence) {
      const root = rootMap.roots[evidence.layer];
      if (!root) fail('ROOT_MAP_MISSING_LAYER', evidence.layer);
      const { bytes } = boundFile(root, evidence.path, `CLOSURE_EVIDENCE:${defect.incident_id}:${evidence.layer}`);
      if (sha256(bytes) !== evidence.sha256) fail('CLOSURE_EVIDENCE_HASH_MISMATCH', `${defect.incident_id}:${evidence.layer}`);
    }
    summaries.push({ incident_id: defect.incident_id, layers: [...defect.affected_layers], bindings });
  }
  const expectedBindings = registry.defects.reduce((sum, defect) => sum + defect.affected_layers.length, 0);
  const coveragePct = expectedBindings === 0 ? 0 : Math.round((bindingCount / expectedBindings) * 100);
  if (coveragePct !== 100) fail('GATE_WIRING_COVERAGE', String(coveragePct));
  return seal({
    schema: 'qa-code/gate-wiring-receipt/v1',
    contract_sha256: contract.contract_sha256,
    registry_sha256: sha256(registryRead.bytes),
    root_map_sha256: sha256(rootsRead.bytes),
    registry_id: registry.registry_id,
    source_revision: registry.source_revision,
    defect_count: registry.defects.length,
    binding_count: bindingCount,
    coverage_pct: coveragePct,
    layers: ESCAPED_DEFECT_LAYERS.filter((layer) => observedLayers.has(layer)),
    defects: summaries,
    execution_status: 'completed',
    semantic_verdict: 'PASS',
    created_at: createdAt,
  });
}

export function verifyGateWiringReceipt(receipt, { registryBytes, rootMapBytes }) {
  readEscapedDefectContract();
  exactKeys(receipt, RECEIPT_FIELDS, 'GATE_WIRING_RECEIPT_UNKNOWN_FIELD');
  if (receipt.schema !== 'qa-code/gate-wiring-receipt/v1') fail('GATE_WIRING_RECEIPT_SCHEMA');
  if (receipt.contract_sha256 !== ESCAPED_DEFECT_CONTRACT_SHA256) fail('GATE_WIRING_RECEIPT_CONTRACT');
  if (receipt.registry_sha256 !== sha256(registryBytes)) fail('GATE_WIRING_RECEIPT_REGISTRY_HASH');
  if (receipt.root_map_sha256 !== sha256(rootMapBytes)) fail('GATE_WIRING_RECEIPT_ROOT_MAP_HASH');
  if (receipt.execution_status !== 'completed' || receipt.semantic_verdict !== 'PASS' || receipt.coverage_pct !== 100) fail('GATE_WIRING_RECEIPT_VERDICT');
  if (!SHA256.test(receipt.integrity || '')) fail('GATE_WIRING_RECEIPT_INTEGRITY');
  const clean = structuredClone(receipt);
  delete clean.integrity;
  if (sha256(canonical(clean)) !== receipt.integrity) fail('GATE_WIRING_RECEIPT_INTEGRITY');
  return receipt;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--registry', '--roots', '--out'].includes(flag) || !value) fail('USAGE');
    values[flag.slice(2)] = value;
  }
  if (Object.keys(values).length !== 3) fail('USAGE');
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryPath = path.resolve(args.registry);
  const rootMapPath = path.resolve(args.roots);
  const output = path.resolve(args.out);
  if (fs.existsSync(output)) fail('OUTPUT_EXISTS', output);
  const receipt = inspectGateWiring({ registryPath, rootMapPath });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  const observed = readJsonBytes(output, 'OUTPUT_READBACK').value;
  verifyGateWiringReceipt(observed, {
    registryBytes: fs.readFileSync(registryPath),
    rootMapBytes: fs.readFileSync(rootMapPath),
  });
  process.stdout.write(`GATE_WIRING_PASS defects=${receipt.defect_count} bindings=${receipt.binding_count} coverage=${receipt.coverage_pct}% receipt=${output}\n`);
}

const isMain = process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
if (isMain) main().catch((error) => {
  const message = error instanceof GateWiringError ? error.message : `INTERNAL:${error.message}`;
  process.stderr.write(`GATE_WIRING_FAIL ${message}\n`);
  process.exitCode = error?.code === 'USAGE' ? 2 : 20;
});
