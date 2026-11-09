// Fix round 3 of the integrated upgrade, Team QA side: each finding of the third review reproduced first.
//   F1  the probe looks at the case's main action only (a plan field, else the last quoted control); sign-in and
//       navigation never decide it; risk in a neutral context, repeatability in the action's own context; a write with
//       no reset path gets no trial at dispatch, and collect decides the same (needs a QA GUI checkout)
//   F4  a probe Dragon's destructive gate refused on every trial is N/A, reported, not UNGRADED
// F5 and F6 run end to end in detectors-e2e.test.mjs; F7 is in web-collect-detectors.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

import { caseDetectorPlan, mainActionOf, plannedActionKinds, qaGuiDetectorTools, riskyMainAction } from '../../scripts/lib/detector-dispatch.mjs';
import { caseDetectorResults } from '../../scripts/lib/detector-collect.mjs';

const QA_GUI = process.env.TEAMQA_WEB_TEST_QA_GUI_ROOT;
const SKIP = QA_GUI ? false : 'set TEAMQA_WEB_TEST_QA_GUI_ROOT to a QA GUI checkout';
const behavioral = (...steps) => ({ kind: 'behavioral', steps });

test('F1 (R3-1): the main action is a plan field, else the last quoted control of a step that is not sign-in, navigation or a check', () => {
  assert.deepEqual(mainActionOf(behavioral('Log in as admin', 'Open the orders page', "Click 'Sort by date'")), { label: 'Sort by date', step: "Click 'Sort by date'", source: 'quoted', context: { inForm: false, inList: false, inDialog: false } });
  assert.equal(mainActionOf(behavioral("Click 'Sort by date'", "Verify the toast 'Sorted'")).label, 'Sort by date');
  assert.equal(mainActionOf(behavioral("Open the user's profile and click 'Edit'")).label, 'Edit', 'an apostrophe opens no quote');
  assert.equal(mainActionOf(behavioral('\u0110\u0103ng nh\u1eadp v\u1edbi t\u00e0i kho\u1ea3n admin', "B\u1ea5m 'S\u1eafp x\u1ebfp'")).label, 'S\u1eafp x\u1ebfp');
  assert.equal(mainActionOf(behavioral("Sign in and click 'Continue'", 'Open the orders page')), null, 'only sign-in and navigation: no main action');
  assert.deepEqual(mainActionOf(behavioral("Click 'Create' in the modal")).context, { inForm: true, inList: false, inDialog: true });
  assert.deepEqual(mainActionOf(behavioral("Click 'Delete' on the first row of the table")).context, { inForm: false, inList: true, inDialog: false });
  assert.deepEqual(mainActionOf(behavioral('Upload the avatar')), { label: 'Upload the avatar', step: 'Upload the avatar', source: 'step', context: { inForm: true, inList: false, inDialog: false } });
  assert.equal(mainActionOf(behavioral('Open the edit dialog')).label, 'Open the edit dialog', 'opening a dialog is the action, not navigation');
  assert.deepEqual(mainActionOf({ ...behavioral('Log in', "Click 'Save'"), data: { main_action: { label: 'Sort by date', inList: true } } }),
    { label: 'Sort by date', step: 'Sort by date', source: 'plan', context: { inForm: false, inList: true, inDialog: false } });
  // A toy classifier: risk from the main action alone.
  const classify = ({ target }) => ({ risky: /save|submit|delete|log ?in|continue/i.test(target.label), kinds: /save|submit|delete|log ?in|continue/i.test(target.label) ? ['submit'] : [] });
  assert.equal(riskyMainAction(behavioral("Log in and click 'Continue'", 'Open the orders page', 'Read the total'), classify), false, 'the sign-in step does not make the case risky');
  assert.deepEqual(plannedActionKinds(behavioral("Click 'Log in'", "Click 'Read more'"), classify), [], 'nor gives it its kinds');
});

test('F1 (R3-1): with QA GUI\'s real classifier, a sign-in before a sort gets the 3 trials; a write in a modal, a drawer or an upload with no reset gets none', { skip: SKIP }, async () => {
  const tools = await qaGuiDetectorTools(QA_GUI);
  const plan = (c) => caseDetectorPlan({ plannedCase: c, classify: tools.classifyAction, repeatability: tools.transientRepeatability });
  for (const signIn of ['Log in as admin', 'Sign in with the admin account', '\u0110\u0103ng nh\u1eadp b\u1eb1ng t\u00e0i kho\u1ea3n qu\u1ea3n tr\u1ecb', "Enter the email and click 'Continue' to sign in"]) {
    assert.deepEqual(plan(behavioral(signIn, 'Open the orders page', "Click 'Sort by date'")).transient, { trials: 3, kinds: ['list-sort'], reset: false }, signIn);
  }
  // Dogfood 05/11: a write that adds (a create in a modal, an upload, a new order in a drawer) with no reset path gets its 3
  // trials with fresh values; a removing write with no reset path gets none.
  for (const steps of [['Open the orders page', "Click 'Create' in the modal"], ['Open the profile page', 'Upload the avatar'], ["Click 'New order' in the drawer"]]) {
    const p = plan(behavioral(...steps));
    assert.deepEqual([p.transient.trials, p.transient.fresh, p.transientNa], [3, true, undefined], steps.join(' / '));
    const withReset = plan({ ...behavioral(...steps), data: { reset: ['Delete what the trial created'] } }).transient;
    assert.deepEqual([withReset.trials, withReset.fresh], [3, undefined], `${steps.join(' / ')} with a reset path`);
  }
  for (const steps of [["Click 'Delete' on the first row of the orders table"], ['Open the orders page', "Click 'Xo\u00e1'"]]) {
    const p = plan(behavioral(...steps));
    assert.deepEqual([p.transient, p.transientNa], [false, 'TRANSIENT_WRITE_NO_RESET'], steps.join(' / '));
  }
  // A modal open, a sort in a list: repeatable. A plan field decides over the steps.
  assert.equal(plan(behavioral('Open the edit dialog')).transient.trials, 3);
  assert.deepEqual(plan(behavioral("Click 'Sort by date' in the orders table")).transient, { trials: 3, kinds: ['list-sort'], reset: false });
  assert.deepEqual(plan({ ...behavioral('Log in', "Click 'Save'"), data: { main_action: { label: 'Sort by date' } } }).transient, { trials: 3, kinds: ['list-sort'], reset: false });
  // Reading and opening a page are still not risky (fix round 2).
  for (const steps of [['Read the heading'], ['Open the about page'], ['Log in', 'Go to the orders page', 'Read the total']]) assert.equal(plan(behavioral(...steps)).transient, false, steps.join(' / '));
});

test('F1 (R3-1): collect decides as dispatch did: a removing write with no reset path is N/A, reported, and its missing probe holds nothing against the case', { skip: SKIP }, async () => {
  const real = await qaGuiDetectorTools(QA_GUI);
  const seen = [];
  const tools = { dragonOps: (calls) => calls.map((c) => ({ kind: 'rpc', method: c.method, params: c.params, result: c.result, ok: c.ok, call: c })),
    transientProbeFromOps: (ops, options) => { seen.push(options.plan ?? null); return null; }, uxActionResultsFromOps: () => [], uxUnavailableResults: () => [], explorationFromOps: async () => null,
    classifyAction: real.classifyAction, transientRepeatability: real.transientRepeatability };
  const shot = { i: 1, method: 'screenshot', params: { tabId: 7, toFile: 'a.png' }, json: { ok: true, result: { ok: true, dom: { url: 'https://t/orders' } } }, called_at: null, at: null };
  const draft = { case_id: 'TC', states: [{ state: 'a' }] };
  const out = await caseDetectorResults({ draft, calls: new Map([[1, shot]]), shots: new Map([[draft.states[0], { call: shot }]]), tools,
    plannedCase: behavioral('Log in as admin', "Click 'Delete' in the orders table"), exists: () => false, fileSha: () => null });
  assert.deepEqual(out.caseIssues, []);
  assert.ok(out.issues.includes('DETECTOR_NA:TC:transient:TRANSIENT_WRITE_NO_RESET'), out.issues.join(', '));
  const sorted = await caseDetectorResults({ draft, calls: new Map([[1, shot]]), shots: new Map([[draft.states[0], { call: shot }]]), tools,
    plannedCase: behavioral('Log in as admin', "Click 'Sort by date'"), exists: () => false, fileSha: () => null });
  assert.deepEqual(sorted.caseIssues, ['DETECTOR_NOT_RUN:TC:transient'], 'the sort the dispatch asked a probe of is required');
});

test('F4 (R3-4): a probe Dragon\'s destructive gate refused on every trial is N/A, reported: no TRANSIENT_NOT_RECORDED, no DETECTOR_NOT_RUN', async () => {
  const tools = { dragonOps: (calls) => calls.map((c) => ({ kind: 'rpc', method: c.method, params: c.params, result: c.result, ok: c.ok, call: c })),
    transientProbeFromOps: () => ({ receipt: null, issues: [], na: 'DESTRUCTIVE_HANDOFF_REQUIRED' }), uxActionResultsFromOps: () => [], uxUnavailableResults: () => [], explorationFromOps: async () => null,
    classifyAction: ({ target }) => ({ kinds: /sort/i.test(target.label) ? ['list-sort'] : [] }), transientRepeatability: () => ({ repeatable: true, trials: 3, reason: null }) };
  const call = (i, method, params, result) => ({ i, method, params: { tabId: 7, ...params }, json: { ok: true, result }, called_at: null, at: null });
  const calls = new Map([call(1, 'screenshot', { toFile: 'a.png' }, { ok: true, dom: { url: 'https://t/orders' } }),
    call(2, 'framesTrial', { correlationId: 'transient:a' }, { ok: false, code: 'DESTRUCTIVE_HANDOFF_REQUIRED', completed: false })].map((c) => [c.i, c]));
  const draft = { case_id: 'TC', states: [{ state: 'a', transient: { action: { method: 'click', selector: '#sort' } } }] };
  const out = await caseDetectorResults({ draft, calls, shots: new Map([[draft.states[0], { call: calls.get(1) }]]), tools, plannedCase: behavioral("Click 'Sort by date'"), exists: () => false, fileSha: () => null });
  assert.deepEqual(out.caseIssues, []);
  assert.deepEqual(out.states.get('a').issues, []);
  assert.ok(out.issues.includes('DETECTOR_NA:TC:transient:DESTRUCTIVE_HANDOFF_REQUIRED'), out.issues.join(', '));
});
