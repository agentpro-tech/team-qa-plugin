import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PREFLIGHT = resolve(ROOT, 'scripts/dragon-hard-surface-preflight.mjs');
const QA_DO = resolve(ROOT, 'scripts/qa_do.mjs');
const TOKEN = 'failclosed-fixture-token';

function run(script, args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}

async function fixture(responder) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || '{}');
    calls.push({ authorization: request.headers.authorization, body });
    const reply = responder(body, calls.length);
    response.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'application/json' });
    response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return {
    calls,
    rpc: `http://127.0.0.1:${server.address().port}/rpc`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

const binding = { sessionId: 'fixture-session', nonce: 'fixture-nonce', browserInstanceId: 'fixture-browser', forbidSyntheticDOM: false };

test('clients fail before network when no bearer token is available', async () => {
  const env = {
    DRAGON_RPC: 'http://127.0.0.1:1/rpc',
    DRAGON_RPC_TOKEN: '',
    DRAGON_RPC_TOKEN_FILE: '/definitely/missing/dragon-token',
  };
  for (const [script, args] of [[PREFLIGHT, ['--tab-id', '42', '--json']], [QA_DO, ['--method', 'listTabs']]]) {
    const result = await run(script, args, env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /bearer token is missing/i);
  }
});

test('preflight rejects missing session binding', async () => {
  const rpc = await fixture(() => ({ body: { ok: true, result: { sessionId: 'fixture-session', forbidSyntheticDOM: false } } }));
  try {
    const result = await run(PREFLIGHT, ['--tab-id', '42', '--json'], { DRAGON_RPC: rpc.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /nonce\/browserInstanceId/i);
    assert.equal(rpc.calls.length, 2);
    assert.equal(typeof rpc.calls[0].body.params.sessionId, 'string');
    assert.equal(rpc.calls[1].body.method, 'session.close');
    assert.equal(rpc.calls[1].body.params.sessionId, 'fixture-session');
  } finally { await rpc.close(); }
});

test('preflight closes the created session when Dragon refuses the requested policy', async () => {
  const rpc = await fixture((_body, call) => call === 1
    ? { body: { ok: true, result: { ...binding, forbidSyntheticDOM: true } } }
    : { body: { ok: true, result: { ok: true, closedTabs: 0 } } });
  try {
    const result = await run(PREFLIGHT, ['--tab-id', '42', '--json'], { DRAGON_RPC: rpc.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refused forbidSyntheticDOM=false/i);
    assert.equal(rpc.calls[1]?.body?.method, 'session.close');
    assert.equal(rpc.calls[1]?.body?.params?.nonce, binding.nonce);
  } finally { await rpc.close(); }
});

test('preflight rejects a nested Dragon denial', async () => {
  const rpc = await fixture((_body, call) => call === 1
    ? { body: { ok: true, result: binding } }
    : { body: { ok: true, result: { completed: true, results: [{ ok: false, code: 'CIRCUIT_OPEN', error: 'fixture denial' }] } } });
  try {
    const result = await run(PREFLIGHT, ['--tab-id', '42', '--json'], { DRAGON_RPC: rpc.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CIRCUIT_OPEN/);
    assert.equal(rpc.calls[2]?.body?.method, 'session.close');
  } finally { await rpc.close(); }
});

test('preflight closes its session, uses native Dragon signals, and preserves output on cleanup failure', async () => {
  const responder = (closeFails) => (_body, call) => {
    if (call === 1) return { body: { ok: true, result: binding } };
    if (call === 2) return { body: { ok: true, result: {
      reads: { hardSurfaceSnapshot: {} },
      snapshot: { crossOriginFrames: 1, shadowClosed: 1, canvasRegions: 1 },
    } } };
    return closeFails
      ? { body: { ok: true, result: { ok: false, code: 'CLOSE_FAILED', error: 'close boom' } } }
      : { body: { ok: true, result: { ok: true, closedTabs: 0 } } };
  };

  const clean = await fixture(responder(false));
  try {
    const result = await run(PREFLIGHT, ['--tab-id', '42', '--json'], { DRAGON_RPC: clean.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).risks.map((risk) => risk.type).sort(), [
      'canvas-only-control', 'closed-shadow-root', 'cross-origin-iframe',
    ]);
    assert.equal(clean.calls[2]?.body?.method, 'session.close');
    assert.deepEqual(clean.calls[2]?.body?.params, {
      sessionId: binding.sessionId,
      nonce: binding.nonce,
      browserInstanceId: binding.browserInstanceId,
    });
  } finally { await clean.close(); }

  const failedClose = await fixture(responder(true));
  try {
    const result = await run(PREFLIGHT, ['--tab-id', '42', '--json'], { DRAGON_RPC: failedClose.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).risks.length, 3);
    assert.match(result.stderr, /close boom/i);
  } finally { await failedClose.close(); }
});

test('preflight fails closed on HTTP unauthorized without exposing the token', async () => {
  const unauthorized = await fixture(() => ({ status: 401, body: { ok: false, code: 'UNAUTHORIZED', error: 'missing or invalid bearer token' } }));
  try {
    const result = await run(PREFLIGHT, ['--tab-id', '42', '--json'], { DRAGON_RPC: unauthorized.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid bearer token/i);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(TOKEN));
  } finally { await unauthorized.close(); }
});

test('preflight rejects malformed JSON and a missing snapshot', async () => {
  const malformed = await fixture(() => ({ body: 'not-json' }));
  try {
    const result = await run(PREFLIGHT, ['--tab-id', '42', '--json'], { DRAGON_RPC: malformed.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /malformed JSON/i);
  } finally { await malformed.close(); }

  const missing = await fixture((_body, call) => call === 1
    ? { body: { ok: true, result: binding } }
    : { body: { ok: true, result: { reads: {} } } });
  try {
    const result = await run(PREFLIGHT, ['--tab-id', '42', '--json'], { DRAGON_RPC: missing.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no hardSurfaceSnapshot/i);
  } finally { await missing.close(); }
});

test('preflight classifies CSP-blocked reads but rejects unrelated read errors', async () => {
  const csp = await fixture((_body, call) => call === 1
    ? { body: { ok: true, result: binding } }
    : { body: { ok: true, result: { reads: { hardSurfaceSnapshot: { __read_error: "unsafe-eval violates Content Security Policy script-src 'none'" } } } } });
  try {
    const result = await run(PREFLIGHT, ['--tab-id', '42', '--json'], { DRAGON_RPC: csp.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).risks, [{ type: 'csp-restricted' }]);
  } finally { await csp.close(); }

  const unrelated = await fixture((_body, call) => call === 1
    ? { body: { ok: true, result: binding } }
    : { body: { ok: true, result: { reads: { hardSurfaceSnapshot: { __read_error: 'renderer crashed' } } } } });
  try {
    const result = await run(PREFLIGHT, ['--tab-id', '42', '--json'], { DRAGON_RPC: unrelated.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /snapshot read failed/i);
  } finally { await unrelated.close(); }
});

test('qa_do rejects nested Dragon denials and malformed JSON', async () => {
  const denied = await fixture(() => ({ body: { ok: true, result: { completed: true, results: [{ ok: false, code: 'POLICY_DENIED', error: 'fixture denial' }] } } }));
  try {
    const result = await run(QA_DO, ['--method', 'listTabs'], { DRAGON_RPC: denied.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /POLICY_DENIED/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(TOKEN));
  } finally { await denied.close(); }

  const malformed = await fixture(() => ({ body: 'not-json' }));
  try {
    const result = await run(QA_DO, ['--method', 'listTabs'], { DRAGON_RPC: malformed.rpc, DRAGON_RPC_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /malformed JSON/i);
  } finally { await malformed.close(); }
});
