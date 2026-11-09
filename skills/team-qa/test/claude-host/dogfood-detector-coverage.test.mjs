// Dogfood 05/11 (a Track D run, Dragon 1.7.0): an ordinary plan gave no detector to any case. Its writes had no
// reset path (no probe), and its "loading" state forced nothing. The probe of a write that adds or saves now runs with
// fresh test values, and the plan's own "loading" / "error" states ask for U1/U2 / U3 on such a write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { caseDetectorPlan, qaGuiDetectorTools, stateUxRules } from '../../scripts/lib/detector-dispatch.mjs';

const QA_GUI = process.env.TEAMQA_WEB_TEST_QA_GUI_ROOT;
const SKIP = QA_GUI ? false : 'set TEAMQA_WEB_TEST_QA_GUI_ROOT to a QA GUI checkout';
// The three cases of that run, as its Designer wrote them (Vietnamese steps, the main action in data.main_action).
const supplier = { id: 'TC-NCC-01', kind: 'behavioral', states: ['ideal', 'loading', 'partial'],
  steps: ['V\u00e0o m\u00e0n "Nh\u00e0 cung c\u1ea5p"', 'B\u1ea5m n\u00fat th\u00eam nh\u00e0 cung c\u1ea5p m\u1edbi, nh\u1eadp t\u00ean v\u00e0 m\u00e3, r\u1ed3i b\u1ea5m l\u01b0u m\u1ed9t l\u1ea7n.'],
  data: { main_action: 'L\u01b0u' } };
const bom = { id: 'TC-BOM-01', kind: 'behavioral', states: ['ideal', 'partial'], steps: ['Xo\u00e1 \u0111\u1ecbnh m\u1ee9c qua menu \u22ef'], data: { main_action: 'Xo\u00e1' } };

test('stateUxRules: "loading" asks U1/U2 and "error" U3 of a write that adds or saves; never of a removing write or a read', () => {
  assert.deepEqual(stateUxRules({ states: ['ideal', 'loading'] }, ['save']), ['U1', 'U2']);
  assert.deepEqual(stateUxRules({ states: ['Error', 'loading'] }, ['submit', 'save']), ['U1', 'U2', 'U3']);
  assert.deepEqual(stateUxRules({ states: ['loading', 'error'] }, ['delete']), []);
  assert.deepEqual(stateUxRules({ states: ['loading'] }, ['list-sort']), []);
  assert.deepEqual(stateUxRules({ states: ['ideal'] }, ['save']), []);
});

test('the dogfood plan now probes its save with fresh values and forces its loading state; the delete stays N/A', { skip: SKIP }, async () => {
  const tools = await qaGuiDetectorTools(QA_GUI);
  const plan = (c) => caseDetectorPlan({ plannedCase: c, classify: tools.classifyAction, repeatability: tools.transientRepeatability });
  const s = plan(supplier);
  assert.deepEqual(s.transient, { trials: 3, kinds: ['save'], reset: false, fresh: true });
  assert.deepEqual([s.fresh, s.ux], [true, ['U1', 'U2']]);
  const prompt = tools.detectorPromptSection({ caseId: supplier.id, detectors: s });
  assert.match(prompt, /fresh test values/);
  assert.match(prompt, /U \(forced UX states, R1c\) for U1, U2/);
  const b = plan(bom);
  assert.deepEqual([b.transient, b.transientNa, b.ux, b.fresh], [false, 'TRANSIENT_WRITE_NO_RESET', [], undefined]);
  // A plan field still decides over the state list and the steps.
  assert.equal(plan({ ...supplier, data: { ...supplier.data, transient: false } }).transient, false);
});

// Dogfood 05/11 run 5: TC-02's plan (a delete with no reset path) gave it no detector, yet its executor guessed a
// probe; the trial deleted a second record. The dispatch now withholds the acting R1a tools, and collect refuses any.
test('a case with no planned detector: its dispatch withholds the acting R1a tools, and collect refuses an R1a action it made', { skip: SKIP }, async () => {
  const { dispatchArgs } = await import('../../scripts/lib/roster.mjs');
  const { caseDetectorResults, R1A_ACTING_TOOLS } = await import('../../scripts/lib/detector-collect.mjs');
  const seat = { harness: 'claude', model: 'm', reasoning_control: { args: [] }, caps: { max_turns: 100 }, mcp_config: { path: '/tmp/mcp.json' } };
  const route = { names: ['Dragon_Browser'] };
  const argv = dispatchArgs({ seat, role: 'executor_gui', route, attempt: 'a', withheldTools: R1A_ACTING_TOOLS });
  const denied = argv[argv.indexOf('--disallowedTools') + 1].split(',');
  for (const tool of ['framesTrial', 'envSet', 'sensorsStart', 'framesStart', 'paintSnapshot']) assert.ok(denied.includes(`mcp__Dragon_Browser__${tool}`), tool);
  for (const tool of ['envReset', 'help', 'do']) assert.ok(!denied.includes(`mcp__Dragon_Browser__${tool}`), `${tool} stays`);
  const plain = dispatchArgs({ seat, role: 'executor_gui', route, attempt: 'a' });
  assert.equal(plain[plain.indexOf('--disallowedTools') + 1], 'Agent,Task,Edit,Write,NotebookEdit,WebSearch,WebFetch', 'a case with detectors keeps its argv');

  const real = await qaGuiDetectorTools(QA_GUI);
  const tools = { dragonOps: (calls) => calls.map((c) => ({ kind: 'rpc', method: c.method, params: c.params, result: c.result, ok: c.ok, call: c })),
    transientProbeFromOps: () => null, uxActionResultsFromOps: () => [], uxUnavailableResults: () => [], explorationFromOps: async () => null,
    classifyAction: real.classifyAction, transientRepeatability: real.transientRepeatability };
  const shot = { i: 1, method: 'screenshot', params: { tabId: 7, toFile: 'a.png' }, json: { ok: true, result: { ok: true, dom: { url: 'https://t/boms' } } } };
  const trial = { i: 2, method: 'framesTrial', params: { tabId: 7, steps: [{ clickSelector: '[role=alertdialog] button:last-of-type' }] }, json: { ok: true, result: { ok: true } } };
  const draft = { case_id: 'TC-BOM-01', states: [{ state: 'after-delete' }] };
  const run = (calls) => caseDetectorResults({ draft, calls: new Map(calls.map((c) => [c.i, c])), shots: new Map([[draft.states[0], { call: shot }]]), tools,
    plannedCase: bom, exists: () => false, fileSha: () => null });
  assert.ok((await run([shot, trial])).caseIssues.includes('DETECTOR_UNPLANNED:TC-BOM-01:frames.trial'));
  assert.ok(!(await run([shot])).caseIssues.some((c) => c.startsWith('DETECTOR_UNPLANNED')));
});
