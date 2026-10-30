#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const [node24Path, node26Path, outputPath] = process.argv.slice(2);
if (!node24Path || !node26Path || !outputPath) {
  console.error('usage: render-red-proof.mjs <node24.json> <node26.json> <output.md>');
  process.exit(2);
}

const node24 = JSON.parse(readFileSync(node24Path, 'utf8'));
const node26 = JSON.parse(readFileSync(node26Path, 'utf8'));
assert.match(node24.node, /^v24\./);
assert.match(node26.node, /^v26\./);
assert.equal(node24.yardstick.sha256, node26.yardstick.sha256, 'yardstick hash differs across runtimes');
assert.equal(node24.results.length, node26.results.length, 'case count differs across runtimes');
assert.equal(node24.summary.phase_a_mismatches, 0, 'Node 24 has phase-A mismatches');
assert.equal(node26.summary.phase_a_mismatches, 0, 'Node 26 has phase-A mismatches');
assert.equal(node24.product_entry_exists, false, 'Node 24 proof did not run on an empty product base');
assert.equal(node26.product_entry_exists, false, 'Node 26 proof did not run on an empty product base');

const byId26 = new Map(node26.results.map((item) => [item.id, item]));
for (const item of node24.results) {
  const peer = byId26.get(item.id);
  assert.ok(peer, 'Node 26 missing ' + item.id);
  assert.equal(item.actual_base, peer.actual_base, item.id + ': runtime status mismatch');
  assert.equal(item.base_match, true, item.id + ': Node 24 base mismatch');
  assert.equal(peer.base_match, true, item.id + ': Node 26 base mismatch');
}

const controls = node24.results
  .filter((item) => item.expected_base === 'green')
  .map((item) => item.id)
  .sort();
assert.deepEqual(controls, ['G3-CONTROL-GREEN', 'G5-CONTROL-GREEN']);

const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
const lines = [
  '# Phase A RED-proof',
  '',
  '- Yardstick SHA-256: ' + node24.yardstick.sha256,
  '- Yardstick files: ' + node24.yardstick.files,
  '- Node 24: ' + node24.node + ' — ' + node24.summary.actual_red + ' RED, '
    + node24.summary.actual_green + ' GREEN controls, 0 mismatch.',
  '- Node 26: ' + node26.node + ' — ' + node26.summary.actual_red + ' RED, '
    + node26.summary.actual_green + ' GREEN controls, 0 mismatch.',
  '- Product entry during proof: absent (scripts/teamqa.mjs does not exist).',
  '- Freeze state: not tagged; awaiting the owner\'s approval.',
  '',
  '| Case | Group | Expected failure message/behavior | Base Node 24 | Base Node 26 | Explanation if GREEN | Provenance |',
  '|---|---|---|---|---|---|---|',
];

for (const item of node24.results) {
  const peer = byId26.get(item.id);
  const explanation = item.expected_base === 'green' ? item.justification : '';
  lines.push(
    '| ' + cell(item.id)
      + ' | ' + cell(item.group)
      + ' | ' + cell(item.expected_behavior)
      + ' | ' + cell(item.actual_base.toUpperCase())
      + ' | ' + cell(peer.actual_base.toUpperCase())
      + ' | ' + cell(explanation)
      + ' | ' + cell(item.provenance)
      + ' |',
  );
}

lines.push(
  '',
  '## Freeze gate',
  '',
  '- Create the team-qa-thuoc-freeze tag only after the owner approves this table.',
  '- Phase B must run in a new session.',
  '- Phase B must not change test/acceptance/; the diff against the freeze tag must be empty.',
  '',
);

writeFileSync(outputPath, lines.join('\n'), 'utf8');
console.log('RED_PROOF_WRITTEN ' + outputPath);
