import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const QA_DO = resolve(ROOT, 'scripts/qa_do.mjs');
const TOKEN = 'qa-do-verdict-fixture-token';

function run(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [QA_DO, ...args], {
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

// Replies with one fixed HTTP status and body to the `do` call, then reports what qa_do printed.
async function doVerdict(reply) {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const scratch = await mkdtemp(join(tmpdir(), 'qa-do-verdict-'));
  const payload = join(scratch, 'payload.json');
  await writeFile(payload, JSON.stringify({ tabId: 1, steps: [{ click: '#save' }, { assert: 'saved' }] }));
  try {
    const result = await run([payload], { DRAGON_RPC: `http://127.0.0.1:${server.address().port}/rpc`, DRAGON_RPC_TOKEN: TOKEN });
    return { ...result, out: JSON.parse(result.stdout) };
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(scratch, { recursive: true, force: true });
  }
}

const passing = [{ ok: true, what: 'title visible' }];

test('qa_do: a completed run whose asserts all hold is PASS', async () => {
  const { code, out } = await doVerdict({ body: { ok: true, result: { completed: true, results: [{ ok: true }, { ok: true }], asserts: passing } } });
  assert.equal(out.verdict, 'PASS');
  assert.equal(out.ok, true);
  assert.equal(code, 0);
});

test('qa_do: a failed step after passing asserts is UNGRADED, never PASS', async () => {
  const { code, out } = await doVerdict({ body: { ok: true, result: { completed: false, asserts: passing,
    results: [{ ok: true }, { ok: false, code: 'TIMEOUT', reason: 'click target not found' }] } } });
  assert.equal(out.ok, false);
  assert.equal(out.verdict, 'UNGRADED');
  assert.equal(code, 1);
});

test('qa_do: an incomplete run with passing asserts and no failed step is UNGRADED', async () => {
  const { out } = await doVerdict({ body: { ok: true, result: { completed: false, results: [{ ok: true }], asserts: passing } } });
  assert.equal(out.verdict, 'UNGRADED');
});

test('qa_do: an HTTP error or a denied call with passing asserts is UNGRADED', async () => {
  const http = await doVerdict({ status: 500, body: { ok: true, result: { completed: true, asserts: passing } } });
  assert.equal(http.out.verdict, 'UNGRADED');
  assert.equal(http.code, 1);
  const denied = await doVerdict({ body: { ok: true, result: { ok: false, code: 'POLICY_DENIED', completed: true, asserts: passing } } });
  assert.equal(denied.out.verdict, 'UNGRADED');
});

test('qa_do: a failed assert is FAIL whether or not the run completed', async () => {
  const failedAssert = [{ ok: true }, { ok: false, what: 'saved toast' }];
  const complete = await doVerdict({ body: { ok: true, result: { completed: true, results: [{ ok: true }], asserts: failedAssert } } });
  assert.equal(complete.out.verdict, 'FAIL');
  const broken = await doVerdict({ body: { ok: true, result: { completed: false, asserts: failedAssert,
    results: [{ ok: false, code: 'STEP_FAILED' }] } } });
  assert.equal(broken.out.verdict, 'FAIL');
});

test('qa_do: a failed run without asserts is UNGRADED, a clean one stays n/a', async () => {
  const broken = await doVerdict({ body: { ok: true, result: { completed: false, results: [{ ok: false, code: 'STEP_FAILED' }] } } });
  assert.equal(broken.out.verdict, 'UNGRADED');
  const clean = await doVerdict({ body: { ok: true, result: { completed: true, results: [{ ok: true }], reads: { title: 'x' } } } });
  assert.equal(clean.out.verdict, 'n/a');
});
