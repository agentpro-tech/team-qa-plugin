#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RELEASE_POLICY } from './release-policy.mjs';

class GateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const shaBuffer = (value) => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = (file) => shaBuffer(fs.readFileSync(file));
const normalizeUrl = (value) => String(value || '').trim().replace(/\.git\/?$/, '').replace(/\/$/, '');
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
};
const integrityFor = (receipt) => shaBuffer(`${JSON.stringify(stable(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'integrity_sha256'))))}\n`);

function stop(code, message) { throw new GateError(code, message); }
function readJson(file, code = 40) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { stop(code, `cannot read JSON ${file}: ${error.message}`); }
}
function git(repo, args, code, label) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 20_000 });
  if (result.error || result.status !== 0) stop(code, `${label}: ${(result.stderr || result.error?.message || 'git failed').trim()}`);
  return result.stdout.trim();
}
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--') || index + 1 >= rest.length) stop(40, `invalid flag: ${key}`);
    args[key.slice(2)] = rest[index + 1]; index += 1;
  }
  return { command, args };
}
function validateManifest(manifest, label) {
  if (manifest?.schema !== 'agentpro/skill-package-manifest/v1' || !manifest.skill || !manifest.version || !Array.isArray(manifest.files)) {
    stop(43, `${label} package-manifest schema invalid`);
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(String(entry.sha256 || '')) || (RELEASE_POLICY.verifyFileMode && !/^0[0-7]{3}$/.test(String(entry.mode || '')))) stop(43, `${label} manifest entry invalid`);
    if (path.isAbsolute(entry.path) || entry.path.split('/').includes('..') || seen.has(entry.path)) stop(43, `${label} manifest path unsafe/duplicate: ${entry.path}`);
    seen.add(entry.path);
  }
}
function verifyPayload(root, manifest, label) {
  validateManifest(manifest, label);
  for (const entry of manifest.files) {
    const file = path.resolve(root, entry.path);
    const relative = path.relative(path.resolve(root), file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) stop(43, `${label} missing file: ${entry.path}`);
    if (shaFile(file) !== entry.sha256) stop(43, `${label} hash mismatch: ${entry.path}`);
    if (RELEASE_POLICY.verifyFileMode) {
      const actualMode = (fs.statSync(file).mode & 0o777).toString(8).padStart(4, '0');
      if (actualMode !== entry.mode) stop(43, `${label} mode mismatch: ${entry.path}`);
    }
  }
}
function archiveExisting(file) {
  if (!file || !fs.existsSync(file)) return;
  const dir = path.join(path.dirname(file), 'archive');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(file).replace(/\.json$/, '');
  let target = path.join(dir, `${base}-pre-${Date.now()}-${process.pid}.json`);
  let counter = 0;
  while (fs.existsSync(target)) { counter += 1; target = path.join(dir, `${base}-pre-${Date.now()}-${process.pid}-${counter}.json`); }
  fs.renameSync(file, target);
}
function writeReceipt(file, receipt) {
  archiveExisting(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sealed = { ...receipt, integrity_sha256: integrityFor(receipt) };
  fs.writeFileSync(file, `${JSON.stringify(sealed, null, 2)}\n`);
  return sealed;
}

export function readAndVerifyReceipt(file, { requiredScope, allowLocalCandidate = false } = {}) {
  const receipt = readJson(file, 44);
  const required = ['schema', 'status', 'scope', 'repo', 'repo_url', 'branch', 'head', 'remote_main', 'worktree_clean', 'checked_at', 'integrity_sha256'];
  if (receipt.schema !== 'team-code/release-truth/v1' || required.some((key) => receipt[key] === undefined)) stop(44, 'release-truth schema/field invalid');
  if (receipt.status !== 'PASS' || receipt.worktree_clean !== true) stop(44, 'release-truth is not PASS clean');
  if (!/^[a-f0-9]{40}$/.test(receipt.head) || !/^[a-f0-9]{40}$/.test(receipt.remote_main) || integrityFor(receipt) !== receipt.integrity_sha256) stop(44, 'release-truth integrity invalid');
  if (receipt.scope === 'local_candidate') {
    if (receipt.scope === 'local_candidate' && !allowLocalCandidate) stop(44, 'local candidate requires explicit allow');
    if (receipt.local_only !== true || receipt.base_remote_ancestor !== true || receipt.head === receipt.remote_main) stop(44, 'local candidate binding invalid');
  } else if (receipt.branch !== 'main' || receipt.head !== receipt.remote_main) stop(44, 'release-truth is not PASS remote exact');
  if (requiredScope && receipt.scope !== requiredScope) stop(44, `release-truth scope must be ${requiredScope}`);
  if (receipt.scope === 'remote_runtime') {
    if (!receipt.runtime || receipt.runtime.checked !== true || !['exact', 'payload_equivalent'].includes(receipt.runtime.payload_verdict)) stop(44, 'release-truth runtime not proven');
  }
  return receipt;
}

function allowLocal(args) {
  const value = args['allow-local-candidate'];
  if (value === undefined) return false;
  if (value !== 'yes') stop(40, '--allow-local-candidate must be yes');
  return true;
}

function prove(args) {
  if (!args.repo || !args.receipt) stop(40, 'prove requires --repo and --receipt');
  const repo = fs.realpathSync(args.repo);
  const receiptFile = path.resolve(args.receipt);
  const top = fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel'], 40, 'not a git repo'));
  if (top !== repo) stop(40, `--repo must be the git root: ${top}`);
  const branch = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], 41, 'cannot read branch');
  if (branch !== 'main') stop(41, `local branch must be main, currently ${branch}`);
  const dirty = git(repo, ['status', '--porcelain=v1', '--untracked-files=no'], 41, 'cannot read worktree');
  if (dirty) stop(41, 'local worktree has uncommitted tracked changes');
  const head = git(repo, ['rev-parse', 'HEAD'], 41, 'cannot read HEAD');
  const repoUrl = git(repo, ['remote', 'get-url', 'origin'], 42, 'missing origin');
  const remoteRaw = git(repo, ['ls-remote', 'origin', 'refs/heads/main'], 42, 'cannot read live GitHub main');
  const remoteMain = remoteRaw.split(/\s+/)[0] || '';
  if (!/^[a-f0-9]{40}$/.test(remoteMain)) stop(42, 'live remote main did not return a valid SHA');
  if (head !== remoteMain) stop(41, `local HEAD ${head} differs from remote main ${remoteMain}`);

  const canonicalManifestFile = path.join(repo, 'package-manifest.json');
  if (!fs.existsSync(canonicalManifestFile)) stop(43, 'canonical is missing package-manifest.json');
  const canonicalManifest = readJson(canonicalManifestFile, 43);
  verifyPayload(repo, canonicalManifest, 'canonical');
  const canonicalManifestSha = shaFile(canonicalManifestFile);
  let runtimeInfo = { checked: false };
  let scope = 'remote';

  if (args.runtime) {
    scope = 'remote_runtime';
    const runtime = fs.realpathSync(args.runtime);
    const sourceFile = path.join(runtime, 'SOURCE.json');
    const runtimeManifestFile = path.join(runtime, 'package-manifest.json');
    if (!fs.existsSync(sourceFile) || !fs.existsSync(runtimeManifestFile)) stop(43, 'runtime is missing SOURCE.json or package-manifest.json');
    const source = readJson(sourceFile, 43);
    const runtimeManifest = readJson(runtimeManifestFile, 43);
    if (source.schema !== 'agentpro/skill-source/v1' || !/^[a-f0-9]{40}$/.test(String(source.commit || ''))) stop(43, 'runtime SOURCE schema/commit invalid');
    if (normalizeUrl(source.repo) !== normalizeUrl(repoUrl)) stop(43, 'runtime SOURCE repo does not match origin');
    if (source.skill !== runtimeManifest.skill || source.version !== runtimeManifest.version) stop(43, 'runtime SOURCE skill/version does not match manifest');
    if (source.manifest_sha256 !== shaFile(runtimeManifestFile)) stop(43, 'runtime SOURCE manifest hash mismatch');
    if (shaFile(runtimeManifestFile) !== canonicalManifestSha) stop(43, 'runtime manifest differs from canonical manifest');
    verifyPayload(runtime, runtimeManifest, 'runtime');
    git(repo, ['cat-file', '-e', `${source.commit}^{commit}`], 43, 'runtime SOURCE commit not found in canonical git');
    const sourceTree = git(repo, ['rev-parse', `${source.commit}^{tree}`], 43, 'cannot read runtime source tree');
    if (source.tree !== sourceTree) stop(43, 'runtime SOURCE tree does not match git');
    let payloadVerdict = 'exact';
    if (source.commit !== head) {
      const ancestor = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', source.commit, head]);
      if (ancestor.status !== 0) stop(43, 'runtime source is not an ancestor of local/GitHub main');
      payloadVerdict = 'payload_equivalent';
    }
    runtimeInfo = {
      checked: true,
      path: runtime,
      source_commit: source.commit,
      source_tree: source.tree,
      manifest_sha256: canonicalManifestSha,
      files_verified: runtimeManifest.files.length,
      payload_verdict: payloadVerdict,
    };
  }

  const receipt = writeReceipt(receiptFile, {
    schema: 'team-code/release-truth/v1',
    status: 'PASS',
    scope,
    repo,
    repo_url: repoUrl,
    branch,
    head,
    remote_main: remoteMain,
    remote_transport: 'git-ls-remote-live',
    worktree_clean: true,
    canonical_manifest_sha256: canonicalManifestSha,
    canonical_files_verified: canonicalManifest.files.length,
    runtime: runtimeInfo,
    checked_at: new Date().toISOString(),
  });
  readAndVerifyReceipt(receiptFile, { requiredScope: scope });
  process.stdout.write(`RELEASE_TRUTH_PASS scope=${scope} head=${head} runtime=${runtimeInfo.payload_verdict || 'not_checked'} receipt=${receiptFile}\n`);
  return receipt;
}

function proveLocal(args) {
  if (!args.repo || !args.receipt) stop(40, 'prove-local requires --repo and --receipt');
  const repo = fs.realpathSync(args.repo); const receiptFile = path.resolve(args.receipt);
  const top = fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel'], 40, 'not a git repo'));
  if (top !== repo) stop(40, `--repo must be the git root: ${top}`);
  const branch = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], 41, 'cannot read branch');
  const dirty = git(repo, ['status', '--porcelain=v1'], 41, 'cannot read worktree');
  if (dirty) stop(41, 'local candidate worktree is not clean');
  const head = git(repo, ['rev-parse', 'HEAD'], 41, 'cannot read HEAD');
  const repoUrl = git(repo, ['remote', 'get-url', 'origin'], 42, 'missing origin');
  const remoteRaw = git(repo, ['ls-remote', 'origin', 'refs/heads/main'], 42, 'cannot read live GitHub main');
  const remoteMain = remoteRaw.split(/\s+/)[0] || '';
  if (!/^[a-f0-9]{40}$/.test(remoteMain)) stop(42, 'live remote main did not return a valid SHA');
  if (head === remoteMain) stop(41, 'HEAD already equals remote main; use the official prove');
  git(repo, ['merge-base', '--is-ancestor', remoteMain, head], 41, 'local candidate does not descend from remote main');
  const manifestFile = path.join(repo, 'package-manifest.json');
  if (!fs.existsSync(manifestFile)) stop(43, 'canonical is missing package-manifest.json');
  const manifest = readJson(manifestFile, 43); verifyPayload(repo, manifest, 'local-candidate');
  const receipt = writeReceipt(receiptFile, {
    schema: 'team-code/release-truth/v1', status: 'PASS', scope: 'local_candidate', local_only: true,
    repo, repo_url: repoUrl, branch, head, remote_main: remoteMain, base_remote_ancestor: true,
    remote_transport: 'git-ls-remote-live', worktree_clean: true,
    canonical_manifest_sha256: shaFile(manifestFile), canonical_files_verified: manifest.files.length,
    runtime: { checked: false }, checked_at: new Date().toISOString(),
  });
  readAndVerifyReceipt(receiptFile, { requiredScope: 'local_candidate', allowLocalCandidate: true });
  process.stdout.write(`RELEASE_TRUTH_PASS scope=local_candidate head=${head} remote_main=${remoteMain} receipt=${receiptFile}\n`);
  return receipt;
}

function verifyEnvelope(args) {
  if (!args.receipt || !args.source) stop(40, 'verify-envelope requires --receipt and --source');
  const receipt = readAndVerifyReceipt(path.resolve(args.receipt), { allowLocalCandidate: allowLocal(args) });
  const source = readJson(path.resolve(args.source), 44);
  if (!['remote', 'remote_runtime', 'local_candidate'].includes(receipt.scope)) stop(44, 'envelope receipt scope invalid');
  if (source.schema !== 'agentpro/skill-source/v1' || source.commit !== receipt.head || normalizeUrl(source.repo) !== normalizeUrl(receipt.repo_url)) stop(44, 'SOURCE is not attested by the release-truth receipt');
  process.stdout.write(`RELEASE_TRUTH_ENVELOPE_PASS commit=${source.commit}\n`);
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (parsed.command === 'prove') prove(parsed.args);
    else if (parsed.command === 'prove-local') proveLocal(parsed.args);
    else if (parsed.command === 'verify-receipt') {
      if (!parsed.args.receipt) stop(40, 'verify-receipt requires --receipt');
      const receipt = readAndVerifyReceipt(path.resolve(parsed.args.receipt), { allowLocalCandidate: allowLocal(parsed.args) });
      process.stdout.write(`RELEASE_TRUTH_RECEIPT_PASS scope=${receipt.scope} head=${receipt.head}\n`);
    } else if (parsed.command === 'verify-envelope') verifyEnvelope(parsed.args);
    else stop(40, 'usage: release-truth-gate.mjs prove|prove-local|verify-receipt|verify-envelope');
  } catch (error) {
    const code = Number(error?.code) || 40;
    const receipt = parsed?.args?.receipt;
    if (['prove', 'prove-local'].includes(parsed?.command) && receipt) {
      try {
        writeReceipt(path.resolve(receipt), {
          schema: 'team-code/release-truth/v1', status: 'FAIL', scope: parsed.command === 'prove-local' ? 'local_candidate' : (parsed.args.runtime ? 'remote_runtime' : 'remote'),
          repo: parsed.args.repo || '', repo_url: '', branch: '', head: '', remote_main: '', worktree_clean: false,
          runtime: { checked: false }, checked_at: new Date().toISOString(), failure_code: code, failure: error.message,
        });
      } catch {}
    }
    process.stderr.write(`RELEASE_TRUTH_${code} ${error.message}\n`);
    process.exit(code);
  }
}
