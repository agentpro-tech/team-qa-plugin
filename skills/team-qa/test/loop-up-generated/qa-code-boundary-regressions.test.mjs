import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { childVerdictIssue } from '../../scripts/lib/child-verdict.mjs';
import { probeLiveCapabilities } from '../../scripts/lib/capability.mjs';
import { sha256 } from '../../scripts/lib/core.mjs';
import * as targetLock from '../../scripts/lib/target-lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('QA-A-001: a resolvable but silent failing child command is not live capability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-live-runtime-'));
  const roles = JSON.parse(readFileSync(join(ROOT, 'roles.json'), 'utf8'));
  roles.skills['qa-gui'].commands.gate = [process.execPath, '-e', 'process.exit(1)'];
  const rolesPath = join(dir, 'roles.json');
  writeFileSync(rolesPath, `${JSON.stringify(roles, null, 2)}\n`);

  const result = spawnSync(process.execPath, ['scripts/teamqa.mjs', 'roles', 'check'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TEAMQA_ROLES: rolesPath, TEAMQA_DRAGON_STATUS_URL: '' },
  });

  assert.notEqual(result.status, 0, 'binary resolution alone must not prove runtime capability');
  assert.match(`${result.stdout}\n${result.stderr}`, /verdict=ungraded|unavailable/i);
});

test('QA-B-001: HTTP 200 status cannot bypass the live child canary', async () => {
  const roles = JSON.parse(readFileSync(join(ROOT, 'roles.json'), 'utf8'));
  roles.skills['qa-gui'].commands.gate = [process.execPath, '-e', 'process.exit(1)'];
  const previous = process.env.TEAMQA_DRAGON_STATUS_URL;
  process.env.TEAMQA_DRAGON_STATUS_URL = 'https://status.invalid/dragon';
  let result;
  try {
    result = await probeLiveCapabilities(roles, ROOT, ROOT, {
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
  } finally {
    if (previous === undefined) delete process.env.TEAMQA_DRAGON_STATUS_URL;
    else process.env.TEAMQA_DRAGON_STATUS_URL = previous;
  }

  assert.equal(result.ok, false, 'HTTP 200 alone must not prove the child gate runtime');
  assert.match(result.detail, /runtime_silent_exit|unavailable/i);
});

test('QA-A-002: exact target shape includes preview URL', () => {
  assert.deepEqual(targetLock.targetShapeErrors({
    project_id: 'ee71fc9d-eebe-4bb2-b130-4930af6fa411',
    preview_url: 'https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app',
    version: '8a9b703d7ac202744bb37c11d1ec377aeb1ed921',
  }, 'TARGET'), []);
});

test('QA-A-003: governed run without a valid declared target fails closed', () => {
  assert.equal(typeof targetLock.targetDeclarationIssue, 'function');
  assert.match(
    String(targetLock.targetDeclarationIssue({ governed: true, source: 'roles', declared: null })),
    /TARGET_(?:DECLARATION|IDENTITY)_MISSING/,
  );
});

function childFixture(payload, source = 'qa-gui') {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-child-receipt-'));
  const artifact = join(dir, 'child.json');
  const raw = Buffer.from(JSON.stringify(payload));
  writeFileSync(artifact, raw);
  return {
    boardPath: join(dir, 'board.jsonl'),
    record: {
      source,
      verdict: 'pass',
      evidence: ['child.json'],
      child_verdict: {
        skill: 'qa-gui',
        verdict: 'pass',
        artifact: 'child.json',
        sha256: sha256(raw),
      },
    },
  };
}

test('QA-A-004a: source=script cannot self-sign a child PASS', () => {
  const fixture = childFixture({ schema: 'qa-gui/verdict/v3', verdict: 'pass' }, 'script');
  assert.notEqual(childVerdictIssue(fixture.record, fixture.boardPath, { governed: true }), null);
});

test('QA-A-004b: child PASS artifact must carry a recognized child schema', () => {
  const fixture = childFixture({ verdict: 'pass' });
  assert.notEqual(childVerdictIssue(fixture.record, fixture.boardPath, { governed: true }), null);
});
