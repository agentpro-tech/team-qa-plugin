import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export class TeamQAError extends Error {
  constructor(exitCode, verdict, code, detail = '') {
    super(`${code}${detail ? ` ${detail}` : ''}`);
    this.exitCode = exitCode;
    this.verdict = verdict;
    this.code = code;
    this.detail = detail;
  }
}

export function fail(exitCode, code, detail = '', verdict = 'fail') {
  throw new TeamQAError(exitCode, verdict, code, detail);
}

export function emit(verdict, ...parts) {
  const line = [`verdict=${verdict}`, ...parts.filter((part) => part !== '' && part != null)].join(' ');
  if (verdict === 'pass') console.log(line);
  else console.error(line);
}

export function visibleCodexAssistantText(event) {
  const p = event?.payload;
  if (event?.type !== 'response_item' || p?.type !== 'message' || p.role !== 'assistant') return null;
  const channel = p.channel, phase = p.phase;
  if (channel === undefined && phase === undefined) return null;
  if (channel !== undefined && !['commentary', 'final'].includes(channel)) return null;
  if (phase !== undefined && !['commentary', 'final_answer'].includes(phase)) return null;
  if (channel !== undefined && phase !== undefined && channel !== (phase === 'final_answer' ? 'final' : phase)) return null;
  const text = typeof p.content === 'string' ? p.content : Array.isArray(p.content)
    ? p.content.filter(c => ['output_text', 'text'].includes(c?.type) && typeof c.text === 'string').map(c => c.text).join('\n') : '';
  return text || null;
}

export async function runEntrypoint(fn) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof TeamQAError) {
      emit(error.verdict, error.code, error.detail);
      process.exitCode = error.exitCode;
      return;
    }
    const detail = String(error?.message ?? error).split('\n')[0];
    emit('fail', 'INTERNAL_ERROR', detail);
    process.exitCode = 1;
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function expandPath(value, base = process.cwd()) {
  if (typeof value !== 'string' || value.length === 0) fail(2, 'PATH_INVALID', String(value ?? ''));
  let expanded = value;
  if (expanded === '~') expanded = homedir();
  else if (expanded.startsWith('~/')) expanded = join(homedir(), expanded.slice(2));
  expanded = expanded.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name) => {
    const resolved = process.env[name];
    if (!resolved) fail(5, 'ENV_MISSING', name, 'ungraded');
    return resolved;
  });
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export function readText(path, options = {}) {
  const label = options.label ?? basename(path);
  const missingExit = options.missingExit ?? 2;
  const unreadableExit = options.unreadableExit ?? 1;
  const missingCode = options.missingCode ?? 'INPUT_MISSING';
  const unreadableCode = options.unreadableCode ?? 'INPUT_UNREADABLE';
  try {
    accessSync(path, constants.R_OK);
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') fail(missingExit, missingCode, label, options.missingVerdict ?? 'fail');
    fail(unreadableExit, unreadableCode, label, options.unreadableVerdict ?? 'fail');
  }
}

export function parseJson(text, code, exitCode = 2, verdict = 'fail') {
  try {
    return JSON.parse(text);
  } catch {
    fail(exitCode, code, '', verdict);
  }
}

export function readJson(path, options = {}) {
  const text = readText(path, options);
  return parseJson(text, options.invalidCode ?? 'JSON_INVALID', options.invalidExit ?? 2, options.invalidVerdict ?? 'fail');
}

export function rejectUnknownFields(value, allowed, code, context = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const allowedSet = new Set(allowed);
  const rejected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (rejected.length > 0) fail(2, code, [context, ...rejected].filter(Boolean).join(' '));
}

export function requireObject(value, code, detail = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(2, code, detail);
}

export function parseFlags(args, definitions) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const definition = definitions[flag];
    if (!definition) fail(2, 'ARG_UNKNOWN', flag);
    if (definition.boolean) {
      result[definition.key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail(2, 'ARG_MISSING_VALUE', flag);
    result[definition.key] = value;
    index += 1;
  }
  for (const [flag, definition] of Object.entries(definitions)) {
    if (definition.required && !Object.hasOwn(result, definition.key)) fail(2, 'ARG_REQUIRED', flag);
  }
  return result;
}

// SCROLL ships inside Team QA (vendor/scroll, public v1). TEAMQA_SCROLL_ROOT points at another copy; a Team QA
// source checkout without the vendored copy falls back to a SCROLL checkout in ~/Dev/scroll.
export const BUNDLED_SCROLL_ROOT = fileURLToPath(new URL('../../vendor/scroll', import.meta.url));
export function scrollRoot(env = process.env) {
  if (env.TEAMQA_SCROLL_ROOT) return expandPath(env.TEAMQA_SCROLL_ROOT);
  if (existsSync(join(BUNDLED_SCROLL_ROOT, 'lib', 'effects.js'))) return BUNDLED_SCROLL_ROOT;
  return join(homedir(), 'Dev', 'scroll');
}

async function loadScrollModule(name) {
  const path = join(scrollRoot(), 'lib', name);
  if (!existsSync(path)) fail(5, 'SCROLL_UNAVAILABLE', path, 'ungraded');
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    fail(5, 'SCROLL_UNAVAILABLE', String(error?.message ?? error).split('\n')[0], 'ungraded');
  }
}

// A file another process may read at any moment (state.json under `roster.mjs wait`, hook events read by parallel hooks)
// is never seen half written: the content goes to a temporary file in the same folder, which then replaces the target in
// one step (rename). An exclusive write links the temporary file to the target instead, which fails when the target
// exists, as the old 'wx' write did; on a file system without hard links it falls back to that 'wx' write.
const NO_HARD_LINKS = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'];
export function writeAtomic(path, content, { exclusive = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
  try {
    if (!exclusive) { renameSync(temp, path); return; }
    try { linkSync(temp, path); }
    catch (error) {
      if (!NO_HARD_LINKS.includes(error?.code)) throw error;
      writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
    }
  } finally {
    try { unlinkSync(temp); } catch { /* renamed into place */ }
  }
}

// A file that parallel processes read and then rewrite (the case ledger of parallel dispatches) is changed under an
// exclusive lock file next to it (<file>.lock, created with O_EXCL and holding the owner's pid). A waiter retries until
// timeoutMs and then fails FILE_LOCK_TIMEOUT. A lock older than staleMs whose owner process is gone is moved aside and
// taken. The lock is released when fn settles.
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
function breakStaleLock(lock, staleMs) {
  let text, stat;
  try { stat = statSync(lock); text = readFileSync(lock, 'utf8'); } catch { return; }
  const owner = Number.parseInt(text, 10);
  if (Date.now() - stat.mtimeMs < staleMs || (Number.isInteger(owner) && owner > 0 && pidAlive(owner))) return;
  const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try { renameSync(lock, aside); } catch { return; }
  // Another waiter may have taken the lock between the read and the rename: give it back.
  let moved = '';
  try { moved = readFileSync(aside, 'utf8'); } catch { /* gone */ }
  if (moved !== text) { try { linkSync(aside, lock); } catch { /* a newer lock exists */ } }
  try { unlinkSync(aside); } catch { /* already gone */ }
}
export async function withFileLock(target, fn, { timeoutMs = 60_000, staleMs = 120_000, pollMs = 10 } = {}) {
  const lock = `${target}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try { fd = openSync(lock, 'wx'); break; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      breakStaleLock(lock, staleMs);
      if (Date.now() >= deadline) fail(3, 'FILE_LOCK_TIMEOUT', `${lock}: another process holds it; remove it only when no dispatch of the run is running`, 'ungraded');
      await new Promise((done) => setTimeout(done, pollMs + Math.floor(Math.random() * pollMs)));
    }
  }
  try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
  try { return await fn(); }
  finally { try { unlinkSync(lock); } catch { /* released */ } }
}

export async function writeConfirmed(path, content, tool = 'fs.write', { exclusive = false } = {}) {
  writeAtomic(path, content, { exclusive });
  const expected = sha256(content);
  const { confirmEffect } = await loadScrollModule('effects.js');
  const confirmed = await confirmEffect({
    tool,
    tier: 'reversible_write',
    confirm: { probe: 'fs.read', expect: `$.sha256 == '${expected}'` },
    invoke: async () => ({ sha256: sha256(readFileSync(path, 'utf8')) }),
  });
  if (!confirmed.ok || !confirmed.checked) fail(1, 'EFFECT_UNCONFIRMED', basename(path));
  return { path, sha256: expected, effect: 'confirmed' };
}

export async function appendConfirmed(path, line, tool = 'fs.append') {
  return withFileLock(path, () => {
    const previous = existsSync(path) ? readText(path) : '';
    return writeConfirmed(path, `${previous}${line}`, tool);
  });
}

export async function appendScrollLedger({ cwd, runId, caseId, status, evidence, digest, tries = 1 }) {
  const loopDir = join(cwd, 'runs', runId);
  mkdirSync(loopDir, { recursive: true });
  const row = {
    ts: new Date().toISOString(),
    loop: `team-qa-${runId}`,
    iteration: 1,
    task: caseId,
    status,
    tries,
    proof: Array.isArray(evidence) ? evidence.join(',') : String(evidence ?? ''),
    digest: String(digest ?? ''),
  };
  const { appendLedgerRow } = await loadScrollModule('ledger.js');
  appendLedgerRow(`local://runs/${runId}/ledger.csv`, cwd, loopDir, row);
  const auditPath = join(loopDir, 'ledger.jsonl');
  const lines = readText(auditPath).trim().split('\n');
  const observed = parseJson(lines.at(-1), 'SCROLL_LEDGER_READBACK_INVALID', 1);
  if (observed.task !== row.task || observed.status !== row.status || observed.proof !== row.proof) {
    fail(1, 'EFFECT_UNCONFIRMED', `scroll-ledger ${caseId}`);
  }
  return { effect: 'confirmed', path: auditPath };
}

function expandCommandPart(part, base) {
  if (typeof part !== 'string' || part.length === 0) fail(2, 'ADAPTER_COMMAND_INVALID');
  if (part === '~' || part.startsWith('~/') || part.startsWith('./') || part.startsWith('../')) {
    return expandPath(part, base);
  }
  return part;
}

export function runAdapter(command, options = {}) {
  if (!Array.isArray(command) || command.length === 0) fail(2, 'ADAPTER_COMMAND_INVALID');
  const cwd = options.cwd ?? process.cwd();
  const [program, ...args] = command.map((part) => expandCommandPart(part, cwd));
  const result = spawnSync(program, args, {
    cwd,
    ...(options.input === undefined ? {} : { input: options.input }),
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message ?? result.error) : '',
  };
}

export function outputJson(result, code = 'ADAPTER_READBACK_INVALID') {
  const lines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // Continue until a machine-readable adapter line is found.
    }
  }
  fail(1, code);
}

export async function confirmExternalEffect({ tool, readback, expected, cwd, env }) {
  const { confirmEffect } = await loadScrollModule('effects.js');
  let observed;
  const confirmed = await confirmEffect({
    tool,
    tier: 'external_comm',
    confirm: { probe: 'configured-readback', expect: `$.content_sha256 == '${expected.content_sha256}'` },
    invoke: async () => {
      const result = runAdapter(readback, { cwd, env });
      if (result.status !== 0 || result.signal) throw new Error(result.error || result.stderr || 'readback failed');
      observed = outputJson(result);
      return observed;
    },
  });
  if (!confirmed.ok) fail(1, 'EFFECT_UNCONFIRMED', tool);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) fail(1, 'EFFECT_UNCONFIRMED', tool);
  return observed;
}

export function safeRunId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    fail(2, 'RUN_ID_INVALID', String(value ?? ''));
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function fileLabel(path) {
  return basename(path);
}
