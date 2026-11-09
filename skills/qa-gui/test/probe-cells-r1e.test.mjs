// Upgrade R1e: the sealed per-cell result of a probe (qa-gui/probe-cells/v1). QA GUI's grader turns a probe receipt
// into cells; the state receipt names the file (`probes[].cells: {path, sha256}`), and the gate re-derives it on every
// run and refuses one that differs. Team QA counts these cells and never grades. Synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROBE_CELLS_SCHEMA, probeCells, probeVerdict } from '../scripts/lib/probes.mjs';
import { OVERLAY_CHECK_SCHEMA } from '../scripts/lib/overlay-check.mjs';
import { WIDTH_SWEEP_SCHEMA } from '../scripts/lib/width-sweep.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(ROOT, 'scripts/qa-gui.mjs');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const observation = (esc = true) => ({
  trigger: { selector: '#edit-trigger', label: 'Edit order' }, overlay: '#edit-dialog',
  mouse: { opened: true, overlay: '#edit-dialog', activeInside: true }, trap: { presses: 2, inside: [true, true] },
  scroll: { scrollable: false }, stacked: { available: false },
  esc: { closed: esc, active: esc ? '#edit-trigger' : '#x' }, keyboard: { reachedTrigger: true, presses: 1, opened: true },
  backdrop: { available: false }, button: { available: true, closed: true, active: '#edit-trigger' },
});
const overlay = (esc) => ({ schema: OVERLAY_CHECK_SCHEMA, route: '/orders', triggers: [], overlays: [{ id: 'dialog:edit-dialog', observation: observation(esc) }] });
const receipt = { schema: 'qa-gui/state-receipt/v1', caseId: 'TC-01', state: 'ideal', url: 'https://test.example/orders?page=1', viewport: '1280x800', domHash: 'e'.repeat(64) };

test('an overlay check gives one cell per way in and out, at the receipt\'s viewport row and condition', () => {
  const probe = overlay(false);
  const text = JSON.stringify(probe);
  const sealed = probeCells({ receipt, caseId: 'TC-01', state: 'ideal', kind: 'overlay-check', probe, probeSha256: sha(text) });
  assert.equal(sealed.schema, PROBE_CELLS_SCHEMA);
  assert.deepEqual([sealed.case, sealed.state, sealed.kind, sealed.probe_sha256], ['TC-01', 'ideal', 'overlay-check', sha(text)]);
  assert.deepEqual(sealed.cells, [
    { route: 'dialog:edit-dialog', state: 'ideal', action: 'open:mouse', viewport: 'desktop-1280', condition: 'default', status: 'PASS' },
    { route: 'dialog:edit-dialog', state: 'ideal', action: 'open:keyboard', viewport: 'desktop-1280', condition: 'default', status: 'PASS' },
    { route: 'dialog:edit-dialog', state: 'ideal', action: 'close:esc', viewport: 'desktop-1280', condition: 'default', status: 'FAIL' },
    { route: 'dialog:edit-dialog', state: 'ideal', action: 'close:backdrop', viewport: 'desktop-1280', condition: 'default', status: 'UNGRADED', reason: 'PRECONDITION_ABSENT' },
    { route: 'dialog:edit-dialog', state: 'ideal', action: 'close:button', viewport: 'desktop-1280', condition: 'default', status: 'PASS' },
  ]);
  assert.match(sealed.integrity, /^[a-f0-9]{64}$/);
  // Deterministic: the same inputs seal the same bytes.
  assert.deepEqual(probeCells({ receipt, caseId: 'TC-01', state: 'ideal', kind: 'overlay-check', probe, probeSha256: sha(text) }), sealed);
});

test('a width sweep gives one cell per matrix row it measured: FAIL where a band fails, UNGRADED where emulation was not verified', () => {
  const probe = {
    schema: WIDTH_SWEEP_SCHEMA, min: 320, max: 1440, step: 20, samples: [], probes: 0, breakpoints: [], captures: [],
    bands: [{ id: 'W2|main', rule: 'W2', selector: 'main', from: 741, to: 783, status: 'CONFIRMED' }],
    rows: [{ row: 'desktop-767', verified: true, failures: ['W2|main'] }, { row: 'desktop-768', verified: false, failures: [] }, { row: 'desktop-769', verified: true, failures: [] }],
  };
  const sealed = probeCells({ receipt: { ...receipt, cell: { version: 'qa-gui/coverage-cell/v1', route: '/orders', action: 'view', viewport: 'desktop-1280', conditions: {} } },
    caseId: 'TC-01', state: 'ideal', kind: 'width-sweep', probe, probeSha256: sha(JSON.stringify(probe)) });
  assert.deepEqual(sealed.cells.map((cell) => [cell.route, cell.state, cell.action, cell.viewport, cell.condition, cell.status, cell.reason ?? null]), [
    ['/orders', 'ideal', 'view', 'desktop-767', 'default', 'FAIL', null],
    ['/orders', 'ideal', 'view', 'desktop-768', 'default', 'UNGRADED', 'EMULATION_NOT_VERIFIED'],
    ['/orders', 'ideal', 'view', 'desktop-769', 'default', 'UNGRADED', 'SWEEP_MATRIX_DISAGREES'],
  ]);
});

// The gate side: probeVerdict with a cells reference.
function gateWith(cellsText, { inManifest = true } = {}) {
  const probe = overlay(true);
  const probeText = JSON.stringify(probe);
  const files = new Map([['evidence/p.json', probeText], ['evidence/p.cells.json', cellsText]]);
  const state = { ...receipt, probes: [{ kind: 'overlay-check', path: 'evidence/p.json', sha256: sha(probeText), cells: { path: 'evidence/p.cells.json', sha256: sha(cellsText) } }] };
  return probeVerdict({ receipt: state, caseId: 'TC-01', state: 'ideal', read: (path) => Buffer.from(files.get(path)),
    locate: (rel) => (files.has(rel) && (inManifest || rel !== 'evidence/p.cells.json') ? { absolute: rel, sha256: sha(files.get(rel)) } : null) });
}

test('gate: the cells file must be exactly what the gate derives from the probe; an edited or unlisted one is UNGRADED', () => {
  const probe = overlay(true);
  const good = `${JSON.stringify(probeCells({ receipt, caseId: 'TC-01', state: 'ideal', kind: 'overlay-check', probe, probeSha256: sha(JSON.stringify(probe)) }), null, 2)}\n`;
  assert.deepEqual(gateWith(good), { verdict: 'PASS', issues: [] });
  const edited = good.replace('"UNGRADED"', '"PASS"');
  let graded = gateWith(edited);
  assert.equal(graded.verdict, 'UNGRADED');
  assert.ok(graded.issues.some((issue) => issue.ungraded && issue.message === 'PROBE:TC-01:ideal:PROBE_CELLS_MISMATCH:overlay-check:evidence/p.cells.json'), JSON.stringify(graded.issues));
  graded = gateWith(good, { inManifest: false });
  assert.ok(graded.issues.some((issue) => issue.message.startsWith('PROBE:TC-01:ideal:PROBE_CELLS_NOT_IN_MANIFEST')), JSON.stringify(graded.issues));
});

test('the qa-gui CLI writes the sealed cells file the state receipt then names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-gui-probe-cells-'));
  const probe = overlay(false);
  writeFileSync(join(dir, 'probe.json'), JSON.stringify(probe));
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt));
  const out = join(dir, 'cells.json');
  const r = spawnSync(process.execPath, [CLI, 'probe-cells', '--receipt', join(dir, 'receipt.json'), '--probe', join(dir, 'probe.json'), '--kind', 'overlay-check', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const line = JSON.parse(r.stdout.trim());
  const text = readFileSync(out, 'utf8');
  assert.deepEqual([line.ok, line.command, line.cells, line.sha256], [true, 'probe-cells', 5, sha(text)]);
  assert.deepEqual(JSON.parse(text), probeCells({ receipt, caseId: 'TC-01', state: 'ideal', kind: 'overlay-check', probe, probeSha256: sha(readFileSync(join(dir, 'probe.json'))) }));
});
