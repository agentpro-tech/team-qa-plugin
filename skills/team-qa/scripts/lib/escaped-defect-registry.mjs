import {
  fail,
  rejectUnknownFields,
  requireObject,
  sha256,
} from './core.mjs';
import { stable } from './release-truth.mjs';
import { trackedErrors } from './validators.mjs';

const LAYERS = ['qa-code', 'qa-gui', 'team-qa', 'team-code'];
const SHA256 = /^[a-f0-9]{64}$/;
const ROOT_FIELDS = ['schema', 'registry_id', 'source_revision', 'defects'];
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
  'schema', 'registry_sha256', 'tracked_input_sha256', 'tracked_output_sha256',
  'registry_id', 'source_revision', 'source_count', 'case_count', 'edge_total',
  'edge_covered', 'trace_pct', 'edges', 'execution_status', 'semantic_verdict',
  'created_at', 'integrity',
];

const nonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
export const canonical = (value) => JSON.stringify(stable(value));
const failBound = (code, detail) => fail(2, `${code}:${detail}`);

function requireFields(value, fields, code, context = '') {
  requireObject(value, code, context);
  rejectUnknownFields(value, fields, code, context);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (missing.length) fail(2, code.replace('UNKNOWN', 'MISSING'), [context, ...missing].filter(Boolean).join(' '));
}

function validateBinding(defect, binding, context) {
  requireFields(binding, BINDING_FIELDS, 'DEFECT_BINDING_UNKNOWN_FIELD', context);
  if (!LAYERS.includes(binding.layer)) fail(2, 'DEFECT_BINDING_LAYER', context);
  for (const field of ['case_id', 'requirement_id', 'fixture', 'positive_test', 'mutation_test', 'gate']) {
    if (!nonBlank(binding[field])) fail(2, 'DEFECT_BINDING_FIELD', `${context} ${field}`);
  }
  if (!['code', 'gui', 'machine', 'multi'].includes(binding.verification_lane)) fail(2, 'DEFECT_BINDING_LANE', context);
  if (!['static', 'behavioral'].includes(binding.case_kind)) fail(2, 'DEFECT_BINDING_KIND', context);
  for (const field of ['fixture_sha256', 'positive_test_sha256', 'mutation_test_sha256', 'gate_sha256']) {
    if (!SHA256.test(binding[field] || '')) fail(2, 'DEFECT_BINDING_HASH', `${context} ${field}`);
  }
}

export function validateEscapedDefectRegistry(registry) {
  requireFields(registry, ROOT_FIELDS, 'DEFECT_REGISTRY_UNKNOWN_FIELD');
  if (registry.schema !== 'agentpro/escaped-defect-registry/v1') fail(2, 'DEFECT_REGISTRY_SCHEMA');
  if (!nonBlank(registry.registry_id) || !nonBlank(registry.source_revision)) fail(2, 'DEFECT_REGISTRY_BINDING');
  if (!Array.isArray(registry.defects) || registry.defects.length === 0) fail(2, 'DEFECT_REGISTRY_EMPTY');
  const incidents = new Set();
  const cases = new Set();
  for (const defect of registry.defects) {
    requireFields(defect, DEFECT_FIELDS, 'DEFECT_UNKNOWN_FIELD');
    if (!nonBlank(defect.incident_id) || incidents.has(defect.incident_id)) fail(2, 'DEFECT_INCIDENT_ID', defect.incident_id ?? 'missing');
    incidents.add(defect.incident_id);
    for (const field of ['title', 'affected_component', 'escaped_gate', 'expected', 'observed', 'root_cause_class', 'owner']) {
      if (!nonBlank(defect[field])) fail(2, 'DEFECT_FIELD', `${defect.incident_id} ${field}`);
    }
    requireFields(defect.source, SOURCE_FIELDS, 'DEFECT_SOURCE_UNKNOWN_FIELD', defect.incident_id);
    if (!nonBlank(defect.source.kind) || !nonBlank(defect.source.ref) || !SHA256.test(defect.source.sha256 || '')) fail(2, 'DEFECT_SOURCE', defect.incident_id);
    if (!['P0', 'P1', 'P2'].includes(defect.severity)) fail(2, 'DEFECT_SEVERITY', defect.incident_id);
    if (!Array.isArray(defect.reproduction) || defect.reproduction.length === 0 || defect.reproduction.some((step) => !nonBlank(step))) fail(2, 'DEFECT_REPRODUCTION', defect.incident_id);
    if (!Array.isArray(defect.affected_layers) || defect.affected_layers.length === 0
      || new Set(defect.affected_layers).size !== defect.affected_layers.length
      || defect.affected_layers.some((layer) => !LAYERS.includes(layer))) fail(2, 'DEFECT_LAYERS', defect.incident_id);
    if (!Array.isArray(defect.regression_tests) || defect.regression_tests.length === 0) fail(2, 'DEFECT_REGRESSIONS', defect.incident_id);
    const bindingLayers = new Set();
    for (const binding of defect.regression_tests) {
      validateBinding(defect, binding, `${defect.incident_id}:${binding?.layer ?? 'missing'}`);
      if (bindingLayers.has(binding.layer)) fail(2, 'DEFECT_BINDING_LAYER_DUPLICATE', `${defect.incident_id}:${binding.layer}`);
      if (cases.has(binding.case_id)) failBound('COMPILE_CASE_DUPLICATE', binding.case_id);
      bindingLayers.add(binding.layer);
      cases.add(binding.case_id);
    }
    const affectedLayers = [...defect.affected_layers].sort();
    const boundLayers = [...bindingLayers].sort();
    if (canonical(boundLayers) !== canonical(affectedLayers)) failBound('DEFECT_LAYER_TRACE', defect.incident_id);
    if (!Array.isArray(defect.closure_evidence) || defect.closure_evidence.length === 0) fail(2, 'DEFECT_CLOSURE_EVIDENCE', defect.incident_id);
    for (const evidence of defect.closure_evidence) {
      requireFields(evidence, EVIDENCE_FIELDS, 'DEFECT_EVIDENCE_UNKNOWN_FIELD', defect.incident_id);
      if (!LAYERS.includes(evidence.layer) || !nonBlank(evidence.kind) || !nonBlank(evidence.path) || !SHA256.test(evidence.sha256 || '')) fail(2, 'DEFECT_EVIDENCE', defect.incident_id);
    }
  }
  return registry;
}

function sourceIdFor(incidentId) {
  return `SRC-ESCAPED-${incidentId}`;
}

function compiledCaseFor(defect, binding, sourceId) {
  return {
    id: binding.case_id,
    title: `${defect.title} [${binding.layer}]`,
    req_id: binding.requirement_id,
    sourceRefs: [sourceId],
    lane: binding.verification_lane,
    steps: structuredClone(defect.reproduction),
    expected: defect.expected,
    data: {
      incident_id: defect.incident_id,
      affected_component: defect.affected_component,
      escaped_gate: defect.escaped_gate,
      root_cause_class: defect.root_cause_class,
      layer: binding.layer,
      fixture: binding.fixture,
      positive_test: binding.positive_test,
      mutation_test: binding.mutation_test,
      gate: binding.gate,
    },
    priority: defect.severity,
    kind: binding.case_kind,
    taxonomy: binding.layer === 'qa-gui' ? ['state', 'regression'] : ['functional', 'regression'],
    states: binding.layer === 'qa-gui' ? ['partial', 'ideal'] : ['ideal'],
    viewports: binding.layer === 'qa-gui' ? ['mobile', 'desktop'] : ['desktop'],
  };
}

export function compileEscapedDefects(registry, trackedInput) {
  validateEscapedDefectRegistry(registry);
  const inputErrors = trackedErrors(trackedInput, { lock: null });
  if (inputErrors.length) fail(2, 'ESCAPED_DEFECT_TRACKED_INPUT', inputErrors.join(';'));
  if (trackedInput.schemaVersion !== 2) fail(2, 'ESCAPED_DEFECT_TRACKED_VERSION');
  const output = structuredClone(trackedInput);
  const sources = new Set(output.sourceItems.map((item) => item.id));
  const cases = new Set(output.cases.map((item) => item.id));
  for (const defect of registry.defects) {
    const sourceId = sourceIdFor(defect.incident_id);
    if (sources.has(sourceId)) failBound('COMPILE_SOURCE_DUPLICATE', sourceId);
    output.sourceItems.push({
      id: sourceId,
      kind: 'qa-derived',
      sourceSystem: 'escaped-defect-registry',
      externalKey: defect.incident_id,
      title: defect.title,
      origin: 'qa-derived',
      qaDerivedReason: `Escaped ${defect.escaped_gate}; root cause ${defect.root_cause_class}.`,
    });
    sources.add(sourceId);
    for (const binding of defect.regression_tests) {
      if (cases.has(binding.case_id)) failBound('COMPILE_CASE_DUPLICATE', binding.case_id);
      output.cases.push(compiledCaseFor(defect, binding, sourceId));
      cases.add(binding.case_id);
    }
  }
  const outputErrors = trackedErrors(output, { lock: null });
  if (outputErrors.length) fail(2, 'ESCAPED_DEFECT_TRACKED_OUTPUT', outputErrors.join(';'));
  return output;
}

function seal(value) {
  const clean = structuredClone(value);
  delete clean.integrity;
  return { ...clean, integrity: sha256(canonical(clean)) };
}

function assertOutputBytes(trackedOutput, trackedOutputBytes) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(trackedOutputBytes).toString('utf8')); } catch { fail(2, 'COMPILE_OUTPUT_JSON'); }
  if (canonical(parsed) !== canonical(trackedOutput)) fail(2, 'COMPILE_OUTPUT_BYTES');
}

export function createEscapedDefectCompileReceipt({
  registry,
  registryBytes,
  trackedInputBytes,
  trackedOutput,
  trackedOutputBytes,
  createdAt = new Date().toISOString(),
}) {
  validateEscapedDefectRegistry(registry);
  assertOutputBytes(trackedOutput, trackedOutputBytes);
  const edges = [];
  for (const defect of registry.defects) {
    const sourceId = sourceIdFor(defect.incident_id);
    for (const binding of defect.regression_tests) {
      const compiledCase = trackedOutput.cases.find((item) => item.id === binding.case_id);
      if (!compiledCase) failBound('COMPILE_CASE_MISSING', binding.case_id);
      if (compiledCase.sourceRefs.length !== 1 || compiledCase.sourceRefs[0] !== sourceId) failBound('COMPILE_CASE_SOURCE_REF', binding.case_id);
      if (compiledCase.req_id !== binding.requirement_id || compiledCase.data?.layer !== binding.layer) failBound('COMPILE_CASE_BINDING', binding.case_id);
      edges.push({
        incident_id: defect.incident_id,
        source_ref: sourceId,
        case_id: binding.case_id,
        layer: binding.layer,
        requirement_id: binding.requirement_id,
      });
    }
  }
  const edgeTotal = registry.defects.reduce((sum, defect) => sum + defect.regression_tests.length, 0);
  if (edges.length !== edgeTotal) fail(2, 'COMPILE_EDGE_COVERAGE');
  return seal({
    schema: 'team-qa/escaped-defect-compile-receipt/v1',
    registry_sha256: sha256(registryBytes),
    tracked_input_sha256: sha256(trackedInputBytes),
    tracked_output_sha256: sha256(trackedOutputBytes),
    registry_id: registry.registry_id,
    source_revision: registry.source_revision,
    source_count: registry.defects.length,
    case_count: edgeTotal,
    edge_total: edgeTotal,
    edge_covered: edges.length,
    trace_pct: edgeTotal === 0 ? 0 : Math.round((edges.length / edgeTotal) * 100),
    edges,
    execution_status: 'completed',
    semantic_verdict: 'PASS',
    created_at: createdAt,
  });
}

export function verifyEscapedDefectCompileReceipt(receipt, { registryBytes, trackedOutputBytes }) {
  requireFields(receipt, RECEIPT_FIELDS, 'COMPILE_RECEIPT_UNKNOWN_FIELD');
  if (receipt.schema !== 'team-qa/escaped-defect-compile-receipt/v1') fail(2, 'COMPILE_RECEIPT_SCHEMA');
  if (receipt.registry_sha256 !== sha256(registryBytes)) fail(2, 'COMPILE_RECEIPT_REGISTRY_HASH');
  if (receipt.tracked_output_sha256 !== sha256(trackedOutputBytes)) fail(2, 'COMPILE_RECEIPT_OUTPUT_HASH');
  if (receipt.execution_status !== 'completed' || receipt.semantic_verdict !== 'PASS'
    || receipt.edge_total < 1 || receipt.edge_covered !== receipt.edge_total || receipt.trace_pct !== 100) fail(2, 'COMPILE_RECEIPT_VERDICT');
  if (!SHA256.test(receipt.integrity || '')) fail(2, 'COMPILE_RECEIPT_INTEGRITY');
  const clean = structuredClone(receipt);
  delete clean.integrity;
  if (sha256(canonical(clean)) !== receipt.integrity) fail(2, 'COMPILE_RECEIPT_INTEGRITY');
  return receipt;
}
