#!/usr/bin/env node
import {integrityFor} from './lib/release-truth.mjs';
import {verifyPlanUserEvent} from './lib/roster.mjs';
import { preparePlanPresentation, loadPlanPresentation, assertPlanPresented } from './lib/chat-presentation.mjs';
import { assertToolPreflight } from './lib/tool-preflight.mjs';
import {createCurrentTeamQaReceipt,verifyCurrentTeamQaReceipt} from './lib/current-run-receipt.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TeamQAError,
  appendConfirmed,
  appendScrollLedger,
  confirmExternalEffect,
  emit,
  expandPath,
  fail,
  outputJson,
  parseFlags,
  parseJson,
  readJson,
  readText,
  rejectUnknownFields,
  requireObject,
  runAdapter,
  runEntrypoint,
  safeRunId,
  sha256,
  sha256File,
  stableJson,
  writeConfirmed,
} from './lib/core.mjs';
import { probeLiveCapabilities } from './lib/capability.mjs';
import { anchorChildSkillPaths } from './lib/install-layout.mjs';
import { runChildCanary } from './lib/child-canary.mjs';
import { childVerdictIssue } from './lib/child-verdict.mjs';
import { assertWebBinding, isDeployedTarget, WEB_CONTRACT_SHA256 } from './lib/deployed-target.mjs';
import { dualVerdictIssue } from './lib/dual-verdict.mjs';
import { attemptHistoryIssue, attemptId, attemptSequenceIssue, effectiveAttempt, latestAttemptByCase } from './lib/attempt-sequence.mjs';
import { failureSeparationIssue, isProductFailure, separateFailures } from './lib/failure-separation.mjs';
import {
  childGateLedger,
  groundedIssue,
  issueReasons,
  redCheckerLedger,
} from './lib/report-integrity.mjs';
import {
  reportTarget,
  resolveTargetLock,
  targetConflict,
  targetIdentityIssue,
} from './lib/target-lock.mjs';
import {
  boardRecordErrors,
  evidenceIssue,
  loadBoard,
  loadPlan,
  loadTracked,
  markers,
  parseReport,
  planErrors,
  trackedErrors,
} from './lib/validators.mjs';
import {
  boardApply as teamworkBoardApply,
  boardIntegrityVerify as teamworkBoardIntegrityVerify,
  boardInit as teamworkBoardInit,
  boardOpen as teamworkBoardOpen,
  boardPrepare as teamworkBoardPrepare,
  boardComparePage as teamworkBoardComparePage,
  boardRender as teamworkBoardRender,
  boardSync as teamworkBoardSync,
  boardValidate as teamworkBoardValidate,
  boardAudit as teamworkBoardAudit,
  boardPublish as teamworkBoardPublish,
  boardPublishNext as teamworkBoardPublishNext,
  rootTranscript,
} from './board-teamwork.mjs';
import { auditBoardWrites, plansOf } from './lib/board-notion.mjs';
import { selectRetestCases } from './lib/retest-scope.mjs';
import { collectRunSecrets, countSecretsInText, scanRunOutputs } from './lib/test-secrets.mjs';
import { costMarkdown } from './lib/cost.mjs';
import { runTiming, timingMarkdown } from './lib/timing.mjs';
import { APP_MAP_FILE, COVERAGE_CELLS_VERSION, COVERAGE_MAP_FILE, EXPLORATION_POLICY_FILE, buildCoverageMap, coverageMapText, coverageMarkdown, explorationPolicy } from './lib/coverage-cells.mjs';
import { claudeProjectsRoot } from './lib/host-transcript.mjs';
import { adjudicationMarkdown, adjudicationOverlay, adjudicationReportField } from './lib/adjudicator.mjs';
import { RTM_EMPTY, RTM_REQUIREMENT, hasRtmEmpty, isRtmEmpty, isRtmRequirementHeaderLine, rtmRequirementIndex } from './lib/report-tokens.mjs';
import { assertRunContract, assertArtifactPath, lockRunDocuments, transitionRun } from './lib/run-contract.mjs';
import { boardDeliverySummary, deliveryPath, recordBlockedBoardDelivery } from './lib/board-delivery.mjs';
import {
  CONTRACT_SHA256,
  createTeamQaReceipt,
  readContract,
  rtmStats,
  verifyTeamQaReceipt,
} from './lib/release-truth.mjs';
import {
  createReliabilityHandoff,
  verifyJobCapsuleForHandoff,
  verifyReliabilityHandoff,
  verifyTeamCodeHandoffAck,
} from './lib/reliability-handoff.mjs';
import {
  SOURCE_TRACEABILITY_VERSION,
  TRACKED_PLAN_SCHEMA_VERSION,
  migrateTrackedSourceTraceability,
  sameSourceRefs,
  sourceTraceabilityRows,
} from './lib/source-traceability.mjs';
import {
  compileEscapedDefects,
  createEscapedDefectCompileReceipt,
  verifyEscapedDefectCompileReceipt,
} from './lib/escaped-defect-registry.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROLE_IDS = ['test_manager', 'analyst', 'designer', 'executor_gui', 'executor_code', 'coverage_gate'];
const ROLE_ROOT_FIELDS = ['schema_version', 'roles', 'engines', 'role_tools', 'mirror', 'skills', 'scroll', 'target'];

function validationFailure(errors, exitCode = 2) {
  if (errors.length === 0) return true;
  for (const error of errors) emit('fail', error);
  process.exitCode = exitCode;
  return false;
}

function assertValid(errors) {
  if (errors.length === 0) return;
  const [code, ...detail] = errors[0].split(' ');
  fail(2, code, detail.join(' '));
}

function configPath() {
  return process.env.TEAMQA_ROLES
    ? expandPath(process.env.TEAMQA_ROLES)
    : join(process.cwd(), 'roles.json');
}

function loadConfig() {
  const path = configPath();
  const value = readJson(path, { label: 'roles.json', invalidCode: 'ROLES_JSON_INVALID' });
  requireObject(value, 'ROLES_TYPE', 'root');
  rejectUnknownFields(value, ROLE_ROOT_FIELDS, 'ROLES_UNKNOWN_FIELD');
  // Child skill paths follow the installed layout (an installed Team QA uses the QA GUI and QA Code next to it).
  if ('skills' in value) value.skills = anchorChildSkillPaths(value.skills);
  return { value, path, cwd: dirname(path) };
}

function validateRolesConfig(config) {
  const errors = [];
  if (!Array.isArray(config.roles)) return ['ROLES_TYPE roles'];
  if (!config.engines || typeof config.engines !== 'object' || Array.isArray(config.engines)) {
    errors.push('ROLES_TYPE engines');
  }
  if (!config.role_tools || typeof config.role_tools !== 'object' || Array.isArray(config.role_tools)) {
    errors.push('ROLES_TYPE role_tools');
  }
  const seen = new Set();
  config.roles.forEach((role, index) => {
    const name = role?.role ?? `roles[${index}]`;
    if (!role || typeof role !== 'object' || Array.isArray(role)) {
      errors.push(`ROLE_TYPE ${name}`);
      return;
    }
    const fields = ['role', 'engine', 'fallback', 'tool_bound'];
    for (const field of fields) if (!Object.hasOwn(role, field)) errors.push(`ROLE_FIELD ${name} ${field}`);
    for (const key of Object.keys(role)) if (!fields.includes(key)) errors.push(`ROLE_UNKNOWN_FIELD ${name} ${key}`);
    if (!ROLE_IDS.includes(role.role)) errors.push(`ROLE_UNKNOWN ${name}`);
    if (seen.has(role.role)) errors.push(`ROLE_DUPLICATE ${name}`);
    seen.add(role.role);
    if (typeof role.engine !== 'string' || role.engine.length === 0) errors.push(`ROLE_TYPE ${name} engine`);
    if (!(role.fallback === null || (typeof role.fallback === 'string' && role.fallback.length > 0))) {
      errors.push(`ROLE_TYPE ${name} fallback`);
    }
    if (typeof role.tool_bound !== 'boolean') errors.push(`ROLE_TYPE ${name} tool_bound`);
  });
  for (const expected of ROLE_IDS) if (!seen.has(expected)) errors.push(`ROLE_MISSING ${expected}`);
  if (config.engines && typeof config.engines === 'object' && !Array.isArray(config.engines)) {
    for (const [engine, metadata] of Object.entries(config.engines)) {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        errors.push(`ENGINE_TYPE ${engine}`);
        continue;
      }
      for (const key of Object.keys(metadata)) if (!['tools', 'description'].includes(key)) errors.push(`ENGINE_UNKNOWN_FIELD ${engine} ${key}`);
      if (!Array.isArray(metadata.tools) || metadata.tools.some((tool) => typeof tool !== 'string')) {
        errors.push(`ENGINE_TYPE ${engine} tools`);
      }
    }
    for (const role of config.roles) {
      const engine = config.engines[role.engine];
      if (!engine) {
        errors.push(`ROLE_ENGINE_UNKNOWN ${role.role} ${role.engine}`);
        continue;
      }
      if (role.fallback !== null && !config.engines[role.fallback]) errors.push(`ROLE_FALLBACK_UNKNOWN ${role.role} ${role.fallback}`);
      if (!role.tool_bound) continue;
      const required = config.role_tools?.[role.role];
      if (!Array.isArray(required) || required.length === 0) {
        errors.push(`ROLE_TOOL_REQUIREMENT_MISSING ${role.role}`);
        continue;
      }
      for (const tool of required) {
        if (!engine.tools.includes(tool)) errors.push(`ROLE_TOOL_UNAVAILABLE ${role.role} ${tool} engine=${role.engine}`);
        if (role.fallback !== null && !config.engines[role.fallback]?.tools?.includes(tool)) {
          errors.push(`ROLE_FALLBACK_TOOL_UNAVAILABLE ${role.role} ${tool} fallback=${role.fallback}`);
        }
      }
    }
  }
  return errors;
}

async function rolesCheck(args) {
  if (args.length > 0) fail(2, 'ARG_UNKNOWN', args[0]);
  const { value, cwd } = loadConfig();
  const errors = validateRolesConfig(value);
  if (!validationFailure(errors)) return;
  const live = await probeLiveCapabilities(value, cwd, REPO_ROOT);
  if (!live.ok) fail(5, live.code, live.detail, 'ungraded');
  emit('pass', `roles=${value.roles.length}`, 'config=roles.json', ...live.notes);
}

function requireSinglePath(args, command) {
  if (args.length !== 1 || args[0].startsWith('--')) fail(2, 'ARG_REQUIRED', `${command} <file>`);
  return resolve(process.cwd(), args[0]);
}

async function planValidate(args) {
  const path = requireSinglePath(args, 'plan validate');
  const plan = loadPlan(path);
  if (!validationFailure(plan.errors)) return;
  emit('pass', `run=${plan.value.run_id}`, `version=${plan.value.plan_version}`);
}

function gateOptions(args, includeSigner = false) {
  return parseFlags(args, {
    '--run': { key: 'runId', required: true },
    '--plan': { key: 'planPath', required: true },
    ...(includeSigner ? {
      '--signed-by': { key: 'signedBy', required: true },
      '--ts': { key: 'ts' },
      '--user-event': {key:'userEvent'},
    } : {}),
  });
}

function loadGatePlan(options) {
  const runId = safeRunId(options.runId);
  const planPath = resolve(process.cwd(), options.planPath);
  const plan = loadPlan(planPath);
  assertValid(plan.errors);
  if (plan.value.run_id !== runId) fail(2, 'RUN_ID_MISMATCH', `${runId} plan=${plan.value.run_id}`);
  return { runId, planPath, plan };
}

function approvalPath(runId, version) {
  return join(process.cwd(), 'control', 'approvals', runId, `plan-v${version}.json`);
}

function validateApproval(value) {
  requireObject(value, 'APPROVAL_TYPE', 'root');
  rejectUnknownFields(value, ['signed_by', 'ts', 'plan_sha256', 'schema', 'run_id', 'round', 'roster_hash', 'historical_diagnostic', 'current_run_graded','event'], 'APPROVAL_UNKNOWN_FIELD');
  for (const field of ['signed_by', 'ts', 'plan_sha256']) {
    if (!Object.hasOwn(value, field)) fail(2, 'APPROVAL_FIELD', field);
  }
  if (value.signed_by !== 'owner') fail(2, 'APPROVAL_SIGNER', String(value.signed_by ?? ''));
  if (typeof value.ts !== 'string' || Number.isNaN(Date.parse(value.ts))) fail(2, 'APPROVAL_TYPE', 'ts');
  if (typeof value.plan_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.plan_sha256)) {
    fail(2, 'APPROVAL_TYPE', 'plan_sha256');
  }
}

function assertSignedPlan({ runId, planPath, plan }) {
  const path = approvalPath(runId, plan.value.plan_version);
  if (!existsSync(path)) fail(3, 'GATE_UNSIGNED', `${runId} ${basename(planPath)}`);
  const approval = readJson(path, {
    label: basename(path),
    invalidCode: 'APPROVAL_JSON_INVALID',
    unreadableCode: 'INPUT_UNREADABLE',
  });
  validateApproval(approval);
  if (approval.plan_sha256 !== sha256File(planPath)) fail(3, 'GATE_STALE', 'plan changed after signing');
  return { approval, path };
}

async function gateStatus(args) {
  const data = loadGatePlan(gateOptions(args));
  assertSignedPlan(data);
  emit('pass', `run=${data.runId}`, `version=${data.plan.value.plan_version}`);
}

async function gateApprove(args) {
  const options = gateOptions(args, true);
  const data = loadGatePlan(options);
  const runDir = join(process.cwd(), 'runs', data.runId);
  const historicalDiagnostic = !existsSync(join(runDir, 'roster.json')) && !existsSync(join(runDir, 'phase.json'));
  let contract;
  if (!historicalDiagnostic) {
    contract = assertRunContract({ runDir, action: 'sign' });
    assertArtifactPath(contract, 'plan', data.planPath);
    if(!options.userEvent)fail(3,'PLAN_USER_EVENT_REQUIRED');
    verifyPlanUserEvent(readJson(options.userEvent),{runId:data.runId,round:contract.roster.round,rosterHash:contract.roster.roster_hash,planHash:sha256File(data.planPath)});
    const shown = loadPlanPresentation({runDir,roster:contract.roster,plan:data.plan.value,planPath:data.planPath});
    assertPlanPresented(readJson(options.userEvent),shown.input);
  }
  if (options.signedBy !== 'owner') fail(2, 'APPROVAL_SIGNER', options.signedBy);
  const approval = {
    signed_by: options.signedBy,
    ts: options.ts ?? new Date().toISOString(),
    plan_sha256: sha256File(data.planPath),
    ...(historicalDiagnostic ? { historical_diagnostic: true, current_run_graded: false } : {
      event:readJson(options.userEvent),schema: 'team-qa/plan-approval/v2', run_id: contract.roster.run_id, round: contract.roster.round, roster_hash: contract.roster.roster_hash,
    }),
  };
  validateApproval(approval);
  const path = approvalPath(data.runId, data.plan.value.plan_version);
  if(existsSync(path))await writeConfirmed(join(runDir,'archive',`plan-approval-${sha256File(path)}.json`),readFileSync(path,'utf8'),'teamqa.approval.archive');
  await writeConfirmed(path, stableJson(approval), 'teamqa.approval.write');
  if(!historicalDiagnostic)await writeConfirmed(join(runDir,'control/approvals/plan.json'),stableJson(approval),'teamqa.approval.snapshot');
  const observed = readJson(path, { label: basename(path), invalidCode: 'APPROVAL_JSON_INVALID' });
  if (JSON.stringify(observed) !== JSON.stringify(approval)) fail(1, 'EFFECT_UNCONFIRMED', basename(path));
  emit('pass', `run=${data.runId}`, `approval=${path}`, ...(historicalDiagnostic ? ['historical_diagnostic=true', 'current_run_graded=false'] : []), 'effect=confirmed');
}

function validateAdapter(name, adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) fail(2, 'ADAPTER_TYPE', name);
  rejectUnknownFields(adapter, ['probe', 'publish', 'readback'], 'ADAPTER_UNKNOWN_FIELD', name);
  for (const field of ['publish', 'readback']) {
    if (!Array.isArray(adapter[field]) || adapter[field].length === 0) fail(2, 'ADAPTER_FIELD', `${name}.${field}`);
  }
  if (Object.hasOwn(adapter, 'probe') && (!Array.isArray(adapter.probe) || adapter.probe.length === 0)) {
    fail(2, 'ADAPTER_FIELD', `${name}.probe`);
  }
}

async function mirrorDebt(runId, mirror, detail) {
  const path = join(process.cwd(), 'runs', runId, 'mirror-sync-debt.jsonl');
  const record = { ts: new Date().toISOString(), mirror, detail: String(detail).slice(0, 500) };
  await appendConfirmed(path, `${JSON.stringify(record)}\n`, 'teamqa.mirror.debt');
}

async function publishPayload(payload) {
  const { value: config, cwd: adapterCwd } = loadConfig();
  if (!config.mirror || typeof config.mirror !== 'object' || Array.isArray(config.mirror)) {
    fail(2, 'MIRROR_CONFIG_INVALID');
  }
  rejectUnknownFields(config.mirror, ['notion', 'doc_colab'], 'MIRROR_UNKNOWN_FIELD');
  const env = {
    TEAMQA_MIRROR_PAYLOAD: JSON.stringify(payload),
    TEAMQA_PROJECT_ROOT: process.cwd(),
  };
  for (const [name, label] of [['notion', 'notion'], ['doc_colab', 'doc-colab']]) {
    const adapter = config.mirror[name];
    if (!adapter) continue;
    validateAdapter(name, adapter);
    if (adapter.probe) {
      const probe = runAdapter(adapter.probe, { cwd: adapterCwd, env });
      if (probe.status !== 0 || probe.signal) continue;
    }
    const write = runAdapter(adapter.publish, { cwd: adapterCwd, env });
    if (write.status !== 0 || write.signal) {
      await mirrorDebt(payload.run_id, label, write.error || write.stderr || `exit=${write.status}`);
      continue;
    }
    await confirmExternalEffect({
      tool: `${label}.publish`,
      readback: adapter.readback,
      expected: payload,
      cwd: adapterCwd,
      env,
    });
    return { mirror: label, effect: 'confirmed' };
  }
  return { mirror: 'file', effect: 'not-applicable' };
}

function planPayload(data) {
  const contentSha = sha256(data.plan.text);
  return {
    schema_version: 1,
    kind: 'plan',
    run_id: data.runId,
    version: data.plan.value.plan_version,
    plan_version: data.plan.value.plan_version,
    plan_sha256: sha256File(data.planPath),
    content_sha256: contentSha,
    content: data.plan.text,
  };
}

async function gatePublish(args) {
  const data = loadGatePlan(gateOptions(args));
  const result = await publishPayload(planPayload(data));
  if (result.mirror === 'file') {
    emit('pass', 'mirror=file', `sign_with="teamqa gate approve --run ${data.runId} --plan ${data.planPath} --signed-by owner"`);
    return;
  }
  emit('pass', `mirror=${result.mirror}`, 'effect=confirmed');
}

function guardRunFile(path, action) {
  const runDir = dirname(resolve(path));
  if (!existsSync(join(runDir, 'roster.json')) && !existsSync(join(runDir, 'phase.json'))) return null;
  return assertRunContract({ runDir, action });
}

function guardCanonicalCommand(action, args) {
  const fileAt = args.indexOf('--file');
  const outAt = args.indexOf('--out');
  const runAt = args.indexOf('--run');
  if (action === 'init') {
    const runDir = runAt >= 0 ? join(process.cwd(), 'runs', safeRunId(args[runAt + 1])) : null;
    const output = outAt >= 0 ? resolve(args[outAt + 1]) : runDir && join(runDir, 'qa-board.json');
    const runDirs = [...new Set([runDir, output && dirname(output)].filter(Boolean))]
      .filter((dir) => existsSync(join(dir, 'roster.json')) || existsSync(join(dir, 'phase.json')));
    // PLAN presents an empty draft before SIGN; tracked cases still require Designer.
    const contractAction = args.includes('--tracked') ? 'design' : 'plan';
    for (const dir of runDirs) assertRunContract({ runDir: dir, action: contractAction });
    if (runDirs.length && output && existsSync(output)) fail(3, 'BOARD_OUTPUT_EXISTS', output);
  } else if (fileAt >= 0) guardRunFile(args[fileAt + 1], 'intake');
}

function designOptions(args) {
  return parseFlags(args, { '--file': { key: 'file' } });
}

async function designValidate(args) {
  const options = designOptions(args);
  const path = resolve(process.cwd(), options.file ?? 'tracked-plan.json');
  const tracked = loadTracked(path);
  if (!validationFailure(tracked.errors)) return;
  emit('pass', `cases=${tracked.value.cases.length}`);
}

async function designMigrateSources(args) {
  const options = parseFlags(args, {
    '--file': { key: 'file', required: true },
    '--mapping': { key: 'mapping', required: true },
    '--out': { key: 'out', required: true },
  });
  const input = resolve(process.cwd(), options.file);
  const output = resolve(process.cwd(), options.out);
  guardRunFile(input, 'design');
  guardRunFile(output, 'design');
  if (input === output) fail(2, 'SOURCE_MIGRATION_OVERWRITE_INPUT');
  if (existsSync(output)) fail(2, 'SOURCE_MIGRATION_OUTPUT_EXISTS', output);
  const legacy = loadTracked(input);
  assertValid(legacy.errors);
  const mapping = readJson(resolve(process.cwd(), options.mapping), { label: 'source-mapping.json' });
  const migrated = migrateTrackedSourceTraceability(legacy.value, mapping);
  assertValid(migrated.errors);
  assertValid(trackedErrors(migrated.value, { lock: resolveTargetLock({ cwd: process.cwd() }) }));
  await writeConfirmed(output, stableJson(migrated.value), 'teamqa.design.migrate-sources');
  const observed = loadTracked(output);
  assertValid(observed.errors);
  if (JSON.stringify(observed.value) !== JSON.stringify(migrated.value)) fail(1, 'SOURCE_MIGRATION_READBACK_MISMATCH');
  emit('pass', `tracked=${output}`, `sources=${migrated.value.sourceItems.length}`, `cases=${migrated.value.cases.length}`, 'effect=confirmed');
}

async function designCompileDefects(args) {
  const options = parseFlags(args, {
    '--registry': { key: 'registry', required: true },
    '--tracked': { key: 'tracked', required: true },
    '--out': { key: 'out', required: true },
    '--receipt': { key: 'receipt', required: true },
  });
  const registryPath = resolve(process.cwd(), options.registry);
  const trackedPath = resolve(process.cwd(), options.tracked);
  guardRunFile(trackedPath, 'design');
  const outputPath = resolve(process.cwd(), options.out);
  const receiptPath = resolve(process.cwd(), options.receipt);
  if (existsSync(outputPath) || existsSync(receiptPath)) fail(2, 'ESCAPED_DEFECT_OUTPUT_EXISTS', existsSync(outputPath) ? outputPath : receiptPath);
  if (outputPath === registryPath || outputPath === trackedPath || receiptPath === registryPath || receiptPath === trackedPath || outputPath === receiptPath) {
    fail(2, 'ESCAPED_DEFECT_OUTPUT_COLLISION');
  }
  const registryBytes = readFileSync(registryPath);
  const trackedInputBytes = readFileSync(trackedPath);
  const registry = readJson(registryPath, { label: 'escaped-defect-registry.json' });
  const trackedInput = loadTracked(trackedPath);
  if (trackedInput.errors.length) fail(2, 'ESCAPED_DEFECT_TRACKED_INPUT', trackedInput.errors.join(';'));
  const compiled = compileEscapedDefects(registry, trackedInput.value);
  const outputText = stableJson(compiled);
  const outputBytes = Buffer.from(outputText);
  const receipt = createEscapedDefectCompileReceipt({
    registry,
    registryBytes,
    trackedInputBytes,
    trackedOutput: compiled,
    trackedOutputBytes: outputBytes,
  });
  await writeConfirmed(outputPath, outputText, 'teamqa.design.compile-defects.tracked');
  await writeConfirmed(receiptPath, stableJson(receipt), 'teamqa.design.compile-defects.receipt');
  const observedTracked = readFileSync(outputPath);
  const observedReceipt = readJson(receiptPath, { label: 'escaped-defect-compile.receipt.json' });
  if (sha256(observedTracked) !== sha256(outputBytes)) fail(1, 'ESCAPED_DEFECT_OUTPUT_READBACK');
  verifyEscapedDefectCompileReceipt(observedReceipt, { registryBytes, trackedOutputBytes: observedTracked });
  emit('pass', `sources=${receipt.source_count}`, `cases=${receipt.case_count}`, `trace_pct=${receipt.trace_pct}`, 'effect=confirmed');
}

function markdownValue(value) {
  return String(value ?? '').replaceAll('|', '&#124;').replaceAll(/\r?\n/g, ' ');
}

function markdownCells(line) {
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

// RTM tokens come from lib/report-tokens.mjs: the writer uses the English requirement header and gap marker;
// rtm fill/verify, report build, lib/run-contract.mjs and lib/release-truth.mjs also read RTM files that earlier
// versions wrote with the legacy tokens.
function sourceRtmLines(plan, tracked) {
  for (const item of tracked.cases) {
    if (!Object.hasOwn(plan.tiers, item.req_id)) fail(2, 'RTM_CASE_REQUIREMENT_UNKNOWN', `${item.id}:${item.req_id}`);
  }
  const lines = [
    `| Source | Source system | Source key | Source title | Case | ${RTM_REQUIREMENT} | Tier | Priority | Verdict | Evidence |`,
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  const rows = sourceTraceabilityRows(tracked, []);
  for (const row of rows) {
    if (row.caseId === null) {
      lines.push(`| ${markdownValue(row.sourceRef)} | ${markdownValue(row.sourceSystem)} | ${markdownValue(row.externalKey)} | ${markdownValue(row.sourceTitle)} | ${RTM_EMPTY} |  |  |  | UNUSED | — |`);
      continue;
    }
    lines.push(`| ${markdownValue(row.sourceRef)} | ${markdownValue(row.sourceSystem)} | ${markdownValue(row.externalKey)} | ${markdownValue(row.sourceTitle)} | ${markdownValue(row.caseId)} | ${markdownValue(row.requirement)} | ${plan.tiers[row.requirement]} | ${row.priority} |  |  |`);
  }
  for (const [requirement, tier] of Object.entries(plan.tiers)) {
    if (!tracked.cases.some((item) => item.req_id === requirement)) {
      lines.push(`| ${RTM_EMPTY} |  |  |  | ${RTM_EMPTY} | ${markdownValue(requirement)} | ${tier} |  |  |  |`);
    }
  }
  return lines;
}

async function rtmBuild(args) {
  const options = parseFlags(args, {
    '--plan': { key: 'plan' },
    '--tracked': { key: 'tracked' },
    '--out': { key: 'out' },
  });
  const planPath = resolve(process.cwd(), options.plan ?? 'test-plan.md');
  const contract = guardRunFile(planPath, 'design');
  if (contract) assertArtifactPath(contract, 'plan', planPath);
  const plan = loadPlan(planPath);
  const tracked = loadTracked(resolve(process.cwd(), options.tracked ?? 'tracked-plan.json'));
  assertValid(plan.errors);
  assertValid(tracked.errors);
  const lines = tracked.value.schemaVersion === TRACKED_PLAN_SCHEMA_VERSION
    ? sourceRtmLines(plan.value, tracked.value)
    : [`| ${RTM_REQUIREMENT} | Tier | Case | Priority | Verdict |`, '|---|---|---|---|---|'];
  if (tracked.value.schemaVersion !== TRACKED_PLAN_SCHEMA_VERSION) {
    for (const [requirement, tier] of Object.entries(plan.value.tiers)) {
      const cases = tracked.value.cases.filter((item) => item.req_id === requirement);
      if (cases.length === 0) lines.push(`| ${requirement} | ${tier} | ${RTM_EMPTY} |  |  |`);
      else for (const item of cases) lines.push(`| ${requirement} | ${tier} | ${item.id} | ${item.priority} |  |`);
    }
  }
  const out = resolve(process.cwd(), options.out ?? 'rtm.md');
  await writeConfirmed(out, `${lines.join('\n')}\n`, 'teamqa.rtm.write');
  emit('pass', `rtm=${basename(out)}`, ...(contract ? [] : ['historical_diagnostic=true', 'current_run_graded=false']), 'effect=confirmed');
}

async function rtmFill(args) {
  const options = parseFlags(args, {
    '--rtm': { key: 'rtm', required: true },
    '--board': { key: 'board', required: true },
    '--out': { key: 'out', required: true },
  });
  const rtmPath = resolve(process.cwd(), options.rtm);
  const boardPath = resolve(process.cwd(), options.board);
  guardRunFile(boardPath, 'intake');
  const board = loadBoard(boardPath); emitBoardSchemaError(board.errors);
  const { latestByCase } = latestAttemptByCase(board.records);
  const records = latestByCase;
  const verdicts = new Map([...latestByCase].map(([id, record]) => [id, record?.verdict === 'pending' ? 'PENDING' : record?.verdict?.toUpperCase() ?? 'UNGRADED']));
  const inputLines = readText(rtmPath, { label: basename(rtmPath) }).split(/\r?\n/);
  const sourceHeader = inputLines.find((line) => line.startsWith('| Source |'));
  if (sourceHeader) {
    const header = markdownCells(sourceHeader);
    const sourceAt = header.indexOf('Source');
    const caseAt = header.indexOf('Case');
    const verdictAt = header.indexOf('Verdict');
    const evidenceAt = header.indexOf('Evidence');
    if ([sourceAt, caseAt, verdictAt, evidenceAt].some((index) => index < 0)) fail(2, 'RTM_INVALID', 'source header');
    const refsByCase = new Map();
    for (const line of inputLines) {
      if (!/^\|[^-].*\|$/.test(line) || line === sourceHeader) continue;
      const cells = markdownCells(line);
      const caseId = cells[caseAt];
      const sourceRef = cells[sourceAt];
      if (!caseId || isRtmEmpty(caseId) || isRtmEmpty(sourceRef)) continue;
      const refs = refsByCase.get(caseId) || [];
      refs.push(sourceRef);
      refsByCase.set(caseId, refs);
    }
    for (const [caseId, sourceRefs] of refsByCase) {
      const record = records.get(caseId);
      if (!record) fail(2, 'RTM_BOARD_CASE_MISSING', caseId);
      if (record.traceabilityVersion !== SOURCE_TRACEABILITY_VERSION || !Array.isArray(record.sourceRefs)) {
        fail(2, 'RTM_SOURCE_REFS_MISSING', caseId);
      }
      if (sourceRefs.length !== record.sourceRefs.length || sourceRefs.some((sourceRef) => !record.sourceRefs.includes(sourceRef))) {
        fail(2, 'RTM_SOURCE_REFS_MISMATCH', caseId);
      }
    }
    const lines = inputLines.map((line) => {
      if (!/^\|[^-].*\|$/.test(line) || line === sourceHeader) return line;
      const cells = markdownCells(line);
      const caseId = cells[caseAt];
      if (!caseId || isRtmEmpty(caseId)) return line;
      const record = records.get(caseId);
      if (!record) fail(2, 'RTM_BOARD_CASE_MISSING', caseId);
      cells[verdictAt] = record.verdict === 'pending' ? 'PENDING' : record.verdict.toUpperCase();
      cells[evidenceAt] = record.evidence.length > 0 ? record.evidence.map(markdownValue).join('<br>') : '—';
      return `| ${cells.join(' | ')} |`;
    });
    await writeConfirmed(resolve(process.cwd(), options.out), `${lines.join('\n').replace(/\n+$/, '')}\n`, 'teamqa.rtm.fill');
    emit('pass', `rtm_filled=${[...verdicts.values()].filter((value) => value !== 'PENDING').length}`, `rtm_total=${verdicts.size}`, 'traceability=source-v1', 'effect=confirmed');
    return;
  }
  const lines = inputLines.map((line) => {
    if (!/^\|[^-].*\|$/.test(line) || isRtmRequirementHeaderLine(line)) return line;
    const cells = line.split('|'); const caseId = cells[3]?.trim();
    if (!caseId || isRtmEmpty(caseId)) return line;
    cells[cells.length - 2] = ` ${verdicts.get(caseId) || 'PENDING'} `;
    return cells.join('|');
  });
  await writeConfirmed(resolve(process.cwd(), options.out), `${lines.join('\n').replace(/\n+$/, '')}\n`, 'teamqa.rtm.fill');
  emit('pass', `rtm_filled=${[...verdicts.values()].filter((value) => value !== 'PENDING').length}`, `rtm_total=${verdicts.size}`, 'effect=confirmed');
}

function boardOptions(args, add = false, seed = false) {
  return parseFlags(args, {
    '--file': { key: 'file' },
    ...(add ? { '--record': { key: 'record', required: true } } : {}),
    ...(seed ? { '--tracked': { key: 'tracked', required: true }, '--run': { key: 'runId', required: true } } : {}),
    ...(!add && !seed ? { '--tracked': { key: 'tracked' } } : {}),
  });
}

function assertPlannedSourceRefs(record, planned, tracked) {
  if (tracked.schemaVersion === TRACKED_PLAN_SCHEMA_VERSION) {
    if (record.traceabilityVersion !== SOURCE_TRACEABILITY_VERSION || !sameSourceRefs(record.sourceRefs, planned.sourceRefs)) {
      fail(2, 'BOARD_SOURCE_REFS_MISMATCH', record.case_id);
    }
    return;
  }
  if (Object.hasOwn(record, 'traceabilityVersion') || Object.hasOwn(record, 'sourceRefs')) {
    fail(2, 'BOARD_SOURCE_REFS_UNEXPECTED', record.case_id);
  }
}

const BINDING_FIELDS = ['task_base', 'source_revision', 'contract_sha256', 'exact_final_sha'];
function runBinding(runDir, required = false) {
  const file = join(runDir, 'binding.json');
  if (!existsSync(file)) {
    if (required) fail(2, 'BINDING_MISSING', file);
    return null;
  }
  const binding = readJson(file, { label: 'binding.json' });
  if (binding.schema === 'team-qa/web-binding/v1') {
    try { assertWebBinding(binding, { runDir, requireProof: false }); }
    catch (error) { fail(2, 'WEB_BINDING_INVALID', error.message); }
    return binding;
  }
  if (!/^[a-f0-9]{40}$/.test(binding.task_base || '')) fail(2, 'BINDING_TASK_BASE');
  if (typeof binding.source_revision !== 'string' || !binding.source_revision) fail(2, 'BINDING_SOURCE_REVISION');
  if (binding.contract_sha256 !== CONTRACT_SHA256) fail(2, 'BINDING_CONTRACT_SHA');
  if (!/^[a-f0-9]{40}$/.test(binding.exact_final_sha || '')) fail(2, 'BINDING_EXACT_FINAL_SHA');
  if (Object.hasOwn(binding, 'run_uuid')
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.run_uuid)) {
    fail(2, 'BINDING_RUN_UUID');
  }
  if (Object.hasOwn(binding, 'requirements_hash')
    && !/^[a-f0-9]{64}$/.test(binding.requirements_hash)) fail(2, 'BINDING_REQUIREMENTS_HASH');
  return binding;
}

function assertRecordBinding(record, binding) {
  if (!binding) return;
  if (binding.schema === 'team-qa/web-binding/v1') {
    for (const field of ['contract_sha256', 'target_kind', 'target_binding_sha256']) {
      if (record[field] !== binding[field]) fail(2, 'BOARD_BINDING_MISMATCH', `${record.case_id}:${field}`);
    }
    if (['task_base', 'source_revision', 'exact_final_sha'].some((field) => Object.hasOwn(record, field))) fail(2, 'BOARD_WEB_GIT_FIELD', record.case_id);
    if (record.target && record.target.target_binding_sha256 !== binding.target_binding_sha256) fail(2, 'BOARD_BINDING_MISMATCH', `${record.case_id}:target`);
  } else {
    for (const field of BINDING_FIELDS) if (record[field] !== binding[field]) fail(2, 'BOARD_BINDING_MISMATCH', `${record.case_id}:${field}`);
  }
  if (record.verification_lane !== record.lane && record.verification_lane !== 'multi') fail(2, 'BOARD_LANE_MISMATCH', record.case_id);
}

function emitBoardSchemaError(errors) {
  if (errors.length === 0) return;
  const [code, ...detail] = errors[0].split(' ');
  fail(2, code, detail.join(' '));
}

// One record can break several constraints at once. Return the full list in
// priority order so that no reason is hidden: reason takes the first one, and the others
// are still reported in the output.
function recordIssues(record, boardPath, lock, binding = null, expectedRequirementId = null) {
  const issues = [
    evidenceIssue(record, boardPath),
    targetIdentityIssue(record, lock),
    dualVerdictIssue(record, lock),
    childVerdictIssue(record, boardPath, lock, binding, expectedRequirementId),
    attemptSequenceIssue(record, lock),
  ];
  return issues.filter((issue) => issue != null);
}

async function boardAdd(args) {
  const options = boardOptions(args, true);
  const boardPath = resolve(process.cwd(), options.file ?? 'board.jsonl');
  const recordPath = resolve(process.cwd(), options.record);
  const record = readJson(recordPath, { label: basename(recordPath), invalidCode: 'BOARD_RECORD_JSON_INVALID' });
  const historicalDiagnostic = !existsSync(join(dirname(boardPath), 'roster.json')) && !existsSync(join(dirname(boardPath), 'phase.json'));
  if (!historicalDiagnostic) {
    const contract = assertRunContract({ runDir: dirname(boardPath), action: 'intake', record });
    if (boardPath !== join(contract.runDir, 'board.jsonl')) fail(2, 'RUN_BOARD_PATH_MISMATCH');
    if (record.run_id !== contract.roster.run_id) fail(2, 'RUN_ID_MISMATCH', record.run_id);
  }
  emitBoardSchemaError(boardRecordErrors(record, 1));
  const trackedPath = join(dirname(boardPath), 'tracked-plan.json');
  let planned = null;
  let trackedValue = null;
  if (existsSync(trackedPath)) {
    const tracked = loadTracked(trackedPath); emitBoardSchemaError(tracked.errors);
    trackedValue = tracked.value;
    planned = tracked.value.cases.find((item) => item.id === record.case_id);
    if (!planned) fail(2, 'BOARD_CASE_UNKNOWN', record.case_id);
    if (planned.lane !== record.lane) fail(2, 'BOARD_LANE_MISMATCH', record.case_id);
    assertPlannedSourceRefs(record, planned, tracked.value);
  }
  const governance = assertGovernedRelease(dirname(boardPath));
  const lock = governance.lock;
  const strictBinding = governance.official ? governance.binding : null;
  let normalized = false;
  const issues = record.verdict === 'blocked'
    ? [record.reason ?? 'BOARD_BLOCKED']
    : recordIssues(record, boardPath, lock, strictBinding, planned?.req_id);
  if (issues.length > 0) {
    record.verdict = 'ungraded';
    [record.reason] = issues;
    normalized = true;
  }
  let records = [];
  if (existsSync(boardPath)) {
    const existing = loadBoard(boardPath);
    emitBoardSchemaError(existing.errors);
    records = existing.records;
  }
  const binding = governance.binding;
  assertRecordBinding(record, binding);
  for (const existing of records) {
    assertRecordBinding(existing, binding);
    if (existing.case_id === record.case_id && planned) assertPlannedSourceRefs(existing, planned, trackedValue);
  }
  const history = records.filter((item) => item.case_id === record.case_id && item.verdict !== 'pending');
  const pendingIndex = records.findIndex((item) => item.case_id === record.case_id && item.verdict === 'pending');
  if (history.length > 0) {
    const previous = history.at(-1);
    if (!['ungraded', 'blocked'].includes(previous.verdict)) fail(2, 'BOARD_RETRY_NOT_ALLOWED', record.case_id);
    const previousAttempt = effectiveAttempt(previous);
    if (!Number.isInteger(previousAttempt)) fail(2, 'ATTEMPT_HISTORY_INCOMPLETE', record.case_id);
    if (previousAttempt >= 3) fail(2, 'ATTEMPT_LIMIT_EXCEEDED', record.case_id);
    if (record.attempt !== previousAttempt + 1 || !record.attempt_id || record.parent_attempt_id !== attemptId(previous)) {
      fail(2, 'ATTEMPT_HISTORY_PARENT', record.case_id);
    }
    records.push(record);
  } else if (pendingIndex >= 0) {
    if (effectiveAttempt(record) !== 1 || Object.hasOwn(record, 'parent_attempt_id')) fail(2, 'ATTEMPT_HISTORY_PARENT', record.case_id);
    records[pendingIndex] = record;
  } else {
    if (effectiveAttempt(record) !== 1 || Object.hasOwn(record, 'parent_attempt_id')) fail(2, 'ATTEMPT_HISTORY_PARENT', record.case_id);
    records.push(record);
  }
  const historyIssue = attemptHistoryIssue(records);
  if (historyIssue) fail(2, historyIssue.split(' ')[0], historyIssue.slice(historyIssue.indexOf(' ') + 1));
  await writeConfirmed(boardPath, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`, 'teamqa.board.add');
  await appendScrollLedger({
    cwd: process.cwd(), runId: record.run_id, caseId: record.case_id, status: record.verdict,
    evidence: record.evidence, digest: record.reason ?? `source=${record.source}`, tries: record.attempt,
  });
  if (normalized || record.verdict === 'ungraded') {
    emit('ungraded', record.reason, ...issues.slice(1), record.case_id, 'effect=confirmed');
    process.exitCode = 1;
    return;
  }
  emit('pass', record.case_id, `case_verdict=${record.verdict}`, ...(historicalDiagnostic ? ['historical_diagnostic=true', 'current_run_graded=false'] : []), 'effect=confirmed');
}

async function boardSeed(args) {
  const options = boardOptions(args, false, true);
  const trackedPath = resolve(process.cwd(), options.tracked);
  const boardPath = resolve(process.cwd(), options.file ?? 'board.jsonl');
  const tracked = loadTracked(trackedPath); emitBoardSchemaError(tracked.errors);
  const runId = safeRunId(options.runId);
  const contract = guardRunFile(boardPath, 'design');
  if (contract) assertArtifactPath(contract, 'tracked', trackedPath);
  const { binding } = assertGovernedRelease(dirname(boardPath));
  const ts = new Date().toISOString();
  const rows = tracked.value.cases.map((item) => ({
    case_id: item.id, lane: item.lane, verdict: 'pending', evidence: [], source: 'script', run_id: runId, ts,
    reason: 'PENDING_EXECUTION', function_verdict: 'ungraded', ui_visual_verdict: 'ungraded', attempt: 1,
    started_at: ts, ended_at: ts, timeout_ms: 1,
    ...(tracked.value.schemaVersion === TRACKED_PLAN_SCHEMA_VERSION
      ? { traceabilityVersion: SOURCE_TRACEABILITY_VERSION, sourceRefs: structuredClone(item.sourceRefs) }
      : {}),
    ...(binding?.schema === 'team-qa/web-binding/v1'
      ? { target_kind: 'deployed-build', target_binding_sha256: binding.target_binding_sha256, verification_lane: item.lane, contract_sha256: WEB_CONTRACT_SHA256 }
      : binding ? { task_base: binding.task_base, source_revision: binding.source_revision, verification_lane: item.lane,
      contract_sha256: binding.contract_sha256, exact_final_sha: binding.exact_final_sha } : {}),
  }));
  await writeConfirmed(boardPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'teamqa.board.seed');
  emit('pass', `seeded=${rows.length}`, `run=${runId}`, ...(contract ? [] : ['historical_diagnostic=true', 'current_run_graded=false']), 'effect=confirmed');
}

async function boardVerify(args) {
  const options = boardOptions(args);
  const boardPath = resolve(process.cwd(), options.file ?? 'board.jsonl');
  if (existsSync(join(dirname(boardPath), 'roster.json')) || existsSync(join(dirname(boardPath), 'phase.json'))) guardRunFile(boardPath, 'intake');
  const board = loadBoard(boardPath);
  emitBoardSchemaError(board.errors);
  const trackedPath = options.tracked ? resolve(process.cwd(), options.tracked) : join(dirname(boardPath), 'tracked-plan.json');
  let trackedValue = null;
  if (existsSync(trackedPath)) {
    const tracked = loadTracked(trackedPath); emitBoardSchemaError(tracked.errors);
    trackedValue = tracked.value;
    const present = new Set(board.records.map((record) => record.case_id));
    const missing = tracked.value.cases.filter((item) => !present.has(item.id)).map((item) => item.req_id || item.id);
    if (missing.length) fail(2, 'BOARD_CASE_MISSING', missing.join(','));
    for (const record of board.records) {
      const planned = tracked.value.cases.find((item) => item.id === record.case_id);
      if (!planned) fail(2, 'BOARD_CASE_UNKNOWN', record.case_id);
      assertPlannedSourceRefs(record, planned, tracked.value);
    }
  }
  const governance = assertGovernedRelease(dirname(boardPath));
  const lock = governance.lock;
  const strictBinding = governance.official ? governance.binding : null;
  for (const record of board.records) assertRecordBinding(record, governance.binding);
  let changed = false;
  const ungraded = [];
  for (const record of board.records) {
    const issues = record.verdict === 'blocked'
      ? [record.reason ?? 'BOARD_BLOCKED']
      : recordIssues(
        record,
        boardPath,
        lock,
        strictBinding,
        trackedValue?.cases.find((item) => item.id === record.case_id)?.req_id,
      );
    if (issues.length > 0) {
      record.verdict = 'ungraded';
      [record.reason] = issues;
      changed = true;
    }
    if (record.verdict === 'ungraded') ungraded.push({ record, issues });
  }
  if (changed) {
    await writeConfirmed(boardPath, `${board.records.map((item) => JSON.stringify(item)).join('\n')}\n`, 'teamqa.board.normalize');
  }
  for (const record of board.records) {
    await appendScrollLedger({
      cwd: process.cwd(), runId: record.run_id, caseId: record.case_id, status: record.verdict,
      evidence: record.evidence, digest: record.reason ?? `verified source=${record.source}`,
    });
  }
  if (ungraded.length > 0) {
    const { record: item, issues } = ungraded[0];
    emit(
      'ungraded',
      item.reason ?? 'BOARD_UNGRADED',
      ...issues.slice(1),
      item.case_id,
      changed ? 'effect=confirmed' : 'effect=not-applicable',
    );
    process.exitCode = 1;
    return;
  }
  emit('pass', ...board.records.map((item) => item.case_id), `records=${board.records.length}`);
}

function schemaMajor(value) {
  const explicit = value.verdict_schema_version;
  if (typeof explicit === 'string' && /^\d+\./.test(explicit)) return Number(explicit.split('.')[0]);
  const schemaConst = value?.properties?.schema?.const;
  const schemaMatch = typeof schemaConst === 'string' ? schemaConst.match(/\/v(\d+)$/) : null;
  if (schemaMatch) return Number(schemaMatch[1]);
  const schemaVersion = value?.properties?.schemaVersion?.enum?.[0];
  if (Number.isInteger(schemaVersion)) return schemaVersion;
  for (const candidate of [value.$id, value.title]) {
    const match = typeof candidate === 'string' ? candidate.match(/(?:^|[-_/ ])v(\d+)(?:\D|$)/i) : null;
    if (match) return Number(match[1]);
  }
  return null;
}

function verifyDeclaredReceiptSchemas(config, cwd) {
  const contract = readContract();
  for (const skill of ['qa-gui', 'qa-code']) {
    const declared = config.skills?.[skill];
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
      fail(5, 'SKILL_RECEIPT_SCHEMA_MISSING', skill, 'ungraded');
    }
    if (typeof declared.receipt_schema !== 'string' || !Number.isInteger(declared.supported_receipt_major)) {
      fail(5, 'SKILL_RECEIPT_SCHEMA_MISSING', skill, 'ungraded');
    }
    const receiptPath = expandPath(declared.receipt_schema, cwd);
    if (!existsSync(receiptPath)) fail(5, 'SKILL_RECEIPT_SCHEMA_MISSING', skill, 'ungraded');
    let schema;
    try { schema = JSON.parse(readFileSync(receiptPath, 'utf8')); }
    catch { fail(5, 'SKILL_RECEIPT_SCHEMA_INVALID', skill, 'ungraded'); }
    const major = schemaMajor(schema);
    if (major !== declared.supported_receipt_major) {
      fail(4, 'SCHEMA_MAJOR_MISMATCH', `${skill} receipt expected=${declared.supported_receipt_major} actual=${major ?? 'unknown'}`);
    }
    const expectedTitle = `${skill}/receipt/v${declared.supported_receipt_major}`;
    if (schema.title !== expectedTitle) fail(4, 'SKILL_RECEIPT_SCHEMA_ID_MISMATCH', `${skill} ${schema.title || 'missing'}`);
    const expectedHash = contract.schemas[expectedTitle];
    if (!expectedHash || sha256File(receiptPath) !== expectedHash) {
      fail(4, 'SKILL_RECEIPT_SCHEMA_SHA_MISMATCH', skill);
    }
  }
}

function assertGovernedRelease(runDir) {
  const binding = runBinding(runDir);
  if (!binding?.run_uuid) return { official: false, binding, lock: resolveTargetLock({ cwd: process.cwd() }) };
  if (!binding.requirements_hash) fail(5, 'UNGOVERNED', 'binding requirements_hash', 'ungraded');
  if (isDeployedTarget(binding.target)) {
    try { assertWebBinding(binding, { runDir, requireProof: false }); }
    catch (error) { fail(5, 'WEB_BINDING_INVALID', error.message, 'ungraded'); }
  }
  const rolesPath = configPath();
  if (!existsSync(rolesPath)) fail(5, 'UNGOVERNED', 'roles.json', 'ungraded');
  const { value: config, cwd } = loadConfig();
  const roleErrors = validateRolesConfig(config);
  if (roleErrors.length > 0) fail(5, 'UNGOVERNED', roleErrors[0], 'ungraded');
  verifyDeclaredReceiptSchemas(config, cwd);
  const lock = resolveTargetLock({ cwd: process.cwd() });
  if (!lock.governed) fail(5, 'UNGOVERNED', 'target lock', 'ungraded');
  if (!lock.declared) fail(5, 'TARGET_IDENTITY_MISSING', 'roles.json target', 'ungraded');
  if (isDeployedTarget(lock.declared) !== (binding.schema === 'team-qa/web-binding/v1')) fail(5, 'TARGET_BINDING_KIND_MISMATCH', '', 'ungraded');
  if (binding.schema === 'team-qa/web-binding/v1') {
    try { assertWebBinding(binding, { target: lock.declared, runDir, requireProof: false }); }
    catch (error) { fail(5, 'WEB_TARGET_BINDING_MISMATCH', error.message, 'ungraded'); }
  }
  return { official: true, binding, lock };
}

async function smoke(args) {
  if (args.length > 0) fail(2, 'ARG_UNKNOWN', args[0]);
  const { value: config, cwd } = loadConfig();
  if (!config.skills || typeof config.skills !== 'object' || Array.isArray(config.skills)) fail(2, 'SKILLS_CONFIG_INVALID');
  rejectUnknownFields(config.skills, ['qa-gui', 'qa-code'], 'SKILLS_UNKNOWN_FIELD');
  const checked = [];
  const canaries = [];
  const canaryInputs = [];
  let receiptDeclarations = false;
  for (const skill of ['qa-gui', 'qa-code']) {
    const declared = config.skills[skill];
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) fail(5, 'SKILL_SCHEMA_MISSING', skill, 'ungraded');
    rejectUnknownFields(
      declared,
      ['verdict_schema', 'supported_major', 'receipt_schema', 'supported_receipt_major', 'commands'],
      'SKILL_CONFIG_UNKNOWN_FIELD',
      skill,
    );
    if (typeof declared.verdict_schema !== 'string' || !Number.isInteger(declared.supported_major)) {
      fail(5, 'SKILL_SCHEMA_MISSING', skill, 'ungraded');
    }
    const path = expandPath(declared.verdict_schema, cwd);
    if (!existsSync(path)) fail(5, 'SKILL_SCHEMA_MISSING', skill, 'ungraded');
    let schema;
    try {
      schema = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) fail(4, 'SKILL_SCHEMA_INVALID', skill);
      fail(5, 'SKILL_SCHEMA_UNREADABLE', skill, 'ungraded');
    }
    if (typeof schema.skill === 'string' && schema.skill !== skill) fail(4, 'SKILL_SCHEMA_ID_MISMATCH', skill);
    const major = schemaMajor(schema);
    if (major === null || major !== declared.supported_major) {
      fail(4, 'SCHEMA_MAJOR_MISMATCH', `${skill} expected=${declared.supported_major} actual=${major ?? 'unknown'}`);
    }
    const hasReceiptPath = Object.hasOwn(declared, 'receipt_schema');
    const hasReceiptMajor = Object.hasOwn(declared, 'supported_receipt_major');
    if (hasReceiptPath !== hasReceiptMajor) fail(5, 'SKILL_RECEIPT_SCHEMA_MISSING', skill, 'ungraded');
    receiptDeclarations ||= hasReceiptPath;
    checked.push(`${skill}@${major}`);
    canaryInputs.push({ skill, declared, cwd, repoRoot: REPO_ROOT });
  }
  if (receiptDeclarations) verifyDeclaredReceiptSchemas(config, cwd);
  for (const input of canaryInputs) canaries.push(runChildCanary(input));
  emit('pass', ...checked, ...canaries);
}

function reportPaths(runId) {
  const runDir = join(process.cwd(), 'runs', runId);
  return {
    runDir,
    plan: join(runDir, 'test-plan.md'),
    tracked: join(runDir, 'tracked-plan.json'),
    board: join(runDir, 'board.jsonl'),
    rtm: join(runDir, 'rtm.md'),
    report: join(runDir, 'summary-report.md'),
  };
}

function validateRtm(text, plan, tracked, boardRecords = []) {
  if (tracked.schemaVersion === TRACKED_PLAN_SCHEMA_VERSION) {
    const lines = text.split(/\r?\n/);
    const headerLine = lines.find((line) => line.startsWith('| Source |'));
    if (!headerLine) fail(2, 'RTM_INVALID', 'source header');
    const header = markdownCells(headerLine);
    const indexes = Object.fromEntries(['Source', 'Source system', 'Source key', 'Source title', 'Case', RTM_REQUIREMENT, 'Tier', 'Priority', 'Verdict', 'Evidence']
      .map((name) => [name, name === RTM_REQUIREMENT ? rtmRequirementIndex(header) : header.indexOf(name)]));
    if (Object.values(indexes).some((index) => index < 0)) fail(2, 'RTM_INVALID', 'source columns');
    const observed = lines
      .filter((line) => /^\|[^-].*\|$/.test(line) && line !== headerLine)
      .map(markdownCells)
      .filter((cells) => cells[indexes.Case] && !isRtmEmpty(cells[indexes.Case]));
    const expected = sourceTraceabilityRows(tracked, boardRecords).filter((row) => row.caseId !== null);
    if (observed.length !== expected.length) fail(2, 'RTM_SOURCE_EDGE_COUNT', `expected=${expected.length} actual=${observed.length}`);
    for (let index = 0; index < expected.length; index += 1) {
      const row = expected[index];
      const cells = observed[index];
      const expectedFields = {
        Source: row.sourceRef,
        'Source system': row.sourceSystem,
        'Source key': row.externalKey,
        'Source title': row.sourceTitle,
        Case: row.caseId,
        [RTM_REQUIREMENT]: row.requirement,
        Tier: plan.tiers[row.requirement],
        Priority: row.priority,
      };
      for (const [field, value] of Object.entries(expectedFields)) {
        if (cells[indexes[field]] !== markdownValue(value)) fail(2, 'RTM_SOURCE_EDGE_MISMATCH', `${index}:${field}`);
      }
      if (cells[indexes.Verdict] !== row.verdict) fail(2, 'RTM_VERDICT_MISMATCH', `${row.sourceRef}:${row.caseId}`);
      const expectedEvidence = row.evidence.length > 0 ? row.evidence.map(markdownValue).join('<br>') : '—';
      if (cells[indexes.Evidence] !== expectedEvidence) fail(2, 'RTM_EVIDENCE_MISMATCH', `${row.sourceRef}:${row.caseId}`);
    }
    const allRows = lines
      .filter((line) => /^\|[^-].*\|$/.test(line) && line !== headerLine)
      .map(markdownCells);
    for (const source of tracked.sourceItems) {
      if (tracked.cases.some((item) => item.sourceRefs.includes(source.id))) continue;
      const visible = allRows.some((cells) => cells[indexes.Source] === markdownValue(source.id)
        && isRtmEmpty(cells[indexes.Case]) && cells[indexes.Verdict] === 'UNUSED');
      if (!visible) fail(2, 'RTM_UNUSED_SOURCE_HIDDEN', source.id);
    }
    for (const requirement of Object.keys(plan.tiers)) {
      if (tracked.cases.some((item) => item.req_id === requirement)) continue;
      const visible = allRows.some((cells) => isRtmEmpty(cells[indexes.Case])
        && cells[indexes[RTM_REQUIREMENT]] === markdownValue(requirement));
      if (!visible) fail(2, 'RTM_GAP_HIDDEN', requirement);
    }
    return;
  }
  if (!isRtmRequirementHeaderLine(text) || !text.includes('| Case |')) fail(2, 'RTM_INVALID', 'header');
  for (const requirement of Object.keys(plan.tiers)) {
    const line = text.split(/\r?\n/).find((item) => item.startsWith(`| ${requirement} |`));
    if (!line) fail(2, 'RTM_MISSING_REQUIREMENT', requirement);
    const cases = tracked.cases.filter((item) => item.req_id === requirement);
    if (cases.length === 0 && !hasRtmEmpty(line)) fail(2, 'RTM_GAP_HIDDEN', requirement);
    for (const item of cases) if (!text.includes(item.id)) fail(2, 'RTM_MISSING_CASE', item.id);
  }
  const stats = rtmStats(text);
  if (stats.filled !== stats.total) fail(2, 'RTM_VERDICT_EMPTY', `count=${stats.total - stats.filled}`);
}

function reportInputs(runId, governance) {
  const paths = reportPaths(runId);
  const plan = loadPlan(paths.plan);
  const tracked = loadTracked(paths.tracked);
  assertValid(plan.errors);
  assertValid(tracked.errors);
  if (plan.value.run_id !== runId) fail(2, 'RUN_ID_MISMATCH', `${runId} plan=${plan.value.run_id}`);
  assertSignedPlan({ runId, planPath: paths.plan, plan });
  const rtm = readText(paths.rtm, { label: 'rtm.md' });
  if (tracked.value.schemaVersion !== TRACKED_PLAN_SCHEMA_VERSION) {
    validateRtm(rtm, plan.value, tracked.value);
  }
  const board = loadBoard(paths.board);
  emitBoardSchemaError(board.errors);
  const caseMap = new Map(tracked.value.cases.map((item) => [item.id, item]));
  const seen = new Set();
  for (const record of board.records) {
    if (record.run_id !== runId) fail(2, 'BOARD_RUN_MISMATCH', record.case_id);
    if (!caseMap.has(record.case_id)) fail(2, 'BOARD_CASE_UNKNOWN', record.case_id);
    seen.add(record.case_id);
    assertPlannedSourceRefs(record, caseMap.get(record.case_id), tracked.value);
    const issue = evidenceIssue(record, paths.board);
    if (issue) fail(2, issue, record.case_id);
  }
  const missingCases = tracked.value.cases.filter((item) => !seen.has(item.id));
  const strictBinding = governance.official ? governance.binding : null;
  const resolved = latestAttemptByCase(board.records, (record) => {
    if (recordIssues(record, paths.board, governance.lock, strictBinding, caseMap.get(record.case_id)?.req_id).length > 0) return true;
    try { assertRecordBinding(record, governance.binding); } catch { return true; }
    return governance.binding?.schema === 'team-qa/web-binding/v1'
      && (record.target_kind !== 'deployed-build' || record.target_binding_sha256 !== governance.binding.target_binding_sha256
        || ['task_base', 'source_revision', 'exact_final_sha'].some((field) => Object.hasOwn(record, field)));
  });
  const latestRecords = tracked.value.cases.map((item) => {
    const latest = resolved.latestByCase.get(item.id);
    if (latest) return latest;
    const last = resolved.histories.get(item.id)?.at(-1);
    return last ? { ...last, verdict: 'ungraded', function_verdict: 'ungraded', ui_visual_verdict: 'ungraded', reason: 'ATTEMPT_LATEST_INVALID' } : null;
  }).filter(Boolean);
  if (tracked.value.schemaVersion === TRACKED_PLAN_SCHEMA_VERSION) {
    validateRtm(rtm, plan.value, tracked.value, latestRecords);
  }
  return { paths, plan: plan.value, tracked: tracked.value, board: latestRecords, attempts: board.records, caseMap, missingCases };
}

function coveragePercent(covered, total) { return total === 0 ? 'N/A' : Math.round((covered / total) * 100); }

function computeReport(runId) {
  const governance = assertGovernedRelease(reportPaths(runId).runDir);
  const data = reportInputs(runId, governance);
  // R2a: the adjudicator's recorded results. Shadow (the default) changes nothing here; an approved roster whose
  // adjudicator seat enforces makes a contested PASS count as UNGRADED from this point on.
  const adjudication = adjudicationOverlay({ runDir: data.paths.runDir, board: data.board });
  if (adjudication?.mode === 'enforce') data.board = adjudication.board;
  const lock = governance.lock;
  const binding = governance.binding;
  const strictBinding = governance.official ? binding : null;
  const requirements = Object.entries(data.plan.tiers);
  // R1b: with the tracked plan's coverage block the Coverage Gate counts cells that have a state receipt; a graded case
  // whose declared cell has none does not cover its requirement (lib/coverage-cells.mjs).
  const cells = coverageCells(data);
  const cellUngraded = new Set(cells?.ungradedCases ?? []);
  const covered = (requirement) => {
    const caseIds = new Set(data.tracked.cases.filter((item) => item.req_id === requirement).map((item) => item.id));
    return data.board.some((record) => caseIds.has(record.case_id) && ['pass', 'fail'].includes(record.verdict) && !cellUngraded.has(record.case_id));
  };
  const high = requirements.filter(([, tier]) => tier === 'FULL');
  const low = requirements.filter(([, tier]) => tier === 'SMOKE');
  // Grounded record checkers run before coverage arithmetic, so an absent tier
  // cannot prevent child, target, evidence, or completeness checks from running.
  const issues = [];
  for (const item of data.missingCases) {
    issues.push(groundedIssue({
      checker: 'board-completeness',
      code: 'BOARD_CASE_MISSING',
      caseId: item.id,
      source: 'tracked_plan',
    }));
  }
  for (const record of data.attempts) {
    if (binding?.schema === 'team-qa/web-binding/v1'
      && (record.target_kind !== 'deployed-build' || record.target_binding_sha256 !== binding.target_binding_sha256
        || ['task_base', 'source_revision', 'exact_final_sha'].some((field) => Object.hasOwn(record, field)))) {
      issues.push(groundedIssue({ checker: 'target-identity', code: 'WEB_RECORD_BINDING_MISMATCH', caseId: record.case_id, evidence: record.evidence }));
    }
    for (const [checker, code] of [
      ['target-identity', targetIdentityIssue(record, lock)],
      ['dual-verdict', dualVerdictIssue(record, lock)],
      ['child-verdict', childVerdictIssue(
        record,
        data.paths.board,
        lock,
        strictBinding,
        data.caseMap.get(record.case_id)?.req_id,
      )],
      ['failure-separation', failureSeparationIssue(record)],
    ]) {
      if (code) issues.push(groundedIssue({ checker, code, caseId: record.case_id, evidence: record.evidence }));
    }
  }
  if (targetConflict(data.attempts)) {
    issues.push(groundedIssue({ checker: 'target-consensus', code: 'TARGET_IDENTITY_CONFLICT' }));
  }
  if (cells) issues.push(...cells.issues);
  const metrics = {
    coverage_high_pct: coveragePercent(high.filter(([requirement]) => covered(requirement)).length, high.length),
    coverage_low_pct: coveragePercent(low.filter(([requirement]) => covered(requirement)).length, low.length),
    defects: { p0: 0, p1: 0, p2: 0 },
    pass: data.board.filter((item) => item.verdict === 'pass').length,
    fail: data.board.filter((item) => item.verdict === 'fail').length,
    ungraded: data.board.filter((item) => item.verdict === 'ungraded').length,
    // The three failure sources are counted separately so that each failure goes to whoever must fix it.
    ...separateFailures(data.board),
  };
  // Defects by priority speak only about the product: a broken harness or environment
  // does not prove the product wrong, so it is not added to p0/p1/p2. They
  // still block GO, but under their own names below.
  const failed = data.board.filter((item) => isProductFailure(item));
  for (const record of failed) {
    const priority = data.caseMap.get(record.case_id).priority.toLowerCase();
    metrics.defects[priority] += 1;
  }
  const waivers = new Set(data.plan.exit_criteria.p1_waivers);
  const failedP1 = failed.filter((record) => data.caseMap.get(record.case_id).priority === 'P1');
  const waivedP1 = failedP1.filter((record) => waivers.has(record.case_id)).map((record) => record.case_id).sort();
  const unwaivedP1 = failedP1.filter((record) => !waivers.has(record.case_id));
  // Each NO_GO reason is built as a grounded issue: which checker found it, which artifact
  // can rebuild it, which case and evidence stand behind it. The v1 `reasons` are still
  // exactly the old strings, derived from these same issues, so the two cannot drift apart.
  const criteria = data.plan.exit_criteria;
  if (metrics.coverage_high_pct !== 'N/A' && metrics.coverage_high_pct < criteria.coverage_high_pct) {
    issues.push(groundedIssue({
      checker: 'coverage-exit',
      code: 'COVERAGE_HIGH_BELOW_EXIT',
      source: 'test_plan',
      detail: `coverage_high_pct ${metrics.coverage_high_pct} < ${criteria.coverage_high_pct}`,
    }));
  }
  if (metrics.coverage_low_pct !== 'N/A' && metrics.coverage_low_pct < criteria.coverage_low_pct) {
    issues.push(groundedIssue({
      checker: 'coverage-exit',
      code: 'COVERAGE_LOW_BELOW_EXIT',
      source: 'test_plan',
      detail: `coverage_low_pct ${metrics.coverage_low_pct} < ${criteria.coverage_low_pct}`,
    }));
  }
  if (metrics.defects.p0 > criteria.p0_max) {
    issues.push(groundedIssue({
      checker: 'defect-exit',
      code: 'P0_OVER_EXIT',
      source: 'test_plan',
      detail: `p0_count ${metrics.defects.p0} > ${criteria.p0_max}`,
    }));
  }
  if (unwaivedP1.length > criteria.p1_max) {
    for (const record of unwaivedP1) {
      issues.push(groundedIssue({
        checker: 'defect-exit',
        code: 'P1_UNWAIVED',
        caseId: record.case_id,
        evidence: record.evidence,
        source: 'test_plan',
      }));
    }
  }
  if (metrics.ungraded > 0) {
    issues.push(groundedIssue({
      checker: 'ungraded-exit',
      code: 'UNGRADED_PRESENT',
      detail: `ungraded_count ${metrics.ungraded} > 0`,
    }));
  }
  const reasons = issueReasons(issues);
  // The number of items each checker inspected in this run. A checker that fails closed at input
  // reading still declares its `checked`: the report exists only when they ran clean,
  // but "clean on 0 items" and "clean on the whole board" are two different things.
  const checked = {
    'coverage-matrix': data.tracked.cases.length,
    'attempt-sequence': data.board.length,
    'evidence-contract': data.board.length,
    'target-identity': data.board.length,
    'target-consensus': 1,
    'dual-verdict': data.board.length,
    'child-verdict': data.board.length,
    'failure-separation': data.board.length,
    'board-completeness': data.tracked.cases.length,
    'coverage-exit': requirements.length,
    'defect-exit': data.board.length,
    'ungraded-exit': data.board.length,
    ...(cells ? { 'coverage-cells': cells.cellCases } : {}),
  };
  return {
    data,
    coverage: cells,
    report: {
      ...(data.tracked.schemaVersion === TRACKED_PLAN_SCHEMA_VERSION ? {
        reportSchemaVersion: 2,
        traceabilityVersion: SOURCE_TRACEABILITY_VERSION,
        sourceTraceability: {
          sourceItems: structuredClone(data.tracked.sourceItems),
          rows: sourceTraceabilityRows(data.tracked, data.board),
        },
      } : {}),
      run_id: runId,
      // A web binding has no Git fields; undefined keys would vanish from the written report.
      ...(binding?.schema === 'team-qa/web-binding/v1' ? { verification_lane: 'all', contract_sha256: binding.contract_sha256 }
        : binding ? { task_base: binding.task_base, source_revision: binding.source_revision, verification_lane: 'all', contract_sha256: binding.contract_sha256, exact_final_sha: binding.exact_final_sha } : {}),
      target: reportTarget({ lock, records: data.board, plan: data.plan }),
      decision: reasons.length === 0 ? 'GO' : 'NO_GO',
      metrics,
      reasons,
      waived_p1: waivedP1,
      grounded_issues: issues,
      red_checkers: redCheckerLedger(issues, checked, { coverageCells: Boolean(cells) }),
      child_gates: childGateLedger(data.board),
      ...(cells ? { coverage_cells: { version: COVERAGE_CELLS_VERSION, map: COVERAGE_MAP_FILE, map_sha256: sha256(cells.mapText), ...cells.summary } } : {}),
      // U5: an unattended run whose board review stayed FAIL records the blocked delivery; COMPLETE verified it.
      ...(existsSync(deliveryPath(data.paths.runDir)) ? { board_delivery: boardDeliverySummary(readJson(deliveryPath(data.paths.runDir), { label: 'board-delivery.json' })) } : {}),
      // B0: board writes the root made outside `teamqa board publish` (a hand-made Notion page, Doc or Drive file).
      ...boardConformance(data.paths.runDir),
      // R2a: next to the real verdicts, what they would be with the adjudicator on (shadow), or what it applied.
      ...adjudicationReportField(adjudication, { decision: reasons.length === 0 ? 'GO' : 'NO_GO', metrics }),
    },
  };
}

// R1b: the coverage map of a run whose tracked plan has the coverage block, or null (the old report is unchanged).
// Inputs: the tracked plan, the signed plan's N/A cells, runs/<run_id>/app-map.json (QA GUI app map v2) when the
// exploration wrote one, and the state receipts behind the latest records.
function coverageCells(data) {
  if (data.tracked.schemaVersion !== TRACKED_PLAN_SCHEMA_VERSION || data.tracked.coverage?.version !== COVERAGE_CELLS_VERSION) return null;
  const appMapPath = join(data.paths.runDir, APP_MAP_FILE);
  let appMap = null;
  let appMapSha256 = null;
  if (existsSync(appMapPath)) {
    const text = readFileSync(appMapPath, 'utf8');
    appMapSha256 = sha256(text);
    try { appMap = JSON.parse(text); } catch { appMap = { schema: null }; }
  }
  const built = buildCoverageMap({ tracked: data.tracked, planCoverage: data.plan.coverage ?? null, appMap, appMapSha256,
    records: data.board, boardDir: dirname(data.paths.board) });
  return { ...built, mapText: coverageMapText(built.map) };
}

function boardConformance(runDir) {
  const transcript = rootTranscript(runDir);
  if (!transcript || !existsSync(transcript)) return {};
  const audit = auditBoardWrites({ transcriptPath: transcript, plans: plansOf(runDir) });
  return { board_conformance: { status: audit.status, planned: audit.planned, nonconforming: audit.nonconforming,
    writes: audit.writes.filter((w) => !w.planned).slice(0, 20).map(({ tool, kind, line }) => ({ tool, kind, line })) } };
}

function reportMarkdown(report, coverageMap = null) {
  const traceability = report.reportSchemaVersion === 2 ? [
    '## Source traceability',
    '',
    '| Source | Source system | Source key | Source title | Case | Verdict | Evidence |',
    '|---|---|---|---|---|---|---|',
    ...report.sourceTraceability.rows.map((row) => `| ${markdownValue(row.sourceRef)} | ${markdownValue(row.sourceSystem)} | ${markdownValue(row.externalKey)} | ${markdownValue(row.sourceTitle)} | ${markdownValue(row.caseId ?? RTM_EMPTY)} | ${markdownValue(row.verdict)} | ${row.evidence.length > 0 ? row.evidence.map(markdownValue).join('<br>') : '—'} |`),
    '',
  ] : [];
  const cellSection = report.coverage_cells && coverageMap ? [coverageMarkdown(report.coverage_cells, coverageMap)] : [];
  const blocked = report.board_delivery ? [
    '## Board not handed over',
    '',
    `The board review is still not PASS after ${report.board_delivery.review_rounds} fix rounds (unattended run): the board is not handed over or published; the receipt records board_delivery: blocked. Open review points:`,
    '',
    ...(report.board_delivery.open.length ? report.board_delivery.open.map((point) => `- ${markdownValue(point)}`) : ['- (the reviewer recorded no specific point)']),
    '',
  ] : [];
  const handMade = report.board_conformance?.nonconforming ? [
    '## Board written outside Team QA',
    '',
    `The root made ${report.board_conformance.nonconforming} board write(s) that \`teamqa board publish\` did not plan. Those pages or files are not the QA board and are not handed over:`,
    '',
    ...report.board_conformance.writes.map((w) => `- ${markdownValue(w.tool)} (${markdownValue(w.kind)}), transcript line ${w.line}`),
    '',
  ] : [];
  return [
    '# Summary report',
    '',
    `Decision: **${report.decision}**`,
    '',
    ...blocked,
    ...handMade,
    ...adjudicationMarkdown(report.adjudication),
    ...traceability,
    ...cellSection,
    markers.REPORT_START,
    JSON.stringify(report, null, 2),
    markers.REPORT_END,
    '',
  ].join('\n');
}

function reportRunOption(args) {
  const options = parseFlags(args, { '--run': { key: 'runId', required: true } });
  options.runId = safeRunId(options.runId);
  return options;
}

// S6 (public v1): the report, board, RTM and plan never carry a test-account password. The values come from the run's
// own credential inputs (lib/test-secrets.mjs); a finding names the file and the count, never the value.
function refuseTestSecrets(runDir, texts = []) {
  const { secrets } = collectRunSecrets(runDir);
  const findings = scanRunOutputs(runDir, secrets);
  for (const [name, text] of texts) { const values = countSecretsInText(text, secrets); if (values) findings.push({ file: name, values }); }
  if (findings.length) fail(3, 'TEST_SECRET_IN_OUTPUT', findings.map((f) => `${f.file} (${f.values})`).join(', '), 'ungraded');
}

async function reportBuild(args) {
  const { runId } = reportRunOption(args);
  const runDir = join(process.cwd(), 'runs', runId);
  const historicalDiagnostic = !existsSync(join(runDir, 'roster.json')) && !existsSync(join(runDir, 'phase.json'));
  if (!historicalDiagnostic) assertRunContract({ runDir, action: 'complete' });
  const { data, report, coverage } = computeReport(runId);
  const prefix = historicalDiagnostic ? 'Historical diagnostic; current_run_graded=false.\n\n' : '';
  // R1b: the full cell list goes beside the report; the report binds it by SHA-256.
  if (coverage) writeFileSync(join(runDir, COVERAGE_MAP_FILE), coverage.mapText);
  // S2: the actual tokens and cost per role follow the machine-checked block (it is not part of what verify compares).
  // R0: where the time went (timing.json beside the report), also outside the machine-checked block.
  const timing = runTiming({ runDir, runId, rootTranscript: rootTranscript(runDir), projectsRoot: claudeProjectsRoot() });
  writeFileSync(join(runDir, 'timing.json'), `${JSON.stringify(timing, null, 2)}\n`);
  const text = prefix + reportMarkdown(report, coverage?.map ?? null) + costMarkdown(runDir) + timingMarkdown(timing);
  refuseTestSecrets(runDir, [[basename(data.paths.report), text]]);
  await writeConfirmed(data.paths.report, text, 'teamqa.report.write');
  const details = [
    ...(historicalDiagnostic ? ['historical_diagnostic=true', 'current_run_graded=false'] : []),
    `decision=${report.decision}`,
    `coverage_high_pct=${report.metrics.coverage_high_pct}`,
    `coverage_low_pct=${report.metrics.coverage_low_pct}`,
    `p0_count=${report.metrics.defects.p0}`,
    `p1_count=${report.metrics.defects.p1}`,
    // State the three failure sources in the result line too: a console reader does not have to open
    // the report to know whether a failure belongs to the product, the harness or the environment.
    `product_defects=${report.metrics.product_defects}`,
    `harness_failures=${report.metrics.harness_failures}`,
    `environment_failures=${report.metrics.environment_failures}`,
    // Traceability is stated right in the result line: how many reasons are grounded and how many
    // checkers declared that they ran, so that a report with no checkers does not pass silently.
    `grounded_issues=${report.grounded_issues.length}`,
    `red_checkers=${report.red_checkers.length}`,
    // R1b: cells with a receipt and the cell count, the frontier and the stop reason, each on its own (no percentage).
    ...(report.coverage_cells ? [`cells_covered=${report.coverage_cells.coarse.covered}`, `cells=${report.coverage_cells.coarse.cells}`,
      `frontier=${report.coverage_cells.frontier.candidates}`, `stop=${report.coverage_cells.stop.reason}`] : []),
  ];
  if (report.waived_p1.length > 0) details.push(`waived_p1=${report.waived_p1.join(',')}`);
  details.push(...report.reasons, 'effect=confirmed');
  emit(report.decision === 'GO' ? 'pass' : 'fail', ...details);
  if (report.decision !== 'GO') process.exitCode = 1;
}

// teamqa board deliver-blocked (upgrade U5): an unattended run records that its board stays undelivered.
async function boardDeliverBlocked(args) {
  const options = parseFlags(args, { '--run': { key: 'runId', required: true }, '--reviews': { key: 'reviews', required: true } });
  const runDir = join(process.cwd(), 'runs', safeRunId(options.runId));
  const contract = assertRunContract({ runDir, action: 'execute' });
  const board = contract.lock.artifacts?.board;
  if (!board) fail(3, 'RUN_DOCUMENT_MISSING', 'board', 'ungraded');
  const record = await recordBlockedBoardDelivery({ runDir, roster: contract.roster, phase: contract.state.phase, boardPath: resolve(runDir, board.path),
    reviews: options.reviews.split(',').map((p) => p.trim()).filter(Boolean).map((p) => resolve(process.cwd(), p)) });
  emit('pass', 'BOARD_DELIVERY_BLOCKED', `reviews=${record.reviews.length}`, `open=${record.open.length}`, `file=${deliveryPath(runDir)}`,
    'next="do not deliver or publish the board; run transition --to COMPLETE, report build and receipt create"');
}

async function reportDiagnose(args) {
  const { runId } = reportRunOption(args);
  const runDir = join(process.cwd(), 'runs', runId);
  const reasons = [];
  try { assertRunContract({ runDir, action: 'complete' }); }
  catch (error) { if (!(error instanceof TeamQAError)) throw error; reasons.push(`${error.code} ${error.detail || ''}`.trim()); }
  const diagnostic = { schema: 'team-qa/diagnostic/v1', run_id: runId, current_run_graded: false, decision: 'NO_GO', reasons };
  await writeConfirmed(join(runDir, 'diagnostic-report.json'), stableJson(diagnostic), 'teamqa.report.diagnose');
  emit('ungraded', 'decision=NO_GO', 'current_run_graded=false', ...reasons, 'effect=confirmed');
  process.exitCode = 1;
}

function mismatchPath(actual, expected, path = '') {
  if (typeof actual !== typeof expected || actual === null || expected === null) {
    return actual === expected ? null : path || 'root';
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return path || 'root';
    for (let index = 0; index < expected.length; index += 1) {
      const mismatch = mismatchPath(actual[index], expected[index], `${path}[${index}]`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  if (typeof expected === 'object') {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    if (JSON.stringify(actualKeys.sort()) !== JSON.stringify(expectedKeys.sort())) return path || 'root';
    for (const key of expectedKeys) {
      const mismatch = mismatchPath(actual[key], expected[key], path ? `${path}.${key}` : key);
      if (mismatch) return mismatch;
    }
    return null;
  }
  return actual === expected ? null : path || 'root';
}

async function reportVerify(args) {
  const { runId } = reportRunOption(args);
  const paths = reportPaths(runId);
  const historicalDiagnostic = !existsSync(join(paths.runDir, 'roster.json')) && !existsSync(join(paths.runDir, 'phase.json'));
  if (!historicalDiagnostic) assertRunContract({ runDir: paths.runDir, action: 'complete' });
  const expected = computeReport(runId).report;
  const observed = parseReport(paths.report).value;
  const mismatch = mismatchPath(observed, expected);
  if (mismatch) fail(2, 'REPORT_MISMATCH', mismatch);
  // R1b: the coverage map beside the report is the one the report binds.
  if (expected.coverage_cells) {
    const mapPath = join(paths.runDir, COVERAGE_MAP_FILE);
    if (!existsSync(mapPath) || sha256(readFileSync(mapPath, 'utf8')) !== expected.coverage_cells.map_sha256) fail(2, 'COVERAGE_MAP_MISMATCH', COVERAGE_MAP_FILE);
  }
  emit('pass', `run=${runId}`, `decision=${expected.decision}`, ...(historicalDiagnostic ? ['historical_diagnostic=true', 'current_run_graded=false'] : []));
}

async function receiptCreate(args) {
  const options = parseFlags(args, {
    '--run': { key: 'runId', required: true }, '--binding': { key: 'binding', required: true }, '--out': { key: 'out', required: true },
  });
  const runId = safeRunId(options.runId); const runDir = join(process.cwd(), 'runs', runId);
  const requestedBinding = readJson(resolve(process.cwd(), options.binding), { label: 'binding.json' });
  const binding = runBinding(runDir, true);
  const bindingMismatch = mismatchPath(requestedBinding, binding);
  if (bindingMismatch) fail(2, 'BINDING_MISMATCH', bindingMismatch);
  let computedDecision = 'NO_GO';
  if (binding.run_uuid) {
    assertGovernedRelease(runDir);
    const computed = computeReport(runId).report;
    const observed = parseReport(join(runDir, 'summary-report.md')).value;
    const reportMismatch = mismatchPath(observed, computed);
    if (reportMismatch) fail(2, 'REPORT_MISMATCH', reportMismatch);
    computedDecision = computed.decision;
  }
  const historicalDiagnostic=!existsSync(join(runDir,'roster.json'))&&!existsSync(join(runDir,'phase.json'))&&!binding.run_uuid;
  if(!historicalDiagnostic)assertRunContract({runDir,action:'complete'});
  const receipt = (historicalDiagnostic?createTeamQaReceipt:createCurrentTeamQaReceipt)({
    runDir,
    runUuid: binding.run_uuid || runId,
    binding,
    computedDecision,
  });
  if(historicalDiagnostic){receipt.historical_diagnostic=true;receipt.current_run_graded=false;receipt.integrity=integrityFor(receipt);}
  await writeConfirmed(resolve(process.cwd(), options.out), stableJson(receipt), 'teamqa.receipt.write');
  emit('pass', `release_verdict=${receipt.release_verdict}`, `missing_ids=${receipt.missing_ids.join(',')}`, 'effect=confirmed');
}

async function receiptVerify(args) {
  const options = parseFlags(args, { '--file': { key: 'file', required: true } });
  const file = resolve(process.cwd(), options.file); const receipt = readJson(file, { label: basename(file) });
  const historicalDiagnostic=receipt.schema==='team-qa/receipt/v1'&&!existsSync(join(dirname(file),'roster.json'))&&!existsSync(join(dirname(file),'phase.json'));
  if(historicalDiagnostic)verifyTeamQaReceipt(receipt,file);else verifyCurrentTeamQaReceipt(receipt, file);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.run_uuid || '')) {
    const runDir = dirname(file);
    const binding = runBinding(runDir, true);
    if (receipt.run_uuid !== binding.run_uuid) fail(2, 'RECEIPT_RUN_UUID');
    for (const field of ['task_base', 'source_revision', 'exact_final_sha', 'requirements_hash', 'contract_sha256']) {
      if (receipt[field] !== binding[field]) fail(2, 'RECEIPT_BINDING_MISMATCH', field);
    }
    const runId = basename(runDir);
    const computed = computeReport(runId).report;
    const observed = parseReport(join(runDir, 'summary-report.md')).value;
    const reportMismatch = mismatchPath(observed, computed);
    if (reportMismatch) fail(2, 'REPORT_MISMATCH', reportMismatch);
    const expectedVerdict = computed.decision === 'GO' ? 'GO' : 'NO-GO';
    if (receipt.release_verdict !== expectedVerdict) fail(2, 'RECEIPT_COMPUTED_VERDICT');
  }
  emit('pass', `release_verdict=${receipt.release_verdict}`, `missing_ids=${receipt.missing_ids.join(',')}`);
}

function handoffExpected(capsule) {
  return {
    run_uuid: capsule.run_uuid,
    task_base: capsule.task_base,
    source_revision: capsule.source_revision,
    exact_final_sha: capsule.exact_final_sha,
    requirements_hash: capsule.requirements_hash,
    capsule_digest: capsule.digest,
  };
}

// A deployed-build (web) receipt/handoff has no Team-code Job Capsule (lib/reliability-handoff.mjs forbids
// one); it binds the run's web binding instead. Git receipts keep requiring --capsule.
function webHandoffInput(args, flag, schema) {
  const at = args.indexOf(flag);
  try { return at >= 0 && readJson(resolve(process.cwd(), args[at + 1])).schema === schema; } catch { return false; }
}
function webHandoffExpected(runDir) {
  const binding = runBinding(runDir, true);
  return { run_uuid: binding.run_uuid, requirements_hash: binding.requirements_hash, target_binding_sha256: binding.target_binding_sha256, target: binding.target };
}

async function handoffCreate(args) {
  const options = parseFlags(args, {
    '--receipt': { key: 'receipt', required: true },
    '--capsule': { key: 'capsule', required: !webHandoffInput(args, '--receipt', 'team-qa/receipt/web-v1') },
    '--out': { key: 'out', required: true },
    '--producer-commit': { key: 'producerCommit', required: true },
    '--ready-at': { key: 'readyAt' },
  });
  const receiptFile = resolve(process.cwd(), options.receipt);
  await receiptVerify(['--file', receiptFile]);
  const capsuleFile = options.capsule ? resolve(process.cwd(), options.capsule) : null;
  assertRunContract({ runDir: dirname(receiptFile), action: 'complete' });
  const receipt = readJson(receiptFile, { label: basename(receiptFile) });
  const capsule = capsuleFile ? verifyJobCapsuleForHandoff(readJson(capsuleFile, { label: basename(capsuleFile) })) : null;
  const envelope = createReliabilityHandoff({
    receipt,
    receiptBytes: readFileSync(receiptFile),
    receiptFile,
    capsuleDigest: capsule?.digest,
    readyAt: options.readyAt ?? new Date().toISOString(),
    producer: { skill: 'team-qa', version: readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8').trim(), source_commit: options.producerCommit },
  });
  verifyReliabilityHandoff(envelope, capsule ? handoffExpected(capsule) : webHandoffExpected(dirname(receiptFile)),{receipt,receiptBytes:readFileSync(receiptFile),receiptFile});
  const out = resolve(process.cwd(), options.out);
  await writeConfirmed(out, stableJson(envelope), 'teamqa.handoff.write');
  emit('pass', `handoff=${out}`, capsule ? `capsule_digest=${capsule.digest}` : '', `release_verdict=${envelope.release_verdict}`, 'effect=confirmed');
}

async function handoffVerify(args) {
  const options = parseFlags(args, {
    '--file': { key: 'file', required: true },
    '--receipt': {key:'receipt',required:true},
    '--capsule': { key: 'capsule', required: !webHandoffInput(args, '--file', 'team-qa/handoff/web-v1') },
  });
  const file = resolve(process.cwd(), options.file);
  assertRunContract({ runDir: dirname(file), action: 'complete' });
  const capsule = options.capsule ? verifyJobCapsuleForHandoff(readJson(resolve(process.cwd(), options.capsule), { label: 'job-capsule.json' })) : null;
  const envelope = readJson(file, { label: basename(file) });
  if(!(Number(envelope.producer?.version?.split('.')[0])>1||(Number(envelope.producer?.version?.split('.')[0])===1&&Number(envelope.producer?.version?.split('.')[1])>=7)))fail(3,'HANDOFF_CURRENT_PRODUCER_REQUIRED');
  const receiptFile=resolve(options.receipt),receipt=readJson(receiptFile);verifyCurrentTeamQaReceipt(receipt,receiptFile);
  verifyReliabilityHandoff(envelope, capsule ? handoffExpected(capsule) : webHandoffExpected(dirname(file)),{receipt,receiptBytes:readFileSync(receiptFile),receiptFile});
  emit('pass', `handoff=${file}`, capsule ? `capsule_digest=${capsule.digest}` : '');
}

async function handoffAckVerify(args) {
  const options = parseFlags(args, {
    '--file': { key: 'file', required: true },
    '--handoff': { key: 'handoff', required: true },
    '--max-latency-ms': { key: 'maxLatencyMs' },
  });
  const ackFile = resolve(process.cwd(), options.file);
  const handoffFile = resolve(process.cwd(), options.handoff);
  const maxLatencyMs = options.maxLatencyMs === undefined ? 15_000 : Number(options.maxLatencyMs);
  if (!Number.isInteger(maxLatencyMs) || maxLatencyMs < 0) fail(2, 'HANDOFF_SLO_INVALID');
  const envelope = readJson(handoffFile, { label: basename(handoffFile) });
  const ack = readJson(ackFile, { label: basename(ackFile) });
  verifyTeamCodeHandoffAck(ack, { handoff: envelope, handoffBytes: readFileSync(handoffFile), maxLatencyMs });
  emit('pass', `ack=${ackFile}`, `handoff_latency_ms=${ack.handoff_latency_ms}`);
}

async function coverageVerify(args) {
  const options = parseFlags(args, { '--requirements': { key: 'requirements', required: true }, '--board': { key: 'board', required: true } });
  const graph = readJson(resolve(process.cwd(), options.requirements), { label: 'requirements.json' });
  if (graph.schema !== 'requirements.freeze/v2' || graph.contract_sha256 !== CONTRACT_SHA256) fail(2, 'REQUIREMENTS_CONTRACT');
  for (const requirement of graph.requirements || []) {
    if (!requirement.requirement_owner) fail(2, `REQUIREMENT_OWNER_MISSING:${requirement.id}`);
    if (!requirement.verification_lane) fail(2, `REQUIREMENT_LANE_MISSING:${requirement.id}`);
    if (requirement.waiver) {
      if (!['not-applicable', 'external-owner'].includes(requirement.waiver.type) || !requirement.waiver.reason || !requirement.waiver.approver) fail(2, `REQUIREMENT_WAIVER_INVALID:${requirement.id}`);
    }
  }
  const boardPath = resolve(process.cwd(), options.board); const trackedPath = join(dirname(boardPath), 'tracked-plan.json');
  if (existsSync(trackedPath) && existsSync(boardPath) && readFileSync(boardPath, 'utf8').trim()) {
    const tracked = loadTracked(trackedPath); const board = loadBoard(boardPath); emitBoardSchemaError([...tracked.errors, ...board.errors]);
    const cases = new Map(tracked.value.cases.map((item) => [item.id, item]));
    const claims = new Map();
    for (const record of board.records.filter((item) => item.verdict === 'pass')) {
      const item = cases.get(record.case_id); const requirement = graph.requirements.find((row) => row.id === item?.req_id);
      if (requirement && requirement.verification_lane !== 'multi' && requirement.verification_lane !== item.lane) fail(2, 'LANE_CLAIM_MISMATCH', requirement.id);
      if (requirement?.waiver) fail(2, 'WAIVER_CANNOT_PASS', requirement.id);
      if (requirement) {
        const lanes = claims.get(requirement.id) || new Set(); lanes.add(item.lane); claims.set(requirement.id, lanes);
        if (lanes.size > 1 && requirement.evidence_contract?.multi_evidence !== true) fail(2, 'MULTI_EVIDENCE_UNDECLARED', requirement.id);
      }
    }
  }
  emit('pass', `requirements=${graph.requirements.length}`);
}

// teamqa coverage policy (R1e): the exploration policy QA GUI's frontier explorer reads, from the run's tracked plan
// (its coverage block and cell cases) and its signed plan (the destructive actions it approves).
async function coveragePolicy(args) {
  const options = parseFlags(args, { '--run': { key: 'runId', required: true }, '--out': { key: 'out' } });
  const runId = safeRunId(options.runId);
  const runDir = join(process.cwd(), 'runs', runId);
  const plan = loadPlan(join(runDir, 'test-plan.md'));
  assertValid(plan.errors);
  const tracked = loadTracked(join(runDir, 'tracked-plan.json'));
  assertValid(tracked.errors);
  if (tracked.value.coverage?.version !== COVERAGE_CELLS_VERSION) fail(2, 'COVERAGE_CELLS_REQUIRED', 'the tracked plan has no coverage block (references/coverage-cells.md)');
  const policy = explorationPolicy({ tracked: tracked.value, plan: plan.value, runId });
  const out = options.out ? resolve(process.cwd(), options.out) : join(runDir, EXPLORATION_POLICY_FILE);
  await writeConfirmed(out, `${JSON.stringify(policy, null, 2)}\n`, 'teamqa.coverage.policy');
  emit('pass', `policy=${out}`, `requirement_cells=${policy.requirementCells.length}`, `high_risk=${policy.highRisk.length}`,
    `approved_destructive=${policy.approvedDestructive.length}`, 'effect=confirmed');
}

async function retestSelect(args) {
  const options = parseFlags(args, {
    '--tracked': { key: 'tracked', required: true }, '--change': { key: 'change', required: true },
    '--out': { key: 'out', required: true },
  });
  const trackedPath = resolve(options.tracked);
  guardRunFile(trackedPath, 'design');
  const tracked = loadTracked(trackedPath);
  assertValid(tracked.errors);
  const changePath = resolve(options.change);
  const result = { ...selectRetestCases(tracked.value, readJson(changePath)), tracked_sha256: sha256File(trackedPath), change_sha256: sha256File(changePath) };
  const out = resolve(options.out);
  if (existsSync(out)) fail(2, 'RETEST_OUTPUT_EXISTS', out);
  await writeConfirmed(out, stableJson(result), 'teamqa.retest.select');
  emit('pass', `scope=${result.mode}`, `cases=${result.caseIds.length}`, 'result_scope=retest-only', `selection=${out}`);
}

async function reportPublish(args) {
  const { runId } = reportRunOption(args);
  const runDir=join(process.cwd(),'runs',runId);const historicalDiagnostic=!existsSync(join(runDir,'roster.json'))&&!existsSync(join(runDir,'phase.json'));
  if(!historicalDiagnostic)assertRunContract({runDir,action:'complete'});
  const paths = reportPaths(runId);
  const parsed = parseReport(paths.report);
  if (parsed.value.run_id !== runId) fail(2, 'RUN_ID_MISMATCH', `${runId} report=${parsed.value.run_id}`);
  const expected = computeReport(runId).report;
  const mismatch = mismatchPath(parsed.value, expected);
  if (mismatch) fail(2, 'REPORT_MISMATCH', mismatch);
  refuseTestSecrets(runDir);
  const contentSha = sha256(parsed.text);
  const payload = {
    schema_version: 1,
    kind: 'report',
    ...(historicalDiagnostic?{historical_diagnostic:true,current_run_graded:false}:{}),
    run_id: runId,
    version: 1,
    decision: parsed.value.decision,
    content_sha256: contentSha,
    content: parsed.text,
  };
  const result = await publishPayload(payload);
  emit('pass', `mirror=${result.mirror}`, result.effect === 'confirmed' ? 'effect=confirmed' : 'sign_on_file=true');
}


// Deployed-build runs read binding.json in every execute-phase check, and the run cannot leave EXECUTE, so a
// web run must be bound (teamqa web bind) before it may enter EXECUTE (eval compat 3).
function requireWebBindingBeforeExecute(runDir) {
  const rosterPath = join(runDir, 'roster.json');
  if (!existsSync(rosterPath)) return;
  const roster = readJson(rosterPath, { label: 'roster.json' });
  if (!isDeployedTarget(roster.target)) return;
  const bindingPath = join(runDir, 'binding.json');
  if (!existsSync(bindingPath)) fail(3, 'WEB_BINDING_REQUIRED', 'run teamqa web bind before moving to EXECUTE', 'ungraded');
  try { assertWebBinding(readJson(bindingPath, { label: 'binding.json' }), { target: roster.target, runDir, requireProof: false }); }
  catch (error) { fail(3, 'WEB_BINDING_INVALID', String(error.message ?? error), 'ungraded'); }
}

async function runPhaseCommand(action, args) {
  const options = parseFlags(args, {
    '--run': { key: 'runId', required: true },
    ...(action === 'transition' ? { '--to': { key: 'to', required: true } } : {}),
    ...(action === 'lock-docs' ? { '--manifest': { key: 'manifest', required: true } } : {}),
    ...(action === 'check' ? { '--stage': { key: 'stage', required: true } } : {}),
  });
  const runDir = join(process.cwd(), 'runs', safeRunId(options.runId));
  if (action === 'transition') {
    if (options.to === 'EXECUTE') requireWebBindingBeforeExecute(runDir);
    const state = await transitionRun({ runDir, to: options.to });
    emit('pass', `phase=${state.phase}`, 'effect=confirmed');
  } else if (action === 'lock-docs') {
    await lockRunDocuments({ runDir, artifacts: readJson(resolve(options.manifest)) });
    emit('pass', 'documents=locked', 'effect=confirmed');
  } else if (action === 'show-plan') {
    const contract = assertRunContract({runDir,action:'plan'});
    const path = resolve(runDir,contract.lock.artifacts.plan.path), plan = loadPlan(path);
    const shown = await preparePlanPresentation({runDir,roster:contract.roster,plan:plan.value,planPath:path});
    console.log(shown.text);
  } else {
    assertRunContract({ runDir, action: options.stage });
    emit('pass', 'contract=current');
  }
}

// teamqa run offer (upgrade U4): the marker line goes to stdout, verbatim, for the root to paste right before its question.
async function runOffer(args) {
  const options = parseFlags(args, { '--run': { key: 'runId', required: true }, '--kind': { key: 'kind', required: true },
    '--cases': { key: 'cases', required: true }, '--reason': { key: 'reason', required: true } });
  const runDir = join(process.cwd(), 'runs', safeRunId(options.runId));
  const { createRunOffer } = await import('./lib/run-contract.mjs');
  const made = await createRunOffer({ runDir, kind: options.kind, cases: options.cases, reason: options.reason });
  console.log(made.marker);
  emit('pass', 'RUN_OFFER', `file=${made.path}`, 'next="paste the TEAMQA_OFFER line verbatim into assistant chat, right before the question"');
}

// teamqa secrets scan --run <id> (public v1, S6): is a test-account password anywhere in what people read?
// 1.15.1: a run with executor inputs or a credential-named file from which no value was read is not called clean;
// it gets the warning TEST_SECRETS_NOT_FOUND (exit 0) with what to do next.
function secretsScan(args) {
  const options = parseFlags(args, { '--run': { key: 'runId', required: true } });
  const runDir = join(process.cwd(), 'runs', safeRunId(options.runId));
  if (!existsSync(runDir)) fail(2, 'RUN_NOT_FOUND', options.runId);
  const { secrets, sources, inputs } = collectRunSecrets(runDir);
  const findings = scanRunOutputs(runDir, secrets);
  if (findings.length) fail(3, 'TEST_SECRET_IN_OUTPUT', findings.map((f) => `${f.file} (${f.values})`).join(', '), 'ungraded');
  const counts = [`values=${secrets.length}`, `sources=${sources}`, `inputs=${inputs}`];
  if (!secrets.length && (sources || inputs)) {
    emit('warn', 'TEST_SECRETS_NOT_FOUND', ...counts, 'next="the run has executor inputs or a credentials file but no password was read from them; write the test passwords as key: value (password: ...) or e-mail / password lines, or point TEAMQA_TEST_SECRETS_FILE at the file that holds them, and scan again"');
    return;
  }
  emit('pass', 'TEST_SECRETS_CLEAN', ...counts, ...(secrets.length ? [] : ['note="no credential input found; nothing to look for"']));
}

// teamqa scroll <command> (public v1): runs the SCROLL CLI that ships with Team QA (or TEAMQA_SCROLL_ROOT), so an agent
// needs no SCROLL install of its own. Arguments, output and exit code pass through unchanged.
async function scrollCommand(args) {
  const { scrollRoot } = await import('./lib/core.mjs');
  const bin = join(scrollRoot(), 'bin', 'scroll.js');
  if (!existsSync(bin)) fail(5, 'SCROLL_UNAVAILABLE', bin, 'ungraded');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}

function help() {
  console.log('teamqa doctor [--json] (what this machine still needs to run Team QA, in order, with the fix for the first gap)');
  console.log('teamqa doctor --bundle <file.json> [--run <id>] (a diagnostic file for support; secrets, e-mails and the home path are taken out)');
  console.log('teamqa grant fingerprint|keygen|issue|show (owner only: another browser platform than the Store Dragon needs a signed grant)');
  console.log('teamqa grant buzz --approvers <npub,…> --days <n> --this-machine | --show (owner only: lets a Buzz agent session be the root, approved by these Buzz accounts)');
  console.log('teamqa activate <license.json> (the free licence; same as teamqa license activate) | teamqa license show | issue --email <e> --days <n> --out <file> (owner)');
  console.log('teamqa suite verify|install --dir <suite> | build|publish (owner) (the three skills as one signed bundle)');
  console.log('teamqa update [--check] [--channel <dir|https url>] (install the newer signed suite; refused while a run is active)');
  console.log('teamqa dragon verify|install --from <dragon-runtime package | https url | suite folder> [--dry-run] (the signed Dragon runtime, checked before it runs)');
  console.log('teamqa scroll <command> (the SCROLL CLI that ships with Team QA: check, build, eval, audit, ...)');
  console.log('teamqa cost estimate|cap --usd <n>|report --run <id> (API-price estimate before approval, a cap that stops at a case boundary, actual cost per role)');
  console.log('teamqa secrets scan --run <id> (no test-account password in the board, report, RTM or plan; report build and publish check it too)');
  console.log('teamqa preflight check --run <id> [--roster <candidate.json>] [--stage basic|plan|execute] [--role executor_code|executor_gui]');
  console.log('teamqa preflight build --run <id> --stage basic|plan|execute [--roster <candidate.json>] [--image <png>] [--video <mp4>] [--current] [--transcript <root.jsonl>] [--repo-root <dir> --source-path <file>] (Claude Code root)');
  console.log('teamqa web identity draft --run <id> [--round <n>] --project-id <p> --environment Local|Test|Staging --preview-url <url> --backend-origin <origin> [--transcript <root.jsonl>]');
  console.log('teamqa web identity prove --run <id> [--round <n>] [--transcript <root.jsonl>]');
  console.log('TEAMQA_ROLES=<absolute overlay outside the package> teamqa web overlay (pre-bind roles overlay; web bind later adds the target)');
  console.log('teamqa run show-plan --run <id> (copy the complete output into assistant chat before plan approval)');
  console.log('teamqa run transition --run <id> --to PLAN|SIGN|DESIGN|EXECUTE|COMPLETE');
  console.log('teamqa run lock-docs --run <id> --manifest <artifacts.json>');
  console.log('teamqa run check --run <id> --stage plan|sign|design|execute|complete');
  console.log('teamqa run offer --run <id> --kind round|attempt --cases <id,id> --reason <CODE> (paste the TEAMQA_OFFER line before asking to run again)');
  console.log('teamqa composition validate|prepare|build|verify --file <file> [--children <index>] [--out <output>]');
  console.log('teamqa roles check');
  console.log('teamqa plan validate <file>');
  console.log('teamqa gate status|approve|publish --run <id> --plan <file>');
  console.log('teamqa design validate [--file <tracked-plan.json>]');
  console.log('teamqa design migrate-sources --file <tracked-plan-v1.json> --mapping <mapping.json> --out <tracked-plan-v2.json>');
  console.log('teamqa design compile-defects --registry <registry.json> --tracked <tracked-plan.json> --out <compiled.json> --receipt <receipt.json>');
  console.log('teamqa rtm build [--plan <file>] [--tracked <file>] [--out <file>]');
  console.log('teamqa rtm fill --rtm <file> --board <board.jsonl> --out <file>');
  console.log('teamqa board seed|add|verify [--file <board.jsonl>]');
  console.log('teamqa board init|validate|render|apply|sync|open (canonical teamwork board)');
  console.log('teamqa board verify --file <qa-board.json> --artifact <index.html> (final Doc-Colab bytes)');
  console.log('teamqa board prepare --file <canonical> --capabilities <probes> --out <payload>');
  console.log('teamqa board compare-page --file <canonical> --snapshot <read-page> --out <receipt>');
  console.log('teamqa board deliver-blocked --run <id> --reviews <r1,r2,r3> (unattended run: the board review stayed FAIL after 3 repair rounds)');
  console.log('teamqa board publish --run <id> --to html|notion|colab [--parent <Notion page>] [--channel <Buzz channel>] --quality-review <receipt> (the only way to deliver a board)');
  console.log('teamqa board publish-next --run <id> (after each planned Notion call; verifies the readback at the end)');
  console.log('teamqa board audit --run <id> | --session <root transcript> (board writes made outside board publish)');
  console.log('teamqa retest select --tracked <plan> --change <impact> --out <selection>');
  console.log('teamqa coverage policy --run <id> [--out <file>] (the exploration policy QA GUI\'s frontier explorer reads: requirement and high-risk cells, approved destructive actions)');
  console.log('teamqa smoke');
  console.log('teamqa report build|verify|publish|diagnose|timing --run <id>');
  console.log('teamqa adjudicate checklist|run|show --run <id> [--case <case>] (independent adjudicator; shadow unless the roster switches it on)');
  console.log('teamqa receipt create|verify');
  console.log('teamqa handoff create|verify|ack-verify');
  console.log('teamqa web requirements|bind|record --run <id> (deployed-build lane; references/claude-host.md)');
  console.log('teamqa continuation register|unregister|inspect|stage-hooks');
  emit('ungraded', 'HELP_ONLY');
}

async function dispatch() {
  const [group, action, ...args] = process.argv.slice(2);
  if (!group || group === 'help' || group === '--help') return help();
  if (group === 'continuation') return (await import('./continuation.mjs')).continuationCommand(action, args);
  if (group === 'doctor') return (await import('./lib/doctor.mjs')).doctorCommand([action, ...args].filter(Boolean));
  if (group === 'grant' && action === 'buzz') return (await import('./lib/buzz-host.mjs')).buzzGrantCommand(args);
  if (group === 'grant') return (await import('./lib/owner-grant.mjs')).grantCommand(action, args);
  if (group === 'license') return (await import('./lib/license.mjs')).licenseCommand(action, args);
  if (group === 'activate') return (await import('./lib/license.mjs')).licenseCommand('activate', [action, ...args].filter(Boolean));
  if (group === 'suite') return (await import('./lib/suite.mjs')).suiteCommand(action, args);
  if (group === 'dragon') return (await import('./lib/dragon-install.mjs')).dragonCommand(action, args);
  if (group === 'scroll') return scrollCommand([action, ...args].filter((value) => value !== undefined));
  if (group === 'secrets' && action === 'scan') return secretsScan(args);
  if (group === 'cost') return (await import('./lib/cost.mjs')).costCommand(action, args, { parseFlags, safeRunId, emit });
  if (group === 'update') return (await import('./lib/suite.mjs')).updateCommand([action, ...args].filter(Boolean));
  if(group==='preflight'&&action==='check'){
    const options=parseFlags(args,{'--run':{key:'run',required:true},'--roster':{key:'roster'},'--stage':{key:'stage'},'--role':{key:'role'}});
    const runDir=join(process.cwd(),'runs',safeRunId(options.run)),file=options.roster?resolve(options.roster):join(runDir,'roster.json');
    const candidate=readJson(file),roster={...candidate,roster_hash:sha256File(file)},stage=options.stage??'basic';
    const plan=stage==='basic'?null:loadPlan(join(runDir,'test-plan.md'));
    if(plan?.errors.length)fail(3,'PREFLIGHT_PLAN_INVALID',plan.errors.join(';'),'ungraded');
    const readiness=assertToolPreflight({runDir,roster,stage,role:options.role,requirements:plan?.value.preflight});
    console.log(stableJson(readiness));
    emit(readiness.verified?'pass':'ungraded','TOOL_PREFLIGHT',`stage=${stage}`,'product_qa=false');
    if(!readiness.verified)process.exitCode=3;
    const notice=(await import('./lib/suite.mjs')).updateNotice();if(notice)process.stderr.write(notice+'\n');
    return;
  }
  if (group === 'preflight' && action === 'build') return (await import('./lib/preflight-build.mjs')).preflightBuildCommand(args);
  if (group === 'web' && action === 'identity') return (await import('./lib/web-identity.mjs')).webIdentityCommand(args);
  if (group === 'composition') return (await import('./target-composition.mjs')).compositionCommand(action,args);
  if (group === 'run' && ['transition', 'lock-docs', 'check', 'show-plan'].includes(action)) return runPhaseCommand(action, args);
  if (group === 'run' && action === 'offer') return runOffer(args);
  if (group === 'roles' && action === 'check') return rolesCheck(args);
  if (group === 'plan' && action === 'validate') return planValidate(args);
  if (group === 'gate' && action === 'status') return gateStatus(args);
  if (group === 'gate' && action === 'approve') return gateApprove(args);
  if (group === 'gate' && action === 'publish') return gatePublish(args);
  if (group === 'design' && action === 'validate') return designValidate(args);
  if (group === 'design' && action === 'migrate-sources') return designMigrateSources(args);
  if (group === 'design' && action === 'compile-defects') return designCompileDefects(args);
  if (group === 'rtm' && action === 'build') return rtmBuild(args);
  if (group === 'rtm' && action === 'fill') return rtmFill(args);
  if (group === 'board' && action === 'seed') return boardSeed(args);
  if (group === 'board' && action === 'add') return boardAdd(args);
  if (group === 'board' && action === 'verify' && args.includes('--artifact')) return teamworkBoardIntegrityVerify(args);
  if (group === 'board' && action === 'verify') return boardVerify(args);
  if (group === 'board' && action === 'init') { guardCanonicalCommand(action, args); return teamworkBoardInit(args); }
  if (group === 'board' && action === 'prepare') return teamworkBoardPrepare(args);
  if (group === 'board' && action === 'compare-page') return teamworkBoardComparePage(args);
  if (group === 'board' && action === 'validate') return teamworkBoardValidate(args);
  if (group === 'board' && action === 'render') return teamworkBoardRender(args);
  if (group === 'board' && action === 'apply') { guardCanonicalCommand(action, args); return teamworkBoardApply(args); }
  if (group === 'board' && action === 'sync') return teamworkBoardSync(args);
  if (group === 'board' && action === 'open') return teamworkBoardOpen(args);
  if (group === 'board' && action === 'deliver-blocked') return boardDeliverBlocked(args);
  if (group === 'board' && action === 'publish') return teamworkBoardPublish(args);
  if (group === 'board' && action === 'publish-next') return teamworkBoardPublishNext(args);
  if (group === 'board' && action === 'audit') return teamworkBoardAudit(args);
  if (group === 'smoke' && action === undefined) return smoke(args);
  if (group === 'report' && action === 'diagnose') return reportDiagnose(args);
  if (group === 'report' && action === 'timing') {
    const { runId } = reportRunOption(args);
    const runDir = join(process.cwd(), 'runs', runId);
    const timing = runTiming({ runDir, runId, rootTranscript: rootTranscript(runDir), projectsRoot: claudeProjectsRoot() });
    console.log(JSON.stringify({ schema: timing.schema, run_id: runId, wall: timing.wall, sources: timing.sources, summary: timing.summary, decisions: { root: timing.decisions.root.length, gui_actions: timing.decisions.gui_actions.length } }, null, 2));
    return;
  }
  if (group === 'report' && action === 'build') return reportBuild(args);
  if (group === 'report' && action === 'verify') return reportVerify(args);
  if (group === 'report' && action === 'publish') return reportPublish(args);
  if (group === 'receipt' && action === 'create') return receiptCreate(args);
  if (group === 'receipt' && action === 'verify') return receiptVerify(args);
  if (group === 'handoff' && action === 'create') return handoffCreate(args);
  if (group === 'handoff' && action === 'verify') return handoffVerify(args);
  if (group === 'handoff' && action === 'ack-verify') return handoffAckVerify(args);
  if (group === 'web' && ['requirements', 'bind', 'record', 'overlay', 'collect', 'collect-screen', 'screens'].includes(action)) return (await import('./lib/web-bind.mjs')).webCommand(action, args, { assertGovernedRelease, recordIssues, assertRecordBinding, assertPlannedSourceRefs, packageRoot: REPO_ROOT });
  if (group === 'adjudicate') return (await import('./lib/adjudicator.mjs')).adjudicatorCommand(action, args);
  if (group === 'speed') return (await import('./lib/speed-cli.mjs')).speedCommand(action, args, { parseFlags, fail, safeRunId });
  if (group === 'coverage' && action === 'verify') return coverageVerify(args);
  if (group === 'coverage' && action === 'policy') return coveragePolicy(args);
  if (group === 'retest' && action === 'select') return retestSelect(args);
  fail(2, 'COMMAND_UNKNOWN', [group, action].filter(Boolean).join(' '));
}

await runEntrypoint(dispatch);
