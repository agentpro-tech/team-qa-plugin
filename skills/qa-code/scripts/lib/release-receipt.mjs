import {verifyProviderExecutionEvidence} from './provider-execution.mjs';
import {verifyGate0SecretAdjudication} from './secret-adjudication.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  readContract as readReleaseTruthContract,
  readReleaseTruthContext,
} from './release-truth-v2.mjs';

export const QA_RECEIPT_SCHEMA = 'qa-code/receipt/v1';
export const QA_RECEIPT_V2_SCHEMA = 'qa-code/receipt/v2';
export const EXECUTION_STATUSES = ['completed', 'blocked', 'failed'];
export const SEMANTIC_VERDICTS = ['PASS', 'PASS-STATIC', 'FAIL', 'UNGRADED'];
export const RECEIPT_KEYS = [
  'schema',
  'run_uuid',
  'repo',
  'task_base',
  'head',
  'diff_sha256',
  'gate0_sha256',
  'execution_status',
  'semantic_verdict',
  'mode',
  'tier',
  'engine',
  'engine_vendor',
  'engine_injected',
  'tool_log',
  'requirement_coverage',
  'created_at',
  'integrity',
];
export const RECEIPT_V2_KEYS = [
  'schema',
  'contract_sha256',
  'run_uuid',
  'repo',
  'task_base',
  'source_revision',
  'head',
  'requirements_hash',
  'verification_lane',
  'execution_status',
  'semantic_verdict',
  'tier',
  'tampering',
  'skipped_layers',
  'atomic_coverage',
  'created_at',
  'integrity',
];

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function fileSha256(path) {
  return sha256(readFileSync(path));
}

export function sealObject(value) {
  const sealed = structuredClone(value);
  delete sealed.integrity;
  sealed.integrity = sha256(canonicalJson(sealed));
  return sealed;
}

export function verifyObjectIntegrity(value) {
  if (!isObject(value) || typeof value.integrity !== 'string') return false;
  const unsealed = structuredClone(value);
  const expected = unsealed.integrity;
  delete unsealed.integrity;
  return /^[0-9a-f]{64}$/.test(expected) && sha256(canonicalJson(unsealed)) === expected;
}

export function engineVendor(engine) {
  const value = String(engine || '').trim().toLowerCase();
  if (/grok|xai|x\.ai/.test(value)) return 'xai';
  if (/claude|sonnet|opus|haiku|anthropic/.test(value)) return 'anthropic';
  if (/codex|gpt|openai|o[134](?:-|$)/.test(value)) return 'openai';
  if (/gemini|google/.test(value)) return 'google';
  if (/ollama|llama|mistral|qwen/.test(value)) return 'local';
  return 'unknown';
}

function git(repo, args, encoding = 'utf8') {
  return spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repo,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function resolveCommit(repo, ref) {
  const result = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return result.status === 0 && !result.error ? result.stdout.trim() : null;
}

export function diffSha256(repo, base, head) {
  const result = git(repo, [
    'diff', '--no-color', '--no-ext-diff', '--no-renames', base, head, '--',
  ], 'buffer');
  if (result.status !== 0 || result.error) {
    throw new Error(result.stderr?.toString('utf8').trim() || 'cannot build the diff to hash');
  }
  return sha256(result.stdout);
}

export function requirementCoverage(gate0) {
  const coverage = gate0?.requirement_coverage;
  if (isObject(coverage)) {
    return {
      covered: Number.isInteger(coverage.covered) ? coverage.covered : 0,
      total: Number.isInteger(coverage.total) ? coverage.total : 0,
      ids: Array.isArray(coverage.ids) ? [...coverage.ids] : [],
    };
  }
  const requirements = Array.isArray(gate0?.acceptance?.requirements)
    ? gate0.acceptance.requirements
    : [];
  return { covered: 0, total: requirements.length, ids: [] };
}

export function parseGrokToolLog(text) {
  const calls = new Map();
  for (const line of String(text || '').split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); }
    catch { continue; }
    const update = event?.params?.update;
    if (update?.sessionUpdate === 'tool_call') {
      calls.set(update.toolCallId, {
        tool: String(update.title || 'unknown'),
        rawInput: update.rawInput || {},
        status: 'started',
      });
    } else if (update?.sessionUpdate === 'tool_call_update' && calls.has(update.toolCallId)) {
      const call = calls.get(update.toolCallId);
      if (typeof update.status === 'string') call.status = update.status;
      if (update.rawInput && Object.keys(call.rawInput).length === 0) call.rawInput = update.rawInput;
    }
  }
  const log = [];
  for (const call of calls.values()) {
    const input = call.rawInput || {};
    if (['todo_write', 'plan', 'think'].includes(call.tool)) continue;
    const command = input.command || input.cmd;
    const pathValue = input.target_file || input.path || input.file_path;
    let kind = 'other';
    if (pathValue || /read|search|grep|glob/i.test(call.tool)) kind = 'read';
    if (command || /terminal|shell|command|bash/i.test(call.tool)) {
      kind = /(?:^|\s)(?:npm|pnpm|yarn|node|python|pytest|go|cargo)\s+(?:test|--test)|pytest|npm\s+t(?:est)?\b/i.test(String(command || '')) ? 'test' : 'command';
    }
    log.push({
      tool: call.tool,
      kind,
      ...(command ? { command: redactToolEvidence(command) } : {}),
      ...(pathValue ? { path: redactToolEvidence(pathValue) } : {}),
      status: call.status,
    });
  }
  return log;
}

function redactToolEvidence(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(Bearer)\s+\S+/gi, '$1 <redacted>')
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1<redacted>')
    .replace(/(--(?:password|token|secret|api-key|api_key)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1<redacted>')
    .replace(/([?&](?:password|token|secret|api[_-]?key)=)[^&\s]+/gi, '$1<redacted>')
    .slice(0, 2048);
}

export function createQaReceipt({
  gate0,
  gate0Path,
  repo,
  taskBase,
  head,
  executionStatus,
  semanticVerdict,
  mode,
  engine,
  engineInjected,
  toolLog,
  providerExecution = null,
  tampering = false,
  createdAt = new Date().toISOString(),
}) {
  const repoReal = realpathSync(repo);
  if (gate0?.contract_sha256 && gate0?.verification_lane === 'code') {
    const gate0Real = realpathSync(gate0Path);
    const gate0Sha = fileSha256(gate0Real);
    const mappings = new Map((gate0.acceptance?.requirements ?? []).map((item) => [
      `${item.requirement_id || item.id}\u0000${item.assertion_id || item.id}`,
      item,
    ]));
    const atomicCoverage = (gate0.acceptance?.results ?? []).map((result) => {
      const requirementId = result.requirement_id || result.id;
      const assertionId = result.assertion_id || result.id;
      const mapping = mappings.get(`${requirementId}\u0000${assertionId}`);
      const checks = mapping
        ? [...new Set([
          ...(mapping.mode === 'preservation' ? (mapping.preservation ?? []) : (mapping.fail_to_pass ?? [])),
          ...(mapping.pass_to_pass ?? []),
        ])]
        : [assertionId];
      const primary = result.mode === 'preservation' ? result.preservation : result.fail_to_pass;
      return {
        requirement_id: requirementId,
        assertion_id: assertionId,
        case_id: result.case_id || mapping?.case_id,
        test_or_check: checks.join(','),
        evidence_ref: gate0Real,
        evidence_sha256: gate0Sha,
        result: result.covered ? 'PASS'
          : [primary, result.pass_to_pass].some((group) => Object.values(group ?? {}).some((item) => item?.outcome === 'ungraded'))
            ? 'UNGRADED' : 'FAIL',
      };
    });
    const skippedLayers = Object.entries(gate0.layers ?? {})
      .filter(([, layer]) => layer?.status === 'skipped')
      .map(([layer, value]) => {
        const reason = (value.notes ?? []).find((item) => typeof item === 'string' && item.trim());
        return { layer, reason: reason || `UNLOCKED_SKIP_REASON:${layer}` };
      });
    const hasUnlockedSkip = skippedLayers.some((item) => item.reason.startsWith('UNLOCKED_SKIP_REASON:'));
    let v2Verdict = semanticVerdict === 'PASS-STATIC' ? 'UNGRADED' : semanticVerdict;
    if (!['PASS', 'FAIL', 'UNGRADED'].includes(v2Verdict)) v2Verdict = 'UNGRADED';
    if (executionStatus !== 'completed' || tampering || hasUnlockedSkip) v2Verdict = 'UNGRADED';
    const value = {
      schema: QA_RECEIPT_V2_SCHEMA,
      contract_sha256: gate0.contract_sha256,
      run_uuid: gate0.run_uuid,
      repo: repoReal,
      task_base: taskBase,
      source_revision: gate0.source_revision,
      head,
      requirements_hash: gate0.requirements_hash,
      verification_lane: 'code',
      execution_status: executionStatus,
      semantic_verdict: v2Verdict,
      tier: atomicCoverage.length === 0 ? 'ZERO' : (mode === 'tools' ? 'FULL' : 'LITE'),
      tampering: Boolean(tampering),
      skipped_layers: skippedLayers,
      atomic_coverage: atomicCoverage,
      ...(providerExecution ? {provider_execution:providerExecution} : {}),
      ...(providerExecution?.attestation ? {dispatch_proof:providerExecution.attestation} : {}),
      created_at: createdAt,
    };
    const receipt = sealObject(value);
    const errors = validateQaReceipt(receipt);
    if (errors.length > 0) throw new Error(`cannot create a valid qa-code receipt v2: ${errors.join('; ')}`);
    return receipt;
  }
  const value = {
    schema: QA_RECEIPT_SCHEMA,
    run_uuid: gate0.run_uuid,
    repo: repoReal,
    task_base: taskBase,
    head,
    diff_sha256: diffSha256(repoReal, taskBase, head),
    gate0_sha256: fileSha256(gate0Path),
    execution_status: executionStatus,
    semantic_verdict: semanticVerdict,
    mode,
    tier: mode === 'tools' ? 'FULL' : 'STATIC',
    engine,
    engine_vendor: engineVendor(engine),
    engine_injected: Boolean(engineInjected),
    tool_log: Array.isArray(toolLog) ? toolLog : [],
    ...(providerExecution ? {provider_execution:providerExecution} : {}),
    ...(providerExecution?.attestation ? {dispatch_proof:providerExecution.attestation} : {}),
    requirement_coverage: requirementCoverage(gate0),
    created_at: createdAt,
  };
  const receipt = sealObject(value);
  const errors = validateQaReceipt(receipt);
  if (errors.length > 0) throw new Error(`cannot create a valid qa-code receipt: ${errors.join('; ')}`);
  return receipt;
}

function validateToolLog(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isObject(item) || typeof item.tool !== 'string' || !item.tool.trim()) {
      errors.push(`${path}[${index}] is missing tool`);
      continue;
    }
    if (!['read', 'command', 'test', 'other'].includes(item.kind)) {
      errors.push(`${path}[${index}].kind is invalid`);
    }
    const allowed = new Set(['tool', 'kind', 'command', 'path', 'status','server']);
    for (const key of Object.keys(item)) {
      if (!allowed.has(key)) errors.push(`${path}[${index}] has unknown field ${key}`);
    }
  }
}

function validateQaReceiptV1Structure(value) {
  const errors = [];
  if (!isObject(value)) return ['receipt must be an object'];
  const allowed = new Set([...RECEIPT_KEYS,'provider_execution','dispatch_proof']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`unknown field: ${key}`);
  }
  for (const key of RECEIPT_KEYS) {
    if (!Object.hasOwn(value, key)) errors.push(`missing field: ${key}`);
  }
  if (value.schema !== QA_RECEIPT_SCHEMA) errors.push('schema is not qa-code/receipt/v1');
  if (typeof value.run_uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.run_uuid)) errors.push('run_uuid is invalid');
  for (const key of ['task_base', 'head']) {
    if (typeof value[key] !== 'string' || !/^[0-9a-f]{40}$/.test(value[key])) errors.push(`${key} must be a full SHA`);
  }
  for (const key of ['diff_sha256', 'gate0_sha256', 'integrity']) {
    if (typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key])) errors.push(`${key} must be a SHA-256`);
  }
  if (!EXECUTION_STATUSES.includes(value.execution_status)) errors.push('execution_status is invalid');
  if (!SEMANTIC_VERDICTS.includes(value.semantic_verdict)) errors.push('semantic_verdict is invalid');
  if (!['tools', 'static'].includes(value.mode)) errors.push('mode is invalid');
  if (!['FULL', 'STATIC'].includes(value.tier)) errors.push('tier is invalid');
  if (typeof value.engine !== 'string' || !value.engine.trim()) errors.push('engine is missing');
  if (typeof value.engine_vendor !== 'string' || !value.engine_vendor.trim()) errors.push('engine_vendor is missing');
  if (typeof value.engine_injected !== 'boolean') errors.push('engine_injected must be a bool');
  validateToolLog(value.tool_log, 'tool_log', errors);
  if (value.mode === 'tools' && value.tier !== 'FULL') errors.push('mode tools requires tier FULL');
  if (value.mode === 'static' && value.tier !== 'STATIC') errors.push('mode static requires tier STATIC');
  if (typeof value.engine === 'string' && value.engine_vendor !== engineVendor(value.engine)) {
    errors.push('engine_vendor does not match engine');
  }
  if (value.semantic_verdict === 'PASS' && value.mode !== 'tools') errors.push('PASS requires mode tools');
  if (value.semantic_verdict === 'PASS-STATIC' && value.mode !== 'static') errors.push('PASS-STATIC requires mode static');
  if (value.semantic_verdict === 'PASS' && value.mode === 'tools'
    && Array.isArray(value.tool_log) && value.tool_log.length === 0) {
    errors.push('PASS tools requires a non-empty tool_log');
  }
  const coverage = value.requirement_coverage;
  if (!isObject(coverage)
    || !Number.isInteger(coverage.covered)
    || !Number.isInteger(coverage.total)
    || coverage.covered < 0
    || coverage.total < coverage.covered
    || !Array.isArray(coverage.ids)
    || coverage.ids.some((id) => typeof id !== 'string' || !id.trim())) {
    errors.push('requirement_coverage is invalid');
  } else {
    for (const key of Object.keys(coverage)) {
      if (!['covered', 'total', 'ids'].includes(key)) errors.push(`requirement_coverage has unknown field ${key}`);
    }
  }
  if (typeof value.created_at !== 'string' || Number.isNaN(Date.parse(value.created_at))) errors.push('created_at is invalid');
  return errors;
}

function validateExactKeys(value, keys, errors) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`unknown field: ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) errors.push(`missing field: ${key}`);
  }
}

function validateQaReceiptV2Structure(value) {
  const errors = [];
  validateExactKeys(value, [...RECEIPT_V2_KEYS,...(value.provider_execution?['provider_execution']:[]),...(value.dispatch_proof?['dispatch_proof']:[])], errors);
  if (value.schema !== QA_RECEIPT_V2_SCHEMA) errors.push('schema is not qa-code/receipt/v2');
  if (typeof value.contract_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.contract_sha256)) errors.push('contract_sha256 must be a SHA-256');
  if (typeof value.run_uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.run_uuid)) errors.push('run_uuid is invalid');
  if (typeof value.repo !== 'string' || !value.repo.trim()) errors.push('repo is missing');
  for (const key of ['task_base', 'head']) {
    if (typeof value[key] !== 'string' || !/^[0-9a-f]{40}$/.test(value[key])) errors.push(`${key} must be a full SHA`);
  }
  if (typeof value.source_revision !== 'string' || !value.source_revision.trim()) errors.push('source_revision is missing');
  if (typeof value.requirements_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.requirements_hash)) errors.push('requirements_hash must be a SHA-256');
  if (value.verification_lane !== 'code') errors.push('verification_lane must be code');
  if (!EXECUTION_STATUSES.includes(value.execution_status)) errors.push('execution_status is invalid');
  if (!['PASS', 'FAIL', 'UNGRADED'].includes(value.semantic_verdict)) errors.push('semantic_verdict v2 is invalid');
  if (!['ZERO', 'LITE', 'FULL'].includes(value.tier)) errors.push('tier v2 is invalid');
  if (typeof value.tampering !== 'boolean') errors.push('tampering must be a bool');
  if (!Array.isArray(value.skipped_layers)) {
    errors.push('skipped_layers must be an array');
  } else {
    for (const [index, item] of value.skipped_layers.entries()) {
      if (!isObject(item)) {
        errors.push(`skipped_layers[${index}] must be an object`);
        continue;
      }
      validateExactKeys(item, ['layer', 'reason'], errors);
      if (typeof item.layer !== 'string' || !item.layer.trim()) errors.push(`skipped_layers[${index}].layer is missing`);
      if (typeof item.reason !== 'string' || !item.reason.trim()) errors.push(`skipped_layers[${index}].reason is missing`);
    }
  }
  if (!Array.isArray(value.atomic_coverage)) {
    errors.push('atomic_coverage must be an array');
  } else {
    const assertionIds = new Set();
    for (const [index, row] of value.atomic_coverage.entries()) {
      if (!isObject(row)) {
        errors.push(`atomic_coverage[${index}] must be an object`);
        continue;
      }
      const keys = ['requirement_id', 'assertion_id', 'case_id', 'test_or_check', 'evidence_ref', 'evidence_sha256', 'result'];
      const rowErrors = [];
      validateExactKeys(row, keys, rowErrors);
      errors.push(...rowErrors.map((item) => `atomic_coverage[${index}]: ${item}`));
      for (const key of ['requirement_id', 'assertion_id', 'case_id', 'test_or_check', 'evidence_ref']) {
        if (typeof row[key] !== 'string' || !row[key].trim()) errors.push(`atomic_coverage[${index}].${key} is missing`);
      }
      if (assertionIds.has(row.assertion_id)) errors.push(`atomic_coverage duplicate assertion_id: ${row.assertion_id}`);
      assertionIds.add(row.assertion_id);
      if (typeof row.evidence_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.evidence_sha256)) errors.push(`atomic_coverage[${index}].evidence_sha256 is invalid`);
      if (!['PASS', 'FAIL', 'UNGRADED'].includes(row.result)) errors.push(`atomic_coverage[${index}].result is invalid`);
    }
  }
  if (typeof value.created_at !== 'string' || Number.isNaN(Date.parse(value.created_at))) errors.push('created_at is invalid');
  if (typeof value.integrity !== 'string' || !/^[0-9a-f]{64}$/.test(value.integrity)) errors.push('integrity must be a SHA-256');
  if (value.execution_status !== 'completed' && value.semantic_verdict !== 'UNGRADED') errors.push('a receipt that is not completed must be UNGRADED');
  if (value.tampering === true && value.semantic_verdict !== 'UNGRADED') errors.push('tampering requires UNGRADED');
  if (value.semantic_verdict === 'PASS' && value.tier !== 'FULL') errors.push('PASS v2 requires tier FULL');
  if (value.semantic_verdict === 'PASS' && Array.isArray(value.atomic_coverage)
    && value.atomic_coverage.some((row) => row?.result !== 'PASS')) errors.push('PASS v2 requires every atomic coverage row to PASS');
  return errors;
}

export function validateQaReceiptStructure(value) {
  if (!isObject(value)) return ['receipt must be an object'];
  if (value.schema === QA_RECEIPT_V2_SCHEMA) return validateQaReceiptV2Structure(value);
  if (value.schema === QA_RECEIPT_SCHEMA) return validateQaReceiptV1Structure(value);
  return [`unsupported qa-code schema: ${value.schema || 'missing'}`];
}

export function validateQaReceipt(value) {
  const errors = validateQaReceiptStructure(value);
  if (!verifyObjectIntegrity(value)) errors.push('integrity does not match');
  if(value?.schema===QA_RECEIPT_SCHEMA && ['PASS','PASS-STATIC'].includes(value.semantic_verdict) && ['openai','anthropic'].includes(engineVendor(value.engine)) && !value.provider_execution)errors.push('PROVIDER_EXECUTION_REQUIRED');
  if(value?.provider_execution && ['PASS','PASS-STATIC'].includes(value.semantic_verdict)) {
    const execution=value.provider_execution;
    const {errors:providerErrors,parsed}=verifyProviderExecutionEvidence(execution,{mode:value.mode || (value.tier==='FULL'?'tools':'static')});
    errors.push(...providerErrors);
    if(value.schema===QA_RECEIPT_SCHEMA && (value.engine!==execution.sent?.model || value.engine_vendor!==execution.provider))errors.push('PROVIDER_ENGINE_MISMATCH');
    if(value.dispatch_proof && canonicalJson(value.dispatch_proof)!==canonicalJson(execution.attestation))errors.push('PROVIDER_DISPATCH_PROOF_MISMATCH');
    if(parsed && value.schema===QA_RECEIPT_SCHEMA && canonicalJson(parsed.tool_log)!==canonicalJson(value.tool_log))errors.push('PROVIDER_TOOL_LOG_MISMATCH');
    if(value.engine_injected)errors.push('PROVIDER_ENGINE_INJECTED');
  }
  return errors;
}

export function verifyQaReceiptBindings(receipt, { gate0 = null, gate0Path = null, repo = null, base = null } = {}) {
  if (receipt?.schema === QA_RECEIPT_V2_SCHEMA) {
    const errors = validateQaReceipt(receipt);
    let contract;
    try { contract = readReleaseTruthContract(); }
    catch (error) { errors.push(error.message); }
    if (contract && receipt.contract_sha256 !== contract.contract_sha256) errors.push('CONTRACT_SHA_MISMATCH');
    if (!gate0 || !gate0Path) errors.push('GATE0_REQUIRED_V2');
    if (gate0) {
      try {verifyGate0SecretAdjudication(gate0);} catch(error) {errors.push(error.message);}
      if (!verifyObjectIntegrity(gate0)) errors.push('gate0 integrity does not match');
      if (gate0.run_uuid !== receipt.run_uuid) errors.push('run_uuid does not bind gate0');
      if (gate0.repo !== receipt.repo) errors.push('repo does not bind gate0');
      if (gate0.base !== receipt.task_base) errors.push('task_base does not bind gate0');
      if (gate0.commit !== receipt.head) errors.push('head does not bind gate0');
      if (gate0.contract_sha256 !== receipt.contract_sha256) errors.push('contract_sha256 does not bind gate0');
      if (gate0.requirements_hash !== receipt.requirements_hash) errors.push('requirements_hash does not bind gate0');
      if (gate0.source_revision !== receipt.source_revision) errors.push('source_revision does not bind gate0');
      if (gate0.verification_lane !== receipt.verification_lane) errors.push('verification_lane does not bind gate0');
    }

    let context = null;
    if (!repo || !base) {
      errors.push('REPO_AND_BASE_REQUIRED_V2');
    } else {
      try {
        const repoReal = realpathSync(repo);
        const currentHead = resolveCommit(repoReal, 'HEAD');
        const taskBase = resolveCommit(repoReal, base);
        if (repoReal !== receipt.repo) errors.push('repo does not match the receipt');
        if (currentHead !== receipt.head) errors.push('RECEIPT_STALE');
        if (taskBase !== receipt.task_base) errors.push('--base does not match the receipt');
        if (!gate0?.requirements?.path) {
          errors.push('REQUIREMENTS_GRAPH_REQUIRED_V2');
        } else {
          context = readReleaseTruthContext(gate0.requirements.path, {
            repo: repoReal,
            taskBase: receipt.task_base,
            lane: 'code',
          });
          if (context.requirementsHash !== receipt.requirements_hash) errors.push('REQUIREMENTS_HASH_MISMATCH');
          if (context.graph.source_revision !== receipt.source_revision) errors.push('SOURCE_REVISION_MISMATCH');
          if (gate0.requirements.sha256 !== context.requirementsHash) errors.push('GATE_REQUIREMENTS_HASH_MISMATCH');
        }
      } catch (error) {
        errors.push(error.message);
      }
    }

    const expectedIds = context?.codeIds ?? (Array.isArray(gate0?.requirements?.code_ids) ? gate0.requirements.code_ids : []);
    const coveredIds = new Set((receipt.atomic_coverage ?? []).map((row) => row.requirement_id));
    const missing = expectedIds.filter((id) => !coveredIds.has(id));
    if (missing.length > 0) errors.push(`ATOMIC_COVERAGE_MISSING:${missing.join(',')}`);
    const gateAssertions = new Set((gate0?.acceptance?.results ?? []).map((row) => `${row.requirement_id || row.id}\u0000${row.case_id || ''}\u0000${row.assertion_id || row.id}`));
    const acceptedCasesByRequirement = new Map((context?.codeRequirements ?? []).map((requirement) => [
      requirement.id,
      new Set(requirement.acceptance_ids),
    ]));
    for (const row of receipt.atomic_coverage ?? []) {
      if (gateAssertions.size > 0 && !gateAssertions.has(`${row.requirement_id}\u0000${row.case_id}\u0000${row.assertion_id}`)) {
        errors.push(`ATOMIC_ASSERTION_NOT_IN_GATE:${row.requirement_id}:${row.case_id}:${row.assertion_id}`);
      }
      const acceptedCases = acceptedCasesByRequirement.get(row.requirement_id) ?? new Set();
      if (!acceptedCases.has(row.case_id)) errors.push(`ATOMIC_CASE_NOT_IN_REQUIREMENT:${row.requirement_id}:${row.case_id}`);
      try {
        const candidate = isAbsolute(row.evidence_ref)
          ? row.evidence_ref
          : resolve(repo ? realpathSync(repo) : process.cwd(), row.evidence_ref);
        if (!existsSync(candidate)) {
          errors.push(`ATOMIC_EVIDENCE_MISSING:${row.evidence_ref}`);
          continue;
        }
        const stat = lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          errors.push(`ATOMIC_EVIDENCE_NOT_REGULAR:${row.evidence_ref}`);
          continue;
        }
        if (fileSha256(candidate) !== row.evidence_sha256) errors.push(`ATOMIC_EVIDENCE_HASH_MISMATCH:${row.evidence_ref}`);
      } catch (error) {
        errors.push(`ATOMIC_EVIDENCE_UNREADABLE:${row.evidence_ref}:${error.message}`);
      }
    }
    return [...new Set(errors)];
  }
  const errors = validateQaReceipt(receipt);
  if (gate0Path && fileSha256(gate0Path) !== receipt.gate0_sha256) errors.push('gate0_sha256 does not match the gate0.json bytes');
  if (gate0) {
    try {verifyGate0SecretAdjudication(gate0);} catch(error) {errors.push(error.message);}
    if (!verifyObjectIntegrity(gate0)) errors.push('gate0 integrity does not match');
    if (gate0.run_uuid !== receipt.run_uuid) errors.push('run_uuid does not bind gate0');
    if (gate0.repo !== receipt.repo) errors.push('repo does not bind gate0');
    if (gate0.base !== receipt.task_base) errors.push('task_base does not bind gate0');
    if (gate0.commit !== receipt.head) errors.push('head does not bind gate0');
  }
  if (repo) {
    const repoReal = realpathSync(repo);
    const head = resolveCommit(repoReal, 'HEAD');
    const taskBase = resolveCommit(repoReal, base || receipt.task_base);
    if (repoReal !== receipt.repo) errors.push('repo does not match the receipt');
    if (head !== receipt.head) errors.push('HEAD does not match the receipt');
    if (taskBase !== receipt.task_base) errors.push('--base does not match the receipt');
    if (head && taskBase && diffSha256(repoReal, taskBase, head) !== receipt.diff_sha256) errors.push('diff_sha256 does not match');
  }
  return errors;
}
