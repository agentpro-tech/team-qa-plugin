#!/usr/bin/env node
import { validateCorpus } from './evaluate.mjs';

const ORDER = ['V6.1', 'V6.4', 'V6.8', 'V6.2', 'V6.5', 'V6.6', 'V6.3', 'V6.7'];
const META = {
  'V6.1': ['buildAppMap', 1, 'exact nodes/edges, no invented node, unknown denominator stays UNGRADED'],
  'V6.2': ['generateProperties', 2, 'P/I/Q trace must be exact; conflicting, unknown, or wrong target stays UNGRADED'],
  'V6.3': ['recallMemory', 3, 'three layers stay app-scoped; foreign/stale/missing-evidence records cannot support PASS'],
  'V6.4': ['diagnoseFailure', 1, 'label/action accuracy plus real-bug recall 1.00 and never retry a real bug'],
  'V6.5': ['baToPlan', 2, 'every Xong khi and failure line traced; invalid ba-pro blocks the whole document'],
  'V6.6': ['replayIntent', 2, 'intent survives selector redesign; multiple valid or unsafe targets halt UNGRADED'],
  'V6.7': ['evaluateRegressionJob', 3, 'complete ordered pipeline and evidence; HR2, timeout, missing Dragon/group fail closed'],
  'V6.8': ['planFormProbes', 1, 'deterministic EP/BVA probes with <=0.05 FP; unreadable custom constraints go untested'],
};

const waveIndex = process.argv.indexOf('--wave');
const requestedWave = waveIndex >= 0 ? Number(process.argv[waveIndex + 1]) : null;
if ((requestedWave !== null && ![1, 2, 3].includes(requestedWave)) || ![2, 4].includes(process.argv.length)) {
  process.stderr.write('usage: signals.mjs [--wave <1|2|3>]\n');
  process.exit(2);
}

try {
  const { manifest } = await validateCorpus();
  const byFeature = new Map(manifest.files.map((entry) => [entry.feature, entry]));
  const signals = ORDER.map((id) => {
    const entry = byFeature.get(id);
    const [exportName, wave, acceptance] = META[id];
    const slug = id.toLowerCase().replace('.', '-');
    return {
      id,
      type: 'loop6-corpus-checker',
      ref: `loop6:${id.toLowerCase()}:${entry.sha256.slice(0, 12)}`,
      detail: `corpus=test/loop6/corpus/${entry.file}; export=${exportName}; wave=${wave}; test_path=test/loop6-${slug}.test.mjs; red_contract=catch missing product import and fail with AssertionError, never top-level ERR_MODULE_NOT_FOUND; hard acceptance=${acceptance}`,
    };
  }).filter((signal) => requestedWave === null || signal.detail.includes(`wave=${requestedWave};`));
  process.stdout.write(`${JSON.stringify(signals)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
}
