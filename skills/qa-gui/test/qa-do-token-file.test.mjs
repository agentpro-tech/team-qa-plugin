import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts/qa_do.mjs');
const FIXTURE_TOKEN = 'fixture-token-never-real';

function runQaDo(env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [SCRIPT, '--method', 'listTabs'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

test('qa_do reads a custom token file, authenticates, and redacts the token', async () => {
  let authorization = '';
  let requestBody = '';
  const server = createServer((request, response) => {
    authorization = String(request.headers.authorization || '');
    request.setEncoding('utf8');
    request.on('data', (chunk) => { requestBody += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { tabs: [] } }));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const scratch = await mkdtemp(join(tmpdir(), 'qa-gui-token-file-'));
  const tokenFile = join(scratch, 'service-token');
  await writeFile(tokenFile, `${FIXTURE_TOKEN}\n`, { mode: 0o600 });
  try {
    const address = server.address();
    const run = await runQaDo({
      ...process.env,
      DRAGON_RPC: `http://127.0.0.1:${address.port}/rpc`,
      DRAGON_RPC_TOKEN: '',
      DRAGON_RPC_TOKEN_FILE: tokenFile,
    });
    assert.equal(run.signal, null);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.equal(authorization, `Bearer ${FIXTURE_TOKEN}`);
    assert.deepEqual(JSON.parse(requestBody), { method: 'listTabs', params: {} });
    assert.equal(run.stdout.includes(FIXTURE_TOKEN), false);
    assert.equal(run.stderr.includes(FIXTURE_TOKEN), false);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(scratch, { recursive: true, force: true });
  }
});
