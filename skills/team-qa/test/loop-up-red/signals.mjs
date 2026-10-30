import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ref = 'test/loop-up-red/teamqa-dogfood-red.mjs';
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ref], {
  cwd: ROOT,
  encoding: 'utf8',
});
const text = `${result.stdout || ''}\n${result.stderr || ''}`;
const seen = new Set();
const signals = [];
for (const line of text.split(/\r?\n/)) {
  const match = /^not ok \d+ - (RED-[A-Z0-9-]+) — (.+)$/.exec(line);
  if (!match || seen.has(match[1])) continue;
  seen.add(match[1]);
  signals.push({
    id: match[1],
    type: 'teamqa_gap',
    ref: `${ref}#${match[1]}`,
    detail: match[2],
  });
}
if (signals.length === 0 && result.status !== 0) throw new Error('red suite failed but produced no inspectable signals');
process.stdout.write(`${JSON.stringify(signals)}\n`);
