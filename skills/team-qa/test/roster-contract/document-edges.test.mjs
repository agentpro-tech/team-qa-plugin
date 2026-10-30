import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRtmEdges } from '../../scripts/lib/run-contract.mjs';
const tracked = { schemaVersion: 2, sourceItems: [{ id: 'S1', sourceSystem: 'fixture', externalKey: 'REQ1', title: 'Fixture source' }], cases: [{ id: 'CASE-1', req_id: 'REQ1', sourceRefs: ['S1'], priority: 'P1' }, { id: 'CASE-10', req_id: 'REQ1', sourceRefs: ['S1'], priority: 'P1' }] };
const plan = { tiers: { REQ1: 'high' } };
// The RTM "Requirement" column header is a Vietnamese format token parsed by Team QA, written here as escapes.
const header = '| Source | Source system | Source key | Source title | Case | Y\u00eau c\u1ea7u | Tier | Priority | Verdict | Evidence |\n|---|---|---|---|---|---|---|---|---|---|\n';
const rows = ['CASE-1', 'CASE-10'].map((id) => `| S1 | fixture | REQ1 | Fixture source | ${id} | REQ1 | high | P1 |  |  |`).join('\n');
test('execution RTM gate compares complete exact source/case edges before any verdict exists', () => {
  assert.doesNotThrow(() => validateRtmEdges(header + rows, plan, tracked));
  assert.throws(() => validateRtmEdges(header + rows.split('\n')[1], plan, tracked), /RTM_SOURCE_LINK/);
  assert.throws(() => validateRtmEdges(header + rows.replace('| CASE-1 |', '| CASE-100 |'), plan, tracked), /RTM_SOURCE_LINK/);
  assert.throws(() => validateRtmEdges(header + rows.replace('| fixture |', '| invented |'), plan, tracked), /RTM_SOURCE_LINK/);
});
