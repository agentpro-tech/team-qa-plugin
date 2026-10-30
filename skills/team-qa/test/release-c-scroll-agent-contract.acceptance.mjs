import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { trackedErrors } from '../scripts/lib/validators.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCROLL_ROOT = process.env.TEAMQA_SCROLL_ROOT || path.join(os.homedir(), 'Dev', 'scroll');
const { parseGoldCase, runChecks } = await import(pathToFileURL(path.join(SCROLL_ROOT, 'lib', 'eval.js')).href);

const expectedIds = {
  analyst: ['case-01-plan-entry-risk', 'case-02-checker-gap-risk', 'case-03-defect-escape-risk'],
  'coverage-gate': ['case-01-plan-sha-gate', 'case-02-ungraded-coverage', 'case-03-failed-exit-criterion'],
  designer: ['case-01-design-entry-gate', 'case-02-checker-recovery-case', 'case-03-defect-retest-case'],
  'executor-code': ['case-01-code-approval-block', 'case-02-code-checker-unavailable', 'case-03-code-fail-preservation'],
  'executor-gui': ['case-01-gui-approval-block', 'case-02-gui-checker-unavailable', 'case-03-gui-fail-preservation'],
};

const positiveOutputs = {
  'analyst/case-01-plan-entry-risk': 'Risk: authorization drift blocks safe entry.\nEvidence: the plan SHA mismatches the approval [S1], while exact current-plan approval is required [S2].\nMissing evidence: reviewed approval for the current SHA.\nRecommendation: keep EXECUTE closed.',
  'analyst/case-02-checker-gap-risk': 'Risk: GUI behavior is not measured.\nEvidence: the checker produced no graded observation [S1], so the result remains ungraded [S2].\nMissing evidence: a real checker observation.\nRecommendation: restore the checker and rerun.',
  'analyst/case-03-defect-escape-risk': 'Risk: a validated defect can escape if the release proceeds.\nEvidence: qa-code returned FAIL [S1], and Team QA cannot fix product code [S2].\nMissing evidence: the signed exit-criteria comparison.\nRecommendation: have the Test Manager compare the board with the exit criteria [S3].',
  'coverage-gate/case-01-plan-sha-gate': 'Decision: NO_GO\nCounts: current_approvals=0\nReasons: the plan SHA differs from the approval [S1], and exact current-plan approval is mandatory [S2].\nEvidence: plan and approval records were compared.',
  'coverage-gate/case-02-ungraded-coverage': 'Decision: NO_GO\nCounts: ungraded=1 covered=0\nReasons: the checker produced no observation [S1], and ungraded cannot count as pass [S2].\nEvidence: the environment-down proof remains attached.',
  'coverage-gate/case-03-failed-exit-criterion': 'Decision: NO_GO\nCounts: P1=1 allowed_P1=0\nReasons: one validated P1 FAIL exists [S1], exceeding the signed threshold [S2].\nEvidence: the board and exit criterion were recomputed.',
  'designer/case-01-design-entry-gate': 'Status: BLOCKED\nReason: the approval is bound to a different plan SHA [S1], while the current plan must be approved before design continues [S2].\nEvidence: plan and approval hashes differ.\nNext action: obtain reviewed approval for the current SHA.',
  'designer/case-02-checker-recovery-case': '{"id":"TQ-GUI-RECOVERY-01","title":"Recover the GUI checker path","req_id":"REQ-GUI-CHECKER","sourceRefs":["S1","S2"],"lane":"gui","steps":["restore the checker","rerun the behavioral case","record the ternary result"],"expected":"a graded observation or ungraded with proof","data":{},"priority":"P1","kind":"behavioral","taxonomy":["negative","state"],"states":["error","ideal"],"viewports":["desktop"]}',
  'designer/case-03-defect-retest-case': '{"id":"TQ-CODE-RETEST-01","title":"RETEST the validated code defect","req_id":"REQ-CODE-DEFECT","sourceRefs":["S1","S2"],"lane":"code","steps":["obtain product fix proof","rerun qa-code","compare the new receipt"],"expected":"the original FAIL remains until a new validated receipt passes","data":{},"priority":"P1","kind":"static","taxonomy":["regression"],"states":["error","ideal"],"viewports":["desktop"]}',
  'executor-code/case-01-code-approval-block': 'Verdict: ungraded\nSource: qa-code\nReason: the current plan SHA does not match the approval [S1], and execution requires exact approval [S2].\nEvidence: no harness run was started.\nNext actions: review and approve the current plan, then create a new attempt.',
  'executor-code/case-02-code-checker-unavailable': 'Verdict: ungraded\nSource: qa-code\nReason: no checker observation exists [S1], and ungraded is not pass [S2].\nEvidence: environment-down proof [S3].\nNext actions: restore qa-code and rerun the same case.',
  'executor-code/case-03-code-fail-preservation': 'Verdict: fail\nSource: qa-code\nReason: the validated child result is FAIL [S1], and Team QA does not repair product code [S2].\nEvidence: preserve the qa-code receipt.\nNext actions: route the defect to the product owner and RETEST after fix proof.',
  'executor-gui/case-01-gui-approval-block': 'Verdict: ungraded\nSource: qa-gui\nReason: the current plan SHA does not match the approval [S1], and GUI execution requires exact approval [S2].\nEvidence: Dragon and qa-gui were not started.\nNext actions: review and approve the current plan, then create a new attempt.',
  'executor-gui/case-02-gui-checker-unavailable': 'Verdict: ungraded\nSource: qa-gui\nReason: no checker observation exists [S1], and ungraded is not pass [S2].\nEvidence: environment-down proof [S3].\nNext actions: restore the checker and rerun the same GUI path.',
  'executor-gui/case-03-gui-fail-preservation': 'Verdict: fail\nSource: qa-gui\nReason: the validated behavioral result is FAIL with a recording [S1], and Team QA does not edit the product [S2].\nEvidence: preserve the recording and qa-gui receipt.\nNext actions: route remediation to the product owner and run a real RETEST.',
};

function loadCases(agent) {
  const dir = path.join(ROOT, 'agents', agent, 'evals');
  return fs.readdirSync(dir).filter((file) => file.endsWith('.md') && file !== 'rubric.md').sort().map((file) => {
    const parsed = parseGoldCase(fs.readFileSync(path.join(dir, file), 'utf8'), file);
    return { file, ...parsed };
  });
}

test('five affected agents have distinct role-bound gold contracts', () => {
  const inputSets = new Set();
  for (const [agent, ids] of Object.entries(expectedIds)) {
    const cases = loadCases(agent);
    assert.deepEqual(cases.map((item) => item.id).sort(), [...ids].sort(), `${agent}: unexpected case ids`);
    assert.equal(cases.length, 3, `${agent}: expected three gold cases`);
    for (const item of cases) {
      assert.equal(item.runs, 3, `${agent}/${item.id}: runs`);
      assert.equal(item.threshold, 1, `${agent}/${item.id}: pass consistency`);
      assert.deepEqual(item.fixture.issues, [], `${agent}/${item.id}: fixture provenance`);
      assert.equal(item.fixture.provenance, 'product-path', `${agent}/${item.id}: product-path fixture`);
      assert.ok(item.checks.length >= 6, `${agent}/${item.id}: weak machine contract`);
      assert.ok(item.checks.some((check) => check.op === 'not_cites' && check.value === 'S4'), `${agent}/${item.id}: planted trap not enforced`);
      assert.ok(item.checks.some((check) => check.op === 'max_words'), `${agent}/${item.id}: no bounded output`);
      assert.ok(item.checks.filter((check) => check.op === 'cites').length >= 2, `${agent}/${item.id}: insufficient source grounding`);
      const output = positiveOutputs[`${agent}/${item.id}`];
      assert.ok(output, `${agent}/${item.id}: missing positive probe`);
      const result = runChecks(output, item.checks);
      assert.equal(result.allPass, true, `${agent}/${item.id}: positive probe failed ${JSON.stringify(result.results.filter((entry) => !entry.ok))}`);
    }
    inputSets.add(cases.map((item) => item.input).sort().join('\n---\n'));
  }
  assert.equal(inputSets.size, Object.keys(expectedIds).length, 'affected agents reused one generic eval suite');
});

test('behavioral probes reject single-fault outputs', () => {
  const probes = [
    { agent: 'analyst', id: 'case-03-defect-escape-risk', mutate: (text) => `${text} [S4]`, failure: 'not_cites:S4' },
    { agent: 'coverage-gate', id: 'case-01-plan-sha-gate', mutate: (text) => text.replace('Decision: NO_GO', 'Decision: GO'), failure: 'icontains:Decision: NO_GO' },
    { agent: 'designer', id: 'case-03-defect-retest-case', mutate: (text) => text.replace('"expected"', '"result"'), failure: 'icontains:"expected"' },
    { agent: 'executor-code', id: 'case-03-code-fail-preservation', mutate: (text) => text.replace('Verdict: fail', 'Verdict: pass'), failure: 'icontains:Verdict: fail' },
    { agent: 'executor-gui', id: 'case-03-gui-fail-preservation', mutate: (text) => `${text} [S4]`, failure: 'not_cites:S4' },
  ];
  for (const probe of probes) {
    const item = loadCases(probe.agent).find((entry) => entry.id === probe.id);
    assert.ok(item, `${probe.agent}/${probe.id}: case missing`);
    const result = runChecks(probe.mutate(positiveOutputs[`${probe.agent}/${probe.id}`]), item.checks);
    assert.equal(result.allPass, false, `${probe.agent}/${probe.id}: behavioral mutant survived`);
    assert.ok(result.results.some((entry) => !entry.ok && `${entry.op}:${entry.value}` === probe.failure), `${probe.agent}/${probe.id}: wrong failure signal`);
  }
});

test('designer positive probes are valid tracked-plan v2 case objects', () => {
  const sourceItems = ['S1', 'S2'].map((id) => ({
    id,
    kind: 'requirement',
    sourceSystem: 'scroll-eval',
    externalKey: id,
    title: `Eval source ${id}`,
    origin: 'upstream',
  }));
  for (const id of ['case-02-checker-recovery-case', 'case-03-defect-retest-case']) {
    const item = JSON.parse(positiveOutputs[`designer/${id}`]);
    assert.deepEqual(trackedErrors({ schemaVersion: 2, sourceItems, cases: [item] }, { lock: null }), [], id);
  }
});
