export const TRACKED_PLAN_SCHEMA_VERSION = 2;
export const SOURCE_TRACEABILITY_VERSION = 'team-qa/source-traceability/v1';
export const SOURCE_MIGRATION_VERSION = 'team-qa/source-traceability-map/v1';

export const SOURCE_ITEM_FIELDS = Object.freeze([
  'id', 'kind', 'sourceSystem', 'externalKey', 'title', 'url', 'origin', 'qaDerivedReason',
]);

const SOURCE_REQUIRED_FIELDS = Object.freeze([
  'id', 'kind', 'sourceSystem', 'externalKey', 'title', 'origin',
]);
const MAPPING_FIELDS = Object.freeze(['migrationVersion', 'sourceItems', 'caseMappings']);
const CASE_MAPPING_FIELDS = Object.freeze(['caseId', 'title', 'sourceRefs']);
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SOURCE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SOURCE_KIND = /^[a-z][a-z0-9._-]*$/;

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function unknownFields(value, allowed, code, context, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${code} ${context} ${key}`);
}

function validHttpUrl(value) {
  if (!nonBlank(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sourceRegistryErrors(sourceItems, context = 'sourceItems') {
  const errors = [];
  if (!Array.isArray(sourceItems)) return [`SOURCE_TYPE ${context}`];
  const ids = new Set();
  const identities = new Set();
  sourceItems.forEach((item, index) => {
    const where = `${context}[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`SOURCE_TYPE ${where}`);
      return;
    }
    unknownFields(item, SOURCE_ITEM_FIELDS, 'SOURCE_UNKNOWN_FIELD', where, errors);
    for (const field of SOURCE_REQUIRED_FIELDS) {
      if (!Object.hasOwn(item, field)) errors.push(`SOURCE_FIELD ${where} ${field}`);
    }
    if (Object.hasOwn(item, 'id')) {
      if (!nonBlank(item.id) || !SOURCE_ID.test(item.id)) errors.push(`SOURCE_TYPE ${where} id`);
      else if (ids.has(item.id)) errors.push(`SOURCE_DUPLICATE_ID ${item.id}`);
      else ids.add(item.id);
    }
    if (Object.hasOwn(item, 'kind') && (!nonBlank(item.kind) || !SOURCE_KIND.test(item.kind))) {
      errors.push(`SOURCE_TYPE ${where} kind`);
    }
    if (Object.hasOwn(item, 'sourceSystem') && (!nonBlank(item.sourceSystem) || !SOURCE_TOKEN.test(item.sourceSystem))) {
      errors.push(`SOURCE_TYPE ${where} sourceSystem`);
    }
    for (const field of ['externalKey', 'title']) {
      if (Object.hasOwn(item, field) && !nonBlank(item[field])) errors.push(`SOURCE_TYPE ${where} ${field}`);
    }
    if (Object.hasOwn(item, 'url') && !validHttpUrl(item.url)) errors.push(`SOURCE_TYPE ${where} url`);
    if (Object.hasOwn(item, 'origin') && !['upstream', 'qa-derived'].includes(item.origin)) {
      errors.push(`SOURCE_TYPE ${where} origin`);
    }
    if (nonBlank(item.sourceSystem) && nonBlank(item.externalKey)) {
      const identity = `${item.sourceSystem}\u0000${item.externalKey}`;
      if (identities.has(identity)) errors.push(`SOURCE_DUPLICATE_EXTERNAL ${item.sourceSystem}:${item.externalKey}`);
      else identities.add(identity);
    }
    if (item.origin === 'qa-derived') {
      if (item.kind !== 'qa-derived') errors.push(`SOURCE_QA_DERIVED_KIND ${where}`);
      if (!nonBlank(item.qaDerivedReason)) errors.push(`SOURCE_QA_DERIVED_REASON ${where}`);
    } else if (item.origin === 'upstream') {
      if (item.kind === 'qa-derived') errors.push(`SOURCE_UPSTREAM_IMPERSONATION ${where}`);
      if (Object.hasOwn(item, 'qaDerivedReason')) errors.push(`SOURCE_UPSTREAM_REASON ${where}`);
    }
  });
  return errors;
}

export function sourceRefErrors(cases, sourceItems) {
  const errors = [];
  const known = new Set(Array.isArray(sourceItems) ? sourceItems.map((item) => item?.id).filter(nonBlank) : []);
  if (!Array.isArray(cases)) return errors;
  cases.forEach((item, index) => {
    const id = nonBlank(item?.id) ? item.id : `cases[${index}]`;
    if (!Array.isArray(item?.sourceRefs) || item.sourceRefs.length === 0) {
      errors.push(`CASE_FIELD ${id} sourceRefs`);
      return;
    }
    const seen = new Set();
    item.sourceRefs.forEach((sourceRef) => {
      if (!nonBlank(sourceRef)) errors.push(`CASE_TYPE ${id} sourceRefs`);
      else if (seen.has(sourceRef)) errors.push(`CASE_SOURCE_REF_DUPLICATE ${id} ${sourceRef}`);
      else if (!known.has(sourceRef)) errors.push(`CASE_SOURCE_REF_UNKNOWN ${id} ${sourceRef}`);
      seen.add(sourceRef);
    });
  });
  return errors;
}

export function sameSourceRefs(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function migrateTrackedSourceTraceability(legacy, mapping) {
  const errors = [];
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || !Array.isArray(legacy.cases)) {
    return { value: null, errors: ['CASE_MIGRATION_LEGACY_REQUIRED root'] };
  }
  if (Object.hasOwn(legacy, 'schemaVersion') || Object.hasOwn(legacy, 'sourceItems')) {
    errors.push('CASE_MIGRATION_LEGACY_REQUIRED schemaVersion=1');
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return { value: null, errors: [...errors, 'SOURCE_MAPPING_TYPE root'] };
  }
  unknownFields(mapping, MAPPING_FIELDS, 'SOURCE_MAPPING_UNKNOWN_FIELD', 'root', errors);
  if (mapping.migrationVersion !== SOURCE_MIGRATION_VERSION) errors.push(`SOURCE_MAPPING_VERSION ${String(mapping.migrationVersion ?? '')}`);
  errors.push(...sourceRegistryErrors(mapping.sourceItems));
  if (!Array.isArray(mapping.caseMappings)) {
    errors.push('SOURCE_MAPPING_TYPE caseMappings');
    return { value: null, errors };
  }

  const legacyIds = new Set(legacy.cases.map((item) => item?.id).filter(nonBlank));
  const seen = new Set();
  mapping.caseMappings.forEach((entry, index) => {
    const where = `caseMappings[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`SOURCE_MAPPING_TYPE ${where}`);
      return;
    }
    unknownFields(entry, CASE_MAPPING_FIELDS, 'SOURCE_MAPPING_UNKNOWN_FIELD', where, errors);
    for (const field of CASE_MAPPING_FIELDS) {
      if (!Object.hasOwn(entry, field)) errors.push(`SOURCE_MAPPING_FIELD ${where} ${field}`);
    }
    if (!nonBlank(entry.caseId)) errors.push(`SOURCE_MAPPING_TYPE ${where} caseId`);
    else if (!legacyIds.has(entry.caseId)) errors.push(`SOURCE_MAPPING_CASE_UNKNOWN ${entry.caseId}`);
    else if (seen.has(entry.caseId)) errors.push(`SOURCE_MAPPING_CASE_DUPLICATE ${entry.caseId}`);
    else seen.add(entry.caseId);
    if (!nonBlank(entry.title)) errors.push(`SOURCE_MAPPING_TYPE ${where} title`);
    if (!Array.isArray(entry.sourceRefs) || entry.sourceRefs.length === 0 || entry.sourceRefs.some((value) => !nonBlank(value))) {
      errors.push(`SOURCE_MAPPING_TYPE ${where} sourceRefs`);
    }
  });
  for (const caseId of legacyIds) if (!seen.has(caseId)) errors.push(`CASE_SOURCE_MAPPING_REQUIRED ${caseId}`);

  const refsByCase = new Map(mapping.caseMappings
    .filter((entry) => entry && nonBlank(entry.caseId))
    .map((entry) => [entry.caseId, entry]));
  const candidate = {
    schemaVersion: TRACKED_PLAN_SCHEMA_VERSION,
    sourceItems: structuredClone(Array.isArray(mapping.sourceItems) ? mapping.sourceItems : []),
    cases: legacy.cases.map((item) => {
      const mapped = refsByCase.get(item.id);
      return {
        ...structuredClone(item),
        title: mapped?.title,
        sourceRefs: structuredClone(mapped?.sourceRefs || []),
      };
    }),
  };
  errors.push(...sourceRefErrors(candidate.cases, candidate.sourceItems));
  return { value: errors.length === 0 ? candidate : null, errors };
}

export function sourceTraceabilityRows(tracked, records = []) {
  if (tracked?.schemaVersion !== TRACKED_PLAN_SCHEMA_VERSION) return [];
  const byCase = new Map((Array.isArray(records) ? records : []).map((record) => [record.case_id, record]));
  const rows = [];
  for (const source of tracked.sourceItems) {
    const cases = tracked.cases.filter((item) => item.sourceRefs.includes(source.id));
    if (cases.length === 0) {
      rows.push({
        sourceRef: source.id,
        sourceSystem: source.sourceSystem,
        externalKey: source.externalKey,
        sourceTitle: source.title,
        caseId: null,
        requirement: null,
        priority: null,
        verdict: 'UNUSED',
        evidence: [],
      });
      continue;
    }
    for (const item of cases) {
      const record = byCase.get(item.id);
      rows.push({
        sourceRef: source.id,
        sourceSystem: source.sourceSystem,
        externalKey: source.externalKey,
        sourceTitle: source.title,
        caseId: item.id,
        requirement: item.req_id,
        priority: item.priority,
        verdict: record?.verdict ? (record.verdict === 'pending' ? 'PENDING' : record.verdict.toUpperCase()) : 'PENDING',
        evidence: structuredClone(Array.isArray(record?.evidence) ? record.evidence : []),
      });
    }
  }
  return rows;
}
