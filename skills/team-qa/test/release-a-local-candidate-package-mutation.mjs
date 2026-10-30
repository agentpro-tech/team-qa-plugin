#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'test/release-a-local-candidate-package.mutations.json'), 'utf8'));
let killed = 0;
for (const mutation of registry.mutations) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `team-qa-${mutation.id}-`));
  fs.cpSync(root, sandbox, { recursive: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.includes(`${path.sep}dist${path.sep}`) });
  const target = path.join(sandbox, mutation.file); const source = fs.readFileSync(target, 'utf8');
  if (!source.includes(mutation.from)) throw new Error(`${mutation.id}:TARGET_MISSING`);
  fs.writeFileSync(target, source.replace(mutation.from, mutation.to));
  const result = spawnSync(process.execPath, ['--test', 'test/release-a-local-candidate-package.test.mjs'], { cwd: sandbox, encoding: 'utf8' });
  if (result.status === 0) throw new Error(`${mutation.id}:SURVIVED`);
  killed++; process.stdout.write(`${mutation.id}=KILLED\n`);
}
if (killed !== registry.mutations.length) throw new Error(`MUTATION_TOTAL:killed=${killed}:total=${registry.mutations.length}`);
process.stdout.write(`TEAM_QA_LOCAL_CANDIDATE_MUTATION_PASS killed=${killed}\n`);
