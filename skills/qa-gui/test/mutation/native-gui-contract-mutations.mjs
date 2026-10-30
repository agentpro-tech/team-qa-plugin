import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePath = join(repo, 'scripts/lib/native-gui-trajectory.mjs');
const testPath = join(repo, 'test/native-gui-trajectory.test.mjs');
const outputDir = join(repo, 'test/output/dragon-canary-20261015/mutations');
const tempRoot = mkdtempSync(join(tmpdir(), 'qa-gui-native-contract-mutations-'));
const original = readFileSync(sourcePath, 'utf8');

function prepare(name, source) {
  const dir = join(tempRoot, name);
  mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'scripts/lib/native-gui-trajectory.mjs'), source);
  cpSync(testPath, join(dir, 'test/native-gui-trajectory.test.mjs'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  return dir;
}

function run(name, source) {
  const dir = prepare(name, source);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/native-gui-trajectory.test.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return { name, dir, status: result.status, signal: result.signal, output: `${result.stdout || ''}${result.stderr || ''}` };
}

const positive = run('positive-control', original);
assert.equal(positive.status, 0, `positive control must pass before mutation checks\n${positive.output}`);

const versionGuard = "const DRAGON_MIN = [1, 6, 4], DRAGON_BELOW = [2, 0, 0];";
assert.ok(original.includes(versionGuard), 'supported version guard source anchor changed');
const versionMutant = original.replace(versionGuard, "const DRAGON_MIN = [1, 6, 3], DRAGON_BELOW = [3, 0, 0];");
const version = run('mutant-version-accepts-1.6.3', versionMutant);
assert.notEqual(version.status, 0, 'a mutant that accepts Dragon 1.6.3 and 2.x must be killed');
assert.match(version.output, /supported Dragon versions are a range/);

const storageGuard = /function readsOnlyDeclaredStorageKeys\(read\) \{[\s\S]*?\n\}/;
assert.match(original, storageGuard, 'Storage read guard source anchor changed');
const storageMutant = original.replace(storageGuard, "function readsOnlyDeclaredStorageKeys(read) {\n  return typeof read === 'string';\n}");
const storage = run('mutant-storage-allows-side-effects', storageMutant);
assert.notEqual(storage.status, 0, 'unrestricted Storage read mutant must be killed');
assert.match(storage.output, /Storage read policy allows literal-key getItem/);

mkdirSync(outputDir, { recursive: true });
const result = {
  schema: 'qa-gui/native-contract-mutations/v1',
  positiveControl: { name: positive.name, status: positive.status, output: positive.output },
  mutants: [version, storage].map(({ name, dir, status, output }) => ({ name, directory: dir, status, killed: status !== 0, output })),
  preservedTempRoot: tempRoot,
  command: 'node test/mutation/native-gui-contract-mutations.mjs',
};
writeFileSync(join(outputDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  positiveControl: positive.status === 0 ? 'PASS' : 'FAIL',
  mutants: result.mutants.map(({ name, status, killed }) => ({ name, status, killed })),
  preservedTempRoot: tempRoot,
  resultsPath: join(outputDir, 'results.json'),
}, null, 2));
