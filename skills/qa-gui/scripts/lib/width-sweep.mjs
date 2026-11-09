// R1e — the width sweep. Contract: references/width-sweep-overlays.md.
//
// Read-only geometry from 320 to 1440 px in steps of 20-40 px (20 by default: the reads are cheap), then bisection to the
// exact width where the layout or a
// failure changes. A failing element is confirmed with a paint-ordered snapshot, captured only at the narrowest width
// that still fails, and its verdict still comes from the responsive matrix rows (scripts/loop7/responsive-matrix.mjs)
// whose emulation was verified: the sweep finds bands, it never grades a PASS on its own.
//
// The engine is pure over a reader:
//   measure(width)      -> {width, layout, failures: [{rule, selector, tag?, detail, rect?}]}   (GEOMETRY_PROBE_BODY)
//   confirm(width, failure)? -> {status: CONFIRMED|NOT_VISIBLE|UNCONFIRMED, reason}   (Dragon: R1a paintSnapshot)
//   snapshot(width)?    -> {nodes: [{index, parent, name, rect, paintOrder, visible}]}         (normalizeDomSnapshot;
//                          used with confirmVisible when the reader has no confirm, e.g. a CDP client)
//   capture(width)?     -> any JSON (the evidence capture at that width)
//   measureRow(row)?    -> {verified, failures: [failure ids]}   (a matrix row under verified emulation)
//   found()?            -> the viewport the tab had before the sweep (read once, first)
//   restore(found)?     -> {ok, viewport?, reason?}: puts that viewport back; always called last, also when the sweep
//                          throws, and recorded in the receipt as `viewport: {found, restored}`
// QA GUI's reader is Dragon's (width-sweep-dragon.mjs); tests use a Playwright reader behind the same interface.
import { RESPONSIVE_MATRIX } from '../loop7/responsive-matrix.mjs';

export const WIDTH_SWEEP_SCHEMA = 'qa-gui/width-sweep/v1';
export const SWEEP_RULES = Object.freeze({
  W1: 'the page scrolls sideways',
  W2: 'an element sticks out of the viewport',
  W3: 'text is cut by its own box',
  W4: 'two controls overlap',
});

// The page-side read: a function body (Dragon `read` step, or wrapped by probeExpression for a page evaluation).
// It only reads geometry and computed style; it changes nothing on the page.
export const GEOMETRY_PROBE_BODY = `
const vw = document.documentElement.clientWidth;
const css = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value);
const sel = (el) => {
  const parts = [];
  for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
    if (e.id) { parts.unshift('#' + css(e.id)); break; }
    let p = e.tagName.toLowerCase();
    if (e.classList.length) p += '.' + [...e.classList].slice(0, 2).map(css).join('.');
    const same = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName && x.className === e.className) : [];
    if (same.length > 1) p += ':nth-of-type(' + ([...e.parentElement.children].filter((x) => x.tagName === e.tagName).indexOf(e) + 1) + ')';
    parts.unshift(p);
    if (e.parentElement === document.body) break;
  }
  return parts.join(' > ');
};
const visible = (el) => {
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};
const box = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
const inScroller = (el) => {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true;
  }
  return false;
};
const failures = [];
const doc = document.documentElement;
if (doc.scrollWidth > vw + 1) failures.push({ rule: 'W1', selector: 'html', tag: 'html', detail: 'scrollWidth ' + doc.scrollWidth + ' > ' + vw });
const all = [...document.body.querySelectorAll('*')].filter(visible);
for (const el of all) {
  const r = el.getBoundingClientRect();
  if ((r.right > vw + 1 || r.left < -1) && !inScroller(el)) {
    const parent = el.parentElement;
    const pr = parent && parent !== document.body ? parent.getBoundingClientRect() : null;
    if (pr && (pr.right > vw + 1 || pr.left < -1)) continue;
    failures.push({ rule: 'W2', selector: sel(el), target: sel(el), tag: el.tagName.toLowerCase(), detail: 'outside the viewport: ' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + vw, rect: box(r) });
  }
}
for (const el of all) {
  const s = getComputedStyle(el);
  if (/(hidden|clip)/.test(s.overflowX) && s.textOverflow !== 'ellipsis' && el.childElementCount === 0 && el.textContent.trim() && el.scrollWidth > el.clientWidth + 1) {
    failures.push({ rule: 'W3', selector: sel(el), target: sel(el), tag: el.tagName.toLowerCase(), detail: 'scrollWidth ' + el.scrollWidth + ' > ' + el.clientWidth, rect: box(el.getBoundingClientRect()) });
  }
}
const controls = all.filter((el) => el.matches('a[href],button,input,select,textarea,[role=button]'));
for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
  if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
  const a = controls[i].getBoundingClientRect(), b = controls[j].getBoundingClientRect();
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (ox > 2 && oy > 2) failures.push({ rule: 'W4', selector: sel(controls[i]) + ' & ' + sel(controls[j]), target: sel(controls[i]), tag: controls[i].tagName.toLowerCase(), detail: 'overlap ' + Math.round(ox) + 'x' + Math.round(oy), rect: box(a) });
}
const marks = [...document.querySelectorAll('header,nav,main,aside,footer,[data-layout]')].filter(visible).slice(0, 24)
  .map((el) => ({ s: sel(el), r: el.getBoundingClientRect() }))
  .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
const rows = [];
for (const m of marks) {
  const row = rows.find((x) => Math.abs(x.top - m.r.top) <= 4);
  if (row) row.items.push(m); else rows.push({ top: m.r.top, items: [m] });
}
const layout = rows.map((row) => row.items.sort((a, b) => a.r.left - b.r.left).map((m) => m.s).join(',')).join(' / ');
return { width: vw, layout, failures };
`;

export function probeExpression(body = GEOMETRY_PROBE_BODY) {
  return `(() => {${body}})()`;
}

const failureId = (failure) => `${failure.rule}|${failure.selector}`;

function normalizeMeasure(value, width) {
  const failures = Array.isArray(value?.failures) ? value.failures.filter((f) => f && typeof f.rule === 'string' && typeof f.selector === 'string') : [];
  return { width, layout: typeof value?.layout === 'string' ? value.layout : '', failures };
}

// CDP DOMSnapshot.captureSnapshot (includePaintOrder, includeDOMRects; computedStyles in `styles` order) -> nodes.
export function normalizeDomSnapshot(cdp, styles = ['visibility', 'opacity', 'display']) {
  const doc = cdp?.documents?.[0];
  const strings = Array.isArray(cdp?.strings) ? cdp.strings : [];
  if (!doc?.layout || !doc?.nodes) return { nodes: [] };
  const text = (index) => (Number.isInteger(index) && index >= 0 ? strings[index] ?? '' : '');
  const at = (name) => styles.indexOf(name);
  const nodes = doc.layout.nodeIndex.map((nodeIndex, k) => {
    const [x, y, width, height] = doc.layout.bounds[k] ?? [0, 0, 0, 0];
    const style = doc.layout.styles?.[k] ?? [];
    const visibility = at('visibility') >= 0 ? text(style[at('visibility')]) : 'visible';
    const opacity = at('opacity') >= 0 ? text(style[at('opacity')]) : '1';
    const display = at('display') >= 0 ? text(style[at('display')]) : 'block';
    return {
      index: nodeIndex, parent: doc.nodes.parentIndex?.[nodeIndex] ?? -1, name: text(doc.nodes.nodeName?.[nodeIndex]),
      rect: { x, y, width, height }, paintOrder: Number.isInteger(doc.layout.paintOrders?.[k]) ? doc.layout.paintOrders[k] : null,
      visible: visibility !== 'hidden' && opacity !== '0' && display !== 'none',
    };
  });
  return { nodes };
}

const near = (a, b) => Math.abs(a - b) <= 1.5;
const contains = (r, x, y) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

// Is the failing element really painted where it fails? Its snapshot node must be visible and, at the centre of its
// on-screen part, no unrelated node may be painted above it.
export function confirmVisible(snapshot, failure, viewportWidth) {
  if (failure?.rule === 'W1') return { status: 'CONFIRMED', reason: 'SCROLL_WIDTH' };
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const r = failure?.rect;
  const name = String(failure?.tag ?? '').toUpperCase();
  const node = r && nodes.find((n) => n.name === name && near(n.rect.x, r.x) && near(n.rect.y, r.y) && near(n.rect.width, r.width) && near(n.rect.height, r.height));
  if (!node) return { status: 'UNCONFIRMED', reason: 'NODE_NOT_IN_SNAPSHOT' };
  if (!node.visible || node.paintOrder === null) return { status: 'NOT_VISIBLE', reason: 'NOT_PAINTED' };
  const left = Math.max(r.x, 0), right = Math.min(r.x + r.width, viewportWidth);
  const x = right > left ? (left + right) / 2 : r.x + r.width / 2;
  const y = r.y + r.height / 2;
  const parents = new Map(nodes.map((n) => [n.index, n.parent]));
  const within = (index, ancestor) => { for (let i = index; i !== -1 && i !== undefined; i = parents.get(i)) if (i === ancestor) return true; return false; };
  const above = nodes.filter((n) => n.visible && n.paintOrder !== null && n.paintOrder > node.paintOrder && contains(n.rect, x, y)
    && !within(n.index, node.index) && !within(node.index, n.index) && n.name !== '#text');
  if (above.length) return { status: 'NOT_VISIBLE', reason: 'COVERED', by: above.sort((a, b) => b.paintOrder - a.paintOrder)[0].name };
  return { status: 'CONFIRMED', reason: null };
}

async function bisect(lo, hi, pred) {
  // pred(lo) is false and pred(hi) true: the smallest width in (lo, hi] where it holds.
  let a = lo, b = hi;
  while (b - a > 1) {
    const mid = Math.floor((a + b) / 2);
    if (await pred(mid)) b = mid; else a = mid;
  }
  return b;
}

/**
 * Sweeps one screen. Returns the `qa-gui/width-sweep/v1` receipt: the coarse samples, the exact layout breakpoints, one
 * band per failure and width range ({id, rule, selector, from, to, status, confirmation, capture, rows, verdict, reason}),
 * the captures and the matrix rows measured.
 */
// A band narrower than `step` that falls between two coarse samples can still be missed; the edges of a band that is
// found are exact.
export async function sweepWidths({ reader, min = 320, max = 1440, step = 20, matrix = RESPONSIVE_MATRIX }) {
  if (!(Number.isInteger(step) && step >= 20 && step <= 40)) throw new Error(`SWEEP_STEP_OUT_OF_RANGE: ${step} (20-40 px)`);
  if (!(Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max > min)) throw new Error('SWEEP_RANGE_INVALID');
  // The sweep leaves the tab at the viewport it found: the reader reads it first and puts it back last, also on a throw.
  const restores = typeof reader.restore === 'function';
  const found = restores && typeof reader.found === 'function' ? await reader.found() : null;
  let receipt, failure = null;
  try { receipt = await sweepBody({ reader, min, max, step, matrix }); } catch (error) { failure = error; }
  let restored = null;
  if (restores) {
    try { restored = await reader.restore(found); } catch (error) { restored = { ok: false, reason: String(error?.message ?? error).split('\n')[0] }; }
    if (!restored || typeof restored.ok !== 'boolean') restored = { ok: false, reason: 'RESTORE_RESULT_INVALID' };
  }
  if (failure) throw failure;
  if (restores) receipt.viewport = { found: found ?? null, restored };
  return receipt;
}

async function sweepBody({ reader, min, max, step, matrix }) {
  const cache = new Map();
  const at = async (width) => {
    if (!cache.has(width)) cache.set(width, normalizeMeasure(await reader.measure(width), width));
    return cache.get(width);
  };
  const coarse = [];
  for (let width = min; width < max; width += step) coarse.push(width);
  coarse.push(max);
  for (const width of coarse) await at(width);

  const breakpoints = [];
  for (let i = 1; i < coarse.length; i += 1) {
    const before = (await at(coarse[i - 1])).layout;
    if (before === (await at(coarse[i])).layout) continue;
    const width = await bisect(coarse[i - 1], coarse[i], async (x) => (await at(x)).layout !== before);
    breakpoints.push({ width, from: (await at(width - 1)).layout, to: (await at(width)).layout });
  }

  const ids = [];
  for (const width of coarse) for (const failure of (await at(width)).failures) if (!ids.includes(failureId(failure))) ids.push(failureId(failure));
  const has = async (width, id) => (await at(width)).failures.some((failure) => failureId(failure) === id);
  const bands = [];
  for (const id of ids) {
    const present = [];
    for (const width of coarse) present.push(await has(width, id));
    for (let i = 0; i < coarse.length; i += 1) {
      if (!present[i] || (i > 0 && present[i - 1])) continue;
      let j = i;
      while (j + 1 < coarse.length && present[j + 1]) j += 1;
      const from = i === 0 ? min : await bisect(coarse[i - 1], coarse[i], (x) => has(x, id));
      const to = j === coarse.length - 1 ? max : (await bisect(coarse[j], coarse[j + 1], async (x) => !(await has(x, id)))) - 1;
      const failure = (await at(from)).failures.find((entry) => failureId(entry) === id);
      bands.push({ id, rule: failure.rule, selector: failure.selector, from, to, detail: failure.detail ?? null, failure });
    }
  }

  // Confirm each band at its narrowest failing width; capture there only, once per width.
  const captures = new Map();
  for (const band of bands) {
    let confirmation;
    if (typeof reader.confirm === 'function') {
      try { confirmation = await reader.confirm(band.from, band.failure); }
      catch (error) { confirmation = { status: 'UNCONFIRMED', reason: 'SNAPSHOT_UNAVAILABLE', detail: String(error?.message ?? error).split('\n')[0] }; }
      if (!['CONFIRMED', 'NOT_VISIBLE', 'UNCONFIRMED'].includes(confirmation?.status)) confirmation = { status: 'UNCONFIRMED', reason: 'CONFIRMATION_INVALID' };
    } else if (typeof reader.snapshot !== 'function') confirmation = { status: 'UNCONFIRMED', reason: 'SNAPSHOT_UNAVAILABLE' };
    else {
      try { confirmation = confirmVisible(await reader.snapshot(band.from), band.failure, band.from); }
      catch (error) { confirmation = { status: 'UNCONFIRMED', reason: 'SNAPSHOT_UNAVAILABLE', detail: String(error?.message ?? error).split('\n')[0] }; }
    }
    band.status = confirmation.status;
    band.confirmation = confirmation;
    band.capture = null;
    if (band.status !== 'NOT_VISIBLE' && typeof reader.capture === 'function') {
      if (!captures.has(band.from)) captures.set(band.from, await reader.capture(band.from));
      band.capture = band.from;
    }
  }

  // The verdict comes from the matrix rows inside a band, measured under verified emulation.
  const rowsMeasured = new Map();
  for (const band of bands) {
    band.rows = matrix.filter((row) => row.w >= band.from && row.w <= band.to).map((row) => row.id);
    if (band.status === 'NOT_VISIBLE') continue;
    for (const id of band.rows) {
      if (rowsMeasured.has(id) || typeof reader.measureRow !== 'function') continue;
      const row = matrix.find((entry) => entry.id === id);
      const measured = await reader.measureRow(row);
      rowsMeasured.set(id, { row: id, verified: measured?.verified === true, failures: Array.isArray(measured?.failures) ? measured.failures.map(String) : [] });
    }
  }
  const receipt = {
    schema: WIDTH_SWEEP_SCHEMA, min, max, step,
    samples: coarse.map((width) => ({ width, layout: cache.get(width).layout, failures: cache.get(width).failures.map(failureId) })),
    probes: cache.size,
    breakpoints,
    bands: bands.map(({ failure, ...band }) => band),
    captures: [...captures].map(([width, value]) => ({ width, capture: value ?? null })),
    rows: [...rowsMeasured.values()],
  };
  for (const band of receipt.bands) Object.assign(band, bandVerdict(band, receipt.rows));
  return receipt;
}

function bandVerdict(band, rows) {
  if (band.status === 'NOT_VISIBLE') return { verdict: null, reason: null };
  if (!Array.isArray(band.rows) || band.rows.length === 0) return { verdict: 'UNGRADED', reason: 'SWEEP_BAND_OUTSIDE_MATRIX' };
  const verified = rows.filter((row) => band.rows.includes(row.row) && row.verified === true);
  if (verified.length === 0) return { verdict: 'UNGRADED', reason: 'EMULATION_NOT_VERIFIED' };
  if (verified.some((row) => row.failures.includes(band.id))) return { verdict: 'FAIL', reason: null };
  return { verdict: 'UNGRADED', reason: 'SWEEP_MATRIX_DISAGREES' };
}

/**
 * The gate's reading of a sweep receipt: each band's verdict is recomputed from the receipt's matrix rows (a stored
 * verdict is not trusted). FAIL when a verified row inside a band shows its failure; UNGRADED when a band has no
 * verified row to decide it; PASS when no band counts.
 */
export function sweepVerdict(receipt) {
  if (receipt?.schema !== WIDTH_SWEEP_SCHEMA || !Array.isArray(receipt.bands) || !Array.isArray(receipt.rows)) return { verdict: 'UNGRADED', issues: ['SWEEP_RECEIPT_INVALID'] };
  const issues = [];
  const verdicts = [];
  for (const band of receipt.bands) {
    if (!['CONFIRMED', 'UNCONFIRMED', 'NOT_VISIBLE'].includes(band?.status) || !Number.isInteger(band.from) || !Number.isInteger(band.to)) {
      issues.push('SWEEP_RECEIPT_INVALID'); verdicts.push('UNGRADED'); continue;
    }
    const rows = RESPONSIVE_MATRIX.filter((row) => row.w >= band.from && row.w <= band.to).map((row) => row.id);
    const { verdict, reason } = bandVerdict({ ...band, rows }, receipt.rows);
    if (verdict === null) continue;
    verdicts.push(verdict);
    if (verdict === 'FAIL') issues.push(`SWEEP_BAND_FAIL:${band.id}:${band.from}-${band.to}:${rows.join(',')}`);
    else issues.push(`${reason}:${band.id}:${band.from}-${band.to}`);
  }
  // A band capture whose copy does not hash to what Dragon reported (Team QA's capture `problem`) backs nothing.
  for (const entry of Array.isArray(receipt.captures) ? receipt.captures : []) {
    const problem = entry?.capture?.problem;
    if (typeof problem === 'string' && problem) { issues.push(`${problem}:${entry.width}`); verdicts.push('UNGRADED'); }
  }
  // A sweep that could not put the tab back at the viewport it found leaves the next states measured at another size.
  if (receipt.viewport !== undefined && receipt.viewport?.restored?.ok !== true) {
    issues.push(`SWEEP_VIEWPORT_NOT_RESTORED:${String(receipt.viewport?.restored?.reason ?? 'unknown')}`);
    verdicts.push('UNGRADED');
  }
  const verdict = verdicts.includes('FAIL') ? 'FAIL' : verdicts.length ? 'UNGRADED' : 'PASS';
  return { verdict, issues };
}
