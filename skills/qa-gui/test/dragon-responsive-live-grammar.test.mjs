import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { RESPONSIVE_MATRIX } from '../scripts/loop7/responsive-matrix.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PRODUCT = resolve(ROOT, 'scripts/dragon-responsive-matrix-preflight.mjs');

test('responsive preflight uses only do-step forms accepted by the live Dragon grammar', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'dragon-live-grammar-'));
  const preload = resolve(dir, 'mock-fetch.mjs');
  const log = resolve(dir, 'calls.jsonl');
  await writeFile(preload, `
    import { appendFileSync } from 'node:fs';
    let viewport = { w: 0, h: 0 };
    globalThis.fetch = async (_url, options = {}) => {
      const body = JSON.parse(options.body || '{}');
      appendFileSync(process.env.MOCK_LOG, JSON.stringify(body) + '\\n');
      let result = { ok: true };
      if (body.method === 'session.create') result = { sessionId: 'grammar-session', nonce: 'grammar-nonce', browserInstanceId: 'grammar-browser', forbidSyntheticDOM: false };
      else if (body.method === 'setViewport') { viewport = { w: body.params.width, h: body.params.height }; result = viewport; }
      else if (body.method === 'do') {
        const unknown = (body.params.steps || []).find((step) => step.read == null && !Number.isFinite(Number(step.wait)));
        const reads = {
          ui: { viewport, verdict: 'PASS', issues: [] },
          a11y: { viewport, verdict: 'PASS', issues: [] },
        };
        for (const step of body.params.steps || []) {
          if (/^mobilePin\\d+$/.test(step.as || '')) reads[step.as] = {
            touchPoints: 5,
            dpr: 3,
            userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36',
            uaDataMobile: true,
            platform: 'Android',
          };
        }
        result = unknown
          ? { completed: true, results: [{ ok: false, code: 'INTERNAL', error: 'unknown step' }] }
          : { reads };
      } else if (body.method === 'captureTab') {
        result = { savedTo: '/tmp/' + viewport.w + 'x' + viewport.h + '.png', evidence: { kind: 'screenshot', ref: 'observation:' + viewport.w, contentHash: 'hash-' + viewport.w } };
      }
      const payload = { ok: true, result };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
  `);
  const child = spawn(process.execPath, ['--import', preload, PRODUCT, '--tab-id', '42', '--json'], {
    cwd: ROOT,
    env: { ...process.env, DRAGON_RPC: 'http://dragon.invalid/rpc', DRAGON_RPC_TOKEN: 'grammar-token', MOCK_LOG: log },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code ?? 1)));
  const calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  await rm(dir, { recursive: true, force: true });

  assert.equal(exitCode, 0, stderr);
  assert.equal(JSON.parse(stdout).matrix.length, RESPONSIVE_MATRIX.length);
  const doCalls = calls.filter((call) => call.method === 'do');
  assert.equal(doCalls.length, RESPONSIVE_MATRIX.length + RESPONSIVE_MATRIX.filter((row) => row.profile === 'mobile').length);
  assert.ok(doCalls.every((call) => call.params.steps.some((step) => Number(step.wait) > 0)));
  assert.ok(doCalls.every((call) => call.params.steps.every((step) => step.settle === undefined)));
});
