import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const entry = join(repoRoot, 'scripts', 'teamqa.mjs');
const rolesPath = join(repoRoot, 'roles.json');
const roleIds = [
  'test_manager',
  'analyst',
  'designer',
  'executor_gui',
  'executor_code',
  'coverage_gate',
];

function readRoles(path = rolesPath) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runRolesCheck(cwd) {
  return spawnSync(process.execPath, [entry, 'roles', 'check'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function withRoles(mutator, fn) {
  const cwd = mkdtempSync(join(tmpdir(), 'teamqa-g1-'));
  try {
    const target = join(cwd, 'roles.json');
    copyFileSync(rolesPath, target);
    const config = readRoles(target);
    mutator(config);
    writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return fn(cwd, config);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('G1 roles.json covers every Appendix A role with the required contract', () => {
  const config = readRoles();
  assert.ok(Array.isArray(config.roles), 'roles must be an array');
  assert.deepEqual(config.roles.map((item) => item.role), roleIds);
  for (const item of config.roles) {
    for (const key of ['role', 'engine', 'fallback', 'tool_bound']) {
      assert.ok(Object.hasOwn(item, key), `${item.role} missing ${key}`);
    }
    assert.equal(typeof item.tool_bound, 'boolean', `${item.role}.tool_bound must be boolean`);
  }
  assert.equal(config.roles.find((item) => item.role === 'executor_gui').tool_bound, true);
});

test('G1 Analyst engine can change in one config line and roles check remains pass', () => {
  withRoles((config) => {
    config.roles.find((item) => item.role === 'analyst').engine = 'haiku';
  }, (cwd) => {
    const result = runRolesCheck(cwd);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /verdict=pass/);
  });
});

test('G1 executor_gui rejects an engine without its declared tool', () => {
  withRoles((config) => {
    config.roles.find((item) => item.role === 'executor_gui').engine = 'codex-terra';
  }, (cwd) => {
    const result = runRolesCheck(cwd);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /verdict=fail/);
    assert.match(`${result.stdout}${result.stderr}`, /executor_gui/);
    assert.match(`${result.stdout}${result.stderr}`, /ROLE_TOOL_UNAVAILABLE/);
  });
});
