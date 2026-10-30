import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const PRODUCT = resolve(ROOT, 'scripts/dragon-actionability-preflight.mjs');
const CORPUS = resolve(ROOT, '.teamcode/actionability-occlusion/corpus.json');
const CONTRACT = resolve(ROOT, '.teamcode/actionability-occlusion/dragon-contract-score.mjs');

test('frozen actionability classifier and read-only Dragon contract are satisfied', async () => {
  const failures = [];
  const corpus = JSON.parse(await readFile(CORPUS, 'utf8'));
  let classify;
  let snapshotScript;
  try {
    ({
      classifyActionabilityObservation: classify,
      ACTIONABILITY_SNAPSHOT_SCRIPT: snapshotScript,
    } = await import(`${pathToFileURL(PRODUCT).href}?planner-red=1`));
  } catch {
    failures.push('actionability preflight must exist and be importable');
  }

  const types = (observation) => {
    if (typeof classify !== 'function') return [];
    try {
      const value = classify(observation);
      return (Array.isArray(value) ? value : value?.risks ?? [])
        .map((risk) => typeof risk === 'string' ? risk : risk?.type)
        .filter(Boolean);
    } catch { return []; }
  };
  const caught = corpus.hard.filter((item) => types(item.observation).includes(item.expected)).length;
  const falsePositives = corpus.ordinary.filter((item) => types(item.observation).length > 0).length;
  if (corpus.hard.length !== 10 || new Set(corpus.hard.map((item) => item.expected)).size !== 10) {
    failures.push('the ten frozen actionability families must be graded whole');
  }
  if (corpus.ordinary.length !== 7) failures.push('the seven frozen ordinary observations must be graded whole');
  if (caught / corpus.hard.length < 0.9) failures.push('classifier recall must be at least 0.90');
  if (falsePositives / corpus.ordinary.length > 0.05) failures.push('classifier false-positive rate must be at most 0.05');
  if (typeof snapshotScript !== 'string'
    || !snapshotScript.includes('elementFromPoint')
    || !snapshotScript.includes('getBoundingClientRect')
    || !snapshotScript.includes('pointerEvents')) {
    failures.push('snapshot must measure geometry, hit testing, and pointer behavior');
  }

  const contract = spawnSync(process.execPath, [CONTRACT], { cwd: ROOT, encoding: 'utf8' });
  if (contract.status !== 0 || contract.stdout.trim() !== '1') {
    failures.push('Dragon contract must be read-only, fully bound, authenticated, closed, and scored 1');
  }
  assert.deepEqual(failures, [], `Missing frozen actionability behavior:\n- ${failures.join('\n- ')}`);
});

test('actionability classifier rejects missing or malformed target evidence', async () => {
  const { classifyActionabilityObservation } = await import(`${pathToFileURL(PRODUCT).href}?invalid-evidence=1`);
  assert.throws(() => classifyActionabilityObservation(null), /observation/i);
  assert.throws(() => classifyActionabilityObservation({}), /targets/i);
  assert.throws(() => classifyActionabilityObservation({ targets: [null] }), /target/i);
});
