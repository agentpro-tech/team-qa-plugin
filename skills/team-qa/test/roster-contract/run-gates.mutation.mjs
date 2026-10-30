import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const cases = [
  { name: 'board-intake', failed: 'direct board intake', mutate: (s) => s.replace("const contract = assertRunContract({ runDir: dirname(boardPath), action: 'intake', record });", "const contract = {runDir:dirname(boardPath),roster:{run_id:record.run_id}};") },
  { name: 'plan-approval', failed: 'direct plan approval', mutate: (s) => s.replace("const historicalDiagnostic = !existsSync(join(runDir, 'roster.json')) && !existsSync(join(runDir, 'phase.json'));", "const historicalDiagnostic = true;") },
];
for (const item of cases) {
  const copy = mkdtempSync(join(tmpdir(), `tq-gate-mutant-${item.name}-`));
  for (const path of ['scripts', 'schemas', 'contracts', 'references', 'test', 'fixtures', 'agents', 'SKILL.md', 'roles.json']) cpSync(join(root, path), join(copy, path), { recursive: true });
  const file = join(copy, 'scripts/teamqa.mjs');
  const original = readFileSync(file, 'utf8'); const mutant = item.mutate(original);
  assert.notEqual(mutant, original, `${item.name}: mutation did not hit implementation`);
  writeFileSync(file, mutant);
  const r = spawnSync(process.execPath, ['--test', join(copy, 'test/roster-contract/run-gates.acceptance.test.mjs')], { encoding: 'utf8' });
  const output = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, output);
  assert.match(output, new RegExp(`✖ ${item.failed}`));
  assert.match(output, /verdict=pass/);
  assert.match(output, /pass 3/); assert.match(output, /fail 1/);
  console.log(`PASS mutation=${item.name} baseline=4/4 mutant=3/4 retained=${copy}`);
}
