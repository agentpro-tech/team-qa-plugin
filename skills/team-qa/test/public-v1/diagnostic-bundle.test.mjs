import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnosticBundle, redact } from '../../scripts/lib/doctor.mjs';
import { readRequirements } from '../../scripts/lib/dragon-requirements.mjs';

const TOKEN = 'sk-ant-oat01-' + 'Z'.repeat(40);
const GH = 'ghp_' + 'A'.repeat(36);
// Sample secrets and paths are assembled at run time so the package hygiene gate finds none in this file.
const U = '/' + 'Users/jane', KEY_HEAD = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', KEY_FOOT = '-----END OPENSSH ' + 'PRIVATE KEY-----';

test('redaction drops secret-keyed values and masks secret shapes anywhere', () => {
  const out = redact({
    password: 'hunter22', apiKey: 'k', Authorization: 'Bearer abcdefghijkl', nested: { session_key: 'x', nonce: 'n-1', note: `use ${TOKEN} then ${GH}` },
    header: 'Bearer abcdefghijklmnop', who: 'reach me at jane.doe@example.org', path: `${U}/Dev/app/runs/r1`,
    key: `${KEY_HEAD}\nAAAA\n${KEY_FOOT}`, keep: 42, list: ['ok', `x ${TOKEN}`],
  }, { home: U });
  assert.equal(out.password, '[redacted]');
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.Authorization, '[redacted]');
  assert.equal(out.nested.session_key, '[redacted]');
  assert.equal(out.nested.nonce, '[redacted]');
  assert.equal(out.nested.note, 'use [token] then [token]');
  assert.equal(out.header, 'Bearer [token]');
  assert.equal(out.who, 'reach me at [email]');
  assert.equal(out.path, '~/Dev/app/runs/r1');
  assert.equal(out.key, '[private key]');
  assert.equal(out.keep, 42);
  assert.deepEqual(out.list, ['ok', 'x [token]']);
});

test('the bundle carries versions, the doctor report and the run state, with nothing secret in it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teamqa-bundle-home-'));
  const runs = join(home, 'project', 'runs');
  mkdirSync(join(runs, 'r1'), { recursive: true });
  writeFileSync(join(runs, 'r1', 'phase.json'), JSON.stringify({ phase: 'EXECUTE', operator: 'jane.doe@example.org', token: TOKEN }));
  writeFileSync(join(runs, 'r1', 'roster.json'), JSON.stringify({ run_id: 'r1', mcp_config: { path: join(home, '.claude', 'mcp.json') } }));
  writeFileSync(join(runs, 'r1', 'accounts.txt'), 'admin hunter22\n');
  const overrides = {
    platform: 'darwin', nodeVersion: '24.1.0', env: {}, home, requirements: readRequirements(),
    // A suite install (the plugin layout is covered in plugin.test.mjs): QA GUI and QA Code sit next to Team QA.
    teamqaRoot: join(home, '.agents', 'skills', 'team-qa'),
    exists: p => p.endsWith('/skills/qa-gui') || p.endsWith('/skills/qa-code') || p.endsWith('SOURCE.json') || p.endsWith('/lib/effects.js'),
    readJson: p => ({ version: p.includes('qa-gui') ? '2.16.0' : '1.10.0' }),
    which: n => n === 'claude' ? '/usr/local/bin/claude' : null, hostVersion: () => '2.1.311 (Claude Code)',
    fetchStatus: () => ({ reachable: true, body: { ok: true, ready: true, bridgeVersion: '1.6.9', extension: { version: '1.6.9' }, note: `Bearer ${'q'.repeat(20)}` } }),
    fetchMethods: () => readRequirements().dragon.rpc, verifyProvider: async () => {},
  };
  const b = await diagnosticBundle({ run: 'r1', runsDir: runs, overrides });
  assert.equal(b.schema, 'team-qa/diagnostics/v1');
  assert.equal(b.doctor.ok, true);
  assert.equal(b.hosts.claude, '2.1.311 (Claude Code)');
  assert.equal(b.run['phase.json'].phase, 'EXECUTE');
  assert.equal(b.run['phase.json'].token, '[redacted]');
  assert.equal(b.run['phase.json'].operator, '[email]');
  assert.equal(b.run['roster.json'].mcp_config.path, '~/.claude/mcp.json');
  const text = JSON.stringify(b);
  for (const leak of [TOKEN, 'jane.doe', 'hunter22', home, 'q'.repeat(20)]) assert.ok(!text.includes(leak), `bundle leaks ${leak.slice(0, 12)}`);
  assert.ok(!('accounts.txt' in b.run), 'account files are never read into the bundle');
});
