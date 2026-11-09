// Upgrade R1e: prioritized frontier exploration. Cells tied to a requirement or high risk go first; an LLM chooser is
// asked only at a hard frontier point (a tie at the top) and sees at most 20 history steps; when coverage plateaus the
// explorer reads the CSS rules that never matched; a destructive action needs the approved plan; the log records the
// edges taken, the candidates left with their reason, and the stop reason, as an app map v2 log.
// Fixtures: an in-memory app driver and test/fixtures/r1e/explore-app.html (synthetic). Not evidence of a product run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EXPLORATION_POLICY_SCHEMA, cssStateHints, dragonExploreDriver, explore, scoreCandidate } from '../scripts/lib/frontier-explorer.mjs';
import { NOT_EXPLORED_CODES } from '../scripts/lib/coverage-cell.mjs';
import { loadPlaywright, PLAYWRIGHT_SKIP } from './support/playwright.mjs';
import { playwrightExploreDriver } from './support/playwright-readers.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// The Orders app as a state machine: list -> form, list -> delete dialog, list -> sorted list.
const SCREENS = {
  'screen:orders-list': { route: '/orders', rows: 3, candidates: [
    { target: 'button:New Order' }, { target: 'button:Delete' }, { target: 'button:Sort' }, { target: 'menu:Export', blocked: 'HOVER_ONLY' }] },
  'screen:order-new': { route: '/orders/new', candidates: [{ target: 'button:Save' }, { target: 'button:Cancel' }] },
  'dialog:delete-order': { route: '/orders', candidates: [{ target: 'button:Delete order' }, { target: 'button:Cancel' }] },
  'screen:orders-sorted': { route: '/orders', rows: 3, candidates: [{ target: 'button:New Order' }] },
};
const MOVES = {
  'screen:orders-list': { 'button:New Order': 'screen:order-new', 'button:Delete': 'dialog:delete-order', 'button:Sort': 'screen:orders-sorted' },
  'screen:order-new': { 'button:Save': 'screen:orders-list', 'button:Cancel': 'screen:orders-list' },
  'dialog:delete-order': { 'button:Delete order': 'screen:orders-list', 'button:Cancel': 'screen:orders-list' },
  'screen:orders-sorted': { 'button:New Order': 'screen:order-new' },
};
function appDriver({ unmatched = [], failAt = null } = {}) {
  let at = 'screen:orders-list';
  const acts = [];
  let reads = 0;
  const observe = async () => {
    const screen = SCREENS[at];
    return { node: at, route: screen.route, domHash: `${at}`.padEnd(64, '0').slice(0, 64), viewport: 'desktop-1280', ...(screen.rows ? { rows: screen.rows } : {}),
      candidates: screen.candidates.map((c) => ({ ...c })) };
  };
  return {
    acts, cssReads: () => reads,
    async start() { at = 'screen:orders-list'; return { url: '/orders', ...(await observe()) }; },
    observe,
    async act(candidate) {
      acts.push(`${at}>${candidate.target}`);
      if (failAt !== null && acts.length === failAt) throw new Error('session lost');
      const to = MOVES[at][candidate.target];
      if (!to) return { blocked: 'UNREACHABLE', detail: 'no such control' };
      at = to;
      return {};
    },
    async unmatchedCssRules() { reads += 1; return unmatched; },
  };
}
const policy = (extra = {}) => ({ schema: EXPLORATION_POLICY_SCHEMA, requirementCells: [], highRisk: [], approvedDestructive: [], ...extra });

test('scoring: a requirement cell first, then high risk, then the intrinsic risk of the action', () => {
  const p = policy({ requirementCells: [{ route: '/orders/new', action: 'click:Save', requirement: 'REQ-FORM' }], highRisk: [{ route: '/orders', action: 'click:Sort' }] });
  const save = scoreCandidate({ route: '/orders/new', target: 'button:Save' }, p);
  const sort = scoreCandidate({ route: '/orders', target: 'button:Sort' }, p);
  const cancel = scoreCandidate({ route: '/orders/new', target: 'button:Cancel' }, p);
  assert.ok(save.score > sort.score && sort.score > cancel.score, JSON.stringify({ save, sort, cancel }));
  assert.deepEqual(save.reasons, ['requirement:REQ-FORM', 'risk:high']);
  assert.ok(sort.reasons.includes('plan-risk'));
});

test('acceptance: the exploration log names the edges taken, every candidate left with its code, and a stop reason', async () => {
  const driver = appDriver();
  const run = await explore({ driver, policy: policy(), budget: 50 });
  const last = run.log.at(-1);
  assert.equal(last.action, 'stop');
  assert.equal(run.map.stop.reason, 'FRONTIER_EMPTY');
  // The destructive "Delete order" is never pressed without the approved plan; the hover-only menu is left with its code.
  assert.ok(!driver.acts.some((act) => act.endsWith('button:Delete order')));
  assert.deepEqual(run.map.frontier.map((entry) => [entry.route, entry.action, entry.reason]), [
    ['/orders', 'click:Export', 'HOVER_ONLY'],
    ['dialog:delete-order', 'click:Delete order', 'NEEDS_APPROVAL'],
  ]);
  assert.ok(run.map.frontier.every((entry) => NOT_EXPLORED_CODES.includes(entry.reason)));
  assert.deepEqual(run.map.nodes.map((node) => node.id).sort(), ['dialog:delete-order', 'screen:order-new', 'screen:orders-list', 'screen:orders-sorted']);
  // With the plan's approval the destructive action is explored.
  const approved = await explore({ driver: appDriver(), policy: policy({ approvedDestructive: [{ route: 'dialog:delete-order', action: 'click:Delete order' }] }), budget: 50 });
  assert.ok(!approved.map.frontier.some((entry) => entry.reason === 'NEEDS_APPROVAL'));
});

test('the stop reason is BUDGET_EXHAUSTED when the budget runs out and BLOCKED when the driver fails', async () => {
  let run = await explore({ driver: appDriver(), policy: policy(), budget: 2 });
  assert.deepEqual([run.log.at(-1).action, run.map.stop.reason], ['stop', 'BUDGET_EXHAUSTED']);
  assert.ok(run.map.frontier.some((entry) => entry.reason === 'BUDGET'));
  run = await explore({ driver: appDriver({ failAt: 2 }), policy: policy(), budget: 50 });
  assert.deepEqual([run.map.stop.reason, run.map.stop.code], ['BLOCKED', 'TOOL_LIMIT']);
  assert.match(run.map.stop.detail, /session lost/);
});

test('the Dragon explore driver starts with a goto step and clicks by the observed selector', async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params.steps]);
    return { completed: true, results: [{ step: 'read', as: 'v', value: JSON.stringify({ node: 'route:/orders', route: '/orders', candidates: [] }) }] };
  };
  const driver = dragonExploreDriver({ rpc, binding: { sessionId: 's' }, tabId: 4, url: 'https://test.example/orders' });
  assert.equal((await driver.start()).node, 'route:/orders');
  await driver.act({ target: 'button:Save', selector: '#save' });
  assert.deepEqual(calls.map(([method, steps]) => [method, Object.keys(steps[0])[0]]), [['do', 'goto'], ['do', 'read'], ['do', 'clickSelector']]);
  assert.equal(calls[0][1][0].goto, 'https://test.example/orders');
});

test('a requirement cell is explored first', async () => {
  const driver = appDriver();
  await explore({ driver, policy: policy({ requirementCells: [{ route: '/orders', action: 'click:Sort', requirement: 'REQ-SORT' }] }), budget: 1 });
  assert.deepEqual(driver.acts, ['screen:orders-list>button:Sort']);
});

test('the chooser is asked only at a tie on top, sees at most 20 steps, and an answer outside the options is not taken', async () => {
  const asked = [];
  const chooser = async ({ options, history }) => { asked.push({ options: options.map((o) => o.target), history: history.length }); return options.at(-1).target; };
  const run = await explore({ driver: appDriver(), policy: policy(), budget: 50, chooser });
  assert.ok(asked.length > 0 && asked.length < run.decisions.length, `asked ${asked.length} of ${run.decisions.length}`);
  assert.ok(asked.every((entry) => entry.options.length >= 2 && entry.history <= 20));
  assert.ok(run.decisions.every((decision) => decision.by === 'rule' || decision.by === 'chooser'));
  const wrong = await explore({ driver: appDriver(), policy: policy(), budget: 50, chooser: async () => 'button:Nowhere' });
  assert.ok(wrong.decisions.some((decision) => decision.note === 'CHOOSER_ANSWER_NOT_AN_OPTION'));
  const long = [];
  await explore({ driver: appDriver(), policy: policy(), budget: 60, historyLimit: 20, chooser: async ({ options, history }) => { long.push(history.length); return options[0].target; } });
  assert.ok(long.every((n) => n <= 20));
});

test('at a plateau the explorer reads the CSS rules that never matched and keeps the states they name as candidates', async () => {
  assert.deepEqual(cssStateHints(['.orders.is-empty .note', '.toast--error', '.skeleton-row', '.btn-primary']), [
    { selector: '.orders.is-empty .note', state: 'empty' }, { selector: '.toast--error', state: 'error' }, { selector: '.skeleton-row', state: 'loading' }]);
  const driver = appDriver({ unmatched: ['.orders.is-empty .note'] });
  const run = await explore({ driver, policy: policy(), budget: 50, plateauWindow: 3 });
  assert.equal(driver.cssReads(), 1);
  assert.ok(run.log.some((entry) => entry.action === 'css-hints'));
  const hint = run.map.frontier.find((entry) => entry.kind === 'state');
  assert.deepEqual([hint.route, hint.state, hint.reason], ['/orders', 'empty', 'UNREACHABLE']);
  assert.match(hint.detail, /is-empty/);
});

const playwright = await loadPlaywright();
test('a real browser run on the fixture app ends its log with a stop reason', { skip: playwright ? false : PLAYWRIGHT_SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const driver = await playwrightExploreDriver({ browser, url: pathToFileURL(join(ROOT, 'test/fixtures/r1e/explore-app.html')).href + '#/orders' });
    const run = await explore({ driver, policy: policy(), budget: 40, plateauWindow: 4 });
    await driver.close();
    assert.equal(run.log.at(-1).action, 'stop');
    assert.equal(run.map.stop.reason, 'FRONTIER_EMPTY');
    assert.ok(run.map.frontier.some((entry) => entry.reason === 'NEEDS_APPROVAL' && /Delete/.test(entry.action)), JSON.stringify(run.map.frontier));
    assert.ok(run.map.frontier.some((entry) => entry.kind === 'state' && entry.state === 'empty'), JSON.stringify(run.map.frontier));
    assert.ok(run.map.nodes.length >= 3, JSON.stringify(run.map.nodes));
  } finally { await browser.close(); }
});
