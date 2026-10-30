import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(new URL('./release-c-scroll-agent-contract.mutations.json', import.meta.url), 'utf8'));

test('five role-contract mutations are killed by the frozen acceptance', () => {
  for (const mutation of registry.mutations) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `team-qa-scroll-contract-${mutation.id}-`));
    try {
      fs.cpSync(ROOT, sandbox, {
        recursive: true,
        filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.includes(`${path.sep}dist${path.sep}`) && !source.includes(`${path.sep}.scroll${path.sep}`),
      });
      const target = path.join(sandbox, mutation.target);
      const source = fs.readFileSync(target, 'utf8');
      assert.equal(source.includes(mutation.anchor), true, `${mutation.id}: mutation anchor missing`);
      fs.writeFileSync(target, source.replace(mutation.anchor, mutation.replacement));
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [
        '--test', '--test-name-pattern', 'behavioral probes reject single-fault outputs',
        'test/release-c-scroll-agent-contract.acceptance.mjs',
      ], { cwd: sandbox, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
      assert.equal(result.error, undefined, `${mutation.id}: ${result.error?.message}`);
      assert.notEqual(result.status, 0, `${mutation.id} survived\n${result.stdout}\n${result.stderr}`);
    } finally {
      fs.mkdirSync(path.join(os.tmpdir(), 'teamqa-test-archive'), { recursive: true });
      fs.renameSync(sandbox, path.join(os.tmpdir(), 'teamqa-test-archive', path.basename(sandbox)));
    }
  }
});
