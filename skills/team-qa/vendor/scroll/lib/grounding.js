// SCROLL — grounding / provenance pre-check (v1.4).
//
// Why: this blocks hallucination at the ACTION layer. An agent that invents a product code,
// a customer id, or an amount and then issues an invoice is a real risk. Before a financial or
// destructive action runs, every critical parameter MUST trace back to a real source seen earlier
// in the run — the blackboard, a prior tool result, the steer file, or the task objective.
//
// Deliberately DETERMINISTIC, not semantic: we only check parameters that can be matched by
// regex/exact token (codes, ids, amounts). "Semantically grounded" would need an LLM judge,
// which would re-introduce the very model-trust we are trying to remove. Scope = exact provenance.

// Build the corpus a parameter may be grounded against.
export function collectSources({ depSummaries = [], objective = '', steer = '', priorOutputs = [], extra = [] } = {}) {
  return [objective, steer, ...depSummaries, ...priorOutputs, ...extra].filter(Boolean).join('\n');
}

// Normalize for matching: lowercase, collapse to alphanumerics. A second digits-only form is
// produced for amounts so "1.500.000" / "1,500,000" / "1500000 VND" all compare equal.
function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function digitsOnly(s) { return String(s).replace(/[^0-9]/g, ''); }
function looksNumeric(v) { return /[0-9]/.test(String(v)) && /^[0-9.,\s]*[0-9][0-9.,\s]*(?:[a-z]{0,4})$/i.test(String(v).trim()); }

// Is a single value present in the source corpus?
export function isGrounded(value, sourcesText) {
  if (value == null || value === '') return true; // nothing to ground
  const src = String(sourcesText || '');
  const nv = norm(value);
  if (nv && norm(src).includes(nv)) return true;
  if (looksNumeric(value)) {
    const dv = digitsOnly(value);
    if (dv && digitsOnly(src).includes(dv)) return true;
  }
  return false;
}

// params: array of { name, value } OR a plain object { name: value }.
// Returns { ok, traced:[names], missing:[names] }.
export function checkGrounding(params, sourcesText) {
  const list = Array.isArray(params)
    ? params
    : Object.entries(params || {}).map(([name, value]) => ({ name, value }));
  const traced = [], missing = [];
  for (const { name, value } of list) {
    if (isGrounded(value, sourcesText)) traced.push(name);
    else missing.push(name);
  }
  return { ok: missing.length === 0, traced, missing };
}
