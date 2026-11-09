// Team QA as a Claude Code plugin (BA plugin, C1-C5): where the sibling skills are found, plugin mode in doctor,
// update and continuation, the hook gate, and the plugin files Team QA ships in scripts/plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ID, TEAMQA_ROOT, installMode, isInstalledRoot, pluginInfo, pluginRegistryDir, runtimeReleaseUrl, siblingSkillRoot } from '../../scripts/lib/install-layout.mjs';
import { doctorChecks, renderDoctor } from '../../scripts/lib/doctor.mjs';
import { readRequirements } from '../../scripts/lib/dragon-requirements.mjs';
import { updateCommand, updateNotice } from '../../scripts/lib/suite.mjs';
import { continuationCommand, hookDefinition } from '../../scripts/continuation.mjs';
import { pluginHook, sessionBinding } from '../../scripts/hooks/plugin-gate.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const tmp = name => realpathSync(mkdtempSync(join(tmpdir(), `teamqa-plugin-${name}-`)));
const REQ = readRequirements();

// <dir>/skills/{team-qa,qa-gui,qa-code}, each installed (SOURCE.json); optionally the plugin manifest above them.
function layout({ plugin = true, name = 'team-qa', version = '1.15.0' } = {}) {
  const dir = tmp('layout');
  for (const skill of ['team-qa', 'qa-gui', 'qa-code']) {
    mkdirSync(join(dir, 'skills', skill), { recursive: true });
    writeFileSync(join(dir, 'skills', skill, 'SOURCE.json'), JSON.stringify({ skill, version }));
    writeFileSync(join(dir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
  }
  if (plugin) { mkdirSync(join(dir, '.claude-plugin')); writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version })); }
  return { dir, teamqa: join(dir, 'skills', 'team-qa') };
}

test('C1: a source checkout keeps ~/.agents/skills; an installed Team QA finds its siblings next to it', () => {
  assert.equal(isInstalledRoot(TEAMQA_ROOT), existsSync(join(TEAMQA_ROOT, 'SOURCE.json')));
  const source = tmp('source');
  assert.equal(siblingSkillRoot('qa-gui', { root: source, env: {}, home: '/h' }), '/h/.agents/skills/qa-gui');
  const { dir, teamqa } = layout();
  assert.equal(siblingSkillRoot('qa-gui', { root: teamqa, env: {}, home: '/h' }), join(dir, 'skills', 'qa-gui'));
  assert.equal(siblingSkillRoot('qa-code', { root: teamqa, env: {}, home: '/h' }), join(dir, 'skills', 'qa-code'));
  // The variables still win.
  assert.equal(siblingSkillRoot('qa-gui', { root: teamqa, env: { TEAMQA_QA_GUI_ROOT: '/x/qa-gui' }, home: '/h' }), '/x/qa-gui');
  assert.equal(siblingSkillRoot('qa-code', { root: teamqa, env: { TEAMQA_QA_CODE_ROOT: '/x/qa-code' }, home: '/h' }), '/x/qa-code');
});

test('C1: a linked install (~/.claude/skills/team-qa -> ~/.agents/skills/team-qa) resolves to the real folder', () => {
  const { dir, teamqa } = layout({ plugin: false });
  const links = tmp('links'); symlinkSync(teamqa, join(links, 'team-qa'));
  assert.equal(siblingSkillRoot('qa-gui', { root: join(links, 'team-qa'), env: {}, home: '/h' }), join(dir, 'skills', 'qa-gui'));
});

test('C1: the provenance check names a missing sibling instead of using another install', async () => {
  const { verifyProviderInterface } = await import('../../scripts/lib/roster.mjs');
  const missing = join(tmp('missing'), 'qa-gui');
  assert.throws(() => verifyProviderInterface({ skill: 'qa-gui', root: missing }), error => error.code === 'SIBLING_SKILL_MISSING' && error.message.includes(missing));
});

test('C2: plugin mode is the plugin layout with a team-qa manifest, and nothing else', () => {
  const plugin = layout();
  assert.deepEqual(pluginInfo(plugin.teamqa), { root: plugin.dir, manifest: join(plugin.dir, '.claude-plugin', 'plugin.json'), version: '1.15.0', id: PLUGIN_ID });
  assert.equal(installMode(plugin.teamqa).mode, 'plugin');
  assert.equal(pluginInfo(layout({ name: 'other' }).teamqa), null);
  const skills = layout({ plugin: false });
  assert.equal(pluginInfo(skills.teamqa), null);
  assert.equal(installMode(skills.teamqa).mode, 'skills');
  assert.equal(installMode(tmp('checkout')).mode, 'source');
  assert.equal(PLUGIN_ID, 'team-qa@agentpro');
  assert.equal(runtimeReleaseUrl('1.15.0'), 'https://github.com/agentpro-tech/team-qa-releases/releases/download/team-qa-1.15.0/dragon-runtime.dbrc');
  assert.equal(pluginRegistryDir('/h'), '/h/.agentpro/teamqa/continuation');
});

// A doctor machine whose Team QA is the plugin at /p (fake file system).
function pluginMachine({ files = {}, extra = [] } = {}) {
  const fs = {
    '/p/.claude-plugin/plugin.json': JSON.stringify({ name: 'team-qa', version: '1.15.0' }),
    '/p/skills/team-qa/SOURCE.json': '{"version":"1.15.0"}', '/p/skills/team-qa/vendor/scroll/lib/effects.js': '',
    '/p/skills/qa-gui': '', '/p/skills/qa-gui/SOURCE.json': '', '/p/skills/qa-code': '', '/p/skills/qa-code/SOURCE.json': '',
    '/p/hooks/hooks.json': 'H', '/p/skills/team-qa/scripts/plugin/hooks.json': 'H', '/p/bin/teamqa': 'B', '/p/skills/team-qa/scripts/plugin/teamqa': 'B',
    ...files,
  };
  return {
    platform: 'darwin', nodeVersion: '24.1.0', env: {}, home: '/h', cwd: '/w', teamqaRoot: '/p/skills/team-qa',
    exists: p => Object.hasOwn(fs, p) || extra.includes(p), realpath: p => p,
    readText: p => { if (!Object.hasOwn(fs, p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return fs[p]; },
    scrollRoot: () => '/p/skills/team-qa/vendor/scroll',
    readJson: p => ({ version: p.includes('qa-gui') ? '2.17.0' : '1.11.0' }),
    which: name => name === 'claude' ? '/usr/local/bin/claude' : null,
    fetchStatus: () => ({ reachable: false }),
    fetchMethods: () => null,
    verifyProvider: async () => {},
    requirements: REQ,
    license: () => ({ ok: false, code: 'LICENSE_NONE' }),
    updateCheck: async () => { throw new Error('the plugin never reads the channel'); },
  };
}

test('C2/C5: doctor in the plugin finds the siblings in the plugin and names the runtime of this release', async () => {
  const r = await doctorChecks(pluginMachine());
  assert.equal(r.checks.find(c => c.id === 'qa-gui').status, 'ok');
  assert.equal(r.first_failure.code, 'DRAGON_RUNTIME_MISSING');
  const failure = r.checks.find(c => c.status === 'fail');
  assert.match(failure.help, /teamqa dragon install --from https:\/\/github\.com\/agentpro-tech\/team-qa-releases\/releases\/download\/team-qa-1\.15\.0\/dragon-runtime\.dbrc/);
  const notes = Object.fromEntries(r.notes.map(n => [n.id, n]));
  assert.match(notes.install.detail, /^plugin team-qa@agentpro 1\.15\.0 \(\/p\)$/);
  assert.match(notes.update.detail, /\/plugin update team-qa@agentpro/);
  assert.deepEqual(r.notes.filter(n => n.status === 'warn'), []);
  const missing = await doctorChecks(pluginMachine({ files: { '/p/skills/qa-code/SOURCE.json': undefined } }));
  assert.ok(missing.checks.every(c => c.id !== 'qa-gui' || c.status === 'ok'));
});

test('C2: doctor warns about a second install, a staged hook and plugin files that are not the signed ones', async () => {
  const twice = await doctorChecks(pluginMachine({ extra: ['/h/.agents/skills/team-qa/SOURCE.json', '/h/.claude/skills/team-qa'] }));
  assert.equal(twice.notes.find(n => n.id === 'duplicate-install')?.code, 'DUPLICATE_INSTALL');
  assert.match(twice.notes.find(n => n.id === 'duplicate-install').help, /Codex keeps using ~\/\.agents\/skills/);
  // The suite install that only Codex links to is not a second install for Claude Code.
  const codex = await doctorChecks(pluginMachine({ extra: ['/h/.agents/skills/team-qa/SOURCE.json'] }));
  assert.equal(codex.notes.find(n => n.id === 'duplicate-install'), undefined);
  assert.equal(codex.notes.find(n => n.id === 'codex-install')?.status, 'info');
  assert.deepEqual(codex.notes.filter(n => n.status === 'warn'), []);
  // CLAUDE_CONFIG_DIR names the skills folder Claude Code reads.
  const config = await doctorChecks({ ...pluginMachine({ extra: ['/c/skills/team-qa'] }), env: { CLAUDE_CONFIG_DIR: '/c' } });
  assert.match(config.notes.find(n => n.id === 'duplicate-install').detail, /\/c\/skills\/team-qa/);
  const hooks = await doctorChecks(pluginMachine({ files: { '/w/.claude/settings.json': '{"hooks":{"Stop":[{"hooks":[{"command":"node /x/scripts/hooks/qa-lifecycle.mjs"}]}]}}' } }));
  const staged = hooks.notes.find(n => n.id === 'hooks');
  assert.equal(staged.code, 'HOOKS_TWICE');
  assert.match(staged.detail, /\/w\/\.claude\/settings\.json/);
  const drift = await doctorChecks(pluginMachine({ files: { '/p/bin/teamqa': 'other' } }));
  assert.match(drift.notes.find(n => n.id === 'plugin-files').detail, /^bin\/teamqa /);
  const text = renderDoctor(drift);
  assert.match(text, /WARN plugin-files: /);
  assert.match(text, /PLUGIN_FILES_DRIFT/);
  // The warnings never block.
  assert.equal(twice.first_failure.code, 'DRAGON_RUNTIME_MISSING');
});

test('C2: a suite install warns when the plugin is installed too and Claude Code links the suite', async () => {
  const m = pluginMachine();
  const suite = linked => doctorChecks({ ...m, teamqaRoot: '/h/.agents/skills/team-qa',
    exists: p => p === '/h/.agents/skills/team-qa/SOURCE.json' || p.startsWith('/h/.agents/skills/qa-') || p.endsWith('effects.js') || (linked && p === '/h/.claude/skills/team-qa'),
    readText: p => p === '/h/.claude/plugins/installed_plugins.json' ? '{"version":2,"plugins":{"team-qa@agentpro":[{}]}}' : m.readText(p),
    scrollRoot: () => '/h/.agents/skills/team-qa/vendor/scroll', updateCheck: async () => ({ status: 'no_channel' }) });
  const r = await suite(true);
  assert.match(r.notes.find(n => n.id === 'install').detail, /^skills \/h\/\.agents\/skills$/);
  assert.equal(r.notes.find(n => n.id === 'duplicate-install')?.code, 'DUPLICATE_INSTALL');
  // Codex's install beside the plugin, with no ~/.claude/skills link: no warning.
  assert.equal((await suite(false)).notes.find(n => n.id === 'duplicate-install'), undefined);
});

test('C2: teamqa update leaves the plugin to Claude Code', () => {
  const plugin = { id: PLUGIN_ID, version: '1.15.0' };
  const lines = []; const log = console.log; console.log = line => lines.push(line);
  try { updateCommand(['--check'], { plugin }); } finally { console.log = log; }
  assert.match(lines[0], /^verdict=pass UPDATE status=plugin installed=1\.15\.0$/);
  assert.match(lines[1], /\/plugin update team-qa@agentpro/);
  assert.throws(() => updateCommand([], { plugin }), error => error.code === 'UPDATE_MANAGED_BY_PLUGIN');
  assert.equal(updateNotice({ channel: '/nowhere', plugin }), null);
});

test('C2/C4: continuation in the plugin: nothing to stage, one fixed registry', async () => {
  const plugin = { id: PLUGIN_ID, version: '1.15.0' };
  await assert.rejects(continuationCommand('stage-hooks', ['--registry', '/tmp/r', '--out', '/tmp/r.json', '--host', 'claude'], { plugin }), error => error.code === 'PLUGIN_HOOKS_ACTIVE');
  await assert.rejects(continuationCommand('register', ['--run', 'r1', '--session', 's1', '--registry', '/elsewhere'], { plugin, registryDir: '/h/.agentpro/teamqa/continuation' }),
    error => error.code === 'PLUGIN_REGISTRY_FIXED');
  // Outside the plugin --registry is still required.
  await assert.rejects(continuationCommand('register', ['--run', 'r1', '--session', 's1'], { plugin: null }), error => error.code === 'ARG_REQUIRED');
});

test('C4: the hook gate answers {} for a session that is not registered, without loading the handler', async () => {
  const registry = tmp('registry');
  writeFileSync(join(registry, 'abc-123.json'), '{}');
  assert.equal(sessionBinding({ session_id: 'zzz-999' }, registry), 'none');
  assert.equal(sessionBinding({ session_id: 'abc-123' }, registry), 'registered');
  assert.equal(sessionBinding({ session_id: '../abc-123' }, registry), 'unknown');
  assert.equal(sessionBinding({}, registry), 'unknown');
  let called = null;
  const handle = async (input, options) => { called = [input.session_id, options.registryDir]; return { decision: 'block' }; };
  assert.deepEqual(await pluginHook({ hook_event_name: 'PreToolUse', session_id: 'zzz-999' }, { registry, handle }), {});
  assert.equal(called, null);
  assert.deepEqual(await pluginHook({ hook_event_name: 'Stop', session_id: 'abc-123' }, { registry, handle }), { decision: 'block' });
  assert.deepEqual(called, ['abc-123', registry]);
  // A session id the gate cannot judge goes to the handler, which refuses what it cannot verify.
  called = null; await pluginHook({ hook_event_name: 'Stop', session_id: '../x' }, { registry, handle });
  assert.deepEqual(called, ['../x', registry]);
});

test('C4: run as Claude Code runs it, the gate prints {} and writes nothing for an unregistered session', () => {
  const home = tmp('home');
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '9a0b1c2d-0000-4000-8000-000000000000', transcript_path: '/nowhere.jsonl', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const started = Date.now();
  const r = spawnSync('/bin/sh', [join(ROOT, 'scripts/plugin/plugin-gate.sh')], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  const ms = Date.now() - started;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '{}');
  assert.deepEqual(readdirSync(home), []);
  assert.ok(ms < 2000, `took ${ms} ms`);
  const garbage = spawnSync('/bin/sh', [join(ROOT, 'scripts/plugin/plugin-gate.sh')], { input: 'not json', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(garbage.stdout.trim(), '{}');
});

test('C4: through a linked path the gate and the staged hook still answer (realpath main check)', () => {
  const link = join(tmp('linked'), 'scripts'); symlinkSync(join(ROOT, 'scripts'), link);
  const home = tmp('linked-home');
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '9a0b1c2d-0000-4000-8000-000000000000', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const env = { PATH: process.env.PATH, HOME: home };
  const gate = spawnSync('/bin/sh', [join(link, 'plugin/plugin-gate.sh')], { input, encoding: 'utf8', env });
  assert.equal(gate.stdout.trim(), '{}', gate.stderr);
  const direct = spawnSync(process.execPath, [join(link, 'hooks/plugin-gate.mjs')], { input, encoding: 'utf8', env });
  assert.equal(direct.stdout.trim(), '{}', direct.stderr);
  const staged = spawnSync(process.execPath, [join(link, 'hooks/qa-lifecycle.mjs'), '--registry', join(home, 'registry')], { input, encoding: 'utf8', env });
  assert.equal(staged.stdout.trim(), '{}', staged.stderr);
});

test('C4: without Node.js the gate refuses a registered session and passes any other; the recorded Node comes first', () => {
  // A copy of the wrapper whose fixed Node locations do not exist, so only PATH and the registry's .node can supply it.
  const dir = tmp('nonode'); mkdirSync(join(dir, 'plugin')); mkdirSync(join(dir, 'hooks'));
  writeFileSync(join(dir, 'plugin', 'plugin-gate.sh'), readFileSync(join(ROOT, 'scripts/plugin/plugin-gate.sh'), 'utf8').replace('/opt/homebrew/bin/node /usr/local/bin/node', '/nonexistent/a/node /nonexistent/b/node'));
  writeFileSync(join(dir, 'hooks', 'plugin-gate.mjs'), 'process.stdout.write("{\\"from\\":\\"node\\"}\\n");');
  const home = tmp('nonode-home'), registry = join(home, '.agentpro', 'teamqa', 'continuation');
  mkdirSync(registry, { recursive: true }); writeFileSync(join(registry, 'abc-123.json'), '{}');
  const run = (sid, event = 'PreToolUse') => spawnSync('/bin/sh', [join(dir, 'plugin', 'plugin-gate.sh')], { input: JSON.stringify({ hook_event_name: event, session_id: sid }), encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } }).stdout.trim();
  const hasSystemNode = ['/usr/bin/node', '/bin/node'].some(p => existsSync(p));
  if (!hasSystemNode) {
    assert.equal(run('zzz-999'), '{}');
    assert.equal(JSON.parse(run('abc-123')).hookSpecificOutput.permissionDecision, 'deny');
    assert.match(JSON.parse(run('abc-123', 'Stop')).systemMessage, /TEAMQA_HOOK_NODE_MISSING/);
  }
  writeFileSync(join(registry, '.node'), process.execPath + '\n');
  assert.equal(run('abc-123'), '{"from":"node"}');
});

test('C4: the plugin hooks are the Claude hooks of stage-hooks, run through the gate', () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, 'scripts/plugin/hooks.json'), 'utf8'));
  const staged = hookDefinition({ registryDir: '/r', nodePath: '/usr/bin/node', host: 'claude' });
  const shape = doc => Object.fromEntries(Object.entries(doc.hooks).map(([event, groups]) => [event, groups.map(g => ({ matcher: g.matcher ?? null, timeouts: g.hooks.map(h => h.timeout) }))]));
  assert.deepEqual(shape(plugin), shape(staged));
  for (const groups of Object.values(plugin.hooks)) for (const g of groups) for (const h of g.hooks)
    assert.deepEqual([h.type, h.command, h.args], ['command', '/bin/sh', ['${CLAUDE_PLUGIN_ROOT}/skills/team-qa/scripts/plugin/plugin-gate.sh']]);
});

test('C3/C6: the plugin manifest, README and command that Team QA ships', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts/plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'team-qa');
  assert.equal(manifest.version, '{{VERSION}}');
  assert.equal(manifest.author.name, 'Agent Pro');
  assert.ok(!('license' in manifest), 'no licence is chosen yet');
  const readme = readFileSync(join(ROOT, 'scripts/plugin/README.md'), 'utf8');
  const prose = readme.replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean);
  assert.ok(prose.length >= 40, 'the directory needs 40 words outside code blocks');
  assert.match(readme, /\/plugin install team-qa@agentpro/);
  assert.match(readme, /sends nothing to Agent Pro/);
  const bin = readFileSync(join(ROOT, 'scripts/plugin/teamqa'), 'utf8');
  assert.match(bin, /^#!\/bin\/sh\n/);
  assert.match(bin, /skills\/team-qa\/scripts\/teamqa\.mjs/);
  const noNode = spawnSync('/bin/sh', [join(ROOT, 'scripts/plugin/teamqa'), '--help'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  if (!existsSync('/opt/homebrew/bin/node') && !existsSync('/usr/local/bin/node')) {
    assert.equal(noNode.status, 127);
    assert.match(noNode.stderr, /needs Node\.js 20 or later/);
  }
});

// L6: a blank line in the hygiene id list matched every line, so every plugin build failed PLUGIN_PERSONAL_ID.
test('the plugin build ignores blank and comment lines of the hygiene id list', async () => {
  const { mkdirSync: mkdir, mkdtempSync: mkdtemp, readFileSync: read, writeFileSync: write } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { spawnSync: run } = await import('node:child_process');
  const script = read(new URL('../../scripts/release-plugin.sh', import.meta.url), 'utf8');
  const start = script.indexOf('IDS="${TEAMQA_HYGIENE_IDS'), end = script.indexOf('\nif command -v claude', start);
  assert.ok(start > 0 && end > start, 'the hygiene block of release-plugin.sh');
  const dir = mkdtemp(joinPath(tmp(), 'teamqa-plugin-ids-')), out = joinPath(dir, 'out'), work = joinPath(dir, 'work');
  for (const sub of ['.claude-plugin', 'bin', 'hooks']) mkdir(joinPath(out, sub), { recursive: true });
  mkdir(work);
  write(joinPath(out, '.claude-plugin', 'plugin.json'), '{"name":"team-qa"}\n');
  write(joinPath(out, 'README.md'), '# Team QA\n\nA plugin.\n');
  write(joinPath(out, 'bin', 'teamqa'), '#!/bin/sh\n');
  write(joinPath(out, 'hooks', 'hooks.json'), '{}\n');
  const ids = joinPath(dir, 'ids.txt');
  write(ids, '\n# the owner list\nexample-handle   # a handle\n   \n');
  const check = () => run('bash', ['-c', `set -euo pipefail; OUT=${JSON.stringify(out)}; WORK=${JSON.stringify(work)}\n${script.slice(start, end)}\necho HYGIENE_OK`], { encoding: 'utf8', env: { ...process.env, TEAMQA_HYGIENE_IDS: ids } });
  const clean = check();
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /HYGIENE_OK/);
  write(joinPath(out, 'README.md'), '# Team QA\n\nBuilt by Example-Handle.\n');
  const leaked = check();
  assert.equal(leaked.status, 4);
  assert.match(leaked.stderr, /PLUGIN_PERSONAL_ID/);
});
