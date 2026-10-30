// SCROLL — eval engine (real). Runs an agent's gold cases N times, grades them
// deterministically (machine checks) + optional LLM-judge, measures consistency,
// and writes a hash-bound audit record. No DB, no engine — files + providers only.
//
//   runEvals(name, { cwd, n, provider, model, judge }) -> report
//
// A gold case lives at agents/<name>/evals/<case>.md :
//   ---
//   id: case-01
//   runs: 5                      # consistency repeats (overridable by --n)
//   pass_consistency: 0.8        # fraction of runs that must pass ALL machine checks
//   ---
//   ## Input            ← the task/prompt given to the agent
//   ...
//   ```checks           ← MACHINE truth (deterministic). YAML list of assertions.
//   - { op: icontains, value: "solar" }
//   - { op: cites,     value: "S1" }
//   - { op: not_cites, value: "S4" }
//   ```
//   ## Rubric           ← optional, scored 1–5 by an LLM judge when --judge is set
//   - Faithfulness: ...
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadAgent, parseFrontmatter, parseYaml } from './scroll.js';
import { pickProvider } from './providers.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

// ── deterministic check ops (the machine truth a node/agent must satisfy) ──
const norm = (s) => String(s == null ? '' : s);
const CHECK_OPS = {
  contains:      (t, v) => t.includes(v),
  not_contains:  (t, v) => !t.includes(v),
  icontains:     (t, v) => t.toLowerCase().includes(String(v).toLowerCase()),
  not_icontains: (t, v) => !t.toLowerCase().includes(String(v).toLowerCase()),
  regex:         (t, v, f) => new RegExp(v, f || '').test(t),
  not_regex:     (t, v, f) => !new RegExp(v, f || '').test(t),
  cites:         (t, v) => new RegExp(`\\b${escapeRe(v)}\\b`).test(t),
  not_cites:     (t, v) => !new RegExp(`\\b${escapeRe(v)}\\b`).test(t),
  min_words:     (t, v) => (t.trim().split(/\s+/).filter(Boolean).length) >= Number(v),
  max_words:     (t, v) => (t.trim().split(/\s+/).filter(Boolean).length) <= Number(v),
  equals:        (t, v) => t.trim() === String(v).trim(),
};
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function runChecks(text, checks) {
  const t = norm(text);
  const results = (checks || []).map((c) => {
    const fn = CHECK_OPS[c.op];
    if (!fn) return { ...c, ok: false, err: `unknown op "${c.op}"` };
    let ok = false, err = null;
    try { ok = !!fn(t, c.value, c.flags); } catch (e) { err = e.message; }
    return { op: c.op, value: c.value, ok, err };
  });
  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, allPass: results.length > 0 && passed === results.length, results };
}

// ── §30 fixture provenance ──
// §8 grades the end state rather than the execution path. It says nothing about where the
// PRECONDITION came from — and that silence lets a green suite prove nothing.
//
// If a case's precondition was hand-built, the case says nothing about the path that was supposed
// to build it. The classic shape: a scheduler's EXECUTE path is exercised against a schedule the
// engineer wrote by hand, so the ARM path is never run once. Every night the job fires, the suite
// stays green, and arming has been broken since the day it shipped.
export const PROVENANCE = ['product-path', 'recorded', 'synthetic'];

export function parseFixture(f = {}) {
  const fx = f.fixture || {};
  const provenance = typeof fx.provenance === 'string' ? fx.provenance.trim() : null;
  const issues = [];
  if (!provenance) {
    issues.push('fixture.provenance not declared (product-path | recorded | synthetic)');
  } else if (!PROVENANCE.includes(provenance)) {
    issues.push(`fixture.provenance "${provenance}" is not one of ${PROVENANCE.join(' | ')}`);
  } else if (provenance === 'product-path' && !fx.setup) {
    issues.push('provenance=product-path requires `setup:` (the path that creates the precondition)');
  } else if (provenance === 'synthetic' && !fx.justification) {
    issues.push('provenance=synthetic requires `justification:` — and never counts as evidence for the path that would otherwise create this precondition');
  }
  return { provenance, setup: fx.setup || null, justification: fx.justification || null, issues };
}

// ── parse a gold case .md → { id, runs, threshold, input, checks, rubric, fixture } ──
export function parseGoldCase(raw, file) {
  const { frontmatter: fm, body } = parseFrontmatter(raw);
  const f = fm || {};
  const sect = (name) => {
    // NB: no 'm' flag — with 'm', `$` matches end-of-LINE and truncates the section to its first
    // line. We anchor the heading with (?:^|\n) and let `$` mean end-of-string instead.
    const re = new RegExp(`(?:^|\\n)##\\s+${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
    const m = body.match(re); return m ? m[1].trim() : '';
  };
  // ```checks fenced YAML list (the machine truth)
  let checks = [];
  const cm = body.match(/```checks\n([\s\S]*?)```/);
  if (cm) {
    const parsed = parseYaml(cm[1]);
    if (Array.isArray(parsed)) checks = parsed.filter((x) => x && x.op);
  }
  return {
    id: f.id || (file ? path.basename(file, '.md') : 'case'),
    runs: Number(f.runs || 3),
    threshold: Number(f.pass_consistency != null ? f.pass_consistency : 0.66),
    judgeMin: Number(f.judge_min != null ? f.judge_min : 4.0),
    input: sect('Input') || body.split('```checks')[0].trim(),
    checks,
    rubric: sect('Rubric'),
    fixture: parseFixture(f),   // §30
  };
}

// ── LLM-judge (qualitative, 1–5 per rubric criterion) ──
// Language follows IDENTITY.language, same contract as lib/digest.js (§4). Default: English.
// (Before: this prompt was hard-coded in one natural language, so every consumer of the
// framework got a judge speaking it regardless of their agent's declared language.)
export const JUDGE_SENTINEL = 'SCROLL_JUDGE_JSON';
const JUDGE_L = {
  en: {
    head: (s) => `You are a strict grader (${s}). Score the OUTPUT against each criterion in the RUBRIC on a 1–5 scale.`,
    only: 'Return JSON ONLY, no prose: {"scores": {"<criterion>": <1-5>}, "average": <number>}',
    rubric: '## RUBRIC', output: '## OUTPUT', none: '(none)', empty: '(empty)',
  },
  vi: {
    head: (s) => `Bạn là giám khảo nghiêm khắc (${s}). Chấm OUTPUT theo từng tiêu chí trong RUBRIC, thang 1–5.`,
    only: 'CHỈ trả JSON, không giải thích: {"scores": {"<tiêu chí>": <1-5>}, "average": <số>}',
    rubric: '## RUBRIC', output: '## OUTPUT', none: '(không có)', empty: '(rỗng)',
  },
};
function judgePrompt(output, rubric, language = 'en') {
  const t = JUDGE_L[language] || JUDGE_L.en;
  return [
    t.head(JUDGE_SENTINEL),
    t.only,
    '', t.rubric, rubric || t.none, '', t.output, output || t.empty,
  ].join('\n');
}
async function judgeOutput(output, rubric, prov, model, language = 'en') {
  let res; try { res = await prov.generate(judgePrompt(output, rubric, language), { model }); }
  catch (e) { return { ok: false, error: 'judge call failed: ' + String(e.message || e) }; }
  const m = String(res.text || '').match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'judge returned no JSON', raw: String(res.text || '').slice(0, 160) };
  let j; try { j = JSON.parse(m[0]); } catch (e) { return { ok: false, error: 'judge JSON parse: ' + e.message }; }
  const scores = j.scores || {};
  const vals = Object.values(scores).map(Number).filter((n) => !isNaN(n));
  const average = typeof j.average === 'number' ? j.average : (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
  return { ok: true, average: +Number(average).toFixed(2), scores };
}

// Stable system prefix from the agent folder (SOUL + identity + tools + hard-rules).
function assembleSystem(agent) {
  return [agent.soul || '', agent.identityBody || '', agent.tools || '', agent.hardRules || '']
    .filter(Boolean).join('\n\n').trim();
}

// ── run all gold cases for an agent ──
export async function runEvals(name, { cwd = process.cwd(), n, provider = 'auto', model, judge = false, judgeProvider, judgeModel, onEvent , language = 'en'} = {}) {
  const agent = loadAgent(name, cwd);
  if (!agent.evals.length) return { name, error: 'no gold cases under evals/ (need ≥1; ≥3 for L1)', cases: [], ok: false };
  const prov = pickProvider(provider, { model });
  if (!prov.ready) return { name, error: `provider "${prov.name}" not ready: ${prov.missing}`, cases: [], ok: false };
  const system = assembleSystem(agent);
  const emit = (ev, d) => onEvent && onEvent(ev, d);
  // optional LLM-judge provider (defaults to the same provider). Skipped silently if not ready.
  let judgeProv = null;
  if (judge) { try { judgeProv = pickProvider(judgeProvider || provider, { model: judgeModel || model }); if (!judgeProv.ready) judgeProv = null; } catch { judgeProv = null; } }

  const cases = [];
  for (const file of agent.evals) {
    const raw = fs.readFileSync(path.join(agent.dir, 'evals', file), 'utf8');
    const gc = parseGoldCase(raw, file);
    const runs = Math.max(1, n ? Number(n) : gc.runs);
    // §29 — no assertions means nobody looked. Report it as `ungraded`, never as a quiet pass.
    if (!gc.checks.length) { cases.push({ id: gc.id, skipped: true, verdict: 'ungraded', fixture: gc.fixture, reason: 'no ```checks block (machine assertions) — case is not gradeable' }); continue; }

    const prompt = system ? `${system}\n\n${gc.input}` : gc.input;
    const perRun = [];
    let passCount = 0, lastText = '';
    for (let i = 0; i < runs; i++) {
      emit('run_start', { case: gc.id, i: i + 1, of: runs });
      let text = '', genErr = null;
      try { const out = await prov.generate(prompt, { cwd, model, system, cachePrefix: system }); text = out.text || ''; }
      catch (e) { genErr = String(e.message || e); }
      lastText = text;
      const chk = genErr ? { passed: 0, total: gc.checks.length, allPass: false, results: [] } : runChecks(text, gc.checks);
      if (chk.allPass) passCount++;
      perRun.push({ i: i + 1, hashIn: sha(prompt), hashOut: sha(text), passed: chk.passed, total: chk.total, allPass: chk.allPass, err: genErr, fails: chk.results.filter((r) => !r.ok).map((r) => `${r.op}:${r.value}`) });
      emit('run_done', { case: gc.id, i: i + 1, allPass: chk.allPass });
    }
    const consistency = passCount / runs;
    const machinePass = consistency >= gc.threshold;
    // LLM-judge (one call per case, token-disciplined) — only if requested + rubric present + judge ready
    // §29: a judge that could not RUN did not say "bad" — it said nothing. That is `ungraded`,
    // not `fail`. (Previously a judge call error was scored as a failure of the output.)
    let judgeRes = null, judgePass = true, judgeUngraded = false;
    if (judgeProv && gc.rubric) {
      judgeRes = await judgeOutput(lastText, gc.rubric, judgeProv, judgeModel || model, language);
      if (judgeRes.ok) {
        judgePass = judgeRes.average >= gc.judgeMin;
      } else {
        judgeUngraded = true; judgePass = false;
      }
      judgeRes.min = gc.judgeMin; judgeRes.pass = judgeRes.ok ? judgePass : null;
    }
    // §29 — verdict is TERNARY: 'pass' | 'fail' | 'ungraded'. Never a boolean, because a boolean
    // forces "we did not measure" to masquerade as one of the two things we did measure.
    const verdict = judgeUngraded ? 'ungraded' : (machinePass && judgePass ? 'pass' : 'fail');
    cases.push({ id: gc.id, runs, passCount, consistency: +consistency.toFixed(3), threshold: gc.threshold, machinePass, judge: judgeRes, verdict, checks: gc.checks.length, fixture: gc.fixture, perRun });
  }

  // §29 — `ungraded` is excluded from `ok` and counted on its own. It is never folded into `pass`
  // (that is the "green because nobody looked" failure) nor into `fail` (nothing was measured).
  const graded = cases.filter((c) => !c.skipped && c.verdict !== 'ungraded');
  const ungraded = cases.filter((c) => c.skipped || c.verdict === 'ungraded');
  const ok = graded.length > 0 && graded.every((c) => c.verdict === 'pass');
  const report = { name, provider: prov.name, model: prov.model, ts: new Date().toISOString(), cases, ok,
    gradable: graded.length, passed: graded.filter((c) => c.verdict === 'pass').length,
    ungraded: ungraded.length };

  // hash-bound audit record (SCROLL §20.6 spirit — tamper-evident, file-native)
  try {
    const dir = path.join(cwd, '.scroll', 'eval'); fs.mkdirSync(dir, { recursive: true });
    report.recordHash = sha(JSON.stringify(report.cases) + report.ts);
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(report, null, 2) + '\n');
  } catch { /* audit is best-effort */ }
  return report;
}
