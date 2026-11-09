import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detachDispatch, runDetached, runStreaming, streamProgress, waitDispatch, STATE_SCHEMA } from '../../scripts/lib/dispatch-detach.mjs';

// Upgrade U6: a detached dispatch and `roster.mjs wait` instead of background jobs polled with sleep. Synthetic runs only.
const REPO = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const SCROLL = process.env.TEAMQA_SCROLL_ROOT || join(homedir(), 'Dev', 'scroll');
const NEEDS_SCROLL = !existsSync(join(SCROLL, 'lib', 'effects.js')) && 'SCROLL runtime unavailable (set TEAMQA_SCROLL_ROOT)';
const runDir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-detach-'))); mkdirSync(join(d, 'runs', 'r1'), { recursive: true }); return join(d, 'runs', 'r1'); };
const line = (o) => JSON.stringify(o) + '\n';
const assistant = (id, tool) => line({ type: 'assistant', message: { id, content: tool ? [{ type: 'tool_use', id: `t-${id}`, ...tool }] : [{ type: 'text', text: 'ok' }] } });

test('runStreaming returns what spawnSync returns and copies stdout to the progress file as it arrives', async () => {
  const dir = runDir(), progress = join(dir, 'progress.jsonl');
  const script = 'let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{for(const n of [1,2,3]){process.stdout.write(JSON.stringify({n,s})+"\\n");await new Promise(r=>setTimeout(r,50));}process.stderr.write("warn\\n");process.exit(4);});';
  const options = { cwd: dir, input: 'hello', timeout: 10000, maxBuffer: 1024 * 1024, env: process.env };
  const streamed = await runStreaming(process.execPath, ['-e', script], { ...options, progress });
  const sync = spawnSync(process.execPath, ['-e', script], { ...options, encoding: 'utf8' });
  assert.equal(streamed.status, 4); assert.equal(sync.status, 4);
  assert.equal(streamed.stdout, sync.stdout); assert.equal(streamed.stderr, sync.stderr);
  assert.equal(readFileSync(progress, 'utf8'), streamed.stdout);
  assert.equal(streamed.error, null);
  const slow = await runStreaming(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { ...options, timeout: 200, progress: join(dir, 'slow.jsonl') });
  assert.equal(slow.status, null); assert.equal(slow.error.code, 'ETIMEDOUT');
  const big = await runStreaming(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { ...options, maxBuffer: 1000, progress: join(dir, 'big.jsonl') });
  assert.equal(big.error.code, 'ENOBUFS');
  const missing = await runStreaming(join(dir, 'no-such-binary'), [], { ...options, progress: join(dir, 'missing.jsonl') });
  assert.equal(missing.error.code, 'ENOENT');
});

test('stream progress counts the worker turns and names its last Dragon call', () => {
  const text = assistant('m1', { name: 'mcp__Dragon_Browser__dragon_rpc', input: { method: 'session.create' } }) + assistant('m1')
    + assistant('m2', { name: 'mcp__Dragon_Browser__dragon_rpc', input: { method: 'do' } }) + assistant('m3', { name: 'Read', input: {} })
    + assistant('m4', { name: 'mcp__Dragon_Browser__screenshot', input: {} }) + '{not json\n';
  assert.deepEqual(streamProgress(text), { turns: 4, last_dragon: 'screenshot' });
  assert.deepEqual(streamProgress(''), { turns: 0, last_dragon: null });
});

test('a detached attempt records running and done; wait reports running before the deadline, then done', { skip: NEEDS_SCROLL }, async () => {
  const dir = runDir(), out = join(dir, 'attestation.json'), attempt = '0b5d8f9e-3c1a-4e2b-9f6d-7a8b9c0d1e2f';
  const state = join(dir, 'dispatch', 'executor_gui', attempt, 'state.json');
  mkdirSync(join(dir, 'dispatch', 'executor_gui', attempt), { recursive: true });
  writeFileSync(state, JSON.stringify({ schema: STATE_SCHEMA, attempt, role: 'executor_gui', case_id: 'TC-01', out, status: 'starting', created_at: new Date().toISOString() }));
  let release;
  const gate = new Promise((r) => { release = r; });
  const running = runDetached({ runDir: dir, role: 'executor_gui', out, caseId: 'TC-01', attempt, run: async ({ attemptId, progress }) => {
    assert.equal(attemptId, attempt);
    writeFileSync(progress, assistant('m1', { name: 'mcp__Dragon_Browser__dragon_rpc', input: { method: 'getPageIdentity' } }));
    await gate;
    return { graded: true };
  } });
  await new Promise((r) => setTimeout(r, 100));
  const early = await waitDispatch({ runDir: dir, attempt, maxSeconds: 0.3, pollMs: 50 });
  assert.equal(early.status, 'running');
  assert.equal(early.turns, 1); assert.equal(early.last_dragon, 'getPageIdentity');
  release();
  await running;
  const done = await waitDispatch({ runDir: dir, attempt, maxSeconds: 5, pollMs: 50 });
  assert.equal(done.status, 'done'); assert.equal(done.graded, true); assert.equal(done.out, out); assert.equal(done.case_id, 'TC-01');
  assert.ok(Number.isInteger(done.elapsed_s));
  // A second background run cannot take the same attempt, and a state that names another output is refused.
  await assert.rejects(runDetached({ runDir: dir, role: 'executor_gui', out, caseId: 'TC-01', attempt, run: async () => ({}) }), (e) => e.code === 'DISPATCH_DETACH_STATE');
});

test('a failed background dispatch is reported with its code and a nonzero exit; a dead worker is DISPATCH_DIED', { skip: NEEDS_SCROLL }, async () => {
  const dir = runDir(), out = join(dir, 'attestation.json');
  // The real CLI: dispatch --detach returns at once; the background dispatch fails (no approved roster) and records it.
  writeFileSync(join(dir, 'prompt.md'), 'test the case');
  const env = { ...process.env, TEAMQA_SCROLL_ROOT: SCROLL };
  const started = spawnSync(process.execPath, [join(REPO, 'scripts/roster.mjs'), 'dispatch', '--run-dir', dir, '--role', 'executor_gui', '--case-id', 'TC-01', '--prompt', join(dir, 'prompt.md'), '--out', out, '--detach'], { encoding: 'utf8', env });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const attempt = /attempt=([0-9a-f-]{36})/.exec(started.stdout)?.[1];
  assert.ok(attempt, started.stdout);
  assert.match(started.stdout, /verdict=pass DISPATCH_DETACHED .*next=".*roster\.mjs wait --run-dir .* --attempt /);
  const waited = spawnSync(process.execPath, [join(REPO, 'scripts/roster.mjs'), 'wait', '--run-dir', dir, '--attempt', attempt, '--max-seconds', '60'], { encoding: 'utf8', env });
  assert.notEqual(waited.status, 0, waited.stdout + waited.stderr);
  assert.match(waited.stderr, /DISPATCH_FAILED attempt=\S+ status=failed turns=0 last_dragon=none elapsed=\d+s code=[A-Z_]+/);
  assert.ok(!existsSync(out), 'no attestation');
  // A running record whose process is gone.
  const ghost = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', gdir = join(dir, 'dispatch', 'executor_gui', ghost);
  mkdirSync(gdir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeFileSync(join(gdir, 'state.json'), JSON.stringify({ schema: STATE_SCHEMA, attempt: ghost, role: 'executor_gui', case_id: null, out, status: 'running', pid: Number(dead), created_at: new Date().toISOString(), started_at: new Date().toISOString() }));
  const died = await waitDispatch({ runDir: dir, attempt: ghost, maxSeconds: 5, pollMs: 50 });
  assert.equal(died.status, 'failed'); assert.equal(died.code, 'DISPATCH_DIED'); assert.equal(died.exit, 3);
  await assert.rejects(waitDispatch({ runDir: dir, attempt: '9f9f9f9f-9f9f-4f9f-9f9f-9f9f9f9f9f9f' }), (e) => e.code === 'DISPATCH_ATTEMPT_UNKNOWN');
  await assert.rejects(waitDispatch({ runDir: dir, attempt: ghost, maxSeconds: 900 }), (e) => e.code === 'WAIT_MAX_SECONDS');
  await assert.rejects(detachDispatch({ argv: [], runDir: dir, role: 'executor_gui', prompt: 'p', out, env: { TEAMQA_DISPATCH_ATTEMPT: ghost } }), (e) => e.code === 'DISPATCH_DETACH_NESTED');
});

// --out role-bindings/<role>.json used to run the worker and then fail ROLE_ATTESTATION_EXISTS.
test('the attestation output may not be the binding path: refused before the background dispatch starts', async () => {
  const { outputIsBinding } = await import('../../scripts/lib/roster.mjs');
  const dir = runDir();
  assert.equal(outputIsBinding(dir, join(dir, 'role-bindings', 'analyst.json')), true);
  assert.equal(outputIsBinding(dir, join(dir, 'role-bindings', 'executor_gui', 'attempt-2.json')), true);
  assert.equal(outputIsBinding(dir, join(dir, 'attestations', 'analyst.json')), false);
  assert.equal(outputIsBinding(dir, join(dir, 'role-bindings-old.json')), false);
  await assert.rejects(detachDispatch({ argv: [], runDir: dir, role: 'analyst', prompt: 'p', out: join(dir, 'role-bindings', 'analyst.json'), env: {} }),
    (e) => e.code === 'DISPATCH_OUTPUT_IS_BINDING');
  assert.equal(existsSync(join(dir, 'dispatch')), false, 'no state was written');
});

// Upgrade M3: `wait` reads state.json while the background dispatch rewrites it. A torn read was JSON_INVALID, and the
// root could dispatch the case again while the worker still ran.
test('wait never reads a half-written state file while the dispatch records its outcome', { skip: NEEDS_SCROLL }, async () => {
  const { splitWrites } = await import('../support/split-writes.mjs');
  const dir = runDir(), out = join(dir, 'attestation.json'), attempt = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
  const attemptDir = join(dir, 'dispatch', 'executor_gui', attempt), state = join(attemptDir, 'state.json');
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(state, JSON.stringify({ schema: STATE_SCHEMA, attempt, role: 'executor_gui', case_id: 'TC-01', out, status: 'starting', created_at: new Date().toISOString() }));
  const reads = [];
  const restore = splitWrites(attemptDir, (path) => { if (path.endsWith('state.json') || path.includes('.state.json.')) reads.push(waitDispatch({ runDir: dir, attempt, maxSeconds: 0 }).then((r) => r.status, (e) => e.code)); });
  try { await runDetached({ runDir: dir, role: 'executor_gui', out, caseId: 'TC-01', attempt, run: async () => ({ graded: true }) }); }
  finally { restore(); }
  const statuses = await Promise.all(reads);
  assert.ok(statuses.length >= 2, 'wait read during both state writes');
  assert.ok(statuses.every((s) => ['starting', 'running', 'done'].includes(s)), `wait saw: ${statuses.join(', ')}`);
});

// M1: the attempt was recorded before the prompt file was read, so a mistyped --prompt used up a case's tries.
test('a dispatch reads its prompt before it records an attempt; a detached one refuses a missing prompt at once', { skip: NEEDS_SCROLL }, async () => {
  const { approveRoster, dispatchRole, selectRoster } = await import('../../scripts/lib/roster.mjs');
  const { sha256File } = await import('../../scripts/lib/core.mjs');
  const dir = runDir(), request = JSON.parse(readFileSync(join(REPO, 'test/roster-dynamic/request-default.json'), 'utf8'));
  const catalogPath = join(REPO, 'test/roster-dynamic/catalog-openai-v1.json'), rosterPath = join(dir, 'roster.json');
  writeFileSync(rosterPath, JSON.stringify(selectRoster({ catalog: JSON.parse(readFileSync(catalogPath, 'utf8')), request, catalogPath }), null, 2) + '\n');
  await approveRoster({ runDir: dir, file: rosterPath, userEvent: { schema: 'team-qa/roster-user-event/v1', id: 'fixture-approval', actor: 'user', text: 'Approve',
    run_id: request.run_id, round: request.round, roster_hash: sha256File(rosterPath) } });
  for (const prompt of [join(dir, 'promt.md'), dir]) {
    await assert.rejects(dispatchRole({ runDir: dir, role: 'test_manager', prompt, out: join(dir, 'receipt.json') }), (e) => e.code === 'DISPATCH_PROMPT_MISSING', prompt);
  }
  assert.equal(existsSync(join(dir, 'dispatch')), false, 'nothing was recorded for the mistyped prompt');
  await assert.rejects(detachDispatch({ argv: [], runDir: dir, role: 'executor_gui', caseId: 'TC-01', prompt: join(dir, 'promt.md'), out: join(dir, 'attestation.json'), env: {} }),
    (e) => e.code === 'DISPATCH_PROMPT_MISSING');
  assert.equal(existsSync(join(dir, 'dispatch')), false, 'no detached attempt was started');
});

// M4: liveness was kill(pid, 0) only, so a pid reused after a reboot kept a dead dispatch "running"; a timeout sent
// SIGTERM once, and a worker that ignored it kept running and spending.
test('wait compares the recorded process start time, so a reused pid is not the dispatch', { skip: NEEDS_SCROLL }, async () => {
  const dir = runDir(), out = join(dir, 'attestation.json');
  const reused = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b', rdir = join(dir, 'dispatch', 'executor_gui', reused);
  mkdirSync(rdir, { recursive: true });
  // This test's own process is alive, but it is not the process that started the dispatch.
  writeFileSync(join(rdir, 'state.json'), JSON.stringify({ schema: STATE_SCHEMA, attempt: reused, role: 'executor_gui', case_id: null, out, status: 'running',
    pid: process.pid, pid_started: 'Thu Jan  1 00:00:00 1970', created_at: new Date().toISOString(), started_at: new Date().toISOString() }));
  const died = await waitDispatch({ runDir: dir, attempt: reused, maxSeconds: 2, pollMs: 50 });
  assert.equal(died.status, 'failed');
  assert.equal(died.code, 'DISPATCH_DIED');
  // A running record from this process, with its true start time, is alive; runDetached records that start time.
  const live = '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c', ldir = join(dir, 'dispatch', 'executor_gui', live);
  mkdirSync(ldir, { recursive: true });
  writeFileSync(join(ldir, 'state.json'), JSON.stringify({ schema: STATE_SCHEMA, attempt: live, role: 'executor_gui', case_id: null, out, status: 'starting', created_at: new Date().toISOString() }));
  let release; const gate = new Promise((r) => { release = r; });
  const running = runDetached({ runDir: dir, role: 'executor_gui', out, caseId: null, attempt: live, run: async () => { await gate; return { graded: false }; } });
  await new Promise((r) => setTimeout(r, 100));
  const recorded = JSON.parse(readFileSync(join(ldir, 'state.json'), 'utf8'));
  assert.ok(typeof recorded.pid_started === 'string' && recorded.pid_started.length > 0, 'the start time is recorded');
  assert.equal((await waitDispatch({ runDir: dir, attempt: live, maxSeconds: 0.3, pollMs: 50 })).status, 'running');
  release(); await running;
});

test('a timed-out worker that ignores SIGTERM is killed after the grace period', async () => {
  const dir = runDir(), started = Date.now();
  const stubborn = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),8000);';
  const result = await runStreaming(process.execPath, ['-e', stubborn], { cwd: dir, input: '', timeout: 300, killGraceMs: 500, maxBuffer: 1024, env: process.env, progress: join(dir, 'stubborn.jsonl') });
  assert.ok(Date.now() - started < 5000, `the worker ran ${Date.now() - started} ms`);
  assert.equal(result.error.code, 'ETIMEDOUT');
  assert.equal(result.signal, 'SIGKILL');
  // Without a progress file (a dispatch without --detach) it behaves the same.
  const plain = await runStreaming(process.execPath, ['-e', 'process.stdout.write("ok")'], { cwd: dir, input: '', timeout: 5000, maxBuffer: 1024, env: process.env, progress: null });
  assert.equal(plain.status, 0); assert.equal(plain.stdout, 'ok');
});
