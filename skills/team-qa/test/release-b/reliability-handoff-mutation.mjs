#!/usr/bin/env node
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'test/release-b/reliability-handoff.mutations.json'), 'utf8'));
let killed = 0;
for (const mutation of registry.mutations) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `teamqa-${mutation.id}-`));
  fs.cpSync(root, sandbox, { recursive: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.includes(`${path.sep}dist${path.sep}`) });
  const target = path.join(sandbox, mutation.file);
  const source = fs.readFileSync(target, 'utf8');
  if (!source.includes(mutation.from)) throw new Error(`${mutation.id} target missing: ${mutation.from}`);
  fs.writeFileSync(target, source.replace(mutation.from, mutation.to));
  const result = cp.spawnSync(process.execPath, ['--test', '--test-name-pattern', `^${mutation.acceptance} `, 'test/release-b/reliability-handoff.acceptance.mjs'], { cwd: sandbox, encoding: 'utf8' });
  if (result.status === 0) throw new Error(`${mutation.id} SURVIVED; expected ${mutation.acceptance} RED`);
  killed += 1;
  process.stdout.write(`${mutation.id} KILLED by ${mutation.acceptance}\n`);
}
if (killed !== registry.mutations.length) throw new Error(`mutation totals wrong killed=${killed}`);
process.stdout.write(`TEAM_QA_RELEASE_B_MUTATION_PASS killed=${killed}\n`);
