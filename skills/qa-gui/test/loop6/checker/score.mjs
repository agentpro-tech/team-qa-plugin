#!/usr/bin/env node
import { evaluate } from './evaluate.mjs';

const metricIndex = process.argv.indexOf('--metric');
const metric = metricIndex >= 0 ? process.argv[metricIndex + 1] : null;
const valid = new Set(['overall_recall', 'false_positive_rate', 'real_bug_recall', ...Array.from({ length: 8 }, (_, i) => `v6_${i + 1}`)]);

if (!valid.has(metric) || process.argv.length !== 4) {
  process.stderr.write('usage: score.mjs --metric <overall_recall|false_positive_rate|real_bug_recall|v6_1..v6_8>\n');
  process.exitCode = 2;
} else {
  try {
    const result = await evaluate();
    const value = metric === 'overall_recall' ? result.overallRecall
      : metric === 'false_positive_rate' ? result.falsePositiveRate
      : metric === 'real_bug_recall' ? result.realBugRecall
      : result.features[`V6.${metric.slice(3)}`].recall;
    if (!Number.isFinite(value)) throw new Error('metric is not finite');
    process.stdout.write(`${value}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

