import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RED = 'test/loop-up-red/teamqa-dogfood-red.mjs';

function finite(value) {
  if (!Number.isFinite(value)) throw new Error('metric is not finite');
  process.stdout.write(`${value}\n`);
}

function redSummary(pattern = '') {
  const args = ['--test', '--test-reporter=tap'];
  if (pattern) args.push(`--test-name-pattern=${pattern}`);
  args.push(RED);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const number = (key) => Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(text)?.[1]);
  const tests = number('tests');
  const pass = number('pass');
  const fail = number('fail');
  const skipped = number('skipped');
  if (![tests, pass, fail, skipped].every(Number.isFinite)) throw new Error('cannot parse TAP summary');
  return { tests, pass, fail, skipped, graded: tests - skipped };
}

function legacySummary() {
  const result = spawnSync(process.execPath, ['test/acceptance/run-acceptance.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = /ACCEPTANCE_SUMMARY total=(\d+) green=(\d+)/.exec(text);
  if (!match || result.status !== 0) throw new Error('legacy acceptance did not pass or summary is missing');
  return { total: Number(match[1]), green: Number(match[2]) };
}

const mode = process.argv[2];
if (mode === 'green_count') finite(redSummary().pass);
else if (mode === 'green_rate') {
  const value = redSummary();
  finite(value.pass / value.tests);
} else if (mode === 'critical_rate') {
  const value = redSummary('LIVE-CAP|CHILD-CANARY|TARGET-LOCK|VERDICT-BINDING|DUAL-VERDICT|FAILURE-SEPARATION|REPORT-INTEGRITY');
  finite(value.graded === 0 ? 0 : value.pass / value.graded);
} else if (mode === 'legacy_rate') {
  const value = legacySummary();
  finite(value.green / value.total);
} else if (mode === 'regression_failures') {
  const value = legacySummary();
  finite(value.total - value.green);
} else if (mode === 'unresolved') finite(redSummary().fail);
else throw new Error('usage: node metrics.mjs green_count|green_rate|critical_rate|legacy_rate|regression_failures|unresolved');
