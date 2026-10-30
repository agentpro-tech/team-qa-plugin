#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { CHECKER_DIR, PRODUCT_PATH, evaluate, validateCorpus } from './evaluate.mjs';

const metrics = ['overall_recall', 'false_positive_rate', 'real_bug_recall', ...Array.from({ length: 8 }, (_, i) => `v6_${i + 1}`)];
const numeric = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

try {
  const { manifest } = await validateCorpus();
  assert.equal(manifest.totals.hard, 212);
  assert.equal(manifest.totals.ordinary, 70);

  for (const metric of metrics) {
    const run = spawnSync(process.execPath, [resolve(CHECKER_DIR, 'score.mjs'), '--metric', metric], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `${run.stdout.trim()}\n`, `${metric} must print one line`);
    assert.match(run.stdout.trim(), numeric, `${metric} must print one numeric token`);
    assert.ok(Number.isFinite(Number(run.stdout.trim())));
  }

  const signalRun = spawnSync(process.execPath, [resolve(CHECKER_DIR, 'signals.mjs')], { encoding: 'utf8' });
  assert.equal(signalRun.status, 0, signalRun.stderr);
  const signals = JSON.parse(signalRun.stdout);
  assert.equal(signals.length, 8);
  assert.deepEqual(signals.map((s) => s.id), ['V6.1', 'V6.4', 'V6.8', 'V6.2', 'V6.5', 'V6.6', 'V6.3', 'V6.7']);
  assert.equal(new Set(signals.map((s) => s.ref)).size, 8);
  for (const signal of signals) {
    assert.deepEqual(Object.keys(signal), ['id', 'type', 'ref', 'detail']);
    assert.ok(Object.values(signal).every((value) => typeof value === 'string' && value.length > 0));
    assert.match(signal.detail, /test_path=test\/loop6-v6-[1-8]\.test\.mjs/);
    assert.match(signal.detail, /red_contract=.*AssertionError.*ERR_MODULE_NOT_FOUND/);
  }

  for (const [wave, expectedIds] of [['1', ['V6.1', 'V6.4', 'V6.8']], ['2', ['V6.2', 'V6.5', 'V6.6']], ['3', ['V6.3', 'V6.7']]]) {
    const filtered = spawnSync(process.execPath, [resolve(CHECKER_DIR, 'signals.mjs'), '--wave', wave], { encoding: 'utf8' });
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.deepEqual(JSON.parse(filtered.stdout).map((s) => s.id), expectedIds);
  }

  let productExists = true;
  try { await access(PRODUCT_PATH, constants.R_OK); } catch { productExists = false; }
  const result = await evaluate();
  if (!productExists) {
    assert.equal(result.overallRecall, 0);
    assert.equal(result.falsePositiveRate, 1);
    assert.equal(result.realBugRecall, 0);
    for (const feature of Object.values(result.features)) assert.equal(feature.recall, 0);
  }
  process.stdout.write('PASS\n');
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
