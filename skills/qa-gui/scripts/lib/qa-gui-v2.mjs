import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { decodePng } from '../visual-diff.mjs';
import { inspectEvidenceManifest, isObject } from './release-receipt-v2.mjs';
import { validateCanonical } from '../teamwork/canonical.mjs';
import { boardVerdict } from '../teamwork/board-gates.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INTERNAL_IDENTIFIER = /(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\b[0-9a-f]{24,64}\b)/i;
const VISION_RULES = ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];
const VERDICTS = ['PASS', 'FAIL', 'UNGRADED'];
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function triVerdict(values) {
  if (values.some((value) => value === 'FAIL')) return 'FAIL';
  if (values.length === 0 || values.some((value) => value !== 'PASS')) return 'UNGRADED';
  return 'PASS';
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function exactKeys(value, allowed, label, issue, ungraded = true) {
  if (!isObject(value)) {
    issue(`${label}:OBJECT_REQUIRED`, ungraded);
    return false;
  }
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) issue(`L22 ${label}:unknown field ${key}`, true);
  return true;
}

function rawUiVerdict(value, label, issue) {
  if (!exactKeys(value, ['id', 'verdict', 'evidence'], label, issue)) return 'UNGRADED';
  if (typeof value.id !== 'string' || !value.id) issue(`${label}:ID_REQUIRED`, true);
  if (typeof value.evidence !== 'string' || !value.evidence) issue(`${label}:RAW_EVIDENCE_REQUIRED`, true);
  if (!VERDICTS.includes(value.verdict)) {
    issue(`${label}:VERDICT_INVALID`, true);
    return 'UNGRADED';
  }
  return value.verdict;
}

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function entryFor(paths, ref, label, issue, expected = {}) {
  const found = paths.get(ref);
  if (!found) {
    issue(`EVIDENCE_REFERENCE_MISSING:${label}:${String(ref)}`);
    return null;
  }
  const { entry } = found;
  if (expected.type && entry.evidence_type !== expected.type) {
    issue(`EVIDENCE_TYPE_MISMATCH:${label}:${entry.evidence_type}:${expected.type}`);
  }
  if (expected.caseId && entry.metadata?.case_id !== expected.caseId) {
    issue(`EVIDENCE_METADATA_CASE_MISMATCH:${label}:${entry.metadata?.case_id || 'missing'}:${expected.caseId}`);
  }
  if (expected.state && entry.metadata?.state !== expected.state) {
    issue(`EVIDENCE_METADATA_STATE_MISMATCH:${label}:${entry.metadata?.state || 'missing'}:${expected.state}`);
  }
  return found;
}

function pngEvidence(paths, ref, label, issue, expected) {
  const found = entryFor(paths, ref, label, issue, { ...expected, type: 'gui-screenshot' });
  if (!found) return null;
  try { decodePng(readFileSync(found.absolute)); }
  catch (error) {
    issue(`VISION_PNG_INVALID:${label}:${ref}:${error.message}`);
    return null;
  }
  return found;
}

function checkBoardPath(boardPath, root) {
  const errors = [];
  try {
    const requested = resolve(boardPath);
    if (lstatSync(requested).isSymbolicLink()) errors.push('BOARD_SYMLINK');
    const real = realpathSync(requested);
    if (!lstatSync(real).isFile()) errors.push('BOARD_NOT_REGULAR');
    if (!inside(root, real)) errors.push('BOARD_OUTSIDE_EVIDENCE_ROOT');
  } catch (error) {
    errors.push(`BOARD_UNREADABLE:${error.message}`);
  }
  return errors;
}

function validateVisionAssertion(assertion, label, paths, issue, { caseId, state } = {}) {
  const risk = Object.hasOwn(assertion ?? {}, 'risk_dimension') || Object.hasOwn(assertion ?? {}, 'scenario');
  const allowed = [
    'assertion_id', 'case_id', 'state', 'verdict', 'evidence_ref', 'evidence_type',
    ...(risk ? ['requirement_id', 'risk_dimension', 'scenario', 'observed_internal_identifiers', 'observed_order'] : ['rule']),
  ];
  if (!exactKeys(assertion, allowed, label, issue)) return null;
  for (const key of ['assertion_id', 'case_id', 'state', 'evidence_ref', 'evidence_type']) {
    if (typeof assertion[key] !== 'string' || !assertion[key]) issue(`${label}:${key.toUpperCase()}_REQUIRED`, true);
  }
  if (!VERDICTS.includes(assertion.verdict)) issue(`${label}:VERDICT_INVALID`, true);
  if (assertion.evidence_type !== 'gui-screenshot') issue(`EVIDENCE_TYPE_MISMATCH:${label}:${assertion.evidence_type}:gui-screenshot`);
  const found = pngEvidence(paths, assertion.evidence_ref, label, issue, {
    caseId: caseId ?? assertion.case_id,
    state: state ?? assertion.state,
  });
  if (assertion.verdict === 'FAIL') issue(`VISION_ASSERTION_FAIL:${label}`);
  if (assertion.verdict === 'UNGRADED') issue(`VISION_ASSERTION_UNGRADED:${label}`, true);
  return found;
}

function checkVision(data, context, paths, issue) {
  const vision = data.vision;
  if (!isObject(vision) || vision.version !== 2 || !Array.isArray(vision.assertions)) {
    issue('VISION_V2_REQUIRED:schemaVersion=5_or_6', true);
    return;
  }
  const assertions = vision.assertions;
  const completed = (data.cases ?? []).filter((entry) => entry?.status !== 'TODO');
  for (const testCase of completed) {
    for (const state of Array.isArray(testCase.states) ? testCase.states : []) {
      for (const rule of VISION_RULES) {
        const matches = assertions.filter((entry) => entry?.case_id === testCase.id && entry?.state === state && entry?.rule === rule);
        if (matches.length === 0) {
          issue(`VISION_ASSERTION_MISSING:${testCase.id}:${state}:${rule}`, true);
          continue;
        }
        if (matches.length > 1) issue(`VISION_ASSERTION_DUPLICATE:${testCase.id}:${state}:${rule}`);
        for (const [index, assertion] of matches.entries()) {
          validateVisionAssertion(assertion, `vision:${testCase.id}:${state}:${rule}:${index}`, paths, issue, {
            caseId: testCase.id,
            state,
          });
        }
      }
    }
  }

  const caseByRequirement = new Map();
  for (const testCase of completed) {
    for (const requirementId of Array.isArray(testCase.requirements) ? testCase.requirements : []) {
      if (!caseByRequirement.has(requirementId)) caseByRequirement.set(requirementId, []);
      caseByRequirement.get(requirementId).push(testCase);
    }
  }
  for (const requirement of context.activeGuiRequirements) {
    const scenarios = [];
    if (requirement.risk_dimensions.includes('stable-identity')) scenarios.push(['stable-identity', 'hidden-ui-identity']);
    if (requirement.risk_dimensions.includes('ordered-setup')) {
      scenarios.push(['ordered-setup', 'same-session-mutation-read'], ['ordered-setup', 'fresh-load']);
    }
    for (const testCase of caseByRequirement.get(requirement.id) ?? []) {
      for (const state of testCase.states ?? []) {
        const orderByScenario = new Map();
        for (const [dimension, scenario] of scenarios) {
          const matches = assertions.filter((entry) => entry?.case_id === testCase.id
            && entry?.state === state
            && entry?.requirement_id === requirement.id
            && entry?.risk_dimension === dimension
            && entry?.scenario === scenario);
          if (matches.length === 0) {
            issue(`RISK_ASSERTION_MISSING:${requirement.id}:${scenario}`, true);
            continue;
          }
          if (matches.length > 1) issue(`RISK_ASSERTION_DUPLICATE:${requirement.id}:${scenario}`);
          for (const [index, assertion] of matches.entries()) {
            validateVisionAssertion(assertion, `risk:${requirement.id}:${scenario}:${index}`, paths, issue, {
              caseId: testCase.id,
              state,
            });
            if (scenario === 'hidden-ui-identity') {
              if (!Array.isArray(assertion.observed_internal_identifiers)) {
                issue(`RISK_OBSERVATION_MISSING:${requirement.id}:${scenario}`, true);
              } else {
                for (const value of assertion.observed_internal_identifiers) {
                  if (INTERNAL_IDENTIFIER.test(String(value))) issue(`INTERNAL_ID_EXPOSED:${requirement.id}:${value}`);
                }
              }
            }
            if (dimension === 'ordered-setup') {
              if (!Array.isArray(assertion.observed_order) || assertion.observed_order.length === 0) {
                issue(`RISK_OBSERVATION_MISSING:${requirement.id}:${scenario}`, true);
              } else {
                orderByScenario.set(scenario, JSON.stringify(assertion.observed_order));
              }
            }
          }
        }
        if (orderByScenario.size === 2
          && new Set(orderByScenario.values()).size !== 1) issue(`ORDERED_PROJECTION_MISMATCH:${requirement.id}`);
      }
    }
  }
}

function checkDwell(receipt, planCase, requirement, label, issue) {
  const network = Array.isArray(receipt.network) ? receipt.network : [];
  const actualFailures = network.filter((entry) => Number.isInteger(entry?.status) && entry.status >= 400).length;
  if (!isObject(receipt.network_summary) || !Number.isInteger(receipt.network_summary.failed_requests)) {
    issue(`NETWORK_SUMMARY_REQUIRED:${label}`, true);
  } else if (receipt.network_summary.failed_requests !== actualFailures) {
    issue(`NETWORK_SUMMARY_MISMATCH:${label}:failed_requests:${receipt.network_summary.failed_requests}:${actualFailures}`);
  }

  const settling = planCase?.data?.settling;
  if (settling?.required !== true) return;
  if (!requirement?.risk_dimensions?.includes('live-projection-cache')) {
    issue(`DWELL_ASYNC_RISK_MISSING:${requirement?.id || label}`, true);
  }
  if (!Number.isInteger(settling.window_ms) || settling.window_ms < 120000) {
    issue(`DWELL_WINDOW_TOO_SHORT:${label}:${settling?.window_ms || 'missing'}`, true);
  }
  const timestamps = [];
  for (const [index, entry] of network.entries()) {
    if (!validDate(entry.ts)) issue(`DWELL_TIMESTAMP_MISSING:${label}:network[${index}]`, true);
    else timestamps.push(Date.parse(entry.ts));
  }
  if (timestamps.length > 0 && Math.max(...timestamps) - Math.min(...timestamps) < settling.window_ms) {
    issue(`DWELL_WINDOW_INCOMPLETE:${label}:${Math.max(...timestamps) - Math.min(...timestamps)}:${settling.window_ms}`, true);
  }
  const failures = new Map();
  for (const entry of network.filter((item) => Number.isInteger(item?.status) && item.status >= 400)) {
    const key = `${String(entry.method || '').toUpperCase()}\u0000${entry.url}\u0000${entry.status}`;
    failures.set(key, (failures.get(key) ?? 0) + 1);
  }
  for (const [key, count] of failures) {
    if (count < 2) continue;
    const [method, url, status] = key.split('\u0000');
    issue(`DWELL_REPEATED_REQUEST_FAILURE:${label}:${method}:${status}:${url}:${count}`);
  }
}

export function checkGuiReleaseTruthV2({ data, boardPath, evidenceRoot, context }) {
  const issues = [];
  const notes = [];
  const atomicCoverage = [];
  let receiptEligible = true;
  const issue = (message, ungraded = false) => {
    issues.push({ message, ungraded });
    if (web && /^(WEB_|state-receipt:.*:(TARGET_BINDING_MISMATCH|PREVIEW_ORIGIN_MISMATCH))/.test(message)) receiptEligible = false;
  };
  const web = context.kind === 'deployed-build';

  for (const [field, value] of [
    ['build', data.build], ['env', data.env], ['db', data.db], ['role', data.role], ['testProfile', data.testProfile],
  ]) {
    if (typeof value !== 'string' || !value.trim()) issue(`${field.toUpperCase()}_BINDING_REQUIRED`, true);
  }
  if (!UUID.test(data.runUuid || '')) issue('RUN_UUID_INVALID', true);
  if (web) {
    if (Object.hasOwn(data, 'commit')) issue('WEB_BOARD_COMMIT_FORBIDDEN', true);
    if (data.runUuid !== context.binding.run_uuid) issue('WEB_RUN_UUID_MISMATCH', true);
    if (data.targetBindingSha256 !== context.targetBindingSha256) issue('WEB_TARGET_BINDING_MISMATCH', true);
    if (data.build !== context.target.frontend_build.id || data.build !== context.target.version) issue('WEB_BUILD_ID_MISMATCH', true);
    if (String(data.env || '').toLowerCase() !== context.target.environment.toLowerCase()) issue('WEB_ENVIRONMENT_MISMATCH', true);
  } else {
    if (!SHA40.test(data.commit || '')) issue('BOARD_COMMIT_INVALID', true);
    else if (data.commit !== context.exactFinalSha) issue(`BOARD_COMMIT_MISMATCH:${data.commit}:${context.exactFinalSha}`);
  }

  const completedCases = (Array.isArray(data.cases) ? data.cases : []).filter((entry) => entry?.status !== 'TODO');
  const validCaseStates = new Set();
  for (const testCase of completedCases) {
    for (const state of Array.isArray(testCase.states) ? testCase.states : []) validCaseStates.add(`${testCase.id}\u0000${state}`);
  }
  const inspected = inspectEvidenceManifest(data.evidenceManifest, {
    evidenceRoot,
    runUuid: data.runUuid,
    taskBase: context.taskBase,
    exactFinalSha: context.exactFinalSha,
    targetBindingSha256: web ? context.targetBindingSha256 : null,
    validCaseStates,
  });
  for (const error of inspected.errors) issue(error);
  if (!inspected.physicalValid) receiptEligible = false;
  if (inspected.root) {
    const boardErrors = checkBoardPath(boardPath, inspected.root);
    for (const error of boardErrors) issue(error);
    if (boardErrors.length > 0) receiptEligible = false;
  }

  const activeById = new Map(context.activeGuiRequirements.map((entry) => [entry.id, entry]));
  const assertionGroups = new Map(context.guiIds.map((id) => [id, []]));
  const assertionIds = new Set();
  const computed = {
    cases: [], functionParts: [], uiParts: [], functionVerdict: 'PASS', uiVerdict: 'PASS',
    acceptance: { covered: 0, total: context.guiIds.length },
  };

  for (const testCase of completedCases) {
    const caseId = testCase?.id || '<missing>';
    const planCase = context.planById.get(caseId);
    if (!planCase) issue(`BOARD_CASE_NOT_IN_PLAN:${caseId}`);
    const requirements = Array.isArray(testCase.requirements) ? testCase.requirements : [];
    if (requirements.length === 0) issue(`GUI_CASE_REQUIREMENTS_MISSING:${caseId}`, true);
    if (planCase && !requirements.includes(planCase.requirementId)) issue(`BOARD_PLAN_REQUIREMENT_MISMATCH:${caseId}:${planCase.requirementId}`);
    for (const requirementId of requirements) {
      const requirement = activeById.get(requirementId);
      if (!requirement) issue(`GUI_REQUIREMENT_OUTSIDE_LANE:${caseId}:${requirementId}`);
      else if (!requirement.acceptance_ids.includes(caseId)) issue(`BOARD_ACCEPTANCE_ID_MISMATCH:${caseId}:${requirementId}`);
    }
    for (const ref of Array.isArray(testCase.evidence) ? testCase.evidence : []) {
      if (!inspected.paths.has(ref)) {
        issue(`CASE_EVIDENCE_NOT_IN_MANIFEST:${caseId}:${ref}`);
        receiptEligible = false;
      }
    }

    const states = Array.isArray(testCase.states) ? testCase.states : [];
    const stateLinks = Array.isArray(testCase.stateReceipts) ? testCase.stateReceipts : [];
    const caseFunction = [];
    const caseUi = [];
    const caseAssertions = [];
    let derivedBehavioral = false;
    if (states.length === 0) issue(`GUI_CASE_STATES_MISSING:${caseId}`, true);

    for (const state of states) {
      const matches = stateLinks.filter((entry) => entry?.state === state);
      if (matches.length !== 1) {
        issue(`STATE_RECEIPT_COUNT:${caseId}:${state}:${matches.length}`, true);
        receiptEligible = false;
        caseFunction.push('UNGRADED');
        caseUi.push('UNGRADED');
        continue;
      }
      const receiptRef = matches[0].file;
      if (!(testCase.evidence ?? []).includes(receiptRef)) issue(`STATE_RECEIPT_NOT_IN_CASE_EVIDENCE:${caseId}:${state}:${receiptRef}`);
      const receiptEvidence = entryFor(inspected.paths, receiptRef, `state-receipt:${caseId}:${state}`, issue, {
        type: 'machine-receipt', caseId, state,
      });
      if (!receiptEvidence) {
        receiptEligible = false;
        caseFunction.push('UNGRADED');
        caseUi.push('UNGRADED');
        continue;
      }
      let receipt;
      try { receipt = JSON.parse(readFileSync(receiptEvidence.absolute, 'utf8')); }
      catch (error) {
        issue(`STATE_RECEIPT_INVALID_JSON:${caseId}:${state}:${error.message}`, true);
        receiptEligible = false;
        continue;
      }
      const label = `state-receipt:${caseId}:${state}`;
      exactKeys(receipt, [
        'schema', 'caseId', 'state', 'capturedAt', 'url', 'build', 'viewport', 'domHash',
        'dragon', 'screenshot', 'function', 'ui', 'preflight', 'auth', 'network',
        'network_summary', 'readback', 'lifecycle', 'equivalentTo', 'equivalenceReason',
        ...(web ? ['targetBindingSha256'] : []),
      ], label, issue);
      if (receipt.schema !== 'qa-gui/state-receipt/v1') issue(`${label}:SCHEMA_INVALID`, true);
      if (receipt.caseId !== caseId || receipt.state !== state) issue(`${label}:CASE_STATE_MISMATCH`, true);
      if (receipt.build !== data.build || receipt.viewport !== data.viewport) issue(`${label}:BUILD_VIEWPORT_MISMATCH`, true);
      if (web && receipt.targetBindingSha256 !== context.targetBindingSha256) issue(`${label}:TARGET_BINDING_MISMATCH`, true);
      if (!validDate(receipt.capturedAt)) issue(`${label}:CAPTURED_AT_INVALID`, true);
      if (typeof receipt.url !== 'string' || !/^https?:\/\//.test(receipt.url)) issue(`${label}:URL_INVALID`, true);
      else if (web) {
        try { if (new URL(receipt.url).origin !== new URL(context.target.preview_url).origin) issue(`${label}:PREVIEW_ORIGIN_MISMATCH`); }
        catch { issue(`${label}:PREVIEW_URL_INVALID`, true); }
      }
      if (!SHA256.test(receipt.domHash || '')) issue(`${label}:DOM_HASH_INVALID`, true);
      exactKeys(receipt.dragon, ['sessionId', 'actionId', 'browserInstanceId', 'tabId', 'innerOk'], `${label}.dragon`, issue);
      for (const field of ['sessionId', 'actionId', 'browserInstanceId', 'tabId']) {
        if (typeof receipt?.dragon?.[field] !== 'string' || !receipt.dragon[field]) issue(`${label}:DRAGON_${field.toUpperCase()}_MISSING`, true);
      }
      if (receipt?.dragon?.innerOk !== true) issue(`${label}:DRAGON_INNER_NOT_OK`, true);

      exactKeys(receipt.screenshot, ['path', 'sha256'], `${label}.screenshot`, issue);
      const screenshot = pngEvidence(inspected.paths, receipt?.screenshot?.path, `${label}:screenshot`, issue, { caseId, state });
      if (!screenshot) receiptEligible = false;
      else if (receipt.screenshot.sha256 !== screenshot.entry.sha256) issue(`SCREENSHOT_HASH_MISMATCH:${caseId}:${state}`);

      exactKeys(receipt.function, ['verdict', 'assertions'], `${label}.function`, issue);
      const assertions = Array.isArray(receipt?.function?.assertions) ? receipt.function.assertions : [];
      if (assertions.length === 0) issue(`ATOMIC_ASSERTIONS_MISSING:${caseId}:${state}`, true);
      const stateFunction = [];
      for (const [index, assertion] of assertions.entries()) {
        const assertionLabel = `${label}.function.assertions[${index}]`;
        if (!exactKeys(assertion, ['requirement_id', 'assertion_id', 'verdict', 'evidence_ref', 'evidence_type'], assertionLabel, issue)) {
          stateFunction.push('UNGRADED');
          continue;
        }
        const verdict = VERDICTS.includes(assertion.verdict) ? assertion.verdict : 'UNGRADED';
        if (verdict !== assertion.verdict) issue(`${assertionLabel}:VERDICT_INVALID`, true);
        stateFunction.push(verdict);
        const requirement = activeById.get(assertion.requirement_id);
        if (!requirement) issue(`ATOMIC_REQUIREMENT_OUTSIDE_GUI_LANE:${assertion.requirement_id}`);
        else if (!requirements.includes(assertion.requirement_id)) issue(`ATOMIC_REQUIREMENT_NOT_DECLARED_BY_CASE:${caseId}:${assertion.requirement_id}`);
        if (typeof assertion.assertion_id !== 'string' || !assertion.assertion_id) issue(`${assertionLabel}:ASSERTION_ID_REQUIRED`, true);
        else if (assertionIds.has(assertion.assertion_id)) issue(`ATOMIC_ASSERTION_DUPLICATE:${assertion.assertion_id}`);
        else assertionIds.add(assertion.assertion_id);
        const evidence = entryFor(inspected.paths, assertion.evidence_ref, assertionLabel, issue, { caseId, state });
        if (evidence && assertion.evidence_type !== evidence.entry.evidence_type) {
          issue(`EVIDENCE_TYPE_MISMATCH:${assertion.requirement_id}:${assertion.evidence_type}:${evidence.entry.evidence_type}`);
        }
        if (requirement && (!requirement.evidence_contract.allowed_types.includes(assertion.evidence_type)
          || (verdict === 'PASS' && !assertion.evidence_type.startsWith('gui-')))) {
          issue(`EVIDENCE_TYPE_MISMATCH:${assertion.requirement_id}:${assertion.evidence_type}`);
        }
        if (evidence && requirement && assertion.assertion_id) {
          const row = {
            requirement_id: assertion.requirement_id,
            assertion_id: assertion.assertion_id,
            case_id: caseId,
            evidence_ref: assertion.evidence_ref,
            evidence_sha256: evidence.entry.sha256,
            evidence_type: assertion.evidence_type,
            result: verdict,
          };
          atomicCoverage.push(row);
          caseAssertions.push(row);
          assertionGroups.get(assertion.requirement_id)?.push(row);
        }
      }
      const functionVerdict = triVerdict(stateFunction);
      if (receipt?.function?.verdict !== functionVerdict) issue(`FUNCTION_VERDICT_MISMATCH:${caseId}:${state}:${receipt?.function?.verdict}:${functionVerdict}`);
      caseFunction.push(functionVerdict);

      exactKeys(receipt.ui, ['verdict', 'uiSanity', 'a11y', 'console', 'network'], `${label}.ui`, issue);
      const stateUi = ['uiSanity', 'a11y', 'console', 'network']
        .map((field) => rawUiVerdict(receipt?.ui?.[field], `${label}.ui.${field}`, issue));
      stateUi.push(rawUiVerdict(receipt.preflight, `${label}.preflight`, issue));
      const uiVerdict = triVerdict(stateUi);
      if (receipt?.ui?.verdict !== uiVerdict) issue(`UI_VERDICT_MISMATCH:${caseId}:${state}:${receipt?.ui?.verdict}:${uiVerdict}`);
      caseUi.push(uiVerdict);

      const network = Array.isArray(receipt.network) ? receipt.network : [];
      for (const [index, entry] of network.entries()) {
        exactKeys(entry, ['method', 'url', 'status', 'ts'], `${label}.network[${index}]`, issue);
        const method = String(entry?.method || '').toUpperCase();
        if (!method || typeof entry?.url !== 'string' || !Number.isInteger(entry?.status)) issue(`${label}.network[${index}]:INVALID`, true);
        if (MUTATING_METHODS.has(method)) derivedBehavioral = true;
      }
      const primaryRequirement = activeById.get(planCase?.requirementId);
      checkDwell(receipt, planCase, primaryRequirement, label, issue);

      if (planCase?.data?.auth_required === true) {
        const loginNotReached = receipt?.auth?.applicationLoginNotReached === true
          || receipt?.readback?.authState?.applicationLoginNotReached === true;
        if (loginNotReached) issue(`AUTH_PRECONDITION_UNMET:${planCase.requirementId}:applicationLoginNotReached`, true);
        if (receipt?.auth?.required !== true) issue(`AUTH_PRECONDITION_UNPROVEN:${planCase.requirementId}:required`, true);
        const authRef = receipt?.auth?.authenticated_screen_evidence_ref;
        if (!authRef || !pngEvidence(inspected.paths, authRef, `auth:${caseId}:${state}`, issue, { caseId, state })) {
          issue(`AUTH_PRECONDITION_UNPROVEN:${planCase.requirementId}:authenticated_screen`, true);
        }
      }
    }

    if (web && testCase.kind === 'behavioral') {
      const segments = Array.isArray(testCase.recordingSegments) ? testCase.recordingSegments : [];
      if (segments.length === 0) issue(`BEHAVIORAL_RECORDING_REQUIRED:${caseId}`, true);
      for (const segment of segments) {
        const recording = inspected.paths.get(segment?.file);
        if (!recording || !String(segment.file).toLowerCase().endsWith('.mp4')) issue(`BEHAVIORAL_RECORDING_MISSING:${caseId}:${segment?.file || 'missing'}`, true);
        else if (lstatSync(recording.absolute).size < 50 * 1024) issue(`BEHAVIORAL_RECORDING_TOO_SMALL:${caseId}:${segment.file}`, true);
        if (!Number.isFinite(segment?.startMs) || !Number.isFinite(segment?.endMs) || segment.startMs < 0 || segment.endMs <= segment.startMs) issue(`BEHAVIORAL_RECORDING_SEGMENT_INVALID:${caseId}`, true);
        if (!testCase.evidence?.includes(segment?.file)) issue(`BEHAVIORAL_RECORDING_NOT_IN_CASE:${caseId}:${segment?.file || 'missing'}`, true);
      }
    }
    const functionVerdict = triVerdict(caseFunction);
    const uiVerdict = triVerdict(caseUi);
    if (functionVerdict === 'FAIL' || uiVerdict === 'FAIL') issue(`CASE_RECEIPT_SEMANTIC_FAIL:${caseId}`);
    if (functionVerdict === 'UNGRADED' || uiVerdict === 'UNGRADED') issue(`CASE_RECEIPT_UNGRADED:${caseId}`, true);
    if (testCase.functionVerdict !== functionVerdict) issue(`BOARD_FUNCTION_VERDICT_MISMATCH:${caseId}:${testCase.functionVerdict}:${functionVerdict}`);
    if (testCase.uiVerdict !== uiVerdict) issue(`BOARD_UI_VERDICT_MISMATCH:${caseId}:${testCase.uiVerdict}:${uiVerdict}`);
    if (derivedBehavioral && testCase.kind !== 'behavioral') issue(`DERIVED_BEHAVIORAL_KIND_MISMATCH:${caseId}`);
    computed.cases.push({ id: caseId, requirements, assertions: caseAssertions, kind: testCase.kind });
    computed.functionParts.push(functionVerdict);
    computed.uiParts.push(uiVerdict);
  }

  for (const requirementId of context.guiIds) {
    const rows = assertionGroups.get(requirementId) ?? [];
    if (rows.length === 0) issue(`GUI_REQUIREMENT_MISSING:${requirementId}`);
    else if (rows.some((row) => row.result === 'PASS')) computed.acceptance.covered += 1;
  }
  checkVision(data, context, inspected.paths, issue);

  const openDefects = (data.defects ?? []).filter((entry) => !['CLOSED', 'REJECTED', 'closed', 'rejected'].includes(entry?.status));
  if (data.release?.verdict === 'GO') {
    for (const testCase of completedCases) {
      if (['FAIL', 'BLOCKED'].includes(testCase.status)
        || testCase.functionVerdict !== 'PASS'
        || testCase.uiVerdict !== 'PASS') issue(`RELEASE_GO_BLOCKED_BY_CASE:${testCase.id}`);
    }
    for (const defect of openDefects) issue(`RELEASE_GO_BLOCKED_BY_DEFECT:${defect.id}`);
  }
  computed.functionVerdict = triVerdict(computed.functionParts);
  computed.uiVerdict = triVerdict(computed.uiParts);
  notes.push(`Requirements: ${computed.acceptance.covered}/${computed.acceptance.total}`);
  return {
    issues,
    notes,
    computed,
    atomicCoverage,
    receiptEligible,
  };
}

export function evaluateGuiWebRun({ data, boardPath, evidenceRoot, context }) {
  if (context?.kind !== 'deployed-build' || !context?.sourceProof) throw new Error('VERIFIED_WEB_CONTEXT_REQUIRED');
  if (![5, 6].includes(data?.schemaVersion)) throw new Error('WEB_BOARD_SCHEMA_5_OR_6_REQUIRED');
  const canonical = validateCanonical(data);
  if (!canonical.ok) return {
    verdict: 'UNGRADED', issues: canonical.errors.map((entry) => ({ message: entry.path + ': ' + entry.message, ungraded: true })),
    receiptEligible: false, atomicCoverage: [], computed: null,
  };
  const checked = checkGuiReleaseTruthV2({ data, boardPath, evidenceRoot, context });
  return { ...checked, verdict: boardVerdict(checked.issues) };
}
