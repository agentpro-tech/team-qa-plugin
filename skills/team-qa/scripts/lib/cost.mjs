// Run cost (public v1, S2): an estimate before the roster is approved, an optional cap that stops the run at a case
// boundary, and the actual tokens and cost per role at the end. Costs are API list prices as Claude Code reports them
// (total_cost_usd); a Claude or ChatGPT plan pays for the same work in usage, not dollars. Codex reports tokens only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fail, readJson, writeConfirmed } from './core.mjs';

// Measured on 15 Team QA eval runs in October 2026 (one worker attempt each; the orchestrating session not included).
export const COST_BASELINE = {
  source: '15 Team QA runs, October 2026',
  roles: {
    analyst: { model: 'claude-sonnet-5-5', per: 'round', attempts: 2, usd_p50: 0.134, usd_max: 0.179, minutes_p50: 0.44 },
    designer: { model: 'claude-sonnet-5-5', per: 'round', attempts: 2, usd_p50: 0.200, usd_max: 0.306, minutes_p50: 0.64 },
    test_manager: { model: 'claude-opus-5-5', per: 'round', attempts: 2, usd_p50: 0.355, usd_max: 0.458, minutes_p50: 0.89 },
    executor_gui: { model: 'claude-sonnet-5-5', per: 'case', attempts: 1.4, usd_p50: 2.63, usd_max: 7.28, minutes_p50: 6.52 },
  },
};
const money = (usd) => `$${usd.toFixed(2)}`;
const round1 = (n) => Math.round(n * 10) / 10;

// What the roster's seats cost by the baseline: the planning roles per round, and each GUI case.
export function estimateRoster(roster, { cases = null } = {}) {
  const seats = (roster.roles ?? []).filter((seat) => COST_BASELINE.roles[seat.role]);
  const part = (per) => seats.filter((seat) => COST_BASELINE.roles[seat.role].per === per).map((seat) => ({ seat, b: COST_BASELINE.roles[seat.role] }));
  const sum = (rows, key) => Math.round(rows.reduce((total, { b }) => total + b.attempts * b[key], 0) * 1000) / 1000;
  const planning = part('round'), perCase = part('case');
  const unmeasured = (roster.roles ?? []).filter((seat) => !COST_BASELINE.roles[seat.role] && seat.role !== 'coverage_gate').map((seat) => seat.role);
  const differentModel = seats.filter((seat) => seat.model && seat.model !== COST_BASELINE.roles[seat.role].model).map((seat) => `${seat.role} (${seat.model}; measured with ${COST_BASELINE.roles[seat.role].model})`);
  const estimate = {
    planning_usd: sum(planning, 'usd_p50'), planning_max_usd: sum(planning, 'usd_max'), planning_minutes: sum(planning, 'minutes_p50'),
    case_usd: sum(perCase, 'usd_p50'), case_max_usd: sum(perCase, 'usd_max'), case_minutes: sum(perCase, 'minutes_p50'),
    unmeasured, different_model: differentModel,
  };
  if (Number.isInteger(cases) && cases >= 0) {
    estimate.cases = cases;
    const r3 = (n) => Math.round(n * 1000) / 1000;
    estimate.total_usd = r3(estimate.planning_usd + cases * estimate.case_usd);
    estimate.total_max_usd = r3(estimate.planning_max_usd + cases * estimate.case_max_usd);
    estimate.total_minutes = r3(estimate.planning_minutes + cases * estimate.case_minutes);
  }
  return estimate;
}

// The lines the roster shows before approval (chat-presentation.mjs). Deterministic: the roster alone decides them.
export function estimateLines(roster) {
  const e = estimateRoster(roster);
  const parts = [];
  if (e.planning_usd) parts.push(`planning roles about ${money(e.planning_usd)} per round`);
  if (e.case_usd) parts.push(`each GUI case about ${money(e.case_usd)} and ${round1(e.case_minutes)} min (up to ${money(e.case_max_usd)})`);
  if (!parts.length) return [];
  const notes = [...(e.unmeasured.length ? [`not measured: ${e.unmeasured.join(', ')}`] : []), ...(e.different_model.length ? [`other model: ${e.different_model.join(', ')}`] : [])];
  return [`Cost estimate at API list prices (${COST_BASELINE.source}): ${parts.join('; ')}. The orchestrating session is extra; a Claude or ChatGPT plan pays in usage instead.${notes.length ? ` ${notes.join('; ')}.` : ''} Cap a run with: teamqa cost cap --run ${roster.run_id} --usd <amount>.`];
}

function lines(path) {
  try { return readFileSync(path, 'utf8').split('\n'); } catch { return []; }
}

// The actual spend of a run: every worker attempt under dispatch/<role>/<attempt>/stdout.jsonl.
export function runSpend(runDir) {
  const roles = {};
  const dir = join(runDir, 'dispatch');
  if (existsSync(dir)) for (const role of readdirSync(dir).sort()) {
    const roleDir = join(dir, role);
    if (!statSync(roleDir).isDirectory()) continue;
    for (const attempt of readdirSync(roleDir).sort()) {
      const file = join(roleDir, attempt, 'stdout.jsonl');
      if (!existsSync(file)) continue;
      const row = roles[role] ??= { attempts: 0, usd: 0, usd_known: 0, minutes: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
      row.attempts += 1;
      let usd = null;
      for (const line of lines(file)) {
        if (!line.includes('"usage"') && !line.includes('total_cost_usd')) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'result') {
          if (typeof event.total_cost_usd === 'number') usd = event.total_cost_usd;
          if (typeof event.duration_ms === 'number') row.minutes += event.duration_ms / 60000;
          const u = event.usage ?? {};
          row.input_tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          row.cached_tokens += u.cache_read_input_tokens ?? 0;
          row.output_tokens += u.output_tokens ?? 0;
        } else if (event.type === 'turn.completed' && event.usage) {
          row.input_tokens += event.usage.input_tokens ?? 0;
          row.cached_tokens += event.usage.cached_input_tokens ?? 0;
          row.output_tokens += event.usage.output_tokens ?? 0;
        }
      }
      if (usd !== null) { row.usd += usd; row.usd_known += 1; }
    }
  }
  const total = Object.values(roles).reduce((sum, row) => sum + row.usd, 0);
  return { roles, usd: total, unpriced: Object.values(roles).reduce((n, row) => n + row.attempts - row.usd_known, 0) };
}

export const capPath = (runDir) => join(runDir, 'cost-cap.json');
export function readCostCap(runDir) {
  if (!existsSync(capPath(runDir))) return null;
  const cap = readJson(capPath(runDir), { label: 'cost-cap.json' });
  if (cap?.schema !== 'team-qa/cost-cap/v1' || !(typeof cap.usd === 'number' && cap.usd > 0)) fail(2, 'COST_CAP_INVALID', capPath(runDir));
  return cap;
}

// Checked before a case starts (run-contract.mjs startCaseDispatch): once the run has spent its cap, no new case runs.
// The evidence of finished cases stays; the run reports NOT COMPLETE with the cases left.
export function assertUnderCap(runDir) {
  const cap = readCostCap(runDir);
  if (!cap) return null;
  const spent = runSpend(runDir).usd;
  if (spent >= cap.usd) fail(3, 'RUN_COST_CAP_REACHED', `spent ${money(spent)} of the ${money(cap.usd)} cap; report NOT COMPLETE with the cases left`, 'ungraded');
  return { cap: cap.usd, spent };
}

export function costMarkdown(runDir) {
  const spend = runSpend(runDir), cap = readCostCap(runDir);
  const names = Object.keys(spend.roles);
  if (!names.length) return '';
  const rows = names.map((role) => { const r = spend.roles[role];
    return `| ${role} | ${r.attempts} | ${round1(r.minutes)} | ${r.input_tokens} | ${r.cached_tokens} | ${r.output_tokens} | ${r.usd_known ? money(r.usd) : 'n/a'} |`; });
  return ['', '## Cost', '', 'Worker attempts of this run at API list prices, as each worker reported them; the orchestrating session is not included.', '',
    '| Role | Attempts | Minutes | Input tokens | Cached tokens | Output tokens | Cost |', '|---|---|---|---|---|---|---|', ...rows,
    `| Total | ${names.reduce((n, role) => n + spend.roles[role].attempts, 0)} |  |  |  |  | ${money(spend.usd)}${spend.unpriced ? ` (+${spend.unpriced} attempts without a price)` : ''} |`,
    ...(cap ? ['', `Cap: ${money(cap.usd)}.`] : []), ''].join('\n');
}

function trackedCaseCount(runDir) {
  try { const tracked = readJson(join(runDir, 'tracked-plan.json'), { label: 'tracked-plan.json' }); return Array.isArray(tracked.cases) ? tracked.cases.length : null; } catch { return null; }
}

export async function costCommand(action, args, { parseFlags, safeRunId, emit }) {
  const options = parseFlags(args, { '--run': { key: 'runId', required: true }, ...(action === 'cap' ? { '--usd': { key: 'usd', required: true } } : {}) });
  const runDir = join(process.cwd(), 'runs', safeRunId(options.runId));
  if (!existsSync(runDir)) fail(2, 'RUN_NOT_FOUND', options.runId);
  if (action === 'estimate') {
    const roster = readJson(join(runDir, 'roster.json'), { label: 'roster.json' }), cases = trackedCaseCount(runDir);
    const e = estimateRoster(roster, { cases });
    console.log(JSON.stringify(e, null, 2));
    emit('pass', 'COST_ESTIMATE', ...(e.total_usd !== undefined ? [`cases=${cases}`, `typical=${money(e.total_usd)}`, `up_to=${money(e.total_max_usd)}`, `minutes=${Math.round(e.total_minutes)}`]
      : [`planning=${money(e.planning_usd)}`, `per_case=${money(e.case_usd)}`]), 'prices=api_list', 'root_session=not_included');
  } else if (action === 'cap') {
    const usd = Number(options.usd);
    if (!(usd > 0)) fail(2, 'COST_CAP_INVALID', String(options.usd));
    await writeConfirmed(capPath(runDir), JSON.stringify({ schema: 'team-qa/cost-cap/v1', usd, set_at: new Date().toISOString() }, null, 2) + '\n', 'teamqa.cost.cap');
    emit('pass', 'COST_CAP_SET', `usd=${usd}`, `spent=${money(runSpend(runDir).usd)}`, 'effect=confirmed');
  } else if (action === 'report') {
    const spend = runSpend(runDir), md = costMarkdown(runDir);
    if (md) console.log(md.trim());
    emit('pass', 'COST_REPORT', `usd=${spend.usd.toFixed(2)}`, `roles=${Object.keys(spend.roles).length}`, `unpriced_attempts=${spend.unpriced}`);
  } else fail(2, 'USAGE', 'teamqa cost estimate|cap|report --run <id> [--usd <amount>]');
}
