import {
  LEGACY_CANONICAL_VERSION,
  SOURCE_TRACEABILITY_CANONICAL_VERSION,
  SOURCE_TRACEABILITY_SCHEMA_VERSION,
  validateCanonical,
} from './canonical.mjs';

const ROOT_FIELDS = Object.freeze(['migrationVersion', 'sourceItems', 'caseMappings']);
const CASE_MAPPING_FIELDS = Object.freeze(['caseId', 'sourceRefs']);

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function unknownFields(value, allowed, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${label}: unknown field ${key}`);
}

function mappingErrors(mapping, legacyCaseIds) {
  const errors = [];
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return ['mapping: expected object'];
  unknownFields(mapping, ROOT_FIELDS, 'mapping', errors);
  if (mapping.migrationVersion !== 'qa-source-traceability-map/v1') errors.push('mapping.migrationVersion: expected qa-source-traceability-map/v1');
  if (!Array.isArray(mapping.sourceItems)) errors.push('mapping.sourceItems: expected array');
  if (!Array.isArray(mapping.caseMappings)) return [...errors, 'mapping.caseMappings: expected array'];

  const seen = new Set();
  mapping.caseMappings.forEach((entry, index) => {
    const label = `mapping.caseMappings[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label}: expected object`);
      return;
    }
    unknownFields(entry, CASE_MAPPING_FIELDS, label, errors);
    if (!nonBlank(entry.caseId)) errors.push(`${label}.caseId: non-blank case id is required`);
    else if (!legacyCaseIds.has(entry.caseId)) errors.push(`${label}.caseId: unknown legacy case ${entry.caseId}`);
    else if (seen.has(entry.caseId)) errors.push(`${label}.caseId: duplicate mapping for ${entry.caseId}`);
    else seen.add(entry.caseId);
    if (!Array.isArray(entry.sourceRefs) || entry.sourceRefs.length === 0 || entry.sourceRefs.some((ref) => !nonBlank(ref))) {
      errors.push(`${label}.sourceRefs: at least one explicit source ref is required`);
    }
    if (Array.isArray(entry.sourceRefs) && new Set(entry.sourceRefs).size !== entry.sourceRefs.length) {
      errors.push(`${label}.sourceRefs: duplicate source refs are not allowed`);
    }
  });
  for (const caseId of legacyCaseIds) if (!seen.has(caseId)) errors.push(`${caseId}: explicit mapping is required; title and ID inference are forbidden`);
  return errors;
}

export function migrateCanonicalSourceTraceability(legacy, mapping) {
  const validation = validateCanonical(legacy);
  if (!validation.ok) throw new Error(`legacy canonical is invalid\n${validation.errors.map(({ path, message }) => `${path}: ${message}`).join('\n')}`);
  if (![4, 5].includes(legacy.schemaVersion) || legacy.canonicalVersion !== LEGACY_CANONICAL_VERSION) {
    throw new Error('legacy canonical must be schema 4 or 5 with qa-board-teamwork/v1');
  }
  const legacyCaseIds = new Set(legacy.cases.map((entry) => entry.id));
  const errors = mappingErrors(mapping, legacyCaseIds);
  if (errors.length > 0) throw new Error(errors.join('\n'));

  const refsByCase = new Map(mapping.caseMappings.map((entry) => [entry.caseId, structuredClone(entry.sourceRefs)]));
  const migrated = structuredClone(legacy);
  migrated.schemaVersion = SOURCE_TRACEABILITY_SCHEMA_VERSION;
  migrated.canonicalVersion = SOURCE_TRACEABILITY_CANONICAL_VERSION;
  migrated.boardKind = 'team-qa-board';
  migrated.sourceItems = structuredClone(mapping.sourceItems);
  migrated.cases.forEach((entry) => { entry.sourceRefs = refsByCase.get(entry.id); });

  const final = validateCanonical(migrated);
  if (!final.ok) throw new Error(`migration result is invalid\n${final.errors.map(({ path, message }) => `${path}: ${message}`).join('\n')}`);
  return migrated;
}
