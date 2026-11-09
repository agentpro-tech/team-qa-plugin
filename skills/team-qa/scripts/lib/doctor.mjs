// `teamqa doctor` (BA public v1, T2): checks what a machine needs to run Team QA, in order, and stops at the first
// thing that is missing. Every finding carries a code and an action an agent can act on without parsing prose, and a
// short instruction for the person. Requirements come from scripts/requirements.json. The doctor reads; it installs nothing, starts nothing and prints no secret.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareVersions, dragonStatusVerdict, readRequirements } from './dragon-requirements.mjs';
import { dragonStatusUrl, defaultDragonRuntimeDir } from './dragon-endpoint.mjs';
import { loadOwnerGrant } from './owner-grant.mjs';
import { loadLicense } from './license.mjs';
import { scrollRoot } from './core.mjs';
import { collectRunSecrets, maskSecrets } from './test-secrets.mjs';
import { PLUGIN_ID, TEAMQA_ROOT, claudeSettingsFiles, installMode, runtimeReleaseUrl, siblingSkillRoot } from './install-layout.mjs';

export const DOCTOR_SCHEMA = 'team-qa/doctor/v1';

// What each action means for a person. Actions that need a release channel name it as not published yet, rather
// than pointing at something that does not exist.
// In the Claude Code plugin (BA plugin C2, C5) the suite is the plugin and the runtime comes from the release page.
export function actionHelp(action, req, { runtimeUrl = null, plugin = false } = {}) {
  const store = req?.dragon?.store_url ?? 'the Chrome Web Store page of Dragon Browser';
  if (plugin && action === 'install_suite') return `Reinstall the Team QA plugin; it holds Team QA, QA GUI and QA Code together: /plugin uninstall ${PLUGIN_ID}, then /plugin install ${PLUGIN_ID}.`;
  if (runtimeUrl && action === 'install_runtime') return `Install the signed Dragon runtime of this release: teamqa dragon install --from ${runtimeUrl}; then run teamqa doctor again.`;
  if (runtimeUrl && action === 'update_runtime') return `Install the signed Dragon runtime of this release: teamqa dragon install --from ${runtimeUrl}; the current runtime is kept for rollback.`;
  return {
    update_node: `Install Node.js ${req?.node?.min ?? ''} or later, then run teamqa doctor again.`,
    install_scroll: 'Team QA cannot find the SCROLL runtime it ships with (vendor/scroll). Reinstall the signed suite (teamqa suite install --dir <suite>, or teamqa update), or set TEAMQA_SCROLL_ROOT to a SCROLL copy.',
    install_suite: 'Install the signed Team QA suite (teamqa suite install --dir <suite>, or teamqa update); it installs Team QA, QA GUI and QA Code together.',
    install_runtime: 'Install the signed Dragon runtime: teamqa dragon install --from <dragon-runtime package, its https URL, or the Team QA suite folder>; then run teamqa doctor again.',
    start_runtime: 'The Dragon runtime is installed but not answering. Start it with: node ~/.dragon-browser/runtime/current/tools/macos-service.mjs status (then install or restart as it says).',
    update_runtime: 'Install the newer signed Dragon runtime: teamqa dragon install --from <package, URL or suite folder>; the current release is kept for rollback.',
    install_extension: `Open ${store} in Chrome and click "Add to Chrome".`,
    update_extension: 'Chrome updates the Store extension on its own within a few hours; to update now open chrome://extensions, turn on Developer mode and click Update.',
    pair: 'Open the Dragon Browser extension options and click Connect, then allow it once in the dialog on your Mac (an extension without the Connect button: paste the token from ~/.dragon-browser/auth/token there).',
    update_teamqa: 'This Dragon is newer than this Team QA supports. Update Team QA.',
    install_host: 'Install Claude Code or Codex; Team QA runs inside one of them.',
    use_supported_platform: 'Team QA supports macOS for now.',
  }[action] ?? '';
}

function realDeps(env = process.env) {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    env,
    home: homedir(),
    exists: existsSync,
    realpath: realpathSync,
    readText: path => readFileSync(path, 'utf8'),
    teamqaRoot: TEAMQA_ROOT,
    cwd: process.cwd(),
    scrollRoot: () => scrollRoot(env),
    readJson: path => JSON.parse(readFileSync(path, 'utf8')),
    which: name => { const r = spawnSync('/usr/bin/which', [name], { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? r.stdout.trim() : null; },
    fetchStatus: url => {
      const r = spawnSync('/usr/bin/curl', ['--fail', '--silent', '--max-time', '3', url], { encoding: 'utf8', timeout: 5000 });
      if (r.status !== 0) return { reachable: false };
      try { return { reachable: true, body: JSON.parse(r.stdout) }; } catch { return { reachable: true, body: null }; }
    },
    // The bridge's own method list, through QA GUI's RPC client (which holds the token handling). No token is read here.
    // Team QA's own provenance check of a child skill (roster.mjs). Loaded lazily: it is the heaviest import here.
    verifyProvider: async skill => { const { verifyProviderInterface } = await import('./roster.mjs'); verifyProviderInterface({ skill }); },
    ownerGrant: () => loadOwnerGrant(),
    license: () => loadLicense(),
    // The update notice reads the channel at most once a day (the answer is cached); no channel set means no network.
    updateCheck: async () => { const { channelFrom, checkUpdate } = await import('./suite.mjs'); return checkUpdate({ channel: channelFrom({ env }), useCache: true }); },
    fetchMethods: guiRoot => {
      const r = spawnSync(process.execPath, [join(guiRoot, 'scripts/qa_do.mjs'), '--method', 'help'], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      if (r.status !== 0) return null;
      try { const raw = JSON.parse(r.stdout); const list = (raw.result ?? raw).rpcMethods; return Array.isArray(list) ? list.map(m => m?.name).filter(Boolean) : null; } catch { return null; }
    },
  };
}

// QA GUI and QA Code next to this Team QA (install.sh or the plugin), or ~/.agents/skills for a source checkout (C1).
function skillRoot(name, deps) {
  return siblingSkillRoot(name, { root: deps.teamqaRoot, env: deps.env, home: deps.home, exists: deps.exists, realpath: deps.realpath });
}

// Notes on how Team QA is installed (C2). They inform and never block: a second install of Team QA, and a hook staged
// by `continuation stage-hooks` while the plugin's own hooks run (two hooks on one event refuse the call as a duplicate).
function installNotes(deps) {
  const layout = installMode(deps.teamqaRoot, { exists: deps.exists, readText: deps.readText, realpath: deps.realpath });
  const notes = [];
  const where = layout.mode === 'plugin' ? `plugin ${PLUGIN_ID} ${layout.plugin.version ?? ''} (${layout.plugin.root})`.replace('  ', ' ')
    : layout.mode === 'skills' ? `skills ${dirname(layout.root)}` : `source checkout ${layout.root}`;
  notes.push({ id: 'install', status: 'info', detail: where });
  const skillsInstall = join(deps.home, '.agents', 'skills', 'team-qa', 'SOURCE.json');
  const configDir = deps.env.CLAUDE_CONFIG_DIR || join(deps.home, '.claude');
  const pluginInstalled = () => { try { return deps.readText(join(configDir, 'plugins', 'installed_plugins.json')).includes(`"${PLUGIN_ID}"`); } catch { return false; } };
  // Claude Code loads Team QA twice only when its own skills folder also holds team-qa (the suite installer's link). A
  // suite install in ~/.agents/skills that only Codex links to sits beside the plugin without a clash.
  const claudeSkill = join(configDir, 'skills', 'team-qa');
  const loadedTwice = () => { try { return deps.exists(claudeSkill); } catch { return false; } };
  if ((layout.mode === 'plugin' || (layout.mode === 'skills' && pluginInstalled())) && loadedTwice())
    notes.push({ id: 'duplicate-install', status: 'warn', code: 'DUPLICATE_INSTALL',
      detail: `Team QA is installed twice for Claude Code: as the plugin ${PLUGIN_ID} and as ${claudeSkill}; Claude Code loads both`,
      help: `Keep one for Claude Code. Remove the plugin with /plugin uninstall ${PLUGIN_ID}, or move the team-qa, qa-gui and qa-code links out of ${join(configDir, 'skills')}; Codex keeps using ~/.agents/skills.` });
  else if (layout.mode === 'plugin' && deps.exists(skillsInstall))
    notes.push({ id: 'codex-install', status: 'info', detail: 'a suite install in ~/.agents/skills serves Codex; Claude Code uses the plugin' });
  if (layout.mode === 'plugin') {
    // The plugin's hooks and command come from this signed Team QA (scripts/plugin); any other copy is not ours.
    const drift = [['hooks/hooks.json', 'scripts/plugin/hooks.json'], ['bin/teamqa', 'scripts/plugin/teamqa']].filter(([inPlugin, signed]) => {
      try { return deps.readText(join(layout.plugin.root, inPlugin)) !== deps.readText(join(layout.root, signed)); } catch { return true; } }).map(([inPlugin]) => inPlugin);
    if (drift.length) notes.push({ id: 'plugin-files', status: 'warn', code: 'PLUGIN_FILES_DRIFT',
      detail: `${drift.join(' and ')} of the plugin differ from the signed copy in skills/team-qa/scripts/plugin`,
      help: `Reinstall the plugin: /plugin uninstall ${PLUGIN_ID}, then /plugin install ${PLUGIN_ID}.` });
    const staged = claudeSettingsFiles({ env: deps.env, home: deps.home, cwd: deps.cwd }).filter(path => {
      try { return deps.exists(path) && deps.readText(path).includes('qa-lifecycle.mjs'); } catch { return false; } });
    if (staged.length) notes.push({ id: 'hooks', status: 'warn', code: 'HOOKS_TWICE',
      detail: `a Team QA hook staged earlier is still in ${staged.join(', ')}, and the plugin runs the same hooks`,
      help: 'Remove the qa-lifecycle.mjs entries from that settings file; with both, every tool call of a registered run is refused as a duplicate.' });
  }
  return { layout, notes };
}

function skillVersion(root, deps) {
  for (const file of ['SOURCE.json', 'package-manifest.json']) {
    const path = join(root, file);
    if (deps.exists(path)) { try { const v = deps.readJson(path).version; if (typeof v === 'string') return v; } catch { /* next */ } }
  }
  const versionFile = join(root, 'VERSION');
  if (deps.exists(versionFile)) { try { return readFileSync(versionFile, 'utf8').trim(); } catch { /* none */ } }
  return null;
}

export async function doctorChecks(overrides = {}) {
  const deps = { ...realDeps(overrides.env), ...overrides };
  const req = overrides.requirements ?? readRequirements();
  const install = installNotes(deps);
  const plugin = install.layout.mode === 'plugin';
  const helpContext = { plugin, runtimeUrl: plugin && install.layout.plugin.version ? runtimeReleaseUrl(install.layout.plugin.version) : null };
  const checks = [];
  let blocked = false;
  const add = (id, result) => {
    if (blocked) { checks.push({ id, status: 'skipped' }); return; }
    const entry = { id, ...result };
    if (entry.status === 'fail') { entry.help = actionHelp(entry.action, req, helpContext); blocked = true; }
    checks.push(entry);
  };
  const fail = (code, detail, action) => ({ status: 'fail', code, detail, action });

  add('platform', req.platforms.includes(deps.platform) ? { status: 'ok', detail: deps.platform }
    : fail('PLATFORM_UNSUPPORTED', `this machine is ${deps.platform}; supported: ${req.platforms.join(', ')}`, 'use_supported_platform'));
  add('node', compareVersions(deps.nodeVersion, req.node.min) >= 0 ? { status: 'ok', detail: deps.nodeVersion }
    : fail('NODE_TOO_OLD', `Node.js ${deps.nodeVersion} is older than ${req.node.min}`, 'update_node'));
  const scroll = deps.scrollRoot();
  add('scroll', deps.exists(join(scroll, 'lib', 'effects.js')) ? { status: 'ok', detail: scroll }
    : fail('SCROLL_MISSING', `no SCROLL runtime at ${scroll}`, 'install_scroll'));
  const hosts = ['claude', 'codex'].map(name => [name, deps.which(name)]).filter(([, path]) => path);
  add('host', hosts.length ? { status: 'ok', detail: hosts.map(([n]) => n).join(', ') }
    : fail('HOST_MISSING', 'neither claude nor codex is on PATH', 'install_host'));

  let guiRoot = null;
  for (const [name, range] of Object.entries(req.skills || {})) {
    const root = skillRoot(name, deps), version = deps.exists(root) ? skillVersion(root, deps) : null;
    if (name === 'qa-gui' && version) guiRoot = root;
    add(name, !version ? fail('SKILL_MISSING', `${name} is not installed at ${root}`, 'install_suite')
      : compareVersions(version, range.min) < 0 ? fail('SKILL_TOO_OLD', `${name} ${version} is older than ${range.min}`, 'install_suite')
      : { status: 'ok', detail: `${name} ${version}` });
    if (!blocked) {
      let problem = null;
      try { await deps.verifyProvider(name); } catch (error) { problem = error?.code ?? String(error?.message ?? error).split(/\s/)[0]; }
      add(`${name}-provenance`, problem ? fail('SKILL_PROVENANCE', `${name} failed Team QA's provenance check: ${problem}`, 'install_suite')
        : { status: 'ok', detail: `${name} provenance verified` });
    }
  }

  const url = dragonStatusUrl(deps.env), runtimeDir = defaultDragonRuntimeDir();
  const status = blocked ? null : deps.fetchStatus(url);
  if (!blocked && !status.reachable) {
    const installed = deps.exists(join(runtimeDir, 'package.json'));
    add('dragon-runtime', installed ? fail('DRAGON_RUNTIME_NOT_RUNNING', `no answer from ${url}; a runtime is installed at ${runtimeDir}`, 'start_runtime')
      : fail('DRAGON_RUNTIME_MISSING', `no answer from ${url} and no runtime at ${runtimeDir}`, 'install_runtime'));
  } else if (!blocked) {
    const grant = deps.ownerGrant();
    const verdict = dragonStatusVerdict(status.body, req.dragon, { ownerGrant: grant });
    if (verdict.ok) add('dragon', { status: 'ok', detail: `runtime ${verdict.bridge}, extension ${verdict.extension}${verdict.extensionId ? ` (${verdict.extensionId})` : ''}${verdict.grant_id ? `, unpacked under owner grant ${verdict.grant_id}` : ''}` });
    else add('dragon', fail(verdict.code, verdict.detail, verdict.action));
  } else add('dragon', {});

  if (!blocked) {
    const methods = guiRoot ? deps.fetchMethods(guiRoot) : null;
    const missing = methods ? req.dragon.rpc.filter(m => !methods.includes(m)) : [];
    add('dragon-rpc', !methods ? { status: 'unverified', detail: 'the bridge method list could not be read; the version check above still holds' }
      : missing.length ? fail('DRAGON_RPC_MISSING', `the bridge lacks ${missing.join(', ')}`, 'update_runtime')
      : { status: 'ok', detail: `${req.dragon.rpc.length} required methods present` });
  } else add('dragon-rpc', {});

  // Notes (public v1, S1 and R3) inform and never block: the licence (not needed while Team QA is free) and whether a
  // newer suite is published on the update channel.
  const notes = [];
  const lic = deps.license();
  notes.push({ id: 'license', status: 'info', detail: lic.ok ? `${lic.license.plan} plan for ${lic.license.email}, until ${lic.license.expires_at.slice(0, 10)}`
    : `no valid licence (${lic.code}); not needed while Team QA is free` });
  let upd; try { upd = plugin ? { status: 'plugin' } : await deps.updateCheck(); } catch (error) { upd = { status: 'unreachable', code: error?.code ?? 'UPDATE_CHECK_ERROR' }; }
  notes.push({ id: 'update', status: 'info', detail: upd.status === 'plugin' ? `Claude Code updates the plugin: /plugin update ${PLUGIN_ID}, or turn on auto-update for the agentpro marketplace in /plugin`
    : upd.status === 'available' ? `Team QA ${upd.latest} is published (installed ${upd.installed ?? 'none'}); run teamqa update`
    : upd.status === 'up_to_date' ? `Team QA ${upd.installed} is the latest published`
    : upd.status === 'no_channel' ? 'no update channel set (TEAMQA_CHANNEL or ~/.agentpro/teamqa/config.json)'
    : `the update channel could not be read (${upd.code})` });
  notes.push(...install.notes);

  const first = checks.find(c => c.status === 'fail') ?? null;
  return { schema: DOCTOR_SCHEMA, ok: !first, checks, notes, first_failure: first ? { id: first.id, code: first.code, action: first.action } : null };
}

export function renderDoctor(report) {
  const lines = [];
  for (const c of report.checks) {
    const tag = { ok: 'OK  ', fail: 'FAIL', skipped: 'SKIP', unverified: 'WARN' }[c.status] ?? '    ';
    lines.push(`${tag} ${c.id}${c.detail ? `: ${c.detail}` : ''}`);
    if (c.status === 'fail') { lines.push(`     ${c.code} → ${c.action}`); if (c.help) lines.push(`     ${c.help}`); }
  }
  for (const n of report.notes ?? []) {
    lines.push(`${n.status === 'warn' ? 'WARN' : 'INFO'} ${n.id}: ${n.detail}`);
    if (n.status === 'warn') { lines.push(`     ${n.code}`); if (n.help) lines.push(`     ${n.help}`); }
  }
  return lines.join('\n');
}

// The diagnostic bundle (public v1, S7): what support needs to see, with secrets taken out before anything is
// written. Values under a secret-looking key are dropped whole; token, key and e-mail shapes are masked anywhere;
// the home folder becomes ~; the run's test-account passwords (S6) are masked too. The bundle copies no credential,
// account or transcript file.
const SECRET_KEY = /pass(word)?|secret|token|cookie|authori[sz]ation|api[_-]?key|nonce|credential|session[_-]?key|private/i;
const SECRET_VALUE = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[token]'], [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[token]'], [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[token]'], [/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer [token]'], [/\b[a-f0-9]{64}\b(?=[^\n]*\b(?:token|secret)\b)/gi, '[token]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];
export function redact(value, { home = homedir() } = {}) {
  const homeRe = home && home.length > 1 ? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : null;
  const clean = v => {
    if (typeof v === 'string') { let t = homeRe ? v.replace(homeRe, '~') : v; for (const [re, mask] of SECRET_VALUE) t = t.replace(re, mask); return t; }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[redacted]' : clean(x)]));
    return v;
  };
  return clean(value);
}

function readIfSmall(path, limit = 256 * 1024) {
  try { const text = readFileSync(path, 'utf8'); return text.length <= limit ? JSON.parse(text) : { omitted: `larger than ${limit} bytes` }; } catch { return null; }
}

export async function diagnosticBundle({ run = null, runsDir = join(process.cwd(), 'runs'), overrides = {} } = {}) {
  const deps = { ...realDeps(overrides.env), ...overrides };
  const report = await doctorChecks(overrides);
  const teamqa = readIfSmall(fileURLToPath(new URL('../../SOURCE.json', import.meta.url)));
  const version = cmd => { const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 8000 }); return r.status === 0 ? r.stdout.trim().split('\n')[0] : null; };
  const status = deps.fetchStatus(dragonStatusUrl(deps.env));
  const bundle = {
    schema: 'team-qa/diagnostics/v1', created_at: new Date().toISOString(),
    teamqa: teamqa ? { version: teamqa.version, commit: teamqa.commit, built_at: teamqa.built_at } : { version: readIfSmall(fileURLToPath(new URL('../../package-files.json', import.meta.url)))?.version ?? null },
    platform: deps.platform, node: deps.nodeVersion,
    hosts: Object.fromEntries(['claude', 'codex'].map(name => [name, deps.which(name) ? (overrides.hostVersion ?? version)(name) : null])),
    doctor: report,
    dragon_status: status.reachable ? status.body : null,
  };
  let secrets = [];
  if (run) {
    const dir = join(runsDir, String(run).replace(/[^A-Za-z0-9._-]/g, '_'));
    bundle.run = { id: run, present: existsSync(dir) };
    if (bundle.run.present) {
      for (const name of ['phase.json', 'roster.json', 'board-delivery.json', 'summary.json']) {
        const doc = readIfSmall(join(dir, name)); if (doc) bundle.run[name] = doc;
      }
      secrets = collectRunSecrets(dir).secrets;
    }
  }
  return JSON.parse(maskSecrets(JSON.stringify(redact(bundle, { home: deps.home })), secrets));
}

export async function doctorCommand(args = []) {
  const at = args.indexOf('--bundle');
  if (at >= 0) {
    const out = args[at + 1];
    if (!out || out.startsWith('--')) { console.error('teamqa doctor --bundle <file.json> [--run <id>]'); process.exitCode = 2; return; }
    const runAt = args.indexOf('--run');
    const bundle = await diagnosticBundle({ run: runAt >= 0 ? args[runAt + 1] : null });
    writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600 });
    console.log(`verdict=pass DOCTOR_BUNDLE path=${out} redacted=true`);
    return;
  }
  const report = await doctorChecks();
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderDoctor(report));
  const f = report.first_failure;
  console.log(report.ok ? 'verdict=pass DOCTOR ready=true' : `verdict=ungraded DOCTOR ready=false code=${f.code} action=${f.action}`);
  if (!report.ok) process.exitCode = 3;
}
