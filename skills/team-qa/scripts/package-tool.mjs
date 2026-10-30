#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [command, ...raw] = process.argv.slice(2);
const args = {};
for (let i = 0; i < raw.length; i += 1) {
  if (!raw[i].startsWith('--')) continue;
  const key = raw[i].slice(2);
  args[key] = raw[i + 1]?.startsWith('--') || raw[i + 1] === undefined ? true : raw[++i];
}
function fail(message, code = 2) { process.stderr.write(`package-tool: ${message}\n`); process.exit(code); }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function json(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`cannot read ${file}: ${error.message}`); }
}
function walk(root, relative, out) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) fail(`will not package a symlink: ${relative}`);
  if (stat.isFile()) { out.push(relative.split(path.sep).join('/')); return; }
  if (!stat.isDirectory()) fail(`unsupported file type: ${relative}`);
  for (const name of fs.readdirSync(absolute).sort()) {
    if (['.DS_Store', '.build', '.node-path', '.scroll', 'node_modules', 'dist'].includes(name)) continue;
    walk(root, path.join(relative, name), out);
  }
}
// `exclude` (public v1, R4): exact paths, `dir/**` for a whole folder, `*` inside one path segment.
function excluded(file, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
    const re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return re.test(file);
  });
}
function packageFiles(root) {
  const config = json(path.join(root, 'package-files.json'));
  const files = [];
  for (const item of config.include || []) {
    const normalized = path.normalize(item);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) fail(`unsafe include: ${item}`);
    if (!fs.existsSync(path.join(root, normalized))) fail(`include does not exist: ${item}`);
    walk(root, normalized, files);
  }
  const patterns = config.exclude || [];
  if (!Array.isArray(patterns) || patterns.some((x) => typeof x !== 'string' || !x || x.startsWith('/') || x.includes('..'))) fail('exclude is invalid');
  return { config, files: [...new Set(files)].filter((file) => !excluded(file, patterns)).sort() };
}

// What must never ship in a public package (public v1, R4). A finding names the file and the rule, never the
// matched text: a secret is not repeated into a build log.
const HYGIENE_RULES = [
  ['PERSONAL_PATH', /\/Users\/(?!(?:fixture|example|user|someone|me|test|runner)\b)[A-Za-z][\w.-]{2,}\//],
  ['PERSONAL_PATH', /\/home\/(?!(?:fixture|example|user|runner|node)\b)[a-z][\w.-]{2,}\//],
  ['PERSONAL_PATH', /\bDropbox\b/],
  ['PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['TOKEN', /\bsk-ant-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/],
];
// A top-level runs/ holds real run data; a runs/ folder inside a test fixture is a fixture.
const INTERNAL_FILES = [/(^|\/)[^/]*worklog[^/]*$/i, /(^|\/)ba-[^/]*\.md$/i, /^runs\//, /\.credentials(\.|$)/i, /(^|\/)accounts\.(txt|json)$/i];
// The build machine's own identity (user name, home folder name, git email), the owner's own list in
// ~/.agentpro/hygiene-ids.txt (one name, handle, address or client name per line; # starts a comment) and
// TEAMQA_HYGIENE_EXTRA, read at build time so that no one's name or address has to be written into the shipped tool.
function personalIds() {
  const ids = new Set();
  try { ids.add(os.userInfo().username); } catch { /* none */ }
  ids.add(path.basename(os.homedir()));
  const email = spawnSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8' });
  if (email.status === 0) ids.add(email.stdout.trim());
  for (const extra of String(process.env.TEAMQA_HYGIENE_EXTRA || '').split(',')) ids.add(extra.trim());
  const listFile = process.env.TEAMQA_HYGIENE_IDS || path.join(os.homedir(), '.agentpro', 'hygiene-ids.txt');
  if (fs.existsSync(listFile)) for (const line of fs.readFileSync(listFile, 'utf8').split('\n')) ids.add(line.replace(/#.*/, '').trim());
  return [...ids].filter((id) => id && id.length >= 4 && !['root', 'runner', 'user', 'node'].includes(id));
}
// Shipped code and skill text are English (public v1). Vietnamese letters are allowed only in files that
// package-files.json lists under `non_english` (a parser of Vietnamese documents and its fixtures, say). The class
// is written as escapes so that this file passes its own rule; the i flag also catches upper-case-only words.
// The character class below is the detector itself, so this file is listed under `non_english`.
const VIETNAMESE = /[\u0103\u00e2\u0111\u00ea\u00f4\u01a1\u01b0\u0102\u00c2\u0110\u00ca\u00d4\u01a0\u01af\u00e0\u00e1\u1ea3\u00e3\u1ea1\u1eb1\u1eaf\u1eb3\u1eb5\u1eb7\u1ea7\u1ea5\u1ea9\u1eab\u1ead\u00e8\u00e9\u1ebb\u1ebd\u1eb9\u1ec1\u1ebf\u1ec3\u1ec5\u1ec7\u00ec\u00ed\u1ec9\u0129\u1ecb\u00f2\u00f3\u1ecf\u00f5\u1ecd\u1ed3\u1ed1\u1ed5\u1ed7\u1ed9\u1edd\u1edb\u1edf\u1ee1\u1ee3\u00f9\u00fa\u1ee7\u0169\u1ee5\u1eeb\u1ee9\u1eed\u1eef\u1ef1\u1ef3\u00fd\u1ef7\u1ef9\u1ef5]/i;
function hygiene(root, ids = personalIds()) {
  const findings = [];
  const personal = ids.length ? new RegExp(`(?:^|[^A-Za-z0-9])(?:${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:$|[^A-Za-z0-9])`, 'i') : null;
  const config = json(path.join(root, 'package-files.json'));
  const nonEnglish = config.non_english ?? [];
  if (!Array.isArray(nonEnglish) || nonEnglish.some((x) => typeof x !== 'string' || !x || x.startsWith('/') || x.includes('..'))) fail('non_english is not a list of package paths');
  for (const file of packageFiles(root).files) {
    for (const re of INTERNAL_FILES) if (re.test(file)) findings.push({ file, rule: 'INTERNAL_FILE' });
    const bytes = fs.readFileSync(path.join(root, file));
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const [rule, re] of HYGIENE_RULES) if (re.test(text)) findings.push({ file, rule });
    if (personal?.test(text)) findings.push({ file, rule: 'PERSONAL_ID' });
    if (VIETNAMESE.test(text) && !excluded(file, nonEnglish)) findings.push({ file, rule: 'NON_ENGLISH' });
  }
  return findings;
}
function buildManifest(root) {
  const { config, files } = packageFiles(root);
  return {
    schema: 'agentpro/skill-package-manifest/v1', skill: config.skill, version: config.version,
    files: files.map((file) => {
      const absolute = path.join(root, file);
      return { path: file, sha256: sha(absolute), mode: (fs.statSync(absolute).mode & 0o777).toString(8).padStart(4, '0') };
    }),
  };
}
function verify(root, manifestFile) {
  const manifest = json(manifestFile);
  if (manifest.schema !== 'agentpro/skill-package-manifest/v1') fail('wrong manifest schema', 1);
  const seen = new Set();
  for (const entry of manifest.files || []) {
    if (!entry.path || entry.path.startsWith('/') || entry.path.split('/').includes('..') || seen.has(entry.path)) fail(`invalid manifest path: ${entry.path}`, 1);
    seen.add(entry.path);
    const absolute = path.join(root, entry.path);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) fail(`missing file: ${entry.path}`, 1);
    if (sha(absolute) !== entry.sha256) fail(`SHA mismatch: ${entry.path}`, 1);
  }
  const actual = packageFiles(root).files;
  const expected = [...seen].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`allowlist mismatch extra=[${actual.filter((x) => !seen.has(x))}] missing=[${expected.filter((x) => !actual.includes(x))}]`, 1);
  return manifest;
}
function copyManifest(root, manifestFile, destination) {
  const manifest = verify(root, manifestFile);
  for (const entry of manifest.files) {
    const target = path.join(destination, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, entry.path), target);
    fs.chmodSync(target, Number.parseInt(entry.mode, 8));
  }
}
if (command === 'manifest') {
  const root = path.resolve(String(args.root || '.'));
  const out = path.resolve(String(args.out || path.join(root, 'package-manifest.json')));
  fs.writeFileSync(out, `${JSON.stringify(buildManifest(root), null, 2)}\n`);
  process.stdout.write(`MANIFEST_WRITE=${out}\n`);
} else if (command === 'verify') {
  const root = path.resolve(String(args.root || '.'));
  const manifest = path.resolve(String(args.manifest || path.join(root, 'package-manifest.json')));
  const doc = verify(root, manifest);
  process.stdout.write(`PACKAGE_MANIFEST_PASS skill=${doc.skill} files=${doc.files.length}\n`);
} else if (command === 'copy') {
  if (!args.dest) fail('copy needs --dest');
  const root = path.resolve(String(args.root || '.'));
  const manifest = path.resolve(String(args.manifest || path.join(root, 'package-manifest.json')));
  copyManifest(root, manifest, path.resolve(String(args.dest)));
  process.stdout.write('PACKAGE_COPY_PASS\n');
} else if (command === 'source') {
  for (const key of ['out', 'skill', 'version', 'repo', 'commit', 'tree', 'manifest-sha', 'package-sha']) if (!args[key]) fail(`source is missing --${key}`);
  fs.writeFileSync(path.resolve(String(args.out)), `${JSON.stringify({
    schema: 'agentpro/skill-source/v1', skill: args.skill, version: args.version,
    repo: args.repo, commit: args.commit, tree: args.tree,
    manifest_sha256: args['manifest-sha'], package_sha256: args['package-sha'], built_at: new Date().toISOString(),
  }, null, 2)}\n`);
} else if (command === 'verify-runtime') {
  const root = path.resolve(String(args.root || '.'));
  const sourceFile = path.resolve(String(args.source || path.join(root, 'SOURCE.json')));
  const source = json(sourceFile);
  const manifestFile = path.join(root, 'package-manifest.json');
  if (source.schema !== 'agentpro/skill-source/v1') fail('wrong SOURCE schema', 1);
  if (sha(manifestFile) !== source.manifest_sha256) fail('SOURCE manifest_sha256 mismatch', 1);
  const manifest = verify(root, manifestFile);
  if (source.skill !== manifest.skill || source.version !== manifest.version) fail('SOURCE skill/version differs from the manifest', 1);
  process.stdout.write(`RUNTIME_VERIFY_PASS skill=${source.skill} commit=${source.commit} files=${manifest.files.length}\n`);
} else if (command === 'hygiene') {
  const root = path.resolve(String(args.root || '.'));
  const findings = hygiene(root);
  for (const f of findings) process.stderr.write(`PACKAGE_HYGIENE ${f.rule} ${f.file}\n`);
  if (findings.length) fail(`the package has ${findings.length} hygiene violations; fix the files or add them to exclude in package-files.json`, 1);
  process.stdout.write(`PACKAGE_HYGIENE_PASS files=${packageFiles(root).files.length}\n`);
} else fail('usage: package-tool.mjs manifest|verify|copy|source|verify-runtime|hygiene');
