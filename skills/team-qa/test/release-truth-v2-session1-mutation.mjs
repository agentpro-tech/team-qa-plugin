#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutations = [
  { id: 'S1-M01-RTM-BLANK', file: 'scripts/teamqa.mjs', from: "if (stats.filled !== stats.total) fail(2, 'RTM_VERDICT_EMPTY', `count=${stats.total - stats.filled}`);", to: '', test: 'I4 ' },
  { id: 'S1-M02-ARTIFACT-HASH', file: 'scripts/lib/release-truth.mjs', from: "if (digest(fs.readFileSync(file)) !== artifact.sha256) fail(2, `RECEIPT_ARTIFACT_HASH:${name}`);", to: '', test: 'I16 ' },
  { id: 'S1-M03-UNKNOWN-CASE', file: 'scripts/teamqa.mjs', from: "if (!planned) fail(2, 'BOARD_CASE_UNKNOWN', record.case_id);", to: '', test: 'I17 ' },
  { id: 'S1-M04-LANE', file: 'scripts/teamqa.mjs', from: "if (!requirement.verification_lane) fail(2, `REQUIREMENT_LANE_MISSING:${requirement.id}`);", to: '', test: 'TQe ' },
];

let killed = 0;
for (const mutation of mutations) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `team-qa-${mutation.id}-`));
  fs.cpSync(root, sandbox, { recursive: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.includes(`${path.sep}dist${path.sep}`) });
  const target = path.join(sandbox, mutation.file); const source = fs.readFileSync(target, 'utf8');
  if (!source.includes(mutation.from)) throw new Error(`${mutation.id}:TARGET_MISSING`);
  fs.writeFileSync(target, source.replace(mutation.from, mutation.to));
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', `^${mutation.test}`, 'test/release-truth-v2-session1.test.mjs'], { cwd: sandbox, encoding: 'utf8' });
  if (result.status === 0) throw new Error(`${mutation.id}:SURVIVED`);
  killed++; process.stdout.write(`${mutation.id}=KILLED\n`);
}
process.stdout.write(`SESSION1_MUTATION_PASS killed=${killed}\n`);
