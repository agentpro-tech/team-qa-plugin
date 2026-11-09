// The Team QA suite (BA public v1, R1, R2, R3): one signed bundle of the three release envelopes (QA Code, QA GUI,
// Team QA), installed by one command, published to a channel, and updated from it.
//
//   suite build   (owner)  three release zips → suite.json + suite.sig.json + the zips, each skill entry signed
//   suite verify           the suite signature, every zip's sha256 and every skill signature against its SOURCE.json
//   suite install          verify, licence if required, run each envelope's own install.sh in dependency order, then
//                          leave release-signature.json beside each installed skill (T4 provenance)
//   suite publish (owner)  copy a suite into a channel folder and sign channel.json
//   update [--check]       read the channel, compare with the installed Team QA, install the newer suite
//
// Every signature uses the owner key (security/owner-grant-key.json holds its public half). Nothing here runs a
// command a downloaded file names: the installer runs install.sh from envelopes whose bytes the signature covers.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stableJson } from './core.mjs';
import { defaultPrivateKeyPath, PUBLIC_KEY_PATH, readPublicKey } from './owner-grant.mjs';
import { releaseEntry, signReleaseEntry, verifyReleaseSignature } from './release-signature.mjs';
import { compareVersions, readRequirements } from './dragon-requirements.mjs';
import { activateLicense, loadLicense } from './license.mjs';
import { verifyDragonRuntime } from './dragon-install.mjs';
import { sourceRepoUrl } from './source-repo.mjs';
import { PLUGIN_ID, pluginInfo, pluginRegistryDir } from './install-layout.mjs';

export const SUITE_SCHEMA = 'agentpro/teamqa-suite/v1';
export const CHANNEL_SCHEMA = 'agentpro/teamqa-channel/v1';
export const INSTALL_ORDER = ['qa-code', 'qa-gui', 'team-qa'];
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const sha256File = path => sha256(readFileSync(path));
const keyIdOf = key => sha256(createPublicKey(key).export({ type: 'spki', format: 'der' }));
const defaultWhich = name => spawnSync('/usr/bin/which', [name], { encoding: 'utf8' }).status === 0;
const die = (code, detail = '') => { throw Object.assign(new Error(`${code}${detail ? ` ${detail}` : ''}`), { code }); };

function unzip(args) {
  const r = spawnSync('unzip', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) die('SUITE_UNZIP', (r.stderr || '').split('\n')[0]);
  return r.stdout;
}
function envelopeOf(zip) {
  const names = unzip(['-Z1', zip]).split('\n').filter(Boolean);
  const folder = names[0]?.split('/')[0];
  if (!folder || !['SOURCE.json', 'install.sh', 'payload.zip'].every(f => names.includes(`${folder}/${f}`))) die('SUITE_ENVELOPE_SHAPE', basename(zip));
  return { folder, names, source: JSON.parse(unzip(['-p', zip, `${folder}/SOURCE.json`])) };
}
const PACKAGE_TOOL = fileURLToPath(new URL('../package-tool.mjs', import.meta.url));
// The envelope's own files (install.sh, verify-install.sh, SOURCE.json, the release-truth receipt and gate) ship to
// users beside the payload, so they pass the same package hygiene gate: no personal path or name, no key or token,
// English text. A release-truth receipt written in the owner's checkout names that checkout: build releases from a
// neutral folder (scripts/release-suite.sh does) or pass allowPersonalPaths for a private test build.
function envelopeHygiene(zip, { folder, names }) {
  const work = mkdtempSync(join(tmpdir(), 'teamqa-suite-envelope-'));
  const top = names.filter(n => /^[^/]+\/[^/]+$/.test(n) && n !== `${folder}/payload.zip`).map(n => n.slice(folder.length + 1));
  mkdirSync(join(work, 'e'), { recursive: true });
  for (const name of top) writeFileSync(join(work, 'e', name), spawnSync('unzip', ['-p', zip, `${folder}/${name}`], { maxBuffer: 64 * 1024 * 1024 }).stdout);
  writeFileSync(join(work, 'e', 'package-files.json'), JSON.stringify({ schema: 'agentpro/skill-package-files/v1', skill: 'envelope', version: '0.0.0', include: top }));
  const r = spawnSync(process.execPath, [PACKAGE_TOOL, 'hygiene', '--root', join(work, 'e')], { encoding: 'utf8' });
  return r.status === 0 ? [] : (r.stderr.match(/^PACKAGE_HYGIENE \S+ \S+/gm) ?? [r.stderr.trim().split('\n').at(-1)]).map(l => l.replace(/^PACKAGE_HYGIENE /, ''));
}
// The payload itself goes through Team QA's package hygiene gate (personal paths and ids, keys, tokens, internal
// files, English text), so QA GUI and QA Code ship under the same rule as Team QA.
function payloadHygiene(zip, { folder, source }) {
  const work = mkdtempSync(join(tmpdir(), 'teamqa-suite-hygiene-'));
  writeFileSync(join(work, 'payload.zip'), spawnSync('unzip', ['-p', zip, `${folder}/payload.zip`], { maxBuffer: 512 * 1024 * 1024 }).stdout);
  unzip(['-q', join(work, 'payload.zip'), '-d', join(work, 'p')]);
  // The installer refuses a payload whose manifest names another version than SOURCE.json; say so at build time.
  let manifestVersion = null;
  try { manifestVersion = JSON.parse(readFileSync(join(work, 'p', source.skill, 'package-manifest.json'), 'utf8')).version; } catch { /* reported below */ }
  if (manifestVersion !== source.version) return [`VERSION_SPLIT package-manifest.json says ${manifestVersion}, SOURCE.json says ${source.version}`];
  const r = spawnSync(process.execPath, [PACKAGE_TOOL, 'hygiene', '--root', join(work, 'p', source.skill)], { encoding: 'utf8' });
  return r.status === 0 ? [] : (r.stderr.match(/^PACKAGE_HYGIENE \S+ \S+/gm) ?? [r.stderr.trim().split('\n').at(-1)]).map(l => l.replace(/^PACKAGE_HYGIENE /, ''));
}
function signDoc(doc, privatePath) {
  if (!existsSync(privatePath)) die('SUITE_KEY_MISSING', privatePath);
  const key = createPrivateKey(readFileSync(privatePath));
  return { key_id: keyIdOf(key), sha256: sha256(stableJson(doc)), signature: sign(null, Buffer.from(stableJson(doc)), key).toString('base64') };
}
function checkDoc(doc, sig, publicKey, code) {
  if (!publicKey) die('SUITE_NO_PUBLIC_KEY');
  if (!sig || sig.key_id !== publicKey.key_id) die(`${code}_WRONG_KEY`);
  let good = false;
  try { good = verify(null, Buffer.from(stableJson(doc)), createPublicKey(publicKey.public_key_pem), Buffer.from(sig.signature, 'base64')); } catch { good = false; }
  if (!good || sig.sha256 !== sha256(stableJson(doc))) die(`${code}_SIGNATURE`);
}

// BA public v1, Q7 (proposal followed): a free user activates with an e-mail licence, so a suite asks for one unless
// it is built with licenseRequired false (--no-license). Nothing checks the licence during a run.
export function buildSuite({ releases, out, privatePath = defaultPrivateKeyPath(), licenseRequired = true, allowPersonalPaths = false, changelog = '', upgradeFrom = null, dragonRuntime = null, now = Date.now(), requirements = readRequirements() }) {
  if (upgradeFrom !== null && !/^\d+\.\d+\.\d+$/.test(upgradeFrom)) die('SUITE_UPGRADE_FROM', String(upgradeFrom));
  const skills = releases.map(zip => {
    const envelope = envelopeOf(zip), { folder, source } = envelope;
    if (!INSTALL_ORDER.includes(source.skill)) die('SUITE_SKILL_UNKNOWN', source.skill);
    if (source.repo !== sourceRepoUrl(source.skill)) die('SUITE_SOURCE_REPO', `${source.skill}: ${source.repo}`);
    const personal = allowPersonalPaths ? [] : envelopeHygiene(zip, envelope);
    if (personal.length) die('SUITE_ENVELOPE_HYGIENE', `${source.skill}: ${personal.join(', ')}`);
    const unclean = allowPersonalPaths ? [] : payloadHygiene(zip, envelope);
    if (unclean.length) die('SUITE_PAYLOAD_HYGIENE', `${source.skill}: ${unclean.join(', ')}`);
    return { skill: source.skill, version: source.version, zip: basename(zip), folder, zip_sha256: sha256File(zip), release: signReleaseEntry(releaseEntry(source), { privatePath }), path: zip };
  });
  for (const name of INSTALL_ORDER) if (skills.filter(s => s.skill === name).length !== 1) die('SUITE_SKILLS', `needs exactly one ${name}`);
  const teamqa = skills.find(s => s.skill === 'team-qa');
  for (const [name, range] of Object.entries(requirements.skills || {})) {
    const s = skills.find(x => x.skill === name);
    if (compareVersions(s.version, range.min) < 0) die('SUITE_SKILL_TOO_OLD', `${name} ${s.version} < ${range.min}`);
  }
  // The Dragon runtime package (D1) can travel with the suite; Team QA verifies it again when it installs it.
  let runtime = null;
  if (dragonRuntime) {
    if (!existsSync(dragonRuntime + '.sig.json')) die('SUITE_DRAGON_RUNTIME_SIGNATURE', basename(dragonRuntime) + '.sig.json');
    const v = verifyDragonRuntime(dragonRuntime, dragonRuntime + '.sig.json', { requirements });
    runtime = { file: basename(dragonRuntime), sha256: sha256File(dragonRuntime), signature_sha256: sha256File(dragonRuntime + '.sig.json'), version: v.version, build: v.build };
  }
  mkdirSync(out, { recursive: true });
  const suite = { schema: SUITE_SCHEMA, version: teamqa.version, created_at: new Date(now).toISOString(), license_required: Boolean(licenseRequired), requirements,
    changelog: String(changelog).slice(0, 4000), upgrade_from: upgradeFrom, ...(runtime ? { dragon_runtime: runtime } : {}),
    skills: INSTALL_ORDER.map(name => { const { path, ...entry } = skills.find(s => s.skill === name); return entry; }) };
  for (const s of skills) copyFileSync(s.path, join(out, s.zip));
  if (runtime) { copyFileSync(dragonRuntime, join(out, runtime.file)); copyFileSync(dragonRuntime + '.sig.json', join(out, runtime.file + '.sig.json')); }
  writeFileSync(join(out, 'suite.json'), JSON.stringify(suite, null, 2) + '\n');
  writeFileSync(join(out, 'suite.sig.json'), JSON.stringify(signDoc(suite, privatePath), null, 2) + '\n');
  const pub = readPublicKey();
  if (pub) writeFileSync(join(out, 'publisher-key.json'), JSON.stringify(pub, null, 2) + '\n');
  writeFileSync(join(out, 'install.sh'), BOOTSTRAP, { mode: 0o755 });
  return suite;
}

// The suite's own installer, for a machine that has no Team QA yet: it checks Node, unpacks the Team QA the suite
// carries and lets that Team QA verify every signature and install the three skills. Compare the key id it prints with
// the one published on the release page; after the first install, updates are checked with the installed key.
const BOOTSTRAP = `#!/usr/bin/env bash
# Team QA suite installer.  bash install.sh [--license <license.json>] [--dest-root <dir> --compat-root <dir>]
set -euo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd -P)"
command -v node >/dev/null || { echo 'SUITE_NODE_MISSING: install Node.js 20 or later (nodejs.org), then run this again' >&2; exit 20; }
MIN="$(node -p "require(process.argv[1]).requirements.node.min" "$HERE/suite.json")"
node -e "const [a,b]=process.argv.slice(1).map(v=>v.split('.').map(Number));process.exit(a[0]>b[0]||a[0]===b[0]&&(a[1]>b[1]||a[1]===b[1]&&a[2]>=b[2])?0:1)" "$(node -p process.versions.node)" "$MIN" || { echo "SUITE_NODE_TOO_OLD: Node.js $MIN or later is needed; nothing was installed" >&2; exit 20; }
WORK="$(mktemp -d "\${TMPDIR:-/tmp}/teamqa-suite-boot.XXXXXX")"
read -r ZIP FOLDER < <(node -p "const s=require(process.argv[1]).skills.find(x=>x.skill==='team-qa');s.zip+' '+s.folder" "$HERE/suite.json")
/usr/bin/unzip -q "$HERE/$ZIP" -d "$WORK/env" && /usr/bin/unzip -q "$WORK/env/$FOLDER/payload.zip" -d "$WORK/p"
echo "publisher key: $(node -p "require(process.argv[1]).key_id" "$WORK/p/team-qa/security/owner-grant-key.json")"
exec node "$WORK/p/team-qa/scripts/teamqa.mjs" suite install --dir "$HERE" "$@"
`;

export function verifySuite(dir, { publicKey = readPublicKey(PUBLIC_KEY_PATH) } = {}) {
  const suite = JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8'));
  if (suite.schema !== SUITE_SCHEMA || !Array.isArray(suite.skills)) die('SUITE_SHAPE');
  checkDoc(suite, JSON.parse(readFileSync(join(dir, 'suite.sig.json'), 'utf8')), publicKey, 'SUITE');
  if (JSON.stringify(suite.skills.map(s => s.skill)) !== JSON.stringify(INSTALL_ORDER)) die('SUITE_SKILLS');
  for (const s of suite.skills) {
    const zip = join(dir, s.zip);
    if (basename(s.zip) !== s.zip || !existsSync(zip)) die('SUITE_ZIP_MISSING', s.zip);
    if (sha256File(zip) !== s.zip_sha256) die('SUITE_ZIP_DRIFT', s.zip);
    const entry = verifyReleaseSignature(s.release, { publicKey });
    const { folder, source } = envelopeOf(zip);
    if (folder !== s.folder || entry.skill !== s.skill) die('SUITE_ENTRY_DRIFT', s.skill);
    for (const k of Object.keys(entry)) if (source[k] !== entry[k]) die('SUITE_SOURCE_DRIFT', `${s.skill}.${k}`);
  }
  if (suite.dragon_runtime) {
    const file = join(dir, basename(suite.dragon_runtime.file));
    if (!existsSync(file) || sha256File(file) !== suite.dragon_runtime.sha256 || !existsSync(file + '.sig.json') || sha256File(file + '.sig.json') !== suite.dragon_runtime.signature_sha256) die('SUITE_DRAGON_RUNTIME_DRIFT', suite.dragon_runtime.file);
  }
  return suite;
}

export function installSuite(dir, { destRoot = join(homedir(), '.agents/skills'), compatRoot = null, installArgs = [], allowLocalCandidate = false, publicKey = readPublicKey(PUBLIC_KEY_PATH), license = null, licenseFile = null, licensePath = undefined, platform = process.platform, nodeVersion = process.versions.node, which = defaultWhich, log = () => {} } = {}) {
  const suite = verifySuite(dir, { publicKey });
  // What the installer cannot fix stops it before any installed skill is touched (BA R2).
  const req = suite.requirements ?? {};
  if (Array.isArray(req.platforms) && !req.platforms.includes(platform)) die('SUITE_PLATFORM_UNSUPPORTED', `${platform}; supported: ${req.platforms.join(', ')}`);
  if (req.node?.min && compareVersions(nodeVersion, req.node.min) < 0) die('SUITE_NODE_TOO_OLD', `Node.js ${nodeVersion} < ${req.node.min}; nothing was installed`);
  if (licenseFile) { const v = activateLicense(licenseFile, { publicKey, ...(licensePath ? { path: licensePath } : {}) }); log(`licence ${v.license.id} (${v.license.plan}) active until ${v.license.expires_at.slice(0, 10)}`); }
  if (suite.license_required) {
    const v = license ?? loadLicense({ publicKey, ...(licensePath ? { path: licensePath } : {}) });
    if (!v.ok) die('SUITE_LICENSE_REQUIRED', `${v.code}: Team QA is free; activate with the licence file you received: bash install.sh --license <license.json> (or teamqa activate <license.json>)`);
  }
  if (!['claude', 'codex'].some(which)) log('note: neither claude nor codex is on PATH; Team QA runs inside one of them');
  // Installing anywhere but the default root needs a compat root too, or the installers would point the real
  // ~/.claude/skills and ~/.codex/skills links at the other install.
  if (destRoot !== join(homedir(), '.agents/skills') && !compatRoot) die('SUITE_COMPAT_ROOT_REQUIRED', 'an install outside ~/.agents/skills needs --compat-root as well');
  // A local-candidate envelope (an owner's test build) installs only when asked, into explicit roots (its install.sh
  // refuses the default ones); only that envelope's install.sh gets the flag.
  const candidates = suite.skills.filter(s => s.folder.endsWith('-local-candidate')).map(s => s.skill);
  if (candidates.length && !allowLocalCandidate) die('SUITE_LOCAL_CANDIDATE', `${candidates.join(', ')}: pass --allow-local-candidate with --dest-root and --compat-root`);
  const work = mkdtempSync(join(tmpdir(), 'teamqa-suite-install-'));
  // Every envelope is unpacked and its installer checked before the first one runs (M8).
  for (const s of suite.skills) {
    unzip(['-q', join(dir, s.zip), '-d', work]);
    const installer = join(work, s.folder, 'install.sh');
    if (!existsSync(installer)) die('SUITE_INSTALLER_MISSING', `${s.skill}: nothing was installed`);
    if (compatRoot && !/--compat-root\)/.test(readFileSync(installer, 'utf8'))) die('SUITE_INSTALLER_COMPAT_ROOT', `${s.skill}: its install.sh takes no --compat-root; nothing was installed`);
  }
  // One version of the suite or the one before, never a mix: each installed skill is moved aside into
  // <dest-root>/.backups before its installer runs, and when any installer fails every skill of this install goes back
  // to what was there before. The new copies are moved aside too (<skill>-failed-…); nothing is deleted.
  const exists = path => { try { lstatSync(path); return true; } catch { return false; } };
  const backups = join(destRoot, '.backups'), stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const moved = [], done = [];
  const rollBack = () => {
    for (const m of [...moved].reverse()) {
      if (exists(m.dest)) { mkdirSync(backups, { recursive: true }); renameSync(m.dest, join(backups, `${m.skill}-failed-suite-${stamp}`)); }
      if (m.previous) renameSync(m.previous, m.dest);
    }
    return moved.map(m => m.skill);
  };
  for (const s of suite.skills) {
    const target = join(destRoot, s.skill);
    let previous = null;
    if (exists(target)) { mkdirSync(backups, { recursive: true }); previous = join(backups, `${s.skill}-pre-suite-${stamp}`); renameSync(target, previous); }
    moved.push({ skill: s.skill, dest: target, previous });
    const args = [join(work, s.folder, 'install.sh'), ...(destRoot ? ['--dest-root', destRoot] : []), ...(compatRoot ? ['--compat-root', compatRoot] : []),
      ...(candidates.includes(s.skill) ? ['--allow-local-candidate', 'yes'] : []), ...installArgs];
    const r = spawnSync('bash', args, { encoding: 'utf8', timeout: 600000 });
    log(`${s.skill} ${s.version}: install.sh exit=${r.status}`);
    if (r.status !== 0) {
      const rolled = rollBack();
      die('SUITE_INSTALL_FAILED', `${s.skill}: ${(r.stderr || r.stdout || '').trim().split('\n').at(-1) ?? ''}; rolled back ${rolled.join(', ')} to the versions installed before (failed copies in ${backups})`);
    }
    try { writeFileSync(join(destRoot, s.skill, 'release-signature.json'), JSON.stringify(s.release, null, 2) + '\n'); }
    catch (error) { const rolled = rollBack(); die('SUITE_INSTALL_FAILED', `${s.skill}: ${error.code || error.message}; rolled back ${rolled.join(', ')}`); }
    done.push({ skill: s.skill, version: s.version });
  }
  if (suite.dragon_runtime) log(`Dragon runtime ${suite.dragon_runtime.version} is in this suite; teamqa doctor says whether to install it (teamqa dragon install --from ${dir})`);
  return { version: suite.version, installed: done };
}

export function publishSuite(dir, channelDir, { name = 'stable', privatePath = defaultPrivateKeyPath(), now = Date.now(), publicKey = readPublicKey(PUBLIC_KEY_PATH) } = {}) {
  const suite = verifySuite(dir, { publicKey });
  if (name === 'stable' && suite.skills.some(s => s.folder.endsWith('-local-candidate'))) die('CHANNEL_LOCAL_CANDIDATE', 'a local-candidate suite never goes to the stable channel');
  const folder = `teamqa-suite-${suite.version}`, target = join(channelDir, folder);
  if (existsSync(target)) die('CHANNEL_VERSION_EXISTS', folder);
  mkdirSync(target, { recursive: true });
  for (const f of readdirSync(dir)) if (statSync(join(dir, f)).isFile()) copyFileSync(join(dir, f), join(target, f));
  const indexPath = join(channelDir, 'channel.json');
  const prior = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : null;
  if (prior && compareVersions(suite.version, prior.latest.version) <= 0) die('CHANNEL_NOT_NEWER', `${suite.version} <= ${prior.latest.version}`);
  const latest = { version: suite.version, path: folder, suite_sha256: sha256(readFileSync(join(target, 'suite.json'))), published_at: new Date(now).toISOString(),
    upgrade_from: suite.upgrade_from ?? null, license_required: Boolean(suite.license_required), changelog: suite.changelog ?? '',
    skills: Object.fromEntries(suite.skills.map(s => [s.skill, s.version])), requirements: suite.requirements ?? null };
  const channel = { schema: CHANNEL_SCHEMA, channel: name, latest, history: [latest, ...(prior?.history ?? [])].slice(0, 50) };
  writeFileSync(indexPath, JSON.stringify(channel, null, 2) + '\n');
  writeFileSync(join(channelDir, 'channel.sig.json'), JSON.stringify(signDoc(channel, privatePath), null, 2) + '\n');
  return channel;
}

// A channel is a folder or an https URL holding channel.json, channel.sig.json and one folder per suite.
function fetchText(channel, rel) {
  if (/^https:\/\//.test(channel)) {
    const r = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '10', `${channel.replace(/\/$/, '')}/${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) die('CHANNEL_UNREACHABLE', rel);
    return r.stdout;
  }
  const path = join(resolve(channel), rel);
  if (!existsSync(path)) die('CHANNEL_UNREACHABLE', rel);
  return readFileSync(path, 'utf8');
}
function fetchFile(channel, rel, dest) {
  if (/^https:\/\//.test(channel)) {
    const r = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '300', '--output', dest, `${channel.replace(/\/$/, '')}/${rel}`], { encoding: 'utf8' });
    if (r.status !== 0) die('CHANNEL_UNREACHABLE', rel);
  } else copyFileSync(join(resolve(channel), rel), dest);
}

export function channelFrom({ flag = null, env = process.env, home = homedir() } = {}) {
  if (flag) return flag;
  if (env.TEAMQA_CHANNEL) return env.TEAMQA_CHANNEL;
  const config = join(home, '.agentpro', 'teamqa', 'config.json');
  if (existsSync(config)) { try { return JSON.parse(readFileSync(config, 'utf8')).channel ?? null; } catch { return null; } }
  return null;
}

export function readChannel(channel, { publicKey = readPublicKey(PUBLIC_KEY_PATH) } = {}) {
  const doc = JSON.parse(fetchText(channel, 'channel.json'));
  if (doc.schema !== CHANNEL_SCHEMA || !doc.latest?.version || !/^teamqa-suite-[0-9A-Za-z.+-]+$/.test(doc.latest.path || '')) die('CHANNEL_SHAPE');
  checkDoc(doc, JSON.parse(fetchText(channel, 'channel.sig.json')), publicKey, 'CHANNEL');
  return doc;
}

export function installedVersion(destRoot = join(homedir(), '.agents/skills')) {
  try { return JSON.parse(readFileSync(join(destRoot, 'team-qa', 'SOURCE.json'), 'utf8')).version; } catch { return null; }
}

// A run whose phase is not COMPLETE and that changed in the last 12 hours counts as running: a run of this folder's
// runs/, and a run in any other folder that a session registered for continuation (the bindings of the continuation
// registry, ~/.agentpro/teamqa/continuation; archived bindings do not count). An update from ~ no longer replaces the
// Team QA a run in ~/app is using (M9).
export function activeRuns(cwd = process.cwd(), now = Date.now(), { registryDir = pluginRegistryDir() } = {}) {
  const running = runDir => {
    const phase = join(runDir, 'phase.json');
    try { return JSON.parse(readFileSync(phase, 'utf8')).phase !== 'COMPLETE' && now - statSync(phase).mtimeMs < 12 * 3600000; } catch { return false; /* missing or unreadable: not counted */ }
  };
  const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
  const out = [], seen = new Set();
  const runs = join(cwd, 'runs');
  if (existsSync(runs)) for (const id of readdirSync(runs).sort()) {
    if (running(join(runs, id))) { out.push(id); seen.add(real(join(runs, id))); }
  }
  let bindings = [];
  try { bindings = readdirSync(registryDir).filter(name => name.endsWith('.json') && !name.startsWith('.')); } catch { bindings = []; }
  for (const name of bindings.sort()) {
    let binding;
    try { if (!statSync(join(registryDir, name)).isFile()) continue; binding = JSON.parse(readFileSync(join(registryDir, name), 'utf8')); } catch { continue; }
    const runDir = binding?.run_dir;
    if (typeof runDir !== 'string' || !isAbsolute(runDir) || seen.has(real(runDir)) || !running(runDir)) continue;
    seen.add(real(runDir));
    out.push(`${typeof binding.run_id === 'string' ? binding.run_id : basename(runDir)} (${runDir})`);
  }
  return out;
}

export function checkUpdate({ channel, destRoot, publicKey = readPublicKey(PUBLIC_KEY_PATH), cachePath = join(homedir(), '.agentpro', 'teamqa', 'update-check.json'), now = Date.now(), maxAgeMs = 24 * 3600000, useCache = false } = {}) {
  if (!channel) return { status: 'no_channel' };
  if (useCache && existsSync(cachePath)) {
    // A cached answer holds only while the installed version is the one it was given for (after an update it is not).
    try { const c = JSON.parse(readFileSync(cachePath, 'utf8')); if (c.channel === channel && now - Date.parse(c.checked_at) < maxAgeMs && (!Object.hasOwn(c.result ?? {}, 'installed') || c.result.installed === installedVersion(destRoot))) return c.result; } catch { /* re-check */ }
  }
  let result;
  try {
    const doc = readChannel(channel, { publicKey });
    const installed = installedVersion(destRoot);
    const newer = !installed || compareVersions(doc.latest.version, installed) > 0;
    const tooOld = newer && installed && doc.latest.upgrade_from && compareVersions(installed, doc.latest.upgrade_from) < 0;
    result = { status: tooOld ? 'reinstall_needed' : newer ? 'available' : 'up_to_date', installed, latest: doc.latest.version, path: doc.latest.path, suite_sha256: doc.latest.suite_sha256,
      ...(doc.latest.changelog ? { changelog: doc.latest.changelog } : {}), ...(tooOld ? { upgrade_from: doc.latest.upgrade_from } : {}) };
  } catch (error) { result = { status: 'unreachable', code: error.code ?? 'CHANNEL_ERROR' }; }
  try {
    let notified = null; try { notified = JSON.parse(readFileSync(cachePath, 'utf8')).notified_on ?? null; } catch { /* none */ }
    mkdirSync(join(cachePath, '..'), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ channel, checked_at: new Date(now).toISOString(), result, ...(notified ? { notified_on: notified } : {}) }) + '\n');
  } catch { /* cache is best effort */ }
  return result;
}

// The preflight notice (BA R3, L6): at most once a day, only when a channel is set; never fails and never blocks.
export function updateNotice({ channel = channelFrom(), destRoot, publicKey, cachePath = join(homedir(), '.agentpro', 'teamqa', 'update-check.json'), now = Date.now(), plugin = pluginInfo() } = {}) {
  try {
    // The plugin is updated by Claude Code, not by `teamqa update`, so the channel notice does not apply to it.
    if (!channel || plugin) return null;
    const r = checkUpdate({ channel, destRoot, ...(publicKey ? { publicKey } : {}), cachePath, now, useCache: true });
    if (!['available', 'reinstall_needed'].includes(r.status)) return null;
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')), today = new Date(now).toISOString().slice(0, 10);
    if (cache.notified_on === today) return null;
    writeFileSync(cachePath, JSON.stringify({ ...cache, notified_on: today }) + '\n');
    return r.status === 'available' ? `TEAMQA_UPDATE_AVAILABLE installed=${r.installed} latest=${r.latest} (teamqa update installs it; nothing changes until then)`
      : `TEAMQA_UPDATE_REINSTALL installed=${r.installed} latest=${r.latest} (this version is older than ${r.upgrade_from}; install the new suite with its install.sh)`;
  } catch { return null; }
}

export function applyUpdate({ channel, destRoot = join(homedir(), '.agents/skills'), compatRoot = null, installArgs = [], publicKey = readPublicKey(PUBLIC_KEY_PATH), cwd = process.cwd(), registryDir = pluginRegistryDir(), log = () => {} } = {}) {
  const busy = activeRuns(cwd, Date.now(), { registryDir });
  if (busy.length) die('UPDATE_RUN_ACTIVE', `wait for ${busy.join(', ')} to finish`);
  const check = checkUpdate({ channel, destRoot, publicKey });
  if (check.status === 'reinstall_needed') die('UPDATE_TOO_OLD', `installed ${check.installed} is older than ${check.upgrade_from}; install the ${check.latest} suite with its install.sh`);
  if (check.status !== 'available') return check;
  const work = mkdtempSync(join(tmpdir(), 'teamqa-update-'));
  for (const f of ['suite.json', 'suite.sig.json']) fetchFile(channel, `${check.path}/${f}`, join(work, f));
  // The suite fetched is the one the signed channel index names: its hash, its version, newer than the installed one.
  // A stale mirror or a wrong folder never installs an older or another suite.
  if (!/^[a-f0-9]{64}$/.test(check.suite_sha256 || '') || sha256(readFileSync(join(work, 'suite.json'))) !== check.suite_sha256) die('UPDATE_SUITE_MISMATCH', 'suite.json is not the one the signed channel index names');
  const suite = JSON.parse(readFileSync(join(work, 'suite.json'), 'utf8'));
  if (suite.version !== check.latest || (check.installed && compareVersions(suite.version, check.installed) <= 0)) die('UPDATE_SUITE_MISMATCH', `the channel folder holds ${suite.version}, not the newer ${check.latest}`);
  for (const s of suite.skills || []) { if (basename(s.zip) !== s.zip) die('SUITE_SHAPE'); fetchFile(channel, `${check.path}/${s.zip}`, join(work, s.zip)); }
  // A suite that carries the Dragon runtime is verified with it, so the update fetches it and its signature too.
  if (suite.dragon_runtime?.file) {
    const file = suite.dragon_runtime.file;
    if (basename(file) !== file) die('SUITE_SHAPE');
    fetchFile(channel, `${check.path}/${file}`, join(work, file)); fetchFile(channel, `${check.path}/${file}.sig.json`, join(work, `${file}.sig.json`));
  }
  const installed = installSuite(work, { destRoot, compatRoot, installArgs, publicKey, log });
  return { status: 'updated', from: check.installed, to: installed.version, installed: installed.installed };
}

export function suiteCommand(action, args = []) {
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const all = name => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
  const passthrough = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
  if (action === 'build') {
    const changelog = flag('--changelog') ? (existsSync(flag('--changelog')) ? readFileSync(flag('--changelog'), 'utf8') : flag('--changelog')) : '';
    const suite = buildSuite({ releases: all('--release').map(p => resolve(p)), out: resolve(flag('--out') || 'dist/suite'), licenseRequired: !args.includes('--no-license'), allowPersonalPaths: args.includes('--allow-personal-paths'), changelog, upgradeFrom: flag('--upgrade-from') ?? null, dragonRuntime: flag('--dragon-runtime') ? resolve(flag('--dragon-runtime')) : null });
    console.log(`verdict=pass SUITE_BUILT version=${suite.version} skills=${suite.skills.map(s => `${s.skill}@${s.version}`).join(',')}`);
    return;
  }
  if (action === 'verify') { const suite = verifySuite(resolve(flag('--dir') || '.')); console.log(`verdict=pass SUITE_VERIFIED version=${suite.version}`); return; }
  if (action === 'install') {
    const r = installSuite(resolve(flag('--dir') || '.'), { destRoot: flag('--dest-root') ? resolve(flag('--dest-root')) : undefined, compatRoot: flag('--compat-root') ? resolve(flag('--compat-root')) : null, installArgs: passthrough, allowLocalCandidate: args.includes('--allow-local-candidate'), licenseFile: flag('--license') ? resolve(flag('--license')) : null, log: line => console.log(line) });
    console.log(`verdict=pass SUITE_INSTALLED version=${r.version} skills=${r.installed.map(s => `${s.skill}@${s.version}`).join(',')}`);
    return;
  }
  if (action === 'publish') {
    const c = publishSuite(resolve(flag('--dir') || '.'), resolve(flag('--channel')), { name: flag('--name') || 'stable' });
    console.log(`verdict=pass CHANNEL_PUBLISHED channel=${c.channel} latest=${c.latest.version}`);
    return;
  }
  console.log('teamqa suite build --release <zip> x3 --out <dir> [--changelog <text|file>] [--upgrade-from <x.y.z>] [--dragon-runtime <dbrc>] [--no-license] [--allow-personal-paths] (owner) | verify --dir <dir> | install --dir <dir> [--license <license.json>] [--dest-root <d> --compat-root <c>] [--allow-local-candidate] [-- <install.sh flags>] | publish --dir <suite> --channel <dir> [--name stable] (owner)');
  process.exitCode = 2;
}

export function updateCommand(args = [], { plugin = pluginInfo() } = {}) {
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  // In the Claude Code plugin, Claude Code installs and updates Team QA; writing into its plugin cache would break the
  // copy it keeps (BA plugin C2). An explicit --dest-root still updates a suite install elsewhere.
  if (plugin && !flag('--dest-root')) {
    const how = `Claude Code updates the plugin: /plugin update ${PLUGIN_ID}, or turn on auto-update for the agentpro marketplace in /plugin`;
    if (args.includes('--check')) { console.log(`verdict=pass UPDATE status=plugin installed=${plugin.version ?? 'unknown'}`); console.log(how); return; }
    die('UPDATE_MANAGED_BY_PLUGIN', how);
  }
  const channel = channelFrom({ flag: flag('--channel') });
  const destRoot = flag('--dest-root') ? resolve(flag('--dest-root')) : undefined;
  if (args.includes('--check')) {
    const r = checkUpdate({ channel, destRoot });
    console.log(r.status === 'available' ? `verdict=pass UPDATE_AVAILABLE installed=${r.installed} latest=${r.latest}` : `verdict=pass UPDATE status=${r.status}${r.code ? ` code=${r.code}` : ''}${r.installed ? ` installed=${r.installed}` : ''}${r.latest ? ` latest=${r.latest}` : ''}`);
    if (r.changelog) console.log(r.changelog);
    return;
  }
  const r = applyUpdate({ channel, destRoot, compatRoot: flag('--compat-root') ? resolve(flag('--compat-root')) : null, log: line => console.log(line) });
  console.log(r.status === 'updated' ? `verdict=pass UPDATED from=${r.from} to=${r.to}` : `verdict=pass UPDATE status=${r.status}${r.code ? ` code=${r.code}` : ''}`);
}
