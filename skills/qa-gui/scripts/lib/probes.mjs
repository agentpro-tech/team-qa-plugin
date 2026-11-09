// Probe receipts a state receipt names in `probes: [{kind, path, sha256, cells?: {path, sha256}}]` (R1e: width sweep,
// overlay check, references/width-sweep-overlays.md; R1d: transient probe, references/transient-rules.md).
// The gate reads each one from the evidence manifest, hash for hash, and grades it itself with the detector's own pure
// grader; a stored verdict in the probe file is never trusted. The probe's verdict joins the state's UI verdict: FAIL
// wins, an ungradable probe makes the state UNGRADED. A receipt without `probes` is unchanged.
import { createHash } from 'node:crypto';
import { WIDTH_SWEEP_SCHEMA, sweepVerdict } from './width-sweep.mjs';
import { OVERLAY_CHECK_SCHEMA, gradeOverlay, notCheckedCells, overlayVerdict } from './overlay-check.mjs';
import { TRANSIENT_PROBE_SCHEMA, transientProbeVerdict } from './transient-probe.mjs';
import { RESPONSIVE_MATRIX } from '../loop7/responsive-matrix.mjs';
import { conditionKey, routeOf, viewportRow } from './coverage-cell.mjs';

// The sealed per-cell result of one probe (`qa-gui/probe-cells/v1`): what QA GUI's grader makes of the probe as
// coverage cells, for Team QA to count without grading. The state receipt names it in `probes[].cells`; the gate
// re-derives it from the probe on every run and refuses a file that differs (PROBE_CELLS_MISMATCH).
export const PROBE_CELLS_SCHEMA = 'qa-gui/probe-cells/v1';

const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value));

function base(receipt) {
  const cell = receipt?.cell && typeof receipt.cell === 'object' ? receipt.cell : null;
  return {
    route: typeof cell?.route === 'string' ? cell.route : routeOf(typeof receipt?.url === 'string' ? receipt.url : '') ?? '*',
    state: typeof cell?.state === 'string' ? cell.state : receipt?.state,
    viewport: typeof cell?.viewport === 'string' ? cell.viewport : viewportRow(receipt?.viewport)?.id ?? '*',
    condition: cell ? conditionKey(cell.conditions) : 'default',
  };
}

function sweepCells(probe, at) {
  const bands = (Array.isArray(probe?.bands) ? probe.bands : []).filter((band) => band?.status !== 'NOT_VISIBLE');
  return (Array.isArray(probe?.rows) ? probe.rows : []).map((measured) => {
    const row = RESPONSIVE_MATRIX.find((entry) => entry.id === measured?.row);
    const inside = row ? bands.filter((band) => row.w >= band.from && row.w <= band.to) : [];
    const failures = Array.isArray(measured?.failures) ? measured.failures : [];
    const verdict = !row || measured.verified !== true ? ['UNGRADED', 'EMULATION_NOT_VERIFIED']
      : inside.some((band) => failures.includes(band.id)) ? ['FAIL', null]
        : inside.length ? ['UNGRADED', 'SWEEP_MATRIX_DISAGREES'] : ['PASS', null];
    return { route: at.route, state: at.state, action: 'view', viewport: String(measured?.row), condition: 'default', status: verdict[0], ...(verdict[1] ? { reason: verdict[1] } : {}) };
  });
}

function overlayCells(probe, at) {
  const unchecked = (Array.isArray(probe?.notChecked) ? probe.notChecked : []).flatMap((entry) => notCheckedCells(entry?.trigger)
    .map((cell) => ({ route: cell.route, state: cell.state, action: cell.action, viewport: at.viewport, condition: at.condition, status: cell.status, reason: cell.reason })));
  return (Array.isArray(probe?.overlays) ? probe.overlays : []).flatMap((entry) => {
    const graded = gradeOverlay(entry?.observation);
    return graded.cells.map((cell) => {
      const check = graded.checks.find((item) => item.rule === cell.rule);
      return { route: cell.route, state: cell.state, action: cell.action, viewport: at.viewport, condition: at.condition, status: cell.status,
        ...(cell.status === 'UNGRADED' && check?.reason ? { reason: check.reason } : {}) };
    });
  }).concat(unchecked);
}

/** The sealed cells of one probe, derived only from the probe and the state receipt's own coordinates. */
export function probeCells({ receipt, caseId, state, kind, probe, probeSha256 }) {
  const at = base(receipt);
  const cells = kind === 'width-sweep' ? sweepCells(probe, at) : kind === 'overlay-check' ? overlayCells(probe, at) : [];
  const unsigned = { schema: PROBE_CELLS_SCHEMA, case: caseId, state, kind, probe_sha256: probeSha256, cells };
  return { ...unsigned, integrity: createHash('sha256').update(canonical(unsigned)).digest('hex') };
}

const SHA256 = /^[a-f0-9]{64}$/;
export const PROBE_KINDS = Object.freeze({
  'width-sweep': { schema: WIDTH_SWEEP_SCHEMA, grade: sweepVerdict },
  'overlay-check': { schema: OVERLAY_CHECK_SCHEMA, grade: overlayVerdict },
  transient: { schema: TRANSIENT_PROBE_SCHEMA, grade: transientProbeVerdict },
  // Round G (G5): the probe of a screen's entry (the navigation that shows it), graded by the same T rules.
  entry: { schema: TRANSIENT_PROBE_SCHEMA, grade: transientProbeVerdict },
});

const tri = (verdicts) => (verdicts.includes('FAIL') ? 'FAIL' : verdicts.every((v) => v === 'PASS') ? 'PASS' : 'UNGRADED');

/**
 * @param receipt  the state receipt
 * @param locate   (rel) -> {absolute, sha256} of a manifest entry, or null when the path is not in the manifest
 * @param read     (absolute) -> Buffer
 * @returns null when the receipt names no probe, else {verdict, issues: [{message, ungraded}]}
 */
export function probeVerdict({ receipt, caseId, state, locate, read }) {
  if (!receipt || typeof receipt !== 'object' || !Object.hasOwn(receipt, 'probes')) return null;
  const label = `PROBE:${caseId}:${state}`;
  const issues = [];
  const verdicts = [];
  const bad = (code) => { issues.push({ message: `${label}:${code}`, ungraded: true }); verdicts.push('UNGRADED'); };
  if (!Array.isArray(receipt.probes) || receipt.probes.length === 0) { bad('PROBES_INVALID'); return { verdict: 'UNGRADED', issues }; }
  for (const [index, probe] of receipt.probes.entries()) {
    const kind = PROBE_KINDS[probe?.kind];
    if (!kind) { bad(`PROBE_KIND_UNKNOWN:${index}:${String(probe?.kind)}`); continue; }
    const entry = typeof probe.path === 'string' ? locate(probe.path) : null;
    if (!entry) { bad(`PROBE_NOT_IN_MANIFEST:${probe.kind}:${String(probe.path)}`); continue; }
    let bytes;
    try { bytes = read(entry.absolute); } catch { bad(`PROBE_UNREADABLE:${probe.kind}:${probe.path}`); continue; }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (!SHA256.test(String(probe.sha256)) || digest !== probe.sha256 || (entry.sha256 && entry.sha256 !== digest)) { bad(`PROBE_HASH_MISMATCH:${probe.kind}:${probe.path}`); continue; }
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { bad(`PROBE_INVALID_JSON:${probe.kind}:${probe.path}`); continue; }
    if (value?.schema !== kind.schema) { bad(`PROBE_SCHEMA:${probe.kind}:${String(value?.schema)}`); continue; }
    const graded = kind.grade(value);
    verdicts.push(graded.verdict);
    for (const code of graded.issues) issues.push({ message: `${label}:${code}`, ungraded: graded.verdict !== 'FAIL' });
    // The sealed cells file, when named, must be exactly what the gate derives from this probe.
    if (probe.cells !== undefined) {
      const ref = probe.cells;
      const where = `${probe.kind}:${String(ref?.path)}`;
      const cellsEntry = typeof ref?.path === 'string' ? locate(ref.path) : null;
      if (!cellsEntry) { bad(`PROBE_CELLS_NOT_IN_MANIFEST:${where}`); continue; }
      let cellsBytes;
      try { cellsBytes = read(cellsEntry.absolute); } catch { bad(`PROBE_CELLS_UNREADABLE:${where}`); continue; }
      const cellsDigest = createHash('sha256').update(cellsBytes).digest('hex');
      if (!SHA256.test(String(ref.sha256)) || cellsDigest !== ref.sha256 || (cellsEntry.sha256 && cellsEntry.sha256 !== cellsDigest)) { bad(`PROBE_CELLS_HASH_MISMATCH:${where}`); continue; }
      let stored = null;
      try { stored = JSON.parse(cellsBytes.toString('utf8')); } catch {}
      const expected = probeCells({ receipt, caseId, state, kind: probe.kind, probe: value, probeSha256: digest });
      if (canonical(stored) !== canonical(expected)) bad(`PROBE_CELLS_MISMATCH:${where}`);
    }
  }
  return { verdict: tri(verdicts), issues };
}
