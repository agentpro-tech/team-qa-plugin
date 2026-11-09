// R1e — the width sweep's reader over Dragon (HR1: every action and read goes through the GUI). Contract:
// references/width-sweep-overlays.md; Dragon side: Dragon docs/r1a-environment-and-sensors.md (paintSnapshot).
// `rpc(method, params)` is the caller's authenticated Dragon RPC (qa_do.mjs).
//   measure(width)          setViewport {width, height, mobile:false, deviceScaleFactor:1}, then one `do` read of the geometry
//   confirm(width, failure) setViewport at the band's narrowest width, then R1a's paintSnapshot read of the failing element
//                           (`failure.target`): shown -> CONFIRMED; covered, hidden, transparent, zero-size or no layout box ->
//                           NOT_VISIBLE; not found -> UNCONFIRMED. A W1 page overflow has no element; its scroll width confirms it.
//   capture(width)          captureTab {evidence:true} at that width (the only capture of a band; R1f light JPEG)
//   measureRow(row)         setViewport with the row's own profile and DPR, an emulation readback, then the geometry; verified
//                           only when the page reads back the row's width, DPR and touch
//   found() / restore()     the viewport the tab had: by default read from the page before the sweep (size, DPR, touch)
//                           and set back with setViewport after it, then read back; `restore: 'clear'` (the case set no
//                           override) calls clearViewport instead; `restore: {width, height, deviceScaleFactor, mobile}`
//                           (the case's matrix row) sets that one
import { GEOMETRY_PROBE_BODY } from './width-sweep.mjs';

export const EMULATION_BODY = 'return { width: document.documentElement.clientWidth, dpr: window.devicePixelRatio, touch: navigator.maxTouchPoints > 0 };';
// The window's own size as a viewport override sets it (innerWidth/innerHeight are the device metrics width and height).
export const VIEWPORT_BODY = 'return { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, touch: navigator.maxTouchPoints > 0 };';
// paintSnapshot reasons that mean the element is not seen. Sticking out of the viewport or being clipped there is what a
// W2/W3 failure is about, so those two only count against W4 (two overlapping controls must both be seen).
const HIDING = ['display-none', 'visibility-hidden', 'transparent', 'zero-size', 'covered', 'no-layout-box'];

function readValue(result, as) {
  const step = Array.isArray(result?.results) ? result.results.find((entry) => entry?.step === 'read' && entry?.as === as) : null;
  let value = step?.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  return value && typeof value === 'object' ? value : null;
}

export function paintConfirmation(result, failure) {
  if (!result || result.ok === false) return { status: 'UNCONFIRMED', reason: String(result?.code ?? 'PAINT_SNAPSHOT_FAILED') };
  const element = Array.isArray(result.elements) ? result.elements[0] : null;
  if (!element || element.found === false) return { status: 'UNCONFIRMED', reason: 'NOT_IN_SNAPSHOT' };
  const reasons = Array.isArray(element.reasons) ? element.reasons : [];
  const hiding = [...HIDING, ...(failure?.rule === 'W4' ? ['outside-viewport', 'clipped'] : [])];
  const hit = reasons.find((reason) => hiding.includes(reason));
  if (hit) return { status: 'NOT_VISIBLE', reason: hit.toUpperCase().replaceAll('-', '_') };
  if (reasons.includes('not-in-snapshot')) return { status: 'UNCONFIRMED', reason: 'NOT_IN_SNAPSHOT' };
  return { status: 'CONFIRMED', reason: null };
}

export function dragonGeometryReader({ rpc, binding = {}, tabId, height = 800, paintMethod = 'paintSnapshot', restore = 'measured' }) {
  const viewport = (width) => rpc('setViewport', { ...binding, tabId, width, height, mobile: false, deviceScaleFactor: 1 });
  const geometry = async () => {
    const value = readValue(await rpc('do', { ...binding, tabId, steps: [{ read: GEOMETRY_PROBE_BODY, as: 'geometry' }] }), 'geometry');
    if (!value) throw new Error('DRAGON_GEOMETRY_READ_EMPTY');
    return value;
  };
  const readViewport = async () => readValue(await rpc('do', { ...binding, tabId, steps: [{ read: VIEWPORT_BODY, as: 'viewport' }] }), 'viewport');
  return {
    async found() {
      if (restore === 'clear') return 'clear';
      if (restore && typeof restore === 'object') return { width: restore.width, height: restore.height, deviceScaleFactor: restore.deviceScaleFactor ?? 1, mobile: restore.mobile === true };
      const v = await readViewport();
      return v && Number.isInteger(v.width) && Number.isInteger(v.height) ? { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: v.touch === true } : null;
    },
    async restore(found) {
      if (!found) return { ok: false, reason: 'VIEWPORT_UNKNOWN' };
      if (found === 'clear') await rpc('clearViewport', { ...binding, tabId });
      else await rpc('setViewport', { ...binding, tabId, ...found });
      const back = await readViewport();
      if (!back) return { ok: false, reason: 'VIEWPORT_READBACK_EMPTY' };
      const ok = found === 'clear' || (back.width === found.width && back.height === found.height);
      return ok ? { ok, viewport: back } : { ok, reason: 'VIEWPORT_READBACK_MISMATCH', viewport: back };
    },
    async measure(width) {
      await viewport(width);
      return geometry();
    },
    async confirm(width, failure) {
      if (failure?.rule === 'W1') return { status: 'CONFIRMED', reason: 'SCROLL_WIDTH' };
      const selector = failure?.target ?? failure?.selector;
      if (typeof selector !== 'string' || !selector) return { status: 'UNCONFIRMED', reason: 'NO_TARGET' };
      await viewport(width);
      return paintConfirmation(await rpc(paintMethod, { ...binding, tabId, selector }), failure);
    },
    async capture(width) {
      await viewport(width);
      return rpc('captureTab', { ...binding, tabId, evidence: true });
    },
    async measureRow(row) {
      await rpc('setViewport', { ...binding, tabId, width: row.w, height: row.h, mobile: row.profile === 'mobile', deviceScaleFactor: row.dpr });
      const read = await rpc('do', { ...binding, tabId, steps: [{ read: EMULATION_BODY, as: 'emulation' }, { read: GEOMETRY_PROBE_BODY, as: 'geometry' }] });
      const emulation = readValue(read, 'emulation');
      const value = readValue(read, 'geometry');
      const verified = Boolean(emulation && value) && emulation.width === row.w && emulation.dpr === row.dpr && emulation.touch === (row.profile === 'mobile');
      return { verified, emulation, failures: (value?.failures ?? []).map((failure) => `${failure.rule}|${failure.selector}`) };
    },
  };
}
