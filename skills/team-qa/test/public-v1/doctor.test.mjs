import test from 'node:test';
import assert from 'node:assert/strict';
import { actionHelp, doctorChecks, renderDoctor, DOCTOR_SCHEMA } from '../../scripts/lib/doctor.mjs';
import { readRequirements } from '../../scripts/lib/dragon-requirements.mjs';

const REQ = readRequirements();
const STORE = 'dmgoldioklileddehbjpbfacojckfkjo';
const status = (over = {}) => ({ ok: true, ready: true, bridgeVersion: '1.6.9', bridgeBuild: 'b', extension: { version: '1.6.9' }, ...over });
// A machine that has everything; each test breaks one thing.
function machine(over = {}) {
  const files = new Set(['/h/team-qa/vendor/scroll/lib/effects.js', '/h/.agents/skills/qa-gui', '/h/.agents/skills/qa-gui/SOURCE.json', '/h/.agents/skills/qa-code', '/h/.agents/skills/qa-code/SOURCE.json']);
  const versions = { '/h/.agents/skills/qa-gui/SOURCE.json': '2.16.0', '/h/.agents/skills/qa-code/SOURCE.json': '1.10.0' };
  return {
    platform: 'darwin', nodeVersion: '24.1.0', env: {}, home: '/h',
    exists: p => files.has(p) || (over.files ?? []).includes(p),
    scrollRoot: () => '/h/team-qa/vendor/scroll',
    readJson: p => ({ version: (over.versions ?? {})[p] ?? versions[p] }),
    which: name => (over.hosts ?? ['claude']).includes(name) ? `/usr/local/bin/${name}` : null,
    fetchStatus: () => over.reachable === false ? { reachable: false } : { reachable: true, body: over.status ?? status() },
    fetchMethods: () => over.methods === undefined ? [...REQ.dragon.rpc, 'perceive'] : over.methods,
    verifyProvider: async skill => { if ((over.badProvenance ?? []).includes(skill)) { const e = new Error('PROVIDER_SOURCE_NOT_IN_CANONICAL_GIT'); e.code = 'PROVIDER_SOURCE_NOT_IN_CANONICAL_GIT'; throw e; } },
    requirements: REQ,
    license: () => over.license ?? { ok: false, code: 'LICENSE_NONE' },
    updateCheck: async () => over.update ?? { status: 'no_channel' },
    ...over.deps,
  };
}
const ids = r => r.checks.map(c => `${c.id}:${c.status}`);

test('a machine with everything is ready, every check named in order', async () => {
  const r = await doctorChecks(machine());
  assert.equal(r.schema, DOCTOR_SCHEMA);
  assert.equal(r.ok, true);
  assert.equal(r.first_failure, null);
  assert.deepEqual(ids(r), ['platform:ok', 'node:ok', 'scroll:ok', 'host:ok', 'qa-gui:ok', 'qa-gui-provenance:ok', 'qa-code:ok', 'qa-code-provenance:ok', 'dragon:ok', 'dragon-rpc:ok']);
});

test('the first gap stops the walk and says what to do', async () => {
  const cases = [
    [{ deps: { platform: 'linux' } }, 'PLATFORM_UNSUPPORTED', 'use_supported_platform'],
    [{ deps: { nodeVersion: '18.19.0' } }, 'NODE_TOO_OLD', 'update_node'],
    [{ deps: { scrollRoot: () => '/nowhere/scroll' } }, 'SCROLL_MISSING', 'install_scroll'],
    [{ hosts: [] }, 'HOST_MISSING', 'install_host'],
    [{ deps: { exists: p => p.endsWith('/lib/effects.js') } }, 'SKILL_MISSING', 'install_suite'],
    [{ versions: { '/h/.agents/skills/qa-gui/SOURCE.json': '2.15.9' } }, 'SKILL_TOO_OLD', 'install_suite'],
    [{ badProvenance: ['qa-code'] }, 'SKILL_PROVENANCE', 'install_suite'],
    [{ reachable: false }, 'DRAGON_RUNTIME_MISSING', 'install_runtime'],
    [{ status: status({ bridgeVersion: '1.6.8' }) }, 'DRAGON_RUNTIME_OLD', 'update_runtime'],
    [{ status: status({ extension: null, ready: false }) }, 'DRAGON_EXTENSION_MISSING', 'install_extension'],
    [{ status: status({ extension: { version: '1.6.6' } }) }, 'DRAGON_EXTENSION_OLD', 'update_extension'],
    [{ status: status({ ready: false }) }, 'DRAGON_NOT_READY', 'pair'],
    [{ status: status({ extension: { version: '1.6.9', id: 'ecidbgopafpecddiefiihnpdljacaiko', installType: 'development' } }) }, 'DRAGON_EXTENSION_NOT_STORE', 'install_extension'],
    [{ methods: REQ.dragon.rpc.filter(m => m !== 'getPageIdentity') }, 'DRAGON_RPC_MISSING', 'update_runtime'],
  ];
  for (const [over, code, action] of cases) {
    const r = await doctorChecks(machine(over));
    assert.equal(r.ok, false, code);
    assert.deepEqual(r.first_failure && [r.first_failure.code, r.first_failure.action], [code, action]);
    const at = r.checks.findIndex(c => c.status === 'fail');
    assert.ok(r.checks.slice(at + 1).every(c => c.status === 'skipped'), `${code}: later checks are skipped`);
    assert.ok(r.checks[at].help.length > 10, `${code}: a person-readable fix`);
  }
});

test('an installed runtime that does not answer is told apart from no runtime', async () => {
  const runtimeFile = `${process.env.HOME}/.dragon-browser/runtime/current/package.json`;
  const r = await doctorChecks(machine({ reachable: false, files: [runtimeFile] }));
  assert.equal(r.first_failure.code, 'DRAGON_RUNTIME_NOT_RUNNING');
  assert.equal(r.first_failure.action, 'start_runtime');
});

test('a method list that cannot be read warns but does not block', async () => {
  const r = await doctorChecks(machine({ methods: null }));
  assert.equal(r.ok, true);
  assert.equal(r.checks.at(-1).status, 'unverified');
});

test('a Store extension that reports its id and install type passes', async () => {
  const r = await doctorChecks(machine({ status: status({ bridgeVersion: '1.6.10', extension: { version: '1.6.9', id: STORE, installType: 'normal' } }) }));
  assert.equal(r.ok, true);
  assert.match(r.checks.find(c => c.id === 'dragon').detail, /runtime 1\.6\.10, extension 1\.6\.9 \(dmgold/);
});

test('the rendering names the code, the action and the fix; every action has a fix', async () => {
  const r = await doctorChecks(machine({ status: status({ extension: { version: '1.6.6' } }) }));
  const text = renderDoctor(r);
  assert.match(text, /FAIL dragon: Dragon extension 1\.6\.6 is older than 1\.6\.9/);
  assert.match(text, /DRAGON_EXTENSION_OLD → update_extension/);
  assert.match(text, /chrome:\/\/extensions/);
  for (const action of ['update_node', 'install_suite', 'install_runtime', 'start_runtime', 'update_runtime', 'install_extension', 'update_extension', 'pair', 'update_teamqa', 'install_host', 'use_supported_platform'])
    assert.ok(actionHelp(action, REQ).length > 10, action);
  assert.match(actionHelp('install_extension', REQ), /chromewebstore\.google\.com\/detail\/dmgoldioklileddehbjpbfacojckfkjo/);
});

test('the licence and the update channel are notes that never block', async () => {
  const free = { ok: true, license: { plan: 'free', email: 'a@b.co', expires_at: '2027-10-29T00:00:00.000Z' } };
  const r = await doctorChecks(machine({ license: free, update: { status: 'available', installed: '1.13.1', latest: '1.14.0' } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes.map(n => n.id), ['license', 'update', 'install']);
  assert.match(r.notes[0].detail, /free plan for a@b\.co, until 2027-10-29/);
  assert.match(r.notes[1].detail, /1\.14\.0 is published \(installed 1\.13\.1\); run teamqa update/);
  const none = await doctorChecks(machine({ reachable: false }));
  assert.equal(none.ok, false);
  assert.match(none.notes[0].detail, /not needed while Team QA is free/);
  assert.match(none.notes[1].detail, /no update channel set/);
  assert.match(renderDoctor(none), /INFO update: no update channel set/);
});
