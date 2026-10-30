// SCROLL v1.6 — §28 EFFECT CONFIRMATION.
//
// A write that *reports* success is not evidence that the write *happened*.
//
// The failure this closes: an interface accepts a call, silently ignores a field it does not
// understand, and returns a success status. Nothing logs, nothing throws. The agent reads the
// success and reports it onward in perfect good faith — the agent is not lying, the interface is.
// Such a defect can live for weeks because every signal says "green".
//
// The rule: after a WRITE, read the state back with a SEPARATE read operation and check it.
// The write's own response is not admissible as its own confirmation.
//
// Declared as data next to `risk`/`ground` in .mcp.json (§21.3, §22) — never in prose:
//   "issue_invoice": {
//     "risk": "financial",
//     "ground": ["product_code", "amount"],
//     "confirm": { "probe": "lookup_invoice", "expect": "$.status == 'issued'" }
//   }

import { normalizeTier, TIER_RANK } from './permissions.js';

// Tiers that mutate state outside the run's own memory.
const WRITE_TIERS = new Set(['reversible_write', 'external_comm', 'financial', 'destructive']);
// Tiers where a missing `confirm` is a governance defect, not a style nit.
const CONFIRM_REQUIRED_TIERS = new Set(['financial', 'destructive']);

export function isWriteTier(tier) {
  return WRITE_TIERS.has(normalizeTier(tier) || 'destructive');
}
export function confirmRequired(tier) {
  return CONFIRM_REQUIRED_TIERS.has(normalizeTier(tier) || 'destructive');
}

// ── expect predicates (deterministic; no LLM in the confirmation path) ──
// Grammar (intentionally small — an obscure predicate is a predicate nobody trusts):
//   $.a.b == 'x'      $.a.b != 'x'      $.a.b == 3      $.a.b == true
//   $.a.b exists      $.a.b contains 'x'                $.a.b        (truthy)
// Arrays: $.items[0].id
const PATH_RE = /^\$(\.[A-Za-z_$][\w$]*|\[\d+\])*$/;

export function readPath(obj, expr) {
  if (!PATH_RE.test(expr)) return { ok: false, error: `bad path: ${expr}` };
  let cur = obj;
  const parts = expr.slice(1).match(/\.[A-Za-z_$][\w$]*|\[\d+\]/g) || [];
  for (const p of parts) {
    if (cur == null) return { ok: true, value: undefined };
    cur = p[0] === '[' ? cur[Number(p.slice(1, -1))] : cur[p.slice(1)];
  }
  return { ok: true, value: cur };
}

function literal(raw) {
  const s = raw.trim();
  if (/^'([\s\S]*)'$/.test(s) || /^"([\s\S]*)"$/.test(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (s !== '' && !isNaN(Number(s))) return Number(s);
  return s;
}

export function evalExpect(expr, obj) {
  const e = String(expr || '').trim();
  if (!e) return { ok: false, error: 'empty expect' };

  let m = e.match(/^(\$[^\s]*)\s*(==|!=)\s*(.+)$/);
  if (m) {
    const r = readPath(obj, m[1]);
    if (!r.ok) return { ok: false, error: r.error };
    const want = literal(m[3]);
    const got = r.value;
    // eslint-disable-next-line eqeqeq
    const eq = got == want;
    return { ok: m[2] === '==' ? eq : !eq, observed: got, expected: want };
  }
  m = e.match(/^(\$[^\s]*)\s+exists$/);
  if (m) {
    const r = readPath(obj, m[1]);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: r.value !== undefined && r.value !== null, observed: r.value, expected: 'exists' };
  }
  m = e.match(/^(\$[^\s]*)\s+contains\s+(.+)$/);
  if (m) {
    const r = readPath(obj, m[1]);
    if (!r.ok) return { ok: false, error: r.error };
    const want = literal(m[2]);
    const hay = r.value;
    const ok = Array.isArray(hay) ? hay.includes(want) : String(hay ?? '').includes(String(want));
    return { ok, observed: hay, expected: `contains ${JSON.stringify(want)}` };
  }
  if (PATH_RE.test(e)) {
    const r = readPath(obj, e);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: !!r.value, observed: r.value, expected: 'truthy' };
  }
  return { ok: false, error: `unsupported expect: ${e}` };
}

// ── the gate ──
// `invoke(probeName, params)` → the probe's result (object or JSON string). Supplied by the caller
// so this module stays runtime-agnostic: it performs no I/O of its own.
export async function confirmEffect({ tool, tier, confirm, params = {}, invoke, emit } = {}) {
  const t = normalizeTier(tier) || 'destructive';
  const say = (ev, d) => { if (typeof emit === 'function') emit(ev, d); };

  if (!isWriteTier(t)) return { checked: false, ok: true, reason: 'not a write' };

  if (!confirm || !confirm.probe || !confirm.expect) {
    // Fail-closed exactly where it matters; elsewhere report honestly as unconfirmed (§29: the
    // absence of a check is never a pass — it is "we did not look").
    const required = confirmRequired(t);
    const res = { checked: false, ok: !required, unconfirmed: true, tier: t,
      reason: `no confirm declared for a ${t} write` };
    if (required) say('effect_unconfirmed', { tool, tier: t, reason: res.reason });
    return res;
  }
  if (typeof invoke !== 'function') {
    return { checked: false, ok: false, unconfirmed: true, tier: t, reason: 'no invoke() provided' };
  }

  let raw;
  try {
    raw = await invoke(confirm.probe, confirm.params || params);
  } catch (e) {
    const reason = `probe "${confirm.probe}" threw: ${String((e && e.message) || e)}`;
    say('effect_unconfirmed', { tool, tier: t, reason });
    return { checked: true, ok: false, unconfirmed: true, tier: t, reason };
  }

  let observedObj = raw;
  if (typeof raw === 'string') { try { observedObj = JSON.parse(raw); } catch { /* keep string */ } }

  const r = evalExpect(confirm.expect, observedObj);
  if (r.error) {
    say('effect_unconfirmed', { tool, tier: t, reason: r.error });
    return { checked: true, ok: false, unconfirmed: true, tier: t, reason: r.error };
  }
  if (r.ok) {
    say('effect_confirmed', { tool, probe: confirm.probe, ok: true, observed: r.observed });
    return { checked: true, ok: true, tier: t, observed: r.observed };
  }
  say('effect_unconfirmed', { tool, expected: r.expected, observed: r.observed });
  return { checked: true, ok: false, unconfirmed: true, tier: t,
    reason: `read-back mismatch: expected ${JSON.stringify(r.expected)}, observed ${JSON.stringify(r.observed)}`,
    expected: r.expected, observed: r.observed };
}

// Corollary of §28, used by interfaces that accept structured input: an unknown field MUST be
// rejected, never dropped. Silently dropping input is how a system comes to report success for
// work it never performed.
export function rejectUnknownFields(body = {}, allowed = [], control = []) {
  const ok = new Set([...allowed, ...control]);
  const rejected = Object.keys(body || {}).filter((k) => !ok.has(k));
  return { ok: rejected.length === 0, rejected };
}

export const _internals = { WRITE_TIERS, CONFIRM_REQUIRED_TIERS, TIER_RANK };
