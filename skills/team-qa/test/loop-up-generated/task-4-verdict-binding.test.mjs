import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('RED-TQ-VERDICT-BINDING-001: PASS requires a bound child verdict hash', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'teamqa-verdict-binding-'));
  writeFileSync(join(tempDir, 'proof.txt'), 'PASS\n');
  writeFileSync(join(tempDir, 'record.json'), JSON.stringify({
    case_id: 'CASE-VERDICT-BINDING',
    lane: 'lane-generated',
    verdict: 'pass',
    evidence: ['proof.txt'],
    source: 'qa-gui',
    run_id: 'run-verdict-binding',
    ts: '2026-08-11T00:00:00.000Z',
    target: {
      project_id: 'ee71fc9d-eebe-4bb2-b130-4930af6fa411',
      preview_url: 'https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app',
      version: '8a9b703d7ac202744bb37c11d1ec377aeb1ed921',
    },
  }));

  const result = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'teamqa.mjs'),
    'board', 'add',
    '--file', join(tempDir, 'board.jsonl'),
    '--record', join(tempDir, 'record.json'),
  ], {
    cwd: tempDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      TEAMQA_TARGET_PROJECT_ID: 'ee71fc9d-eebe-4bb2-b130-4930af6fa411',
      TEAMQA_TARGET_PREVIEW_URL: 'https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app',
      TEAMQA_TARGET_VERSION: '8a9b703d7ac202744bb37c11d1ec377aeb1ed921',
    },
  });

  assert.notEqual(result.status, 0, `board accepted an unbound PASS: ${result.stdout.trim()}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /CHILD_VERDICT_MISSING|CHILD_VERDICT_HASH/);
});
