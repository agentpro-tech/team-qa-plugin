// `teamqa speed compare --off <run> --on <run>` (upgrade R3): the same cases run both ways, once with a speed flag off
// and once with it on (or a shadow run against its own decision log). A case the off run fails that the on run does not
// fail is a miss; one the on run leaves ungraded is listed apart (it is not graded yet, it must run again). The time
// receipts of both runs (R0, lib/timing.mjs) show what the flag saved, by step kind. A shadow run's vision by diff
// decisions add the states where inheriting would have missed a VLM FAIL.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { latestAttemptByCase } from './attempt-sequence.mjs';
import { readSpeedDecisions } from './cost-ladder.mjs';

const verdictOf = (record) => String(record?.verdict ?? 'missing').toLowerCase();

export function runOutcomes(runDir) {
  const path = join(runDir, 'board.jsonl');
  const records = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)) : [];
  const { latestByCase } = latestAttemptByCase(records);
  return Object.fromEntries([...latestByCase].sort(([a], [b]) => a.localeCompare(b)).map(([caseId, record]) => [caseId, verdictOf(record)]));
}

function kindTotals(timing) {
  const byKind = timing?.summary?.by_kind ?? {};
  return Object.fromEntries(Object.entries(byKind).map(([kind, row]) => [kind, { steps: row.count, ms: row.total_ms }]));
}

// `off` and `on`: {cases: {case_id: verdict}, timing: timing.json content or null, decisions: decisions.jsonl rows}.
export function compareSpeedRuns({ off, on }) {
  const ids = [...new Set([...Object.keys(off.cases), ...Object.keys(on.cases)])].sort();
  const missed = [], ungradedOn = [], gained = [], agree = [], absent = [];
  for (const id of ids) {
    const a = off.cases[id] ?? 'missing', b = on.cases[id] ?? 'missing';
    if (a === 'missing' || b === 'missing') { absent.push({ case_id: id, off: a, on: b }); continue; }
    if (a === 'fail' && b === 'pass') missed.push({ case_id: id, off: a, on: b });
    else if (a === 'fail' && b !== 'fail') ungradedOn.push({ case_id: id, off: a, on: b });
    else if (a !== 'fail' && b === 'fail') gained.push({ case_id: id, off: a, on: b });
    else agree.push(id);
  }
  const shadowMissed = (on.decisions ?? []).filter((d) => d.kind === 'vision_by_diff' && d.mode === 'shadow' && (d.missed_rules ?? []).length)
    .map((d) => ({ case_id: d.case_id, state: d.state, rules: d.missed_rules }));
  const offKinds = kindTotals(off.timing), onKinds = kindTotals(on.timing);
  const kinds = [...new Set([...Object.keys(offKinds), ...Object.keys(onKinds)])].sort();
  const wall = (t) => t?.wall?.duration_ms ?? null;
  const total = (k) => Object.values(k).reduce((n, row) => n + row.ms, 0);
  return {
    verdict: missed.length || shadowMissed.length ? 'missed' : 'no-miss',
    cases: { compared: ids.length - absent.length, agree: agree.length, missed, ungraded_on: ungradedOn, gained, absent },
    vision_shadow_missed: shadowMissed,
    timing: {
      receipts: { off: off.timing ? 'found' : 'missing', on: on.timing ? 'found' : 'missing' },
      wall_ms: { off: wall(off.timing), on: wall(on.timing), delta: wall(off.timing) !== null && wall(on.timing) !== null ? wall(on.timing) - wall(off.timing) : null },
      step_ms: { off: total(offKinds), on: total(onKinds), delta: total(onKinds) - total(offKinds) },
      by_kind: Object.fromEntries(kinds.map((kind) => [kind, { off: offKinds[kind] ?? { steps: 0, ms: 0 }, on: onKinds[kind] ?? { steps: 0, ms: 0 },
        delta_ms: (onKinds[kind]?.ms ?? 0) - (offKinds[kind]?.ms ?? 0) }])),
    },
  };
}

export function readRunForCompare(runDir) {
  const timingFile = join(runDir, 'timing.json');
  return { cases: runOutcomes(runDir), timing: existsSync(timingFile) ? JSON.parse(readFileSync(timingFile, 'utf8')) : null, decisions: readSpeedDecisions(runDir) };
}
