#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { cases as g2 } from './cases/g2-plan.mjs';
import { cases as g3 } from './cases/g3-gate.mjs';
import { cases as g4 } from './cases/g4-design.mjs';
import { cases as g5 } from './cases/g5-board-smoke.mjs';
import { cases as g6 } from './cases/g6-report.mjs';
import {
  hashAcceptanceTree,
  PRODUCT_ENTRY,
  REPO_ROOT,
} from './lib/harness.mjs';

const allCases = [...g2, ...g3, ...g4, ...g5, ...g6];
const ids = new Set();
for (const item of allCases) {
  if (ids.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
  ids.add(item.id);
}
for (const group of ['G2', 'G3', 'G4', 'G5', 'G6']) {
  if (!allCases.some((item) => item.group === group)) throw new Error(`missing acceptance group: ${group}`);
}

const args = process.argv.slice(2);
const phaseA = args.includes('--phase-a');
const evidenceAt = args.indexOf('--evidence');
const evidencePath = evidenceAt >= 0 ? args[evidenceAt + 1] : null;
if (evidenceAt >= 0 && !evidencePath) throw new Error('--evidence requires a path');

const results = [];
for (const item of allCases) {
  const started = Date.now();
  try {
    await item.run();
    results.push({ item, actual: 'green', duration_ms: Date.now() - started, error: null });
  } catch (error) {
    const message = String(error?.message ?? error).split('\n')[0];
    results.push({ item, actual: 'red', duration_ms: Date.now() - started, error: message.slice(0, 500) });
  }
}

for (const result of results) {
  const matchesBase = result.actual === result.item.base;
  const mark = result.actual === 'green' ? 'GREEN' : 'RED';
  const expected = phaseA ? ` base=${result.item.base}` : '';
  console.log(`[${mark}] ${result.item.id} (${result.item.group})${expected} ${matchesBase ? 'MATCH' : 'MISMATCH'}`);
  if (!phaseA && result.error) console.log(`  ${result.error.split('\n')[0]}`);
}

const actualGreen = results.filter((result) => result.actual === 'green').length;
const actualRed = results.length - actualGreen;
const controls = results.filter((result) => result.item.base === 'green');
const productCases = results.filter((result) => result.item.base === 'red');
const phaseAMismatches = results.filter((result) => result.actual !== result.item.base);
const tree = hashAcceptanceTree();

const evidence = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  mode: phaseA ? 'phase-a-red-proof' : 'phase-b-acceptance',
  node: process.version,
  product_entry: relative(REPO_ROOT, PRODUCT_ENTRY),
  product_entry_exists: existsSync(PRODUCT_ENTRY),
  yardstick: tree,
  summary: {
    total: results.length,
    actual_green: actualGreen,
    actual_red: actualRed,
    expected_base_red: productCases.length,
    expected_control_green: controls.length,
    phase_a_mismatches: phaseAMismatches.length,
  },
  results: results.map((result) => ({
    id: result.item.id,
    group: result.item.group,
    requirement: result.item.requirement,
    expected_behavior: result.item.expected,
    expected_base: result.item.base,
    actual_base: result.actual,
    base_match: result.actual === result.item.base,
    provenance: result.item.provenance,
    setup: result.item.setup ?? null,
    justification: result.item.justification ?? null,
    duration_ms: result.duration_ms,
    failure: result.error,
  })),
};

if (evidencePath) {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`EVIDENCE_WRITTEN ${evidencePath}`);
}

console.log(
  `ACCEPTANCE_SUMMARY total=${results.length} green=${actualGreen} red=${actualRed} controls=${controls.length} phase_a_mismatches=${phaseAMismatches.length}`,
);

if (phaseA) {
  if (phaseAMismatches.length > 0) process.exit(1);
  console.log('PHASE_A_RED_PROOF=PASS');
  process.exit(0);
}

if (actualRed > 0) process.exit(1);
console.log('TEAM_QA_ACCEPTANCE=PASS');
