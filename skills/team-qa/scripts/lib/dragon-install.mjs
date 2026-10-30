// `teamqa dragon install` (BA public v1, D1 and T2): install the Dragon runtime from its signed package on a machine
// that has no DragonOS repository. Team QA checks the package itself before any of its code runs: the Ed25519
// signature over the exact bytes against the Dragon release key in scripts/requirements.json, the key fingerprint,
// every file digest, the package kind ("runtime") and a version inside the bridge range Team QA supports. Only then is
// it extracted into a fresh folder and handed to that package's own installer (tools/macos-service.mjs install), which
// keeps the previous release for rollback and starts the bridge with the manual destructive policy unless the user
// already chose otherwise.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inRange, readRequirements } from './dragon-requirements.mjs';

const SCHEMA = 'dragon-browser-rc/v1';
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const die = (code, detail = '') => { throw Object.assign(new Error(`${code}${detail ? ` ${detail}` : ''}`), { code }); };

export function verifyDragonRuntime(artifactPath, signaturePath = artifactPath + '.sig.json', { requirements = readRequirements() } = {}) {
  const key = requirements.dragon?.runtime;
  if (!key) die('DRAGON_RUNTIME_KEY_MISSING', 'scripts/requirements.json has no dragon.runtime key');
  if (!existsSync(artifactPath)) die('DRAGON_RUNTIME_PACKAGE_MISSING', artifactPath);
  if (!existsSync(signaturePath)) die('DRAGON_RUNTIME_SIGNATURE_MISSING', signaturePath);
  const publicKey = createPublicKey(key.public_key_pem);
  if ('sha256:' + sha256(publicKey.export({ type: 'spki', format: 'der' })) !== key.fingerprint) die('DRAGON_RUNTIME_KEY_INVALID');
  const bytes = readFileSync(artifactPath);
  let sig;
  try { sig = JSON.parse(readFileSync(signaturePath, 'utf8')); } catch { die('DRAGON_RUNTIME_SIGNATURE_SHAPE'); }
  if (sig?.algorithm !== 'Ed25519' || typeof sig.value !== 'string' || sig.publicKeyFingerprint !== key.fingerprint) die('DRAGON_RUNTIME_WRONG_KEY');
  let good = false;
  try { good = verify(null, bytes, publicKey, Buffer.from(sig.value, 'base64')); } catch { good = false; }
  if (!good) die('DRAGON_RUNTIME_SIGNATURE', 'the package is not the one Dragon signed');
  let body;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { die('DRAGON_RUNTIME_SHAPE'); }
  if (body?.schema !== SCHEMA || body.kind !== 'runtime' || !Array.isArray(body.files)) die('DRAGON_RUNTIME_KIND', 'this signed bundle is not a Dragon runtime package');
  const range = inRange(String(body.version), requirements.dragon.bridge);
  if (range !== 'ok') die(range === 'old' ? 'DRAGON_RUNTIME_PACKAGE_OLD' : 'DRAGON_RUNTIME_PACKAGE_UNSUPPORTED', `${body.version} (Team QA needs ${requirements.dragon.bridge.min} up to below ${requirements.dragon.bridge.below})`);
  for (const f of body.files) {
    const raw = Buffer.from(String(f.data || ''), 'base64');
    if (raw.length !== Number(f.bytes) || 'sha256:' + sha256(raw) !== f.sha256) die('DRAGON_RUNTIME_FILE_DIGEST', String(f.path));
    const rel = normalize(String(f.path || ''));
    if (!f.path || isAbsolute(String(f.path)) || rel === '..' || rel.startsWith('..' + sep) || rel.split(/[\\/]/).includes('..')) die('DRAGON_RUNTIME_PATH', String(f.path));
  }
  for (const required of ['server.js', 'package.json', 'tools/macos-service.mjs']) if (!body.files.some(f => f.path === required)) die('DRAGON_RUNTIME_SHAPE', `missing ${required}`);
  return { version: body.version, build: body.build ?? null, files: body.files, packageHash: 'sha256:' + sha256(bytes) };
}

export function extractDragonRuntime(verified, outputDir = mkdtempSync(join(tmpdir(), `dragon-runtime-${verified.version}-`))) {
  for (const f of verified.files) {
    const target = resolve(outputDir, normalize(f.path));
    if (!target.startsWith(resolve(outputDir) + sep)) die('DRAGON_RUNTIME_PATH', f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(String(f.data), 'base64'));
  }
  return outputDir;
}

// A source is a package file, an https URL, or a suite folder that carries one (dragon-runtime-*.dbrc).
export function locateDragonRuntime(source, { fetchFile = curlFetch } = {}) {
  if (/^https:\/\//.test(source)) {
    const dir = mkdtempSync(join(tmpdir(), 'dragon-runtime-download-')), name = basename(new URL(source).pathname) || 'dragon-runtime.dbrc';
    fetchFile(source, join(dir, name));
    fetchFile(source + '.sig.json', join(dir, name + '.sig.json'));
    return join(dir, name);
  }
  const path = resolve(source);
  if (existsSync(join(path, 'suite.json'))) {
    const suite = JSON.parse(readFileSync(join(path, 'suite.json'), 'utf8'));
    if (!suite.dragon_runtime?.file) die('DRAGON_RUNTIME_NOT_IN_SUITE', 'this suite carries no Dragon runtime package');
    return join(path, basename(suite.dragon_runtime.file));
  }
  return path;
}
function curlFetch(url, dest) {
  const r = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '300', '--output', dest, url], { encoding: 'utf8' });
  if (r.status !== 0) die('DRAGON_RUNTIME_DOWNLOAD', url);
}

export function installDragonRuntime({ source, platform = process.platform, run = spawnSync, requirements = readRequirements(), dryRun = false, log = () => {} } = {}) {
  if (!source) die('DRAGON_RUNTIME_SOURCE', 'give --from <package file | https url | suite folder>');
  if (platform !== 'darwin') die('DRAGON_PLATFORM_UNSUPPORTED', `${platform}; the Dragon runtime runs as a macOS LaunchAgent`);
  const artifactPath = locateDragonRuntime(source);
  const verified = verifyDragonRuntime(artifactPath, artifactPath + '.sig.json', { requirements });
  log(`verified Dragon runtime ${verified.version} (${verified.packageHash})`);
  const dir = extractDragonRuntime(verified);
  const args = [join(dir, 'tools', 'macos-service.mjs'), 'install', '--source', dir, ...(verified.build ? ['--build', verified.build] : []), ...(dryRun ? ['--dry-run'] : [])];
  const r = run(process.execPath, args, { encoding: 'utf8', timeout: 180000 });
  if (r.status !== 0) die('DRAGON_RUNTIME_INSTALL_FAILED', String(r.stderr || r.stdout || '').trim().split('\n').at(-1) ?? '');
  return { version: verified.version, build: verified.build, source: dir, output: String(r.stdout || '').trim() };
}

export function dragonCommand(action, args = []) {
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (action === 'verify') {
    const file = locateDragonRuntime(flag('--from'));
    const v = verifyDragonRuntime(file);
    console.log(`verdict=pass DRAGON_RUNTIME_VERIFIED version=${v.version} build=${v.build ?? 'none'} files=${v.files.length}`);
    return;
  }
  if (action === 'install') {
    const r = installDragonRuntime({ source: flag('--from'), dryRun: args.includes('--dry-run'), log: line => console.log(line) });
    console.log(`verdict=pass DRAGON_RUNTIME_INSTALLED version=${r.version} build=${r.build ?? 'none'}${args.includes('--dry-run') ? ' dry_run=true' : ''}`);
    return;
  }
  console.log('teamqa dragon verify|install --from <dragon-runtime-x.y.z.dbrc | https url | suite folder> [--dry-run]');
  process.exitCode = 2;
}
