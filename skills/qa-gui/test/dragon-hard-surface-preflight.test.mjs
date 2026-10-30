import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const PREFLIGHT = resolve(ROOT, 'scripts/dragon-hard-surface-preflight.mjs');
const QA_DO = resolve(ROOT, 'scripts/qa_do.mjs');
const LIVE_HARD_FIXTURE = resolve(ROOT, '.teamcode/hard-surface/fixtures/live-hard.html');
const TOKEN = 'planner-red-proof-token';

async function runCli(script, args) {
  const fixtureDir = await mkdtemp(resolve(tmpdir(), 'dragon-preflight-test-'));
  const preload = resolve(fixtureDir, 'mock-fetch.mjs');
  const log = resolve(fixtureDir, 'requests.jsonl');
  await writeFile(preload, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (_url, options = {}) => {
      const body = JSON.parse(options.body || '{}');
      appendFileSync(process.env.MOCK_LOG, JSON.stringify({ authorization: options.headers?.Authorization ?? options.headers?.authorization, body }) + '\\n');
      let result = { tabs: [] };
      if (body.method === 'session.create') result = { sessionId: 'fixture-session', nonce: 'fixture-nonce', browserInstanceId: 'fixture-browser', forbidSyntheticDOM: false };
      if (body.method === 'do') result = { reads: { hardSurfaceSnapshot: { canvases: [{ interactive: true, semanticFallback: false, pointerHandler: true }] } } };
      const payload = { ok: true, result };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      };
    };
  `);
  const child = spawn(process.execPath, ['--import', preload, script, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      DRAGON_RPC: 'http://dragon.invalid/rpc',
      DRAGON_RPC_TOKEN: TOKEN,
      MOCK_LOG: log,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolveExit(124);
    }, 5000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code ?? 1);
    });
  });
  let requests = [];
  try {
    requests = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {}
  await rm(fixtureDir, { recursive: true, force: true });
  return { requests, stdout, stderr, exitCode };
}

test('hard-surface classifier and Dragon CLIs honor the measured signal contract', async () => {
  const failures = [];
  let classifyHardSurfaces = null;
  try {
    ({ classifyHardSurfaces } = await import(`${pathToFileURL(PREFLIGHT).href}?planner-red=1`));
  } catch {
    failures.push('scripts/dragon-hard-surface-preflight.mjs must exist and be importable');
  }

  const hardCases = [
    [{ csp: { scriptEvalBlocked: true, policy: "script-src 'none'" } }, 'csp-restricted'],
    [{ iframes: [{ sameOrigin: false, interactive: true }] }, 'cross-origin-iframe'],
    [{ shadowRoots: [{ mode: 'open', interactiveCount: 2 }] }, 'open-shadow-root'],
    [{ shadowRoots: [{ mode: 'closed', hostInteractive: true }] }, 'closed-shadow-root'],
    [{ canvases: [{ interactive: true, semanticFallback: false, pointerHandler: true }] }, 'canvas-only-control'],
    [{ dragDrop: [{ requiresTrustedPointer: true, dropTarget: true }] }, 'trusted-drag-drop'],
    [{ virtualization: { windowed: true, totalItems: 1000, renderedItems: 18 } }, 'virtualized-list'],
    [{ overlays: [{ portaled: true, modal: true, ownsFocus: true }] }, 'portaled-overlay'],
    [{ fileInputs: [{ nativePicker: true, required: true }] }, 'native-file-picker'],
    [{ editables: [{ contentEditable: true, customModel: true, richText: true }] }, 'custom-contenteditable'],
  ];
  const normalCases = [
    { controls: [{ tag: 'button', semantic: true }] },
    { iframes: [{ sameOrigin: true, interactive: false }] },
    { canvases: [{ interactive: false, semanticFallback: true }] },
    { virtualization: { windowed: false, totalItems: 12, renderedItems: 12 } },
    { overlays: [{ portaled: false, modal: false, ownsFocus: false }] },
  ];
  if (typeof classifyHardSurfaces !== 'function') {
    failures.push('classifyHardSurfaces must be exported as a function');
  } else {
    const normalize = (value) => (Array.isArray(value) ? value : value?.risks ?? [])
      .map((item) => typeof item === 'string' ? item : item?.type);
    let caught = 0;
    for (const [observation, expected] of hardCases) {
      if (normalize(await classifyHardSurfaces(observation)).includes(expected)) caught += 1;
    }
    const falsePositives = normalCases.filter((observation) => normalize(classifyHardSurfaces(observation)).length > 0).length;
    if (caught / hardCases.length < 0.9) failures.push('classifier recall must be at least 0.90');
    if (falsePositives / normalCases.length > 0.05) failures.push('classifier false-positive rate must be at most 0.05');
  }

  const binding = { sessionId: 'fixture-session', nonce: 'fixture-nonce', browserInstanceId: 'fixture-browser' };
  const preflight = await runCli(PREFLIGHT, ['--tab-id', '42', '--json']);
  const [sessionRequest, snapshotRequest] = preflight.requests;
  if (preflight.exitCode !== 0) failures.push('preflight CLI must exit successfully');
  if (preflight.stdout.includes(TOKEN) || preflight.stderr.includes(TOKEN)) failures.push('preflight CLI must not print DRAGON_RPC_TOKEN');
  if (sessionRequest?.authorization !== `Bearer ${TOKEN}` || sessionRequest?.body?.params?.forbidSyntheticDOM !== false) {
    failures.push('preflight must authenticate and create a forbidSyntheticDOM=false session');
  }
  const params = snapshotRequest?.body?.params;
  const readsSnapshot = params?.steps?.some((step) => typeof step?.read === 'string' && step.as === 'hardSurfaceSnapshot');
  if (snapshotRequest?.authorization !== `Bearer ${TOKEN}` || snapshotRequest?.body?.method !== 'do'
    || params?.tabId !== 42 || params?.sessionId !== binding.sessionId || params?.nonce !== binding.nonce
    || params?.browserInstanceId !== binding.browserInstanceId || !readsSnapshot) {
    failures.push('preflight snapshot read must bind tabId, sessionId, nonce, and browserInstanceId');
  }
  let preflightOutput = null;
  try { preflightOutput = JSON.parse(preflight.stdout); } catch {}
  if (!Array.isArray(preflightOutput?.risks) || !preflightOutput.risks.some((risk) => (risk?.type ?? risk) === 'canvas-only-control')) {
    failures.push('preflight JSON must classify hardSurfaceSnapshot');
  }

  const qaDo = await runCli(QA_DO, ['--method', 'listTabs']);
  if (qaDo.exitCode !== 0 || qaDo.requests[0]?.authorization !== `Bearer ${TOKEN}`) {
    failures.push('qa_do.mjs must send DRAGON_RPC_TOKEN as Bearer authentication');
  }
  if (qaDo.stdout.includes(TOKEN) || qaDo.stderr.includes(TOKEN)) failures.push('qa_do.mjs must not print DRAGON_RPC_TOKEN');

  assert.deepEqual(failures, [], `Missing Dragon hard-surface behavior:\n- ${failures.join('\n- ')}`);
});

test('shipped hard-surface fixture uses a navigable cross-origin frame', async () => {
  const fixture = await readFile(LIVE_HARD_FIXTURE, 'utf8');
  const preflight = await readFile(PREFLIGHT, 'utf8');
  assert.doesNotMatch(fixture, /example\.invalid|src=["']about:blank/i);
  assert.match(fixture, /<iframe\b[^>]*\bsrc=["']https:\/\/example\.com\//i);
  assert.match(preflight, /rpc\('waitForState',[\s\S]*?state: 'complete'/);
  assert.doesNotMatch(preflight, /waitForState',[^{]*\{\s*\.\.\.binding/);
});
