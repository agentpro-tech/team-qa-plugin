// Integration of R1b with R1a/R1d: a coverage cell's environment conditions are the ones Dragon recorded for the state
// (receipt.env.conditions), in the cell vocabulary (kind=value, coverage-cell.mjs). The gate refuses a cell whose
// conditions differ from that record, and one that names conditions with no Dragon record behind them.
import test from 'node:test';
import assert from 'node:assert/strict';

import { cellConditionsOf, conditionKey, stateCell, stateCellIssues } from '../scripts/lib/coverage-cell.mjs';
import { conditions } from './support/r1d-board.mjs';

test('Dragon\'s closed conditions record in the cell vocabulary', () => {
  assert.deepEqual(cellConditionsOf(null), {});
  assert.deepEqual(cellConditionsOf(conditions({ probes: { sensors: true, frames: true } })), {}, 'sensors and frames are not conditions');
  assert.deepEqual(cellConditionsOf(conditions({ network: { offline: true, latencyMs: 0, downloadKbps: null, uploadKbps: null, urlPattern: null } })), { network: 'offline' });
  assert.deepEqual(cellConditionsOf(conditions({ network: { offline: false, latencyMs: 2000, downloadKbps: 400, uploadKbps: 400, urlPattern: null } })), { network: 'slow-3g' });
  assert.deepEqual(cellConditionsOf(conditions({ network: { offline: false, latencyMs: 300, downloadKbps: null, uploadKbps: null, urlPattern: 'http://127.0.0.1:*/api/*' } })),
    { network: 'latency300-downany-upany' });
  assert.deepEqual(cellConditionsOf(conditions({ cpu: { rate: 4 }, timezone: 'Asia/Ho_Chi_Minh', locale: 'vi-VN',
    media: { type: null, colorScheme: 'dark', reducedMotion: 'reduce', forcedColors: null, contrast: null, reducedTransparency: null } })),
  { cpu: '4', locale: 'vi-VN', media: 'colorScheme:dark,reducedMotion:reduce', timezone: 'Asia/Ho_Chi_Minh' });
  assert.deepEqual(cellConditionsOf(conditions({ cpu: { rate: 1 } })), {}, 'CPU 1x is the default');
  const requests = [{ id: 'write', urlPattern: '*/api/orders*', action: 'hold', status: null, errorReason: null, matched: 1 },
    { id: 'err', urlPattern: '*/api/save*', action: 'respond', status: 500, errorReason: null, matched: 1 },
    { id: 'off', urlPattern: '*/api/x*', action: 'fail', status: null, errorReason: 'InternetDisconnected', matched: 0 }];
  assert.deepEqual(cellConditionsOf(conditions({ requests })), { request: 'hold,respond:500,fail:InternetDisconnected' });
  assert.equal(conditionKey(cellConditionsOf(conditions({ requests: requests.slice(1, 2), locale: 'vi-VN' }))), 'locale=vi-VN+request=respond:500');
});

const cell = (over = {}) => ({ version: 'qa-gui/coverage-cell/v1', route: '/orders', state: 'error', action: 'click:Save', viewport: 'desktop-1280', conditions: {}, ...over });
const receipt = (c, env) => ({ caseId: 'TC-01', state: 'error', viewport: '1280x800', domHash: 'd'.repeat(64), cell: c, ...(env === undefined ? {} : { env }) });
const failing = { id: 'err', urlPattern: '*/api/save*', action: 'respond', status: 500, errorReason: null, matched: 1 };

test('the gate: a cell must name the conditions Dragon recorded for its state, and no others', () => {
  const env = { conditions: conditions({ requests: [failing], verified: true }) };
  assert.deepEqual(stateCellIssues(receipt(cell({ conditions: { request: 'respond:500' } }), env)), []);
  assert.equal(stateCell(receipt(cell({ conditions: { request: 'respond:500' } }), env)).condition, 'request=respond:500');
  assert.deepEqual(stateCellIssues(receipt(cell(), env)).map((p) => p.code), ['CELL_CONDITIONS_MISMATCH']);
  assert.deepEqual(stateCellIssues(receipt(cell({ conditions: { request: 'respond:503' } }), env)).map((p) => p.code), ['CELL_CONDITIONS_MISMATCH']);
  // Conditions with no Dragon record behind them are not a forced state.
  assert.deepEqual(stateCellIssues(receipt(cell({ conditions: { network: 'offline' } }))).map((p) => p.code), ['CELL_CONDITIONS_UNBACKED']);
  // No env block and no conditions: as before R1a; an env block of defaults (null) and no conditions: fine.
  assert.deepEqual(stateCellIssues(receipt(cell())), []);
  assert.deepEqual(stateCellIssues(receipt(cell(), { conditions: null })), []);
});
