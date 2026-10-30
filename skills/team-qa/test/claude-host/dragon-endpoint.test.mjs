// Eval compat 9: the Dragon status endpoint follows TEAMQA_DRAGON_STATUS_URL (already the roles-check probe
// endpoint) so a run can use an isolated loopback Dragon; without it nothing changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { DEFAULT_DRAGON_STATUS_URL, dragonRuntimeDir, dragonStatusCommand, dragonStatusUrl, isDragonStatusCommand } from '../../scripts/lib/dragon-endpoint.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VAR_FORMS = ['curl --fail --silent $TEAMQA_DRAGON_STATUS_URL', 'curl --fail --silent "$TEAMQA_DRAGON_STATUS_URL"',
  'curl --fail --silent ${TEAMQA_DRAGON_STATUS_URL}', 'curl --fail --silent "${TEAMQA_DRAGON_STATUS_URL}"'];

test('without TEAMQA_DRAGON_STATUS_URL the status call is exactly the historical 9233 command', () => {
  assert.equal(DEFAULT_DRAGON_STATUS_URL, 'http://127.0.0.1:9233/status');
  assert.equal(dragonStatusUrl({}), DEFAULT_DRAGON_STATUS_URL);
  assert.equal(dragonStatusCommand({}), 'curl --fail --silent http://127.0.0.1:9233/status');
  assert.equal(isDragonStatusCommand('curl --fail --silent http://127.0.0.1:9233/status', {}), true);
  for (const form of VAR_FORMS) assert.equal(isDragonStatusCommand(form, {}), false, form);
  assert.equal(isDragonStatusCommand('curl --fail --silent http://127.0.0.1:9333/status', {}), false);
});

test('a loopback TEAMQA_DRAGON_STATUS_URL moves the status call to that bridge', () => {
  const env = { TEAMQA_DRAGON_STATUS_URL: 'http://127.0.0.1:9333/status' };
  assert.equal(dragonStatusUrl(env), 'http://127.0.0.1:9333/status');
  assert.equal(dragonStatusCommand(env), 'curl --fail --silent http://127.0.0.1:9333/status');
  assert.equal(isDragonStatusCommand('curl --fail --silent http://127.0.0.1:9333/status', env), true);
  for (const form of VAR_FORMS) assert.equal(isDragonStatusCommand(form, env), true, form);
  assert.equal(isDragonStatusCommand('curl --fail --silent http://127.0.0.1:9233/status', env), false, 'the global bridge is not this run\'s Dragon');
  assert.equal(dragonStatusUrl({ TEAMQA_DRAGON_STATUS_URL: 'http://localhost:9444/status' }), 'http://localhost:9444/status');
});

test('a non-loopback or malformed value is never followed', () => {
  for (const value of ['https://status.invalid/dragon', 'http://10.0.0.5:9333/status', 'http://127.0.0.1:9333/rpc', 'http://127.0.0.1/status',
    'http://127.0.0.1:9333/status?x=1', 'file:///etc/passwd', ' ']) {
    const env = { TEAMQA_DRAGON_STATUS_URL: value };
    assert.equal(dragonStatusUrl(env), DEFAULT_DRAGON_STATUS_URL, value);
    for (const form of VAR_FORMS) assert.equal(isDragonStatusCommand(form, env), false, `${value} ${form}`);
  }
});

test('no script keeps its own copy of the 9233 status endpoint', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.mjs') && !['dragon-endpoint.mjs', 'claude-refs.mjs'].includes(entry.name)
        && readFileSync(file, 'utf8').includes('127.0.0.1:9233/status')) offenders.push(file);
    }
  };
  walk(join(ROOT, 'scripts'));
  assert.deepEqual(offenders, []);
  for (const file of ['scripts/lib/tool-preflight.mjs', 'scripts/lib/preflight-build.mjs', 'scripts/hooks/qa-lifecycle.mjs']) {
    assert.match(readFileSync(join(ROOT, file), 'utf8'), /dragon-endpoint\.mjs/, file);
  }
});

// Eval compat 11: the runtime pin follows the isolated lane's release, and only that.
test('the Dragon runtime pin follows TEAMQA_DRAGON_RUNTIME_DIR only for an isolated loopback lane with a full runtime', () => {
  const historical = join(homedir(), '.dragon-browser/runtime/current');
  const release = mkdtempSync(join(tmpdir(), 'dragon-release-'));
  for (const name of ['server.js', 'mcp-server.mjs', 'package.json']) writeFileSync(join(release, name), name);
  const partial = mkdtempSync(join(tmpdir(), 'dragon-partial-'));
  writeFileSync(join(partial, 'server.js'), 'x');
  const lane = { TEAMQA_DRAGON_STATUS_URL: 'http://127.0.0.1:9333/status' };
  assert.equal(dragonRuntimeDir({}), historical, 'no variable: the historical runtime');
  assert.equal(dragonRuntimeDir({ ...lane, TEAMQA_DRAGON_RUNTIME_DIR: release }), release, 'the lane release serves the run');
  assert.equal(dragonRuntimeDir({ TEAMQA_DRAGON_RUNTIME_DIR: release }), historical, 'without the lane status URL the global bridge is in use');
  assert.equal(dragonRuntimeDir({ TEAMQA_DRAGON_STATUS_URL: 'http://10.0.0.5:9333/status', TEAMQA_DRAGON_RUNTIME_DIR: release }), historical);
  for (const value of ['relative/release', partial, join(release, 'server.js'), release + '\nx', ' ', join(release, 'missing')]) {
    assert.equal(dragonRuntimeDir({ ...lane, TEAMQA_DRAGON_RUNTIME_DIR: value }), historical, JSON.stringify(value));
  }
});

test('no script pins ~/.dragon-browser/runtime/current outside dragon-endpoint.mjs except the Codex native service helper', () => {
  for (const file of ['scripts/lib/tool-preflight.mjs', 'scripts/lib/preflight-build.mjs']) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.match(source, /dragonRuntimeDir\(\)/, file);
    const pins = source.split('\n').filter(line => line.includes('.dragon-browser/runtime/current') && !line.trim().startsWith('//'));
    assert.deepEqual(pins.filter(line => !line.includes('tools/macos-service.mjs')), [], file);
  }
});
