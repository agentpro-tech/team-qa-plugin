import { readFileSync } from 'node:fs';

import { boardVerdict, findingEvidenceErrors, proseLanguageErrors, requiredFieldErrors } from './board-gates.mjs';

export const TEAMWORK_STATUSES = Object.freeze([
  'TODO',
  'DOING',
  'PASS',
  'FAIL',
  'BLOCKED',
  'ASSIGNED',
  'FIXING',
  'RETEST',
  'VERIFIED',
  'CLOSED',
  'REOPENED',
  'REJECTED',
  'DEFERRED',
]);

export const TEAMWORK_PRIORITIES = Object.freeze(['P1', 'P2', 'P3', 'P4']);
export const REJECTION_REASONS = Object.freeze(['cannot-reproduce', 'as-designed', 'duplicate']);
export const SOURCE_TRACEABILITY_SCHEMA_VERSION = 6;
export const LEGACY_CANONICAL_VERSION = 'qa-board-teamwork/v1';
export const SOURCE_TRACEABILITY_CANONICAL_VERSION = 'qa-board-teamwork/v2';

const schema = JSON.parse(readFileSync(new URL('./canonical.schema.json', import.meta.url), 'utf8'));

// A deployed-build (web-v1) board declares `targetBindingSha256` instead of `commit`, and its evidence metadata binds
// `target_binding_sha256` instead of the Git `task_base`/`commit` (references/release-receipt-web-v1.md). Its
// behavioral cases carry the `recordingSegments` the web gate requires. Such a board validates against this variant;
// every other board validates against the schema exactly as before.
const deployedBuildSchema = (() => {
  const web = structuredClone(schema);
  delete web.properties.commit;
  web.properties.targetBindingSha256 = { $ref: '#/$defs/targetBindingSha256' };
  web.$defs.evidenceManifestEntry.properties.metadata = { $ref: '#/$defs/evidenceMetadataWeb' };
  web.$defs.case.properties.recordingSegments = { $ref: '#/$defs/recordingSegments' };
  return web;
})();

export function isDeployedBuildBoard(data) {
  return data !== null && typeof data === 'object' && !Array.isArray(data) && Object.hasOwn(data, 'targetBindingSha256');
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function resolveRef(ref, root) {
  return ref.replace(/^#\//, '').split('/').reduce((value, key) => value?.[key], root);
}

function validateNode(rule, value, path, errors, root = schema) {
  if (!rule) return;
  if (rule.$ref) return validateNode(resolveRef(rule.$ref, root), value, path, errors, root);
  if (rule.anyOf) {
    const accepted = rule.anyOf.some((candidate) => {
      const candidateErrors = [];
      validateNode(candidate, value, path, candidateErrors, root);
      return candidateErrors.length === 0;
    });
    if (!accepted) errors.push({ path: path || 'root', message: 'does not match an allowed value' });
    return;
  }

  if (rule.type) {
    const actual = valueType(value);
    if (actual !== rule.type) {
      errors.push({ path: path || 'root', message: `expected ${rule.type}, got ${actual}` });
      return;
    }
  }
  if (rule.enum && !rule.enum.includes(value)) {
    errors.push({ path: path || 'root', message: `value ${JSON.stringify(value)} is not allowed` });
  }
  if (typeof value === 'string') {
    if (rule.minLength != null && value.length < rule.minLength) errors.push({ path, message: `must contain at least ${rule.minLength} character` });
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push({ path, message: `must match ${rule.pattern}` });
  }
  if (typeof value === 'number' && rule.minimum != null && value < rule.minimum) {
    errors.push({ path, message: `must be at least ${rule.minimum}` });
  }
  if (Array.isArray(value)) {
    if (rule.minItems != null && value.length < rule.minItems) errors.push({ path, message: `must contain at least ${rule.minItems} item` });
    if (rule.items && Object.keys(rule.items).length > 0) value.forEach((item, index) => validateNode(rule.items, item, `${path}[${index}]`, errors, root));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of rule.required || []) {
      if (!Object.hasOwn(value, required)) errors.push({ path: path ? `${path}.${required}` : required, message: `missing required field ${required}` });
    }
    for (const [key, childRule] of Object.entries(rule.properties || {})) {
      if (Object.hasOwn(value, key)) validateNode(childRule, value[key], path ? `${path}.${key}` : key, errors, root);
    }
    if (rule.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(rule.properties || {}, key)) {
          errors.push({
            path: path ? `${path}.${key}` : key,
            message: `L22 unknown field ${key}; additional properties are not allowed`,
            ungraded: true,
          });
        }
      }
    }
  }
}

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function addDateError(errors, path, value) {
  if (!validDate(value)) errors.push({ path, message: 'must be an ISO date-time' });
}

function duplicateIds(items) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== 'string') continue;
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

function sourceTraceabilityErrors(data) {
  const errors = [];
  const cases = Array.isArray(data?.cases) ? data.cases : [];
  const legacy = data?.schemaVersion === 4 || data?.schemaVersion === 5;
  if (legacy) {
    if (data.canonicalVersion !== LEGACY_CANONICAL_VERSION) {
      errors.push({ path: 'canonicalVersion', message: `schema ${data.schemaVersion} requires ${LEGACY_CANONICAL_VERSION}` });
    }
    if (Object.hasOwn(data, 'boardKind')) errors.push({ path: 'boardKind', message: 'source traceability fields require schema 6' });
    if (Object.hasOwn(data, 'sourceItems')) errors.push({ path: 'sourceItems', message: 'source traceability fields require schema 6' });
    cases.forEach((entry, index) => {
      if (Object.hasOwn(entry || {}, 'sourceRefs')) errors.push({ path: `cases[${index}].sourceRefs`, message: 'source traceability fields require schema 6' });
    });
    return errors;
  }
  if (data?.schemaVersion !== SOURCE_TRACEABILITY_SCHEMA_VERSION) return errors;

  if (data.canonicalVersion !== SOURCE_TRACEABILITY_CANONICAL_VERSION) {
    errors.push({ path: 'canonicalVersion', message: `schema 6 requires ${SOURCE_TRACEABILITY_CANONICAL_VERSION}` });
  }
  if (data.boardKind !== 'team-qa-board') {
    errors.push({ path: 'boardKind', message: 'schema 6 requires boardKind team-qa-board' });
  }
  if (!Array.isArray(data.sourceItems)) {
    errors.push({ path: 'sourceItems', message: 'schema 6 requires a source registry array' });
    return errors;
  }

  const sourceIds = new Map();
  const externalIdentities = new Map();
  data.sourceItems.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    if (typeof item.id === 'string') {
      if (sourceIds.has(item.id)) errors.push({ path: `sourceItems[${index}].id`, message: `duplicate source id ${item.id}` });
      else sourceIds.set(item.id, index);
    }
    if (typeof item.sourceSystem === 'string' && typeof item.externalKey === 'string') {
      const identity = `${item.sourceSystem}\u0000${item.externalKey}`;
      if (externalIdentities.has(identity)) {
        errors.push({ path: `sourceItems[${index}].externalKey`, message: `duplicate source identity ${item.sourceSystem}:${item.externalKey}` });
      } else externalIdentities.set(identity, index);
    }
    if (item.origin === 'qa-derived') {
      if (item.kind !== 'qa-derived') errors.push({ path: `sourceItems[${index}].kind`, message: 'qa-derived origin requires kind qa-derived' });
      if (typeof item.qaDerivedReason !== 'string' || item.qaDerivedReason.trim().length === 0) {
        errors.push({ path: `sourceItems[${index}].qaDerivedReason`, message: 'qa-derived source requires an explicit reason' });
      }
    } else if (item.origin === 'upstream') {
      if (item.kind === 'qa-derived') errors.push({ path: `sourceItems[${index}].origin`, message: 'kind qa-derived cannot impersonate an upstream origin' });
      if (Object.hasOwn(item, 'qaDerivedReason')) errors.push({ path: `sourceItems[${index}].qaDerivedReason`, message: 'upstream source cannot declare a QA-derived reason' });
    }
  });

  cases.forEach((entry, caseIndex) => {
    if (!Array.isArray(entry?.sourceRefs) || entry.sourceRefs.length === 0) {
      errors.push({ path: `cases[${caseIndex}].sourceRefs`, message: `${entry?.id || 'case'} requires at least one explicit source reference` });
      return;
    }
    const seen = new Set();
    entry.sourceRefs.forEach((sourceRef, sourceIndex) => {
      if (seen.has(sourceRef)) errors.push({ path: `cases[${caseIndex}].sourceRefs`, message: `duplicate ${sourceRef}` });
      seen.add(sourceRef);
      if (typeof sourceRef === 'string' && !sourceIds.has(sourceRef)) {
        errors.push({ path: `cases[${caseIndex}].sourceRefs[${sourceIndex}]`, message: `unknown source ref ${sourceRef}` });
      }
    });
  });
  return errors;
}

function semanticErrors(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return errors;
  addDateError(errors, 'boardCreated', data.boardCreated);

  const cases = Array.isArray(data.cases) ? data.cases : [];
  const defects = Array.isArray(data.defects) ? data.defects : [];
  const rounds = Array.isArray(data.rounds) ? data.rounds : [];
  const caseIds = new Set(cases.map((entry) => entry?.id).filter(Boolean));
  const roundIds = new Set(rounds.map((entry) => entry?.round).filter(Number.isInteger));

  for (const id of duplicateIds(cases)) errors.push({ path: 'cases', message: `duplicate case id ${id}` });
  for (const id of duplicateIds(defects)) errors.push({ path: 'defects', message: `duplicate defect id ${id}` });
  if (Number.isInteger(data.currentRound) && !roundIds.has(data.currentRound)) {
    errors.push({ path: 'currentRound', message: `round ${data.currentRound} is missing from rounds` });
  }

  rounds.forEach((round, index) => addDateError(errors, `rounds[${index}].startedAt`, round?.startedAt));
  cases.forEach((entry, caseIndex) => {
    const work = entry?.work;
    if (work && typeof work === 'object' && !Array.isArray(work)) {
      const workPath = `cases[${caseIndex}].work`;
      if (Array.isArray(work.remainingChecks) && new Set(work.remainingChecks).size !== work.remainingChecks.length) {
        errors.push({ path: `${workPath}.remainingChecks`, message: 'entries must be unique' });
      }
      if (work.state === 'running' && (typeof work.workerSessionId !== 'string' || !work.workerSessionId.trim())) {
        errors.push({ path: `${workPath}.workerSessionId`, message: 'running work requires a worker session' });
      }
      if (work.state === 'blocked' && (!work.blocker || typeof work.blocker !== 'object' || Array.isArray(work.blocker))) {
        errors.push({ path: `${workPath}.blocker`, message: 'blocked work requires a blocker' });
      }
      if (work.state !== 'blocked' && Object.hasOwn(work, 'blocker')) {
        errors.push({ path: `${workPath}.blocker`, message: 'only blocked work may carry a blocker' });
      }
      if (work.state === 'blocked' && Object.hasOwn(work, 'workerSessionId')) {
        errors.push({ path: `${workPath}.workerSessionId`, message: 'blocked work cannot carry a worker session' });
      }
    }
    for (const historyIndex in entry?.history || []) addDateError(errors, `cases[${caseIndex}].history[${historyIndex}].when`, entry.history[historyIndex]?.when);
    for (const commentIndex in entry?.comments || []) addDateError(errors, `cases[${caseIndex}].comments[${commentIndex}].when`, entry.comments[commentIndex]?.when);
    const results = Array.isArray(entry?.results) ? entry.results : [];
    const seenRounds = new Set();
    results.forEach((result, resultIndex) => {
      addDateError(errors, `cases[${caseIndex}].results[${resultIndex}].recordedAt`, result?.recordedAt);
      if (seenRounds.has(result?.round)) errors.push({ path: `cases[${caseIndex}].results`, message: `duplicate round ${result?.round}` });
      seenRounds.add(result?.round);
      if (Number.isInteger(result?.round) && !roundIds.has(result.round)) errors.push({ path: `cases[${caseIndex}].results[${resultIndex}].round`, message: `round ${result.round} is missing from board rounds` });
    });
    if (results.length > 0) {
      const latest = [...results].sort((a, b) => a.round - b.round).at(-1);
      if (entry.functionVerdict !== latest.functionVerdict) errors.push({ path: `cases[${caseIndex}].functionVerdict`, message: 'must match the latest round result' });
      if (entry.uiVerdict !== latest.uiVerdict) errors.push({ path: `cases[${caseIndex}].uiVerdict`, message: 'must match the latest round result' });
    }
  });

  defects.forEach((entry, defectIndex) => {
    if (typeof entry?.caseId === 'string' && !caseIds.has(entry.caseId)) errors.push({ path: `defects[${defectIndex}].caseId`, message: `unknown case ${entry.caseId}` });
    for (const historyIndex in entry?.history || []) addDateError(errors, `defects[${defectIndex}].history[${historyIndex}].when`, entry.history[historyIndex]?.when);
    for (const commentIndex in entry?.comments || []) addDateError(errors, `defects[${defectIndex}].comments[${commentIndex}].when`, entry.comments[commentIndex]?.when);
    for (const evidenceIndex in entry?.fixEvidence || []) addDateError(errors, `defects[${defectIndex}].fixEvidence[${evidenceIndex}].addedAt`, entry.fixEvidence[evidenceIndex]?.addedAt);
    if (Number.isInteger(entry?.lastRetestFixEvidenceCount) && Array.isArray(entry?.fixEvidence) && entry.lastRetestFixEvidenceCount > entry.fixEvidence.length) {
      errors.push({ path: `defects[${defectIndex}].lastRetestFixEvidenceCount`, message: 'cannot exceed fixEvidence length' });
    }
    if (entry?.status === 'RETEST' && (!Array.isArray(entry.fixEvidence) || entry.fixEvidence.length === 0)) {
      errors.push({ path: `defects[${defectIndex}].fixEvidence`, message: `${entry.id || 'defect'} RETEST requires fix evidence` });
    }
    if (entry?.status === 'REJECTED' && !REJECTION_REASONS.includes(entry.rejectionReason)) {
      errors.push({ path: `defects[${defectIndex}].rejectionReason`, message: `${entry.id || 'defect'} REJECTED requires a typed reason` });
    }
  });
  errors.push(...requiredFieldErrors(data));
  errors.push(...findingEvidenceErrors(data));
  errors.push(...proseLanguageErrors(data));
  errors.push(...sourceTraceabilityErrors(data));
  return errors;
}

export function validateCanonical(data) {
  const errors = [];
  const root = isDeployedBuildBoard(data) ? deployedBuildSchema : schema;
  validateNode(root, data, '', errors, root);
  errors.push(...semanticErrors(data));
  const result = { ok: errors.length === 0, errors };
  // The scoreboards read the same run as a verdict. It stays non-enumerable so `{ok, errors}` —
  // the shape callers already deep-compare against — is byte-for-byte what it always was.
  Object.defineProperty(result, 'verdict', { value: boardVerdict(errors), enumerable: false });
  return result;
}

const DEFECT_TRANSITIONS = Object.freeze({
  TODO: new Set(['ASSIGNED', 'DEFERRED', 'REJECTED']),
  ASSIGNED: new Set(['FIXING', 'BLOCKED', 'DEFERRED', 'REJECTED']),
  FIXING: new Set(['RETEST', 'BLOCKED', 'DEFERRED', 'REJECTED']),
  RETEST: new Set(['VERIFIED', 'REOPENED', 'BLOCKED']),
  VERIFIED: new Set(['CLOSED', 'REOPENED']),
  REOPENED: new Set(['ASSIGNED', 'FIXING', 'DEFERRED']),
  BLOCKED: new Set(['ASSIGNED', 'FIXING', 'DEFERRED']),
  DEFERRED: new Set(['ASSIGNED', 'FIXING']),
  REJECTED: new Set(['REOPENED']),
  CLOSED: new Set(['REOPENED']),
});

function entityForChange(data, change) {
  const collection = change?.entity === 'case' ? data.cases : change?.entity === 'defect' ? data.defects : null;
  return collection?.find((entry) => entry.id === change?.id);
}

function changeError(change, message) {
  return `${change?.id || '<missing>'}.${change?.field || '<missing>'}: ${message}`;
}

export function applyChanges(data, changes, context = {}) {
  const initial = validateCanonical(data);
  if (!initial.ok) return { ok: false, errors: initial.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  if (!Array.isArray(changes)) return { ok: false, errors: ['changes: expected array'] };

  const actor = context.actor;
  const when = context.now;
  const source = context.source || 'agent';
  const qaActors = new Set(context.qaActors || []);
  if (typeof actor !== 'string' || actor.length === 0) return { ok: false, errors: ['changes: actor is required'] };
  if (!validDate(when)) return { ok: false, errors: ['changes: valid now timestamp is required'] };
  if (!['native', 'notion', 'agent'].includes(source)) return { ok: false, errors: [`changes: unsupported source ${source}`] };

  const next = structuredClone(data);
  const errors = [];
  let changed = 0;
  for (const change of changes) {
    const target = entityForChange(next, change);
    if (!target) { errors.push(changeError(change, `unknown ${change?.entity || 'entity'}`)); continue; }
    if (!['status', 'priority', 'assignee'].includes(change.field)) { errors.push(changeError(change, 'field is not editable')); continue; }
    if (Object.hasOwn(change, 'from') && change.from !== target[change.field]) {
      errors.push(changeError(change, `expected ${JSON.stringify(change.from)} but canonical has ${JSON.stringify(target[change.field])}`));
      continue;
    }
    if (target[change.field] === change.to) continue;

    if (change.field === 'priority' && !TEAMWORK_PRIORITIES.includes(change.to)) {
      errors.push(changeError(change, `priority ${JSON.stringify(change.to)} is not allowed`));
      continue;
    }
    if (change.field === 'assignee' && (typeof change.to !== 'string' || change.to.trim().length === 0)) {
      errors.push(changeError(change, 'assignee cannot be empty'));
      continue;
    }
    if (change.field === 'status') {
      if (!TEAMWORK_STATUSES.includes(change.to)) {
        errors.push(changeError(change, `status ${JSON.stringify(change.to)} is not allowed`));
        continue;
      }
      if (change.entity === 'defect') {
        if (change.to === 'CLOSED' && actor === target.createdBy) {
          errors.push(changeError(change, `defect creator ${actor} cannot set CLOSED`));
          continue;
        }
        if (['VERIFIED', 'CLOSED', 'REOPENED'].includes(change.to) && !qaActors.has(actor)) {
          errors.push(changeError(change, `${change.to} requires a QA actor`));
          continue;
        }
        if (change.to === 'RETEST' && target.fixEvidence.length <= target.lastRetestFixEvidenceCount) {
          errors.push(changeError(change, `defect ${target.id} RETEST requires fresh fix evidence`));
          continue;
        }
        if (change.to === 'REJECTED' && !REJECTION_REASONS.includes(change.rejectionReason || target.rejectionReason)) {
          errors.push(changeError(change, `defect ${target.id} rejectionReason is required`));
          continue;
        }
        const allowed = DEFECT_TRANSITIONS[target.status];
        if (allowed && !allowed.has(change.to)) {
          errors.push(changeError(change, `transition ${target.status} -> ${change.to} is not allowed`));
          continue;
        }
      }
    }

    const from = target[change.field];
    target[change.field] = change.field === 'assignee' ? change.to.trim() : change.to;
    if (change.field === 'status' && change.entity === 'defect') {
      if (change.to === 'RETEST') target.lastRetestFixEvidenceCount = target.fixEvidence.length;
      if (change.to === 'REJECTED') target.rejectionReason = change.rejectionReason || target.rejectionReason;
      else if (from === 'REJECTED') target.rejectionReason = null;
    }
    target.history.push({ who: actor, field: change.field, from, to: target[change.field], when, source });
    changed += 1;
  }

  if (errors.length > 0) return { ok: false, errors };
  if (changed > 0 && context.incrementRev !== false) next.rev += 1;
  const final = validateCanonical(next);
  if (!final.ok) return { ok: false, errors: final.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  return { ok: true, data: next, applied: changed };
}

function statusFromVerdicts(functionVerdict, uiVerdict) {
  if (functionVerdict === 'FAIL' || uiVerdict === 'FAIL') return 'FAIL';
  if (functionVerdict === 'BLOCKED' || uiVerdict === 'BLOCKED' || functionVerdict === 'UNGRADED' || uiVerdict === 'UNGRADED') return 'BLOCKED';
  if (functionVerdict === 'PASS' && uiVerdict === 'PASS') return 'PASS';
  return 'DOING';
}

export function addRoundResult(data, caseId, result, context = {}) {
  const initial = validateCanonical(data);
  if (!initial.ok) return { ok: false, errors: initial.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  if (!result || !Number.isInteger(result.round) || result.round < 1) return { ok: false, errors: [`case ${caseId}: round must be a positive integer`] };
  if (!['PASS', 'FAIL', 'BLOCKED', 'UNGRADED'].includes(result.functionVerdict)) return { ok: false, errors: [`case ${caseId}: invalid functionVerdict`] };
  if (!['PASS', 'FAIL', 'BLOCKED', 'UNGRADED'].includes(result.uiVerdict)) return { ok: false, errors: [`case ${caseId}: invalid uiVerdict`] };
  if (!validDate(result.recordedAt)) return { ok: false, errors: [`case ${caseId}: recordedAt must be an ISO date-time`] };
  if (!Array.isArray(result.evidence)) return { ok: false, errors: [`case ${caseId}: evidence must be an array`] };

  const next = structuredClone(data);
  const target = next.cases.find((entry) => entry.id === caseId);
  if (!target) return { ok: false, errors: [`case ${caseId}: not found`] };
  if (target.results.some((entry) => entry.round === result.round)) return { ok: false, errors: [`case ${caseId}: round ${result.round} already exists; results are append-only`] };

  target.results.push(structuredClone(result));
  target.results.sort((a, b) => a.round - b.round);
  target.functionVerdict = result.functionVerdict;
  target.uiVerdict = result.uiVerdict;
  target.evidence = [...result.evidence];
  const nextStatus = statusFromVerdicts(result.functionVerdict, result.uiVerdict);
  if (target.status !== nextStatus) {
    const from = target.status;
    target.status = nextStatus;
    target.history.push({
      who: context.actor || result.recordedBy || 'qa-agent',
      field: 'status',
      from,
      to: nextStatus,
      when: result.recordedAt,
      source: context.source || 'agent',
    });
  }
  if (!next.rounds.some((entry) => entry.round === result.round)) {
    next.rounds.push({ round: result.round, startedAt: result.recordedAt, scope: context.scope || 'case result update' });
    next.rounds.sort((a, b) => a.round - b.round);
  }
  next.currentRound = Math.max(next.currentRound, result.round);
  next.rev += 1;
  const final = validateCanonical(next);
  if (!final.ok) return { ok: false, errors: final.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  return { ok: true, data: next };
}

export function reconcileChanges(data, changes, context = {}) {
  const initial = validateCanonical(data);
  if (!initial.ok) return { ok: false, errors: initial.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  if (!Array.isArray(changes)) return { ok: false, errors: ['changes: expected array'] };
  const qaActors = new Set(context.qaActors || []);
  const next = structuredClone(data);
  const errors = [];
  const indexed = changes.map((change, index) => ({ ...change, index }));

  for (const change of indexed) {
    const target = entityForChange(next, change);
    if (!target) { errors.push(changeError(change, `unknown ${change?.entity || 'entity'}`)); continue; }
    if (!['status', 'priority', 'assignee'].includes(change.field)) { errors.push(changeError(change, 'field is not reconcilable')); continue; }
    if (!validDate(change.when)) { errors.push(changeError(change, 'when must be an ISO date-time')); continue; }
    if (typeof change.who !== 'string' || change.who.length === 0) { errors.push(changeError(change, 'who is required')); continue; }
    if (!['native', 'notion', 'agent'].includes(change.source)) { errors.push(changeError(change, `unsupported source ${change.source}`)); continue; }
    if (change.field === 'status' && !TEAMWORK_STATUSES.includes(change.to)) errors.push(changeError(change, `status ${JSON.stringify(change.to)} is not allowed`));
    if (change.field === 'priority' && !TEAMWORK_PRIORITIES.includes(change.to)) errors.push(changeError(change, `priority ${JSON.stringify(change.to)} is not allowed`));
    if (change.field === 'assignee' && (typeof change.to !== 'string' || change.to.trim().length === 0)) errors.push(changeError(change, 'assignee cannot be empty'));
  }
  if (errors.length > 0) return { ok: false, errors };

  const groups = new Map();
  for (const change of indexed) {
    const key = `${change.entity}:${change.id}:${change.field}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(change);
  }
  const conflicts = [];
  for (const events of groups.values()) {
    events.sort((left, right) => Date.parse(left.when) - Date.parse(right.when) || left.index - right.index);
    const target = entityForChange(next, events[0]);
    let winner = events.at(-1);
    if (events[0].field === 'status') {
      const qaEvents = events.filter((event) => qaActors.has(event.who));
      if (qaEvents.length > 0) winner = qaEvents.at(-1);
      if (winner.to === 'CLOSED' && winner.who === target.createdBy) return { ok: false, errors: [changeError(winner, `defect creator ${winner.who} cannot set CLOSED`)] };
      if (['VERIFIED', 'CLOSED', 'REOPENED'].includes(winner.to) && !qaActors.has(winner.who)) return { ok: false, errors: [changeError(winner, `${winner.to} requires a QA actor`)] };
      if (winner.to === 'REJECTED' && !REJECTION_REASONS.includes(winner.rejectionReason || target.rejectionReason)) return { ok: false, errors: [changeError(winner, 'rejectionReason is required')] };
    }
    for (const event of events) {
      target.history.push({ who: event.who, field: event.field, from: event.from, to: event.to, when: event.when, source: event.source });
    }
    target[winner.field] = winner.field === 'assignee' ? winner.to.trim() : winner.to;
    if (winner.field === 'status' && winner.to === 'REJECTED') target.rejectionReason = winner.rejectionReason || target.rejectionReason;
    if (events.length > 1) conflicts.push({
      entity: winner.entity,
      id: winner.id,
      field: winner.field,
      winner: winner.who,
      winnerSource: winner.source,
      events: events.map(({ index: _index, ...event }) => event),
    });
  }
  if (changes.length > 0) next.rev += 1;
  const final = validateCanonical(next);
  if (!final.ok) return { ok: false, errors: final.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  return { ok: true, data: next, conflicts };
}
