// Detached dispatch and wait (upgrade U6).
//   roster.mjs dispatch … --detach
//   roster.mjs wait --run-dir runs/<id> --attempt <attempt> [--max-seconds 540]
// A worker may run for 30 minutes, past the 10-minute cap of one Bash call, so a root ran each dispatch in the
// background and polled it with sleep, and every wake-up re-read its whole context. `--detach` starts the same dispatch
// in the background and returns at once with its attempt id: dispatch/<role>/<attempt>/state.json goes starting →
// running → done | failed (with the dispatch's error code), and the worker's stream is copied to progress.jsonl as it
// arrives. `wait` blocks until the dispatch ends or --max-seconds pass (default 540, under the Bash cap) and prints one
// line: the state, the worker's turns so far, its last Dragon call and the time it has run. A dispatch without
// --detach runs as before; the attested stdout.jsonl and the attestation are written the same way in both.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, readJson, stableJson, writeConfirmed } from './core.mjs';

export const STATE_SCHEMA = 'team-qa/dispatch-state/v1';
export const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const WAIT_DEFAULT_SECONDS = 540;
const CLI = fileURLToPath(new URL('../roster.mjs', import.meta.url));
const ROLES = ['test_manager', 'analyst', 'designer', 'executor_gui', 'executor_code'];
const canonicalRole = (role) => String(role).replaceAll('-', '_');
const refuse = (code, detail = '') => fail(3, code, detail, 'ungraded');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const attemptDir = (runDir, role, attempt) => join(resolve(runDir), 'dispatch', canonicalRole(role), attempt);

// A process is the one a state file names only when its start time matches too: after a reboot or a long wait the
// same pid can belong to another process. The start time is what `ps -o lstart=` prints (Linux and macOS); null when
// it cannot be read, and then only the pid is checked.
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  const text = r.status === 0 && !r.error ? String(r.stdout).trim() : '';
  return text || null;
}

// The detached start: validate what the background dispatch needs to find its arguments, record `starting`, launch it.
export async function detachDispatch({ argv, runDir, role, prompt, out, caseId = null, screenId = null, env = process.env }) {
  if (env.TEAMQA_DISPATCH_ATTEMPT) refuse('DISPATCH_DETACH_NESTED');
  for (const [flag, value] of [['--run-dir', runDir], ['--role', role], ['--prompt', prompt], ['--out', out]]) if (!value) fail(2, 'ARG_REQUIRED', flag);
  if (!ROLES.includes(canonicalRole(role))) refuse('DISPATCH_ROLE_UNKNOWN', role);
  if (existsSync(resolve(out))) refuse('DISPATCH_OUTPUT_EXISTS', out);
  // The binding path is refused here too, before the background dispatch starts.
  const bindings = resolve(runDir, 'role-bindings');
  if (resolve(out) === bindings || resolve(out).startsWith(`${bindings}/`)) refuse('DISPATCH_OUTPUT_IS_BINDING', `${out}: write the attestation outside role-bindings/`);
  // A mistyped prompt is refused here, before an attempt exists (M1).
  let promptIsFile = false;
  try { promptIsFile = statSync(resolve(prompt)).isFile(); } catch { promptIsFile = false; }
  if (!promptIsFile) refuse('DISPATCH_PROMPT_MISSING', `${prompt}: not a readable file`);
  const attempt = randomUUID(), dir = attemptDir(runDir, role, attempt), statePath = join(dir, 'state.json');
  await writeConfirmed(statePath, stableJson({ schema: STATE_SCHEMA, attempt, role: canonicalRole(role), case_id: caseId, ...(screenId ? { screen_id: screenId } : {}), out: resolve(out),
    status: 'starting', created_at: new Date().toISOString() }), 'teamqa.dispatch.state', { exclusive: true });
  const log = openSync(join(dir, 'detach.log'), 'a');
  const child = spawn(process.execPath, [CLI, 'dispatch', ...argv.filter((arg) => arg !== '--detach')],
    { cwd: process.cwd(), env: { ...env, TEAMQA_DISPATCH_ATTEMPT: attempt }, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  await writeConfirmed(join(dir, 'launcher.json'), stableJson({ attempt, pid: child.pid ?? null, pid_started: processStartTime(child.pid), launched_at: new Date().toISOString() }), 'teamqa.dispatch.launcher');
  child.unref();
  return { attempt, state: statePath, next: `node ${CLI} wait --run-dir ${resolve(runDir)} --attempt ${attempt}` };
}

// The background side: the parent's `starting` record must name this attempt, role, case and output; the dispatch runs
// with this attempt id and records how it ended.
export async function runDetached({ runDir, role, out, caseId = null, attempt, run }) {
  if (!ATTEMPT_ID.test(String(attempt))) refuse('DISPATCH_ATTEMPT_INVALID', String(attempt));
  const dir = attemptDir(runDir, role, attempt), statePath = join(dir, 'state.json');
  const state = existsSync(statePath) ? readJson(statePath) : null;
  if (!(state?.schema === STATE_SCHEMA && state.status === 'starting' && state.attempt === attempt && state.role === canonicalRole(role)
    && state.out === resolve(out) && state.case_id === caseId)) refuse('DISPATCH_DETACH_STATE', statePath);
  const started_at = new Date().toISOString(), pid_started = processStartTime(process.pid);
  await writeConfirmed(statePath, stableJson({ ...state, status: 'running', pid: process.pid, pid_started, started_at }), 'teamqa.dispatch.state');
  try {
    const a = await run({ attemptId: attempt, progress: join(dir, 'progress.jsonl') });
    await writeConfirmed(statePath, stableJson({ ...state, status: 'done', pid: process.pid, pid_started, started_at, ended_at: new Date().toISOString(), graded: a.graded === true }), 'teamqa.dispatch.state');
    return a;
  } catch (error) {
    await writeConfirmed(statePath, stableJson({ ...state, status: 'failed', pid: process.pid, pid_started, started_at, ended_at: new Date().toISOString(),
      code: error?.code || 'INTERNAL_ERROR', detail: String(error?.detail ?? error?.message ?? error).split('\n')[0].slice(0, 500),
      verdict: error?.verdict || 'fail', exit: Number.isInteger(error?.exitCode) ? error.exitCode : 1 }), 'teamqa.dispatch.state');
    throw error;
  }
}

// The worker's stdout as spawnSync gives it (status, signal, error, stdout, stderr; the same timeout and per-stream
// maxBuffer), with stdout also appended to `progress` as it arrives (no file when progress is null). A worker stopped
// for its timeout or its buffer gets SIGTERM, and SIGKILL when it is still running killGraceMs later.
export const KILL_GRACE_MS = 10_000;
export function runStreaming(bin, args, { cwd, input, timeout, maxBuffer, env, progress, killGraceMs = KILL_GRACE_MS }) {
  return new Promise((done) => {
    const fd = progress ? openSync(progress, 'a') : null, out = [], err = [];
    let outBytes = 0, errBytes = 0, error = null, finished = false, killer = null;
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = (e) => {
      error ??= e;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killer ??= setTimeout(() => { if (!finished) { try { child.kill('SIGKILL'); } catch { /* already gone */ } } }, killGraceMs);
    };
    const timer = setTimeout(() => stop(Object.assign(new Error(`spawn ${bin} ETIMEDOUT`), { code: 'ETIMEDOUT' })), timeout);
    const finish = (status, signal) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killer); if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
      done({ status: error ? null : status, signal: signal ?? null, error, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBuffer) return stop(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' }));
      out.push(chunk); if (fd !== null) { try { writeSync(fd, chunk); } catch { /* progress is informational */ } }
    });
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length;
      if (errBytes > maxBuffer) return stop(Object.assign(new Error('stderr maxBuffer length exceeded'), { code: 'ENOBUFS' }));
      err.push(chunk);
    });
    child.on('error', (e) => { error ??= e; if (child.pid === undefined) finish(null, null); });
    child.on('close', finish);
    child.stdin.on('error', () => { /* the worker may exit before reading its input */ });
    child.stdin.end(input);
  });
}

// What a stream-json log shows so far: assistant turns (distinct message ids) and the last Dragon call.
export function streamProgress(text) {
  const turns = new Set();
  let lastDragon = null;
  for (const line of String(text || '').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    turns.add(e.message.id ?? e.uuid ?? turns.size);
    for (const b of e.message.content) {
      if (b?.type !== 'tool_use' || !/dragon/i.test(b.name ?? '')) continue;
      lastDragon = /__dragon_rpc$/.test(b.name) ? b.input?.method ?? 'dragon_rpc' : String(b.name).split('__').at(-1);
    }
  }
  return { turns: turns.size, last_dragon: lastDragon };
}

// Alive and, when its start time was recorded, still the same process (a record from before 1.15.2 has none).
const alive = (pid, started = null) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  if (!started) return true;
  const now = processStartTime(pid);
  return now === null || now === started;
};
function locate(runDir, attempt) {
  const base = join(resolve(runDir), 'dispatch');
  const found = existsSync(base) ? readdirSync(base).filter((role) => ROLES.includes(role) && existsSync(join(base, role, attempt, 'state.json'))) : [];
  if (found.length !== 1) refuse('DISPATCH_ATTEMPT_UNKNOWN', attempt);
  return join(base, found[0], attempt);
}

// Blocks until the attempt ends or maxSeconds pass. The result names the state and what the worker has done so far.
export async function waitDispatch({ runDir, attempt, maxSeconds = WAIT_DEFAULT_SECONDS, pollMs = 1000, now = Date.now }) {
  if (!ATTEMPT_ID.test(String(attempt))) refuse('DISPATCH_ATTEMPT_INVALID', String(attempt));
  const seconds = Number(maxSeconds);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 590) fail(2, 'WAIT_MAX_SECONDS', `${maxSeconds} (0–590, under the 10-minute Bash cap)`);
  const dir = locate(runDir, attempt), statePath = join(dir, 'state.json'), deadline = now() + seconds * 1000;
  const launcher = () => (existsSync(join(dir, 'launcher.json')) ? readJson(join(dir, 'launcher.json')) : {});
  let state;
  for (;;) {
    state = readJson(statePath);
    if (['done', 'failed'].includes(state.status)) break;
    const owner = state.status === 'running' ? { pid: state.pid, started: state.pid_started } : (({ pid = null, pid_started = null }) => ({ pid, started: pid_started }))(launcher());
    const pid = owner.pid ?? null;
    if (pid !== null && !alive(pid, owner.started)) {
      state = readJson(statePath);
      if (!['done', 'failed'].includes(state.status)) state = { ...state, status: 'failed', code: 'DISPATCH_DIED', detail: `process ${pid} ended without recording an outcome`, verdict: 'ungraded', exit: 3 };
      break;
    }
    if (now() >= deadline) break;
    await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
  }
  const progressPath = join(dir, 'progress.jsonl');
  const progress = streamProgress(existsSync(progressPath) ? readFileSync(progressPath, 'utf8') : '');
  const start = Date.parse(state.started_at ?? state.created_at), end = state.ended_at ? Date.parse(state.ended_at) : now();
  return { attempt, status: state.status, role: state.role, case_id: state.case_id, out: state.out, ...progress,
    elapsed_s: Number.isFinite(start) ? Math.max(0, Math.round((end - start) / 1000)) : null,
    ...(state.status === 'done' ? { graded: state.graded } : {}),
    ...(state.status === 'failed' ? { code: state.code, detail: state.detail, verdict: state.verdict, exit: state.exit } : {}) };
}
