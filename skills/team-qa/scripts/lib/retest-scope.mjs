import { fail, rejectUnknownFields } from './core.mjs';

export function selectRetestCases(tracked, change) {
  rejectUnknownFields(change, ['target_version', 'impact', 'defect_cases', 'affected_cases', 'smoke_cases', 'rationale'], 'RETEST_FIELD_UNKNOWN');
  for (const key of ['target_version', 'rationale']) {
    if (typeof change?.[key] !== 'string' || !change[key].trim()) fail(2, 'RETEST_INPUT_INVALID', key);
  }
  if (!['bounded', 'shared', 'unknown', 'full-release'].includes(change.impact)) fail(2, 'RETEST_IMPACT_INVALID');
  const ids = tracked.cases.map((item) => item.id);
  const known = new Set(ids);
  for (const key of ['defect_cases', 'affected_cases', 'smoke_cases']) {
    if (!Array.isArray(change[key])) fail(2, 'RETEST_INPUT_INVALID', key);
    if (new Set(change[key]).size !== change[key].length) fail(2, 'RETEST_CASE_DUPLICATE', key);
    for (const id of change[key]) if (!known.has(id)) fail(2, 'RETEST_CASE_UNKNOWN', id);
  }
  const full = ['unknown', 'full-release'].includes(change.impact);
  if (!full && change.defect_cases.length === 0) fail(2, 'RETEST_DEFECT_REQUIRED');
  if (!full && change.smoke_cases.length === 0) fail(2, 'RETEST_SMOKE_REQUIRED');
  if (change.impact === 'shared' && change.affected_cases.length === 0) fail(2, 'RETEST_SHARED_IMPACT_REQUIRED');
  const selected = new Set([...change.defect_cases, ...change.affected_cases, ...change.smoke_cases]);
  return {
    schema: 'team-qa/retest-scope/v1',
    target_version: change.target_version,
    mode: full ? 'full' : change.impact === 'shared' ? 'expanded' : 'targeted',
    result_scope: 'retest-only',
    rationale: change.rationale,
    caseIds: ids.filter((id) => full || selected.has(id)),
    notSelectedCaseIds: ids.filter((id) => !full && !selected.has(id)),
  };
}
