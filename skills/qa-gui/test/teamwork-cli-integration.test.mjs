import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'scripts/teamwork/cli.mjs');
const example = join(root, 'scripts/teamwork/example-canonical.json');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
}

test('teamwork CLI validates canonical data with a machine-readable receipt', () => {
  const result = run(['validate', '--file', example]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.rev, 0);
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
});

test('teamwork CLI initializes the current canonical schema for Team QA', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-teamwork-cli-init-'));
  const output = join(dir, 'canonical.json');
  const result = run([
    'init', '--out', output, '--board-id', 'tq-runtime', '--title', 'Sample App Remix QA',
    '--environment', 'TEST', '--database', 'sample-test', '--viewport', '1280x800',
    '--round', '2', '--scope', 'Runtime integration', '--language', 'en', '--actor', 'Team QA',
    '--at', '2026-08-11T14:40:00.000Z',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const canonical = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(canonical.canonicalVersion, 'qa-board-teamwork/v2');
  assert.equal(canonical.schemaVersion, 6);
  assert.equal(canonical.boardKind, 'team-qa-board');
  assert.equal(canonical.boardId, 'tq-runtime');
  assert.equal(canonical.rev, 0);
  assert.equal(canonical.envDb, 'TEST / sample-test');
  assert.equal(canonical.currentRound, 2);
  assert.deepEqual(canonical.cases, []);
  assert.deepEqual(canonical.sourceItems, []);
  assert.deepEqual(canonical.defects, []);
  assert.equal(run(['validate', '--file', output]).status, 0);
});

test('teamwork CLI hardens a Doc-Colab packet without overwriting its input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-teamwork-cli-apply-'));
  const input = join(dir, 'canonical.json');
  const packet = join(dir, 'packet.json');
  const output = join(dir, 'canonical-next.json');
  writeFileSync(input, readFileSync(example));
  writeFileSync(packet, JSON.stringify({
    protocol: 'doc-colab/v2',
    qaDelta: {
      baseRev: 0,
      updates: [{ entity: 'case', id: 'TC-01', field: 'assignee', from: 'qa-agent', to: 'Owner' }],
      comments: [], evidence: [],
    },
  }));
  const result = run([
    'apply', '--file', input, '--change', packet, '--out', output,
    '--evidence-dir', join(dir, 'evidence'), '--actor', 'Owner', '--actor-role', 'qa',
    '--at', '2026-08-11T14:41:00.000Z',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(readFileSync(input, 'utf8')).rev, 0);
  const next = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(next.rev, 1);
  assert.equal(next.cases[0].assignee, 'Owner');
});

test('teamwork CLI exports and compares the exact Notion row set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-teamwork-cli-notion-'));
  const snapshot = join(dir, 'notion.json');
  const exported = run(['export-notion', '--file', example, '--out', snapshot]);
  assert.equal(exported.status, 0, exported.stderr || exported.stdout);
  const rows = JSON.parse(readFileSync(snapshot, 'utf8'));
  assert.equal(rows.length, 2);
  const compared = run(['compare-notion', '--file', example, '--snapshot', snapshot]);
  assert.equal(compared.status, 0, compared.stderr || compared.stdout);
  const receipt = JSON.parse(compared.stdout);
  assert.equal(receipt.matchPercent, 100);
  assert.deepEqual(receipt.mismatches, []);
});
