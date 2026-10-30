#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [command, ...raw] = process.argv.slice(2);
const args = {};
for (let i = 0; i < raw.length; i++) {
  if (!raw[i].startsWith('--')) continue;
  const key = raw[i].slice(2);
  args[key] = raw[i + 1]?.startsWith('--') || raw[i + 1] === undefined ? true : raw[++i];
}

function fail(message, code = 2) {
  process.stderr.write(`package-tool: ${message}\n`);
  process.exit(code);
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

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
  // test/output holds what a local test or mutation run wrote (test/mutation/*.mjs); it is never part of the package.
  if (relative.split(path.sep).join('/') === 'test/output') return;
  for (const name of fs.readdirSync(absolute).sort()) {
    if (['.DS_Store', '.node-path', 'node_modules', 'dist'].includes(name)) continue;
    walk(root, path.join(relative, name), out);
  }
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
  return { config, files: [...new Set(files)].sort() };
}

function buildManifest(root) {
  const { config, files } = packageFiles(root);
  return {
    schema: 'agentpro/skill-package-manifest/v1',
    skill: config.skill,
    version: config.version,
    files: files.map(file => {
      const absolute = path.join(root, file);
      return { path: file, sha256: sha(absolute), mode: (fs.statSync(absolute).mode & 0o777).toString(8).padStart(4, '0') };
    })
  };
}

function verify(root, manifestFile) {
  const manifest = json(manifestFile);
  if (manifest.schema !== 'agentpro/skill-package-manifest/v1') fail('manifest schema sai', 1);
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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const extra = actual.filter(x => !seen.has(x));
    const missing = expected.filter(x => !actual.includes(x));
    fail(`allowlist mismatch extra=[${extra}] missing=[${missing}]`, 1);
  }
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
  const doc = {
    schema: 'agentpro/skill-source/v1', skill: args.skill, version: args.version,
    repo: args.repo, commit: args.commit, tree: args.tree,
    manifest_sha256: args['manifest-sha'], package_sha256: args['package-sha'], built_at: new Date().toISOString()
  };
  fs.writeFileSync(path.resolve(String(args.out)), `${JSON.stringify(doc, null, 2)}\n`);
} else if (command === 'verify-runtime') {
  const root = path.resolve(String(args.root || '.'));
  const sourceFile = path.resolve(String(args.source || path.join(root, 'SOURCE.json')));
  const source = json(sourceFile);
  const manifestFile = path.join(root, 'package-manifest.json');
  if (source.schema !== 'agentpro/skill-source/v1') fail('SOURCE schema sai', 1);
  if (sha(manifestFile) !== source.manifest_sha256) fail('SOURCE manifest_sha256 mismatch', 1);
  const manifest = verify(root, manifestFile);
  if (source.skill !== manifest.skill || source.version !== manifest.version) fail('SOURCE skill/version does not match the manifest', 1);
  process.stdout.write(`RUNTIME_VERIFY_PASS skill=${source.skill} commit=${source.commit} files=${manifest.files.length}\n`);
} else {
  fail('usage: package-tool.mjs manifest|verify|copy|source|verify-runtime');
}
