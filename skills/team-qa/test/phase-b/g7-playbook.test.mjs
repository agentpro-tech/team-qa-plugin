import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const skillPath = join(repoRoot, 'SKILL.md');
const agentIds = [
  'test-manager',
  'analyst',
  'designer',
  'executor-gui',
  'executor-code',
  'coverage-gate',
];

function skillText() {
  return readFileSync(skillPath, 'utf8');
}

test('G7 SKILL.md contains the complete five-phase BA playbook', () => {
  const text = skillText();
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter, 'SKILL.md must have YAML frontmatter');
  const keys = frontmatter[1]
    .split('\n')
    .filter((line) => /^[a-z_]+:/.test(line))
    .map((line) => line.slice(0, line.indexOf(':')))
    .sort();
  assert.deepEqual(keys, ['description', 'name']);
  assert.match(frontmatter[1], /^name: team-qa$/m);

  for (const token of [
    'Phase 1 — PLAN',
    'Phase 2 — SIGN',
    'Phase 3 — DESIGN',
    'Phase 4 — EXECUTE',
    'Phase 5 — COMPLETE',
    'test_manager',
    'executor_gui',
    'coverage_gate',
    'teamqa plan validate',
    'teamqa gate status',
    'teamqa design validate',
    'teamqa board verify',
    'teamqa report build',
    'L11',
    'L12',
    'Notion',
    'doc-colab',
    'P1',
    'P2',
    'P3',
    'P4',
    'P5',
    'verdict=ungraded',
  ]) {
    assert.ok(text.includes(token), `SKILL.md missing ${token}`);
  }
  for (const code of [0, 1, 2, 3, 4, 5]) {
    assert.match(text, new RegExp(`\\| ${code} \\|`), `missing exit code ${code}`);
  }
});

test('G7 SCROLL role agents come from complete gradeable scaffolds', () => {
  for (const agent of agentIds) {
    const root = join(repoRoot, 'agents', agent);
    for (const path of ['IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'hard-rules.md']) {
      assert.ok(existsSync(join(root, path)), `${agent} missing ${path}`);
    }
    for (const path of ['case-example.md', 'case-02-citation-discipline.md', 'case-03-boundary.md']) {
      assert.ok(existsSync(join(root, 'evals', path)), `${agent} missing evals/${path}`);
    }
  }
});

test('G7 one-command fixture runner covers G1-G6 and reports pass', () => {
  const runner = join(repoRoot, 'fixtures', 'run_fixtures.sh');
  accessSync(runner, constants.X_OK);
  const result = spawnSync('bash', [runner], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, TEAMQA_NODE: process.execPath },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, output);
  for (const group of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
    assert.ok(output.includes(`${group}=PASS`), `fixture runner missing ${group}=PASS\n${output}`);
  }
  assert.ok(output.includes('TEAM_QA_FIXTURES=PASS'), output);
});
