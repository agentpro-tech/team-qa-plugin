#!/usr/bin/env node
// mutate.mjs — mutation runner zero-dependency cho qa-code P4.
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

class UsageError extends Error {}
class RestoreError extends Error {}

const SOURCE_EXT = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)|\.(?:test|spec|e2e)\.[^/]+$/i;
const startedAt = performance.now();

let activeChild = null;
let activeOriginal = null;
let scratchDir = null;
let nodeShimDir = null;

function usage(message) {
  throw new UsageError(message);
}

// M1: the target's parent must realpath INSIDE the repo — blocks a testCmd that swaps a folder for a symlink escaping the repo.
function realParentInside(repo, absolute) {
  let parentReal;
  try { parentReal = realpathSync(dirname(absolute)); } catch { return false; }
  return inside(repo, parentReal);
}

// M1: a write with a containment constraint. Do NOT follow a symlink in the last component (testCmd may swap
// the source for a symlink pointing outside the repo) — remove the symlink, then write a real file, leaving the outside target untouched.
function safeContainedWrite(repo, absolute, body, options) {
  if (!realParentInside(repo, absolute)) {
    throw new RestoreError(`target escapes the repo through a folder symlink, refusing to write: ${absolute}`);
  }
  let st;
  try { st = lstatSync(absolute); } catch { st = null; }
  if (st && st.isSymbolicLink()) rmSync(absolute, { force: true });
  writeFileSync(absolute, body, options);
}

// M1: recreate a baseline symlink with the right target. Only constrain the PARENT to be inside the repo (as for writes);
// do NOT follow the link outside the repo — only write the target string back verbatim, never go through it.
function safeContainedSymlink(repo, absolute, target) {
  if (!realParentInside(repo, absolute)) {
    throw new RestoreError(`target escapes the repo through a folder symlink, refusing to create the symlink: ${absolute}`);
  }
  let st;
  try { st = lstatSync(absolute); } catch { st = null; }
  if (st) rmSync(absolute, { force: true, recursive: st.isDirectory() });
  symlinkSync(target, absolute);
}

function restoreActive() {
  if (!activeOriginal) return;
  const { path, body, repo } = activeOriginal;
  let restoreError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      safeContainedWrite(repo, path, body);
      activeOriginal = null;
      return;
    } catch (error) {
      restoreError = error;
    }
  }

  const rescuePath = `${path}.qa-code-original-${process.pid}-${Date.now()}`;
  let rescueError;
  try {
    if (!realParentInside(repo, rescuePath)) throw new Error('rescue folder escapes the repo');
    writeFileSync(rescuePath, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    rescueError = error;
  }
  process.stderr.write(
    '\nqa-code: DANGER — RESTORE FAILED AFTER 2 WRITES.\n' +
    `The target file may still be mutated: ${path}\n` +
    (rescueError
      ? `could NOT write the rescue file either: ${rescuePath} (${rescueError?.message ?? rescueError})\n`
      : `THE ORIGINAL WAS RESCUED TO: ${rescuePath}\n`) +
    'Stop now; restore the target file from the rescue copy before running again.\n\n',
  );
  throw new RestoreError(
    `cannot restore ${path}: ${restoreError?.message ?? restoreError}`,
    { cause: restoreError },
  );
}

function removeScratch() {
  if (!scratchDir) return;
  const target = scratchDir;
  scratchDir = null;
  rmSync(target, { recursive: true, force: true });
}

// M3: a shim folder OUTSIDE the repo holds a symlink `node` -> process.execPath. It is prepended to the PATH of
// testCmd (default `node --test` and the package test script) so that the `node` token runs the same runtime that
// runs the helper — independent of `node` in the installed PATH (the LaunchAgent only sets QA_CODE_NODE).
// The symlink keeps a Node path with spaces intact and involves no shell interpolation.
function ensureNodeShim() {
  if (nodeShimDir) return;
  const dir = mkdtempSync(join(tmpdir(), 'qa-code-node-shim-'));
  symlinkSync(process.execPath, join(dir, 'node'));
  nodeShimDir = dir;
}

function removeNodeShim() {
  if (!nodeShimDir) return;
  const target = nodeShimDir;
  nodeShimDir = null;
  rmSync(target, { recursive: true, force: true });
}

function killActive(signal = 'SIGTERM') {
  if (!activeChild?.pid) return;
  try {
    process.kill(-activeChild.pid, signal);
  } catch {
    try { activeChild.kill(signal); } catch { /* the process has already exited */ }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    killActive(signal);
    try {
      restoreActive();
    } catch (error) {
      process.stderr.write(`qa-code: restore on ${signal} failed: ${error.message}\n`);
    }
    try { removeScratch(); } catch { /* do not mask the signal exit */ }
    try { removeNodeShim(); } catch { /* do not mask the signal exit */ }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

function parseArgs(argv) {
  const options = { base: 'HEAD~1', maxSeconds: 1800 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--repo', '--base', '--config', '--json', '--max-seconds'].includes(flag)) {
      usage(`invalid flag: ${flag}`);
    }
    if (index + 1 >= argv.length) usage(`missing value for ${flag}`);
    const value = argv[index += 1];
    if (flag === '--repo') options.repo = value;
    if (flag === '--base') options.base = value;
    if (flag === '--config') options.config = value;
    if (flag === '--json') options.json = value;
    if (flag === '--max-seconds') options.maxSeconds = Number(value);
  }
  if (!options.repo) usage('missing --repo');
  if (!Number.isFinite(options.maxSeconds) || options.maxSeconds <= 0) {
    usage('--max-seconds must be a positive number');
  }
  return options;
}

function runSync(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function git(repo, args) {
  return runSync('git', args, repo);
}

// V6: declare the pinned runtime so that the verdict can read it. process.execPath is the node that was exec'd
// (the QA_CODE_NODE proxy execs the real node), so the path takes exactly the QA_CODE_NODE string the
// wrapper pinned — no realpath, so that it matches the path the operator declared at install time.
function pinnedNode() {
  return { path: process.env.QA_CODE_NODE || process.execPath, version: process.version };
}

// V1: a mutant must pass `node --check` before the tests; a mutant that does not parse is invalid
// and must not enter run/killed/survived because of a syntax error.
function nodeCheck(absolute) {
  const result = spawnSync(process.execPath, ['--check', absolute], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0;
}

// V3: fingerprint the repo to catch a testCmd that dirties the worktree.
function fingerprint(repo) {
  return {
    status: git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout,
    worktree: git(repo, ['diff', '--no-ext-diff', '--']).stdout,
    index: git(repo, ['diff', '--cached', '--no-ext-diff', '--']).stdout,
  };
}

function statusEntries(porcelain) {
  const parts = porcelain.split('\0');
  const entries = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    entries.push({ xy, path: entry.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') index += 1; // the source slot of a rename/copy comes right after
  }
  return entries;
}

// M1: capture EVERY kind of baseline node — regular (bytes), symlink (target), absent, or other
// (non-regular other than symlink: fifo/socket/device). That way restore does not turn a symlink into null and then
// delete it by mistake when another path is tampered with.
function captureNode(absolute) {
  let st;
  try { st = lstatSync(absolute); } catch { return { type: 'absent' }; }
  if (st.isSymbolicLink()) {
    try { return { type: 'symlink', target: readlinkSync(absolute) }; } catch { return { type: 'other' }; }
  }
  if (st.isFile()) return { type: 'regular', bytes: readFileSync(absolute) };
  const kind = st.isDirectory() ? 'directory'
    : (st.isFIFO() ? 'fifo'
      : (st.isSocket() ? 'socket'
        : (st.isCharacterDevice() ? 'character-device'
          : (st.isBlockDevice() ? 'block-device' : 'unknown'))));
  // M1/F1: `other` cannot be recreated zero-dep, but we must notice that it was swapped or its metadata changed
  // so that we go loud UNGRADED instead of treating every other/other as equal and continuing mutation.
  return {
    type: 'other', kind, dev: st.dev, ino: st.ino, mode: st.mode, nlink: st.nlink,
    rdev: st.rdev, size: st.size, atimeMs: st.atimeMs, mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs, birthtimeMs: st.birthtimeMs,
  };
}

function nodesEqual(a, b) {
  if (!a || !b) return a === b;
  if (a.type !== b.type) return false;
  if (a.type === 'regular') return a.bytes.equals(b.bytes);
  if (a.type === 'symlink') return a.target === b.target;
  if (a.type === 'other') {
    return a.kind === b.kind && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
      && a.nlink === b.nlink && a.rdev === b.rdev && a.size === b.size
      && a.atimeMs === b.atimeMs && a.mtimeMs === b.mtimeMs
      && a.ctimeMs === b.ctimeMs && a.birthtimeMs === b.birthtimeMs;
  }
  return true; // absent/absent
}

// Git porcelain does not list untracked FIFOs/sockets/devices. V3 exact restore therefore needs a separate
// fingerprint for symlinks + special nodes on disk; it does not recurse through symlinks and skips `.git`.
function specialNodes(repo) {
  const found = new Map();
  const walk = (directory, prefix = '') => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === '.git' || path.startsWith('.git/')) continue;
      const absolute = join(directory, entry.name);
      let st;
      try { st = lstatSync(absolute); } catch { continue; }
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
        found.set(path, captureNode(absolute));
      } else if (st.isDirectory()) {
        walk(absolute, path);
      }
    }
  };
  walk(repo);
  return found;
}

function specialDriftPaths(repo, baseline) {
  const current = specialNodes(repo);
  const paths = new Set([...baseline.keys(), ...current.keys()]);
  return [...paths].filter((path) => !nodesEqual(
    baseline.get(path) ?? { type: 'absent' },
    current.get(path) ?? { type: 'absent' },
  ));
}

// M2: capture enough to restore EXACTLY — the frozen fingerprint + index blobs + the node of every
// non-clean path (tracked-dirty/staged/untracked). Captured once before the clean run and used for every revert.
function snapshot(repo) {
  const fp = fingerprint(repo);
  const byPath = new Map(statusEntries(fp.status).map((entry) => [entry.path, entry]));
  const nodes = new Map();
  for (const path of byPath.keys()) nodes.set(path, captureNode(join(repo, path)));
  const staged = new Map();
  const stage = git(repo, ['ls-files', '--stage', '-z']).stdout;
  for (const record of stage.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, sha] = record.slice(0, tab).split(/\s+/);
    staged.set(record.slice(tab + 1), { mode, sha });
  }
  return {
    fp, byPath, nodes, staged, special: specialNodes(repo),
  };
}

function safeRemove(repo, absolute) {
  if (!realParentInside(repo, absolute)) return;
  rmSync(absolute, { recursive: true, force: true });
}

// M1: bring the WORKTREE back to the baseline node KIND. Regular rewrites the bytes; symlink recreates the target;
// absent deletes. A non-regular other than symlink (other) CANNOT be recreated exactly — leave the current
// state as is so that the exactness recheck catches it and goes loud UNGRADED instead of deleting the user's node.
function restoreWorktreeNode(repo, absolute, node) {
  if (nodesEqual(captureNode(absolute), node)) return; // already right, no churn (including an unchanged other)
  if (node.type === 'regular') { safeContainedWrite(repo, absolute, node.bytes); return; }
  if (node.type === 'symlink') { safeContainedSymlink(repo, absolute, node.target); return; }
  if (node.type === 'absent') safeRemove(repo, absolute);
  // other: cannot be recreated — leave it.
}

// M2: bring ONE path back to its exact baseline state (worktree by node kind + index).
function restorePath(repo, snap, path) {
  const absolute = join(repo, path);
  const base = snap.byPath.get(path);
  const node = snap.nodes.get(path) ?? { type: 'absent' };
  if (base) {
    if (base.xy === '??') {
      git(repo, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', path]);
    } else {
      const idx = snap.staged.get(path);
      if (idx) git(repo, ['update-index', '--cacheinfo', `${idx.mode},${idx.sha},${path}`]);
      else git(repo, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', path]);
    }
    restoreWorktreeNode(repo, absolute, node);
    return;
  }
  // FIFO/socket/device may be invisible to Git status but are still in the separate fingerprint.
  // The `other` kind cannot be recreated zero-dep: leave the current state so that the recheck reports exact=false;
  // never delete by mistake a special node that we cannot recover.
  const special = snap.special.get(path);
  if (special) {
    restoreWorktreeNode(repo, absolute, special);
    return;
  }
  // Clean baseline: either tracked-clean (back to HEAD) or absent (delete what testCmd created).
  if (git(repo, ['cat-file', '-e', `HEAD:${path}`]).status === 0) {
    git(repo, ['reset', '--quiet', '--', path]);
    git(repo, ['checkout', '--quiet', '--', path]);
  } else {
    git(repo, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', path]);
    safeRemove(repo, absolute);
  }
}

// Return { names, exact } if testCmd changed the repo state compared with the baseline; null if clean.
// exact=false => it cannot be restored exactly => the caller emits a loud UNGRADED.
function detectAndRevertTamper(repo, snap) {
  const after = fingerprint(repo);
  const fpEqual = (fp) => fp.status === snap.fp.status
    && fp.worktree === snap.fp.worktree && fp.index === snap.fp.index;
  // The content/target of baseline untracked files does not show in the frozen fingerprint — check it separately.
  const untrackedDrift = () => [...snap.byPath.entries()]
    .filter(([p, e]) => e.xy === '??'
      && !nodesEqual(captureNode(join(repo, p)), snap.nodes.get(p)))
    .map(([p]) => p);
  const contentDrift = untrackedDrift();
  const specialDrift = specialDriftPaths(repo, snap.special);
  if (fpEqual(after) && contentDrift.length === 0 && specialDrift.length === 0) return null;

  const before = new Set(statusEntries(snap.fp.status).map((entry) => entry.path));
  const strangeNames = statusEntries(after.status)
    .filter((entry) => !before.has(entry.path)).map((entry) => entry.path);
  const touched = new Set([
    ...snap.byPath.keys(),
    ...statusEntries(after.status).map((entry) => entry.path),
    ...contentDrift,
    ...specialDrift,
  ]);
  for (const path of touched) restorePath(repo, snap, path);

  const recheck = fingerprint(repo);
  const exact = fpEqual(recheck) && untrackedDrift().length === 0
    && specialDriftPaths(repo, snap.special).length === 0;
  const names = strangeNames.length ? strangeNames
    : (contentDrift.length ? contentDrift
      : (specialDrift.length ? specialDrift : ['(change whose file name cannot be determined)']));
  return { names, exact };
}

function emitTamper(output, options, strange, totalsPart, mutatedFiles) {
  const run = totalsPart.run ?? 0;
  const killed = totalsPart.killed ?? 0;
  const survived = totalsPart.survived ?? 0;
  const invalid = totalsPart.invalid ?? 0;
  const { generated } = totalsPart;
  output.status = 'ungraded';
  output.totals = { generated, run, killed, survived, invalid, skipped: generated - run - invalid };
  output.kill_rate = 0;
  output.truncated = {
    hit_budget: false,
    unscanned_files: mutatedFiles,
    note: `testCmd dirtied the repo (unexpected files: ${strange.join(', ')}); run cancelled, no valid numbers`,
  };
  process.stderr.write(`qa-code: testCmd changed the repo state — unexpected files: ${strange.join(', ')}\n`);
  serialize(options.json, output);
  return 20;
}

function normalizeRepoPath(repo, file) {
  if (!file) return '';
  let normalized = String(file).replaceAll('\\', '/');
  const repoPosix = repo.replaceAll('\\', '/');
  if (normalized.startsWith(`${repoPosix}/`)) normalized = normalized.slice(repoPosix.length + 1);
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readConfig(repo, option) {
  const candidate = option
    ? (isAbsolute(option) ? option : resolve(process.cwd(), option))
    : join(repo, 'qa-code.config.json');
  if (!existsSync(candidate)) {
    if (option) usage(`cannot find --config: ${option}`);
    return {};
  }
  let configReal;
  try {
    // V4: the config may be outside the repo or behind a symlink; realpath it, then only read it.
    configReal = realpathSync(candidate);
  } catch {
    usage(`cannot read --config: ${candidate}`);
  }
  try {
    return JSON.parse(readFileSync(configReal, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) usage(`--config is not valid JSON: ${candidate}`);
    usage(`cannot read --config: ${candidate}`);
  }
}

function packageTestCommand(repo) {
  const manifest = join(repo, 'package.json');
  if (!existsSync(manifest)) return 'node --test';
  try {
    const body = JSON.parse(readFileSync(manifest, 'utf8'));
    const command = body?.scripts?.test;
    return typeof command === 'string' && command.trim() ? command : 'node --test';
  } catch {
    return 'node --test';
  }
}

function validateConfig(config, repo) {
  const mutation = config?.mutation ?? {};
  const core = mutation.core ?? [];
  const threshold = Number(mutation.threshold ?? 70);
  const testCmd = mutation.testCmd ?? packageTestCommand(repo);
  const testFiles = mutation.testFiles;
  if (!Array.isArray(core) || core.some((item) => typeof item !== 'string' || !item)) {
    usage('mutation.core must be a non-empty array of globs');
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    usage('mutation.threshold must be a number from 0 to 100');
  }
  if (typeof testCmd !== 'string' || !testCmd.trim()) {
    usage('mutation.testCmd must be a non-empty command string');
  }
  if (testFiles !== undefined
    && (!Array.isArray(testFiles)
      || testFiles.length === 0
      || testFiles.some((item) => typeof item !== 'string' || !item.trim()))) {
    usage('mutation.testFiles must be a non-empty array of globs');
  }
  return { core, threshold, testCmd, testFiles };
}

function resolveCommit(repo, ref, label) {
  const result = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (result.status !== 0) usage(`cannot resolve ${label}: ${ref}`);
  return result.stdout.trim();
}

function listRepoFiles(repo) {
  const result = git(repo, ['ls-files', '-co', '--exclude-standard', '-z']);
  if (result.status !== 0) usage('cannot list the files in the repo');
  return [...new Set(result.stdout.split('\0').filter(Boolean).map((file) => normalizeRepoPath(repo, file)))]
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function addedLinesForFile(repo, baseCommit, file) {
  const result = git(repo, [
    '-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff',
    baseCommit, '--', file,
  ]);
  if (result.status !== 0) usage(`cannot read git diff for ${file}`);
  const lines = new Set();
  let newLine = 0;
  let inHunk = false;
  for (const line of result.stdout.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      lines.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      // A deleted line does not move the pointer on the new-file side.
    } else if (line.startsWith(' ')) {
      newLine += 1;
    } else if (line.startsWith('\\ No newline')) {
      // A git marker, not content.
    } else {
      inHunk = false;
    }
  }
  return lines;
}

function globRegex(pattern) {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function scopeFiles(repo, baseCommit, corePatterns) {
  const files = listRepoFiles(repo).filter((file) => SOURCE_EXT.test(file) && !TEST_PATH.test(file));
  const coreMatchers = corePatterns.map(globRegex);
  const scope = [];
  for (const file of files) {
    const absolute = join(repo, file);
    let stat;
    try { stat = lstatSync(absolute); } catch { continue; }
    const core = coreMatchers.some((matcher) => matcher.test(file));
    const added = addedLinesForFile(repo, baseCommit, file);
    if (!(core || added.size)) continue;
    // V2: realpath the source before any write; reject a file that escapes the repo or a symlink loop.
    let real;
    try {
      real = realpathSync(absolute);
    } catch (error) {
      usage(`cannot realpath the source (symlink loop?): ${file}: ${error?.code ?? error?.message ?? error}`);
    }
    if (!inside(repo, real)) usage(`source is outside the repo through a symlink: ${file}`);
    if (!stat.isSymbolicLink() && !existsSync(absolute)) continue;
    scope.push({ file, absolute: real, allLines: core, added });
  }
  return scope.sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

function codeMask(body) {
  const mask = Array(body.length).fill(false);
  let state = 'code';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    const next = body[index + 1];
    if (state === 'line-comment') {
      if (char === '\n') { state = 'code'; mask[index] = true; }
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') { index += 1; state = 'code'; }
      continue;
    }
    if (state === 'quote') {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) { state = 'code'; quote = ''; }
      continue;
    }
    if (char === '/' && next === '/') { state = 'line-comment'; index += 1; continue; }
    if (char === '/' && next === '*') { state = 'block-comment'; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') {
      state = 'quote';
      quote = char;
      continue;
    }
    mask[index] = true;
  }
  return mask;
}

function lineStarts(body) {
  const starts = [0];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAt(body, starts, line) {
  const start = starts[line - 1];
  const endCandidate = body.indexOf('\n', start);
  const end = endCandidate === -1 ? body.length : endCandidate;
  return { start, end, text: body.slice(start, end) };
}

// V1/M4: mark '<'/'>' as a JSX tag/fragment or TS generic so that NO BOUNDARY is generated.
// Zero-dep, a context heuristic; real comparisons (a<b, a<=b, a > b, a>=b) are still generated.
function angleSkipSet(body, mask) {
  const skip = new Set();
  const prevSig = (i) => {
    let p = i - 1;
    while (p >= 0 && (!mask[p] || /\s/.test(body[p]))) p -= 1;
    return p >= 0 ? body[p] : '';
  };
  // Balanced scan from an opening '<'; mark every '<'/'>' inside the tag/generic span.
  const markSpan = (start) => {
    let depth = 0;
    for (let k = start; k < body.length; k += 1) {
      if (!mask[k]) continue;
      const char = body[k];
      if (char === '<') { depth += 1; skip.add(k); } else if (char === '>') {
        if (body[k - 1] === '=') continue; // an arrow inside a JSX prop / generic constraint, the span is not closed yet
        depth -= 1; skip.add(k); if (depth === 0) return;
      }
    }
  };
  // Treat it as a generic only if the balanced span between '<' and '>' holds only "type"/tag characters; an unexpected operator => a real comparison.
  const genericLike = (start) => {
    let depth = 0;
    for (let k = start; k < body.length; k += 1) {
      if (!mask[k]) return false;
      const char = body[k];
      if (char === '<') { depth += 1; continue; }
      if (char === '>') {
        if (body[k - 1] === '=') continue;
        depth -= 1;
        if (depth === 0) {
          let after = k + 1;
          while (after < body.length && /\s/.test(body[after])) after += 1;
          // A generic/tag only makes sense when a call/type syntax follows the closing mark. `a<b>c` is still a comparison.
          return after >= body.length || /[>()\[\]{},.;:?=|&]/.test(body[after]);
        }
        continue;
      }
      if (/[A-Za-z0-9_$,.[\]\s]/.test(char)) continue;
      return false;
    }
    return false;
  };
  for (let i = 0; i < body.length; i += 1) {
    if (!mask[i] || body[i] !== '<' || skip.has(i)) continue;
    const next = body[i + 1];
    if (next === '=' || next === '<') continue; // '<=' and '<<' are real operators
    if (next === '/' || next === '>') { markSpan(i); continue; } // JSX close/fragment
    if (next !== undefined && /[A-Za-z]/.test(next)) {
      const prevOperand = /[A-Za-z0-9_$)\]]/.test(prevSig(i));
      if (!prevOperand) { markSpan(i); continue; } // '<Tag' in expression position => JSX
      if (genericLike(i)) markSpan(i); // 'Ident<Type>' => generic
    }
  }
  return skip;
}

function addOperatorMutants(mutants, body, mask, starts, file, eligible, angleSkip) {
  const tokens = [
    { original: '!==', replacement: '===', op: 'NEGATE' },
    { original: '===', replacement: '!==', op: 'NEGATE' },
    { original: '>=', replacement: '>', op: 'BOUNDARY' },
    { original: '<=', replacement: '<', op: 'BOUNDARY' },
    { original: '&&', replacement: '||', op: 'LOGIC' },
    { original: '||', replacement: '&&', op: 'LOGIC' },
    { original: '>', replacement: '>=', op: 'BOUNDARY' },
    { original: '<', replacement: '<=', op: 'BOUNDARY' },
  ];
  for (let line = 1; line <= starts.length; line += 1) {
    if (!eligible(line)) continue;
    const info = lineAt(body, starts, line);
    for (let offset = 0; offset < info.text.length; offset += 1) {
      const absolute = info.start + offset;
      if (!mask[absolute]) continue;
      for (const token of tokens) {
        if (!info.text.startsWith(token.original, offset)) continue;
        if (![...token.original].every((_, part) => mask[absolute + part])) continue;
        // M4: skip '<'/'>' that belong to a JSX tag/fragment or TS generic — they are not comparisons.
        if ((token.original[0] === '<' || token.original[0] === '>') && angleSkip.has(absolute)) continue;
        if (token.original === '>' && (info.text[offset - 1] === '=' || info.text[offset + 1] === '>' || info.text[offset + 1] === '=')) continue;
        if (token.original === '<' && (info.text[offset - 1] === '<' || info.text[offset + 1] === '<' || info.text[offset + 1] === '=')) continue;
        const mutatedBody = body.slice(0, absolute) + token.replacement + body.slice(absolute + token.original.length);
        const mutatedInfo = lineAt(mutatedBody, lineStarts(mutatedBody), line);
        mutants.push({
          op: token.op, file, line, column: offset + 1,
          start: absolute, end: absolute + token.original.length,
          replacement: token.replacement,
          original: info.text.trim(), mutated: mutatedInfo.text.trim(),
        });
        offset += token.original.length - 1;
        break;
      }
    }
  }
}

function addReturnMutants(mutants, body, mask, starts, file, eligible) {
  for (let line = 1; line <= starts.length; line += 1) {
    if (!eligible(line)) continue;
    const info = lineAt(body, starts, line);
    let expression = /\breturn\s+/.exec(info.text);
    let searchFrom = 0;
    while (expression) {
      const keyword = info.start + expression.index;
      const before = info.text[expression.index - 1] ?? '';
      const keywordOk = [...'return'].every((_, part) => mask[keyword + part]);
      if (keywordOk && !/[\w$]/.test(before)) {
        const exprStart = info.start + expression.index + expression[0].length;
        let exprEnd = info.end;
        for (let at = exprStart; at < info.end; at += 1) {
          if (body[at] === ';' && mask[at]) { exprEnd = at; break; }
        }
        while (exprEnd > exprStart && /\s/.test(body[exprEnd - 1])) exprEnd -= 1;
        if (exprEnd > exprStart) {
          const mutatedBody = body.slice(0, exprStart) + 'null' + body.slice(exprEnd);
          const mutatedInfo = lineAt(mutatedBody, lineStarts(mutatedBody), line);
          mutants.push({
            op: 'RETURN', file, line, column: expression.index + 1,
            start: exprStart, end: exprEnd, replacement: 'null',
            original: info.text.trim(), mutated: mutatedInfo.text.trim(),
          });
        }
      }
      searchFrom = expression.index + expression[0].length;
      expression = /\breturn\s+/.exec(info.text.slice(searchFrom));
      if (expression) expression.index += searchFrom;
    }
  }
}

function mutantsFor(entry) {
  const body = readFileSync(entry.absolute, 'utf8');
  const mask = codeMask(body);
  const starts = lineStarts(body);
  const eligible = (line) => entry.allLines || entry.added.has(line);
  const angleSkip = angleSkipSet(body, mask);
  const mutants = [];
  addOperatorMutants(mutants, body, mask, starts, entry.file, eligible, angleSkip);
  addReturnMutants(mutants, body, mask, starts, entry.file, eligible);
  mutants.sort((a, b) => a.line - b.line || a.column - b.column || a.op.localeCompare(b.op, 'en'));
  return { body, mutants };
}

function remainingMs(maxSeconds) {
  return Math.max(0, Math.floor(maxSeconds * 1000 - (performance.now() - startedAt)));
}

function runAsync(command, args, { cwd, timeoutMs, shell = false, env = process.env }) {
  return new Promise((finish) => {
    if (timeoutMs <= 0) {
      finish({ status: null, timedOut: true, stdout: '', stderr: '' });
      return;
    }
    const child = spawn(command, args, {
      cwd, shell, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killActive('SIGTERM');
      setTimeout(() => killActive('SIGKILL'), 250).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      activeChild = null;
      finish({ status: null, timedOut, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      activeChild = null;
      finish({ status: code, timedOut, stdout, stderr });
    });
  });
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // M3: `node` in testCmd points to the pinned runtime (shim), even when the installed PATH has no Node.
  if (nodeShimDir) env.PATH = env.PATH ? `${nodeShimDir}:${env.PATH}` : nodeShimDir;
  return env;
}

async function runTestCommand(repo, command, maxSeconds) {
  return runAsync('/bin/sh', ['-c', command], {
    cwd: repo, timeoutMs: remainingMs(maxSeconds), env: cleanEnv(),
  });
}

function testFiles(repo, patterns) {
  const matchers = patterns?.map(globRegex) ?? [];
  return listRepoFiles(repo)
    .filter((file) => SOURCE_EXT.test(file) && TEST_PATH.test(file) && existsSync(join(repo, file)))
    .filter((file) => matchers.length === 0 || matchers.some((matcher) => matcher.test(file)));
}

function parseLcovTouched(repo, body) {
  const touched = new Set();
  let current = null;
  let hit = false;
  const flush = () => {
    if (current && hit && SOURCE_EXT.test(current) && !TEST_PATH.test(current)) touched.add(current);
  };
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      flush();
      current = normalizeRepoPath(repo, line.slice(3));
      hit = false;
    } else if (line.startsWith('DA:') && current) {
      const count = Number(line.slice(3).split(',')[1]);
      if (count > 0) hit = true;
    } else if (line === 'end_of_record') {
      flush();
      current = null;
      hit = false;
    }
  }
  flush();
  return touched;
}

async function collectBlame(repo, maxSeconds, patterns) {
  const bySource = new Map();
  scratchDir = mkdtempSync(join(repo, '.qa-code-mutation-'));
  try {
    let number = 0;
    for (const testFile of testFiles(repo, patterns)) {
      if (remainingMs(maxSeconds) <= 0) break;
      number += 1;
      const lcov = join(scratchDir, `${number}.lcov`);
      const result = await runAsync(process.execPath, [
        '--test', '--experimental-test-coverage', '--test-reporter=lcov',
        `--test-reporter-destination=${lcov}`, testFile,
      ], { cwd: repo, timeoutMs: remainingMs(maxSeconds), env: cleanEnv() });
      if (result.status !== 0 || result.timedOut || !existsSync(lcov)) continue;
      for (const source of parseLcovTouched(repo, readFileSync(lcov, 'utf8'))) {
        if (!bySource.has(source)) bySource.set(source, []);
        bySource.get(source).push(testFile);
      }
    }
  } finally {
    removeScratch();
  }
  for (const candidates of bySource.values()) candidates.sort((a, b) => a.localeCompare(b, 'en'));
  return bySource;
}

function blameFor(file, blameMap) {
  const candidates = [...new Set(blameMap.get(file) ?? [])];
  if (candidates.length === 1) {
    return {
      blamed_test: candidates[0],
      why_blamed: `the only test file that touches ${file} according to the LCOV of the clean run`,
    };
  }
  if (candidates.length > 1) {
    return {
      blamed_test: null,
      why_blamed: `LCOV has ${candidates.length} test files touching ${file}; not enough grounds to pick a single file`,
      candidate_tests: candidates,
    };
  }
  return {
    blamed_test: null,
    why_blamed: `cannot infer a test file touching ${file} from the LCOV of the clean run`,
  };
}

function serialize(outPath, output) {
  const body = `${JSON.stringify(output, null, 2)}\n`;
  if (!outPath) {
    process.stdout.write(body);
    return;
  }
  const absolute = resolve(outPath);
  if (!existsSync(dirname(absolute))) usage(`the parent folder of --json does not exist: ${dirname(absolute)}`);
  writeFileSync(absolute, body);
}

function baseOutput(repo, base, commit, threshold, generated, mutatedFiles) {
  return {
    schema: 'qa-code/mutation/v1',
    status: 'ungraded',
    repo,
    base,
    commit,
    threshold,
    kill_rate: 0,
    totals: {
      generated, run: 0, killed: 0, survived: 0, invalid: 0, skipped: generated,
    },
    survivors: [],
    mutated_files: mutatedFiles,
    truncated: {
      hit_budget: false,
      unscanned_files: [],
      partially_scanned_files: [],
      remaining_mutants_by_file: [],
      max_seconds: null,
      elapsed_seconds: null,
      note: '',
    },
  };
}

function roundRobinByFile(mutants) {
  const groups = new Map();
  for (const mutant of mutants) {
    if (!groups.has(mutant.file)) groups.set(mutant.file, []);
    groups.get(mutant.file).push(mutant);
  }
  const queues = [...groups.values()];
  const ordered = [];
  for (let index = 0; ordered.length < mutants.length; index += 1) {
    for (const queue of queues) {
      if (queue[index]) ordered.push(queue[index]);
    }
  }
  return ordered;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let repo;
  try { repo = realpathSync(options.repo); } catch { usage(`cannot read --repo: ${options.repo}`); }
  const check = git(repo, ['rev-parse', '--is-inside-work-tree']);
  if (check.status !== 0 || check.stdout.trim() !== 'true') usage('--repo must be a git repo');

  const config = validateConfig(readConfig(repo, options.config), repo);
  const commitFull = resolveCommit(repo, 'HEAD', 'HEAD');
  const baseCommit = resolveCommit(repo, options.base, '--base');
  const shortCommit = git(repo, ['rev-parse', '--short', commitFull]).stdout.trim();
  const scope = scopeFiles(repo, baseCommit, config.core);

  // M1: pin the realpath'd path of each source; write/restore only use this path and never join it again.
  const absByFile = new Map(scope.map((entry) => [entry.file, entry.absolute]));
  const originals = new Map();
  const mutants = [];
  const mutantsByFile = new Map();
  for (const entry of scope) {
    const generated = mutantsFor(entry);
    originals.set(entry.file, generated.body);
    mutantsByFile.set(entry.file, generated.mutants.length);
    mutants.push(...generated.mutants);
  }
  mutants.sort((a, b) => a.file.localeCompare(b.file, 'en')
    || a.line - b.line || a.column - b.column || a.op.localeCompare(b.op, 'en'));
  const orderedMutants = roundRobinByFile(mutants);
  orderedMutants.forEach((mutant, index) => { mutant.id = `M${index + 1}`; });
  const mutatedFiles = [...mutantsByFile.entries()].filter(([, count]) => count > 0).map(([file]) => file);
  const output = baseOutput(repo, options.base, shortCommit, config.threshold, orderedMutants.length, mutatedFiles);
  output.node = pinnedNode();
  const attemptedByFile = new Map();
  const completedByFile = new Map();
  const budgetTruncation = (note) => {
    const remainingMutantsByFile = mutatedFiles.map((file) => ({
      file,
      count: Math.max(0, (mutantsByFile.get(file) ?? 0) - (completedByFile.get(file) ?? 0)),
    })).filter((item) => item.count > 0);
    const unscannedFiles = remainingMutantsByFile
      .filter((item) => (attemptedByFile.get(item.file) ?? 0) === 0)
      .map((item) => item.file);
    const partiallyScannedFiles = remainingMutantsByFile
      .filter((item) => (attemptedByFile.get(item.file) ?? 0) > 0)
      .map((item) => item.file);
    const remaining = remainingMutantsByFile.reduce((sum, item) => sum + item.count, 0);
    return {
      hit_budget: true,
      unscanned_files: unscannedFiles,
      partially_scanned_files: partiallyScannedFiles,
      remaining_mutants_by_file: remainingMutantsByFile,
      max_seconds: options.maxSeconds,
      elapsed_seconds: Number(((performance.now() - startedAt) / 1000).toFixed(2)),
      note: `${remaining} mutants not run; ${unscannedFiles.length} files not touched; ${partiallyScannedFiles.length} files only partially scanned. ${note}`,
    };
  };

  if (orderedMutants.length === 0) {
    output.truncated.note = 'no valid line/operator in the incremental + core scope';
    serialize(options.json, output);
    return 20;
  }

  // M3: build the shim so that every testCmd runs `node` with the pinned runtime before the first testCmd runs.
  ensureNodeShim();
  // V3/M2: capture the full baseline before the clean test run to catch and restore a testCmd that dirties the worktree.
  const baseline = snapshot(repo);
  const clean = await runTestCommand(repo, config.testCmd, options.maxSeconds);
  if (clean.timedOut) {
    // M2: still detect/restore tampering even when out of time; no early return that skips recovery.
    const strange = detectAndRevertTamper(repo, baseline);
    if (strange && !strange.exact) {
      process.stderr.write('qa-code: could NOT restore the baseline exactly after the clean run ran out of time — UNGRADED.\n');
    }
    output.truncated = budgetTruncation(
      'Budget ran out during the clean test run; no valid mutation result.',
    );
    serialize(options.json, output);
    return 20;
  }
  const cleanStrange = detectAndRevertTamper(repo, baseline);
  if (cleanStrange) {
    if (!cleanStrange.exact) {
      process.stderr.write('qa-code: could NOT restore the baseline exactly after testCmd — UNGRADED.\n');
    }
    return emitTamper(output, options, cleanStrange.names, { generated: mutants.length }, mutatedFiles);
  }
  if (clean.status !== 0) {
    output.truncated.note = 'testCmd failed already in the clean run; the mutation result has no meaning';
    serialize(options.json, output);
    return 20;
  }

  const blameMap = await collectBlame(repo, options.maxSeconds, config.testFiles);
  let killed = 0;
  let survived = 0;
  let run = 0;
  let invalid = 0;
  let hitBudget = false;

  for (let index = 0; index < orderedMutants.length; index += 1) {
    const mutant = orderedMutants[index];
    const timeLeft = remainingMs(options.maxSeconds);
    if (timeLeft <= 0) {
      hitBudget = true;
      break;
    }
    const absolute = absByFile.get(mutant.file);
    const originalBody = originals.get(mutant.file);
    const changed = originalBody.slice(0, mutant.start) + mutant.replacement + originalBody.slice(mutant.end);
    attemptedByFile.set(mutant.file, (attemptedByFile.get(mutant.file) ?? 0) + 1);
    activeOriginal = { path: absolute, body: originalBody, repo };
    let result;
    let parseOk = false;
    try {
      safeContainedWrite(repo, absolute, changed);
      parseOk = nodeCheck(absolute); // V1: syntax gate before the tests
      if (parseOk) result = await runTestCommand(repo, config.testCmd, options.maxSeconds);
    } finally {
      restoreActive();
    }
    if (!parseOk) {
      // A mutant that does not parse: count it invalid, it does not enter run/killed/survived.
      invalid += 1;
      completedByFile.set(mutant.file, (completedByFile.get(mutant.file) ?? 0) + 1);
      continue;
    }
    if (result.timedOut) {
      // M2: restore testCmd tampering before stopping because time ran out.
      const strange = detectAndRevertTamper(repo, baseline);
      if (strange && !strange.exact) {
        process.stderr.write('qa-code: could NOT restore the baseline exactly when the mutant ran out of time — UNGRADED.\n');
      }
      hitBudget = true;
      break;
    }
    const strange = detectAndRevertTamper(repo, baseline);
    if (strange) {
      if (!strange.exact) {
        process.stderr.write('qa-code: could NOT restore the baseline exactly after testCmd — UNGRADED.\n');
      }
      return emitTamper(output, options, strange.names, {
        generated: orderedMutants.length, run, killed, survived, invalid,
      }, mutatedFiles);
    }
    run += 1;
    completedByFile.set(mutant.file, (completedByFile.get(mutant.file) ?? 0) + 1);
    if (result.status === 0) {
      survived += 1;
      output.survivors.push({
        id: mutant.id,
        op: mutant.op,
        file: mutant.file,
        line: mutant.line,
        original: mutant.original,
        mutated: mutant.mutated,
        ...blameFor(mutant.file, blameMap),
      });
    } else {
      killed += 1;
    }
    // The child's `close` can beat the timeout callback right at the deadline. If this is
    // the last mutant, the loop has no next round left for the check at the top of the loop to set the flag.
    // The mutant that just finished is still a valid result; the part not run starts at index + 1.
    if (remainingMs(options.maxSeconds) <= 0) {
      hitBudget = true;
      break;
    }
  }

  output.totals = {
    generated: orderedMutants.length,
    run,
    killed,
    survived,
    invalid,
    skipped: orderedMutants.length - run - invalid,
  };
  output.kill_rate = run > 0 ? Number(((killed / run) * 100).toFixed(2)) : 0;
  if (hitBudget) {
    output.truncated = budgetTruncation('Kill rate is computed only on the mutants that ran.');
  }

  if (run === 0) {
    output.status = 'ungraded';
    if (!output.truncated.note) output.truncated.note = 'no mutant could be run';
    serialize(options.json, output);
    return 20;
  }
  output.status = output.kill_rate >= config.threshold ? 'pass' : 'fail';
  serialize(options.json, output);
  return output.status === 'pass' ? 0 : 1;
}

async function entry() {
  try {
    const code = await main();
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof RestoreError)) {
      try {
        restoreActive();
      } catch (restoreError) {
        process.stderr.write(`qa-code: restore after the main error failed: ${restoreError.message}\n`);
      }
    }
    try { removeScratch(); } catch { /* the original error is reported below */ }
    if (error instanceof UsageError) {
      process.stderr.write(`qa-code: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`qa-code: mutation runner error: ${error?.stack ?? error}\n`);
    process.exitCode = 20;
  } finally {
    try { removeNodeShim(); } catch { /* clean up the shim, do not mask the exit code */ }
  }
}

// When the helper is run directly, compare physical paths on both sides so that symlinks/spaces do not trip it.
const modulePath = realpathSync(fileURLToPath(import.meta.url));
const argvPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (modulePath === argvPath) await entry();
