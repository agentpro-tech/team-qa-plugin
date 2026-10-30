import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESPONSIVE_MATRIX as MATRIX_WITH_PROFILE } from '../scripts/loop7/responsive-matrix.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PRODUCT = resolve(ROOT, 'scripts/dragon-responsive-matrix-preflight.mjs');
const CORPUS = resolve(ROOT, '.teamcode/responsive-matrix/corpus.json');
const UI_GATE = resolve(ROOT, 'scripts/ui-sanity.js');
const A11Y_GATE = resolve(ROOT, 'scripts/a11y-gate0.js');
const TOKEN = 'responsive-matrix-red-proof-token';
const BINDING = {
  sessionId: 'matrix-session',
  nonce: 'matrix-nonce',
  browserInstanceId: 'matrix-browser',
  forbidSyntheticDOM: false,
};
const MATRIX = MATRIX_WITH_PROFILE.map(({ w, h }) => ({ w, h }));

function run(args, env = {}, preload = null) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), PRODUCT, ...args], {
      cwd: ROOT,
      env: { ...process.env, DRAGON_RPC_TOKEN: TOKEN, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    const timer = setTimeout(() => child.kill('SIGTERM'), 8000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function mockedRun(scenario, args, extraEnv = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'dragon-responsive-test-'));
  const preload = resolve(dir, 'mock-fetch.mjs');
  const log = resolve(dir, 'calls.jsonl');
  await writeFile(preload, `
    import { appendFileSync } from 'node:fs';
    let active = { w: 0, h: 0 };
    let currentUrl = 'about:blank';
    globalThis.fetch = async (_url, options = {}) => {
      const body = JSON.parse(options.body || '{}');
      appendFileSync(process.env.MOCK_LOG, JSON.stringify({ authorization: options.headers?.Authorization ?? options.headers?.authorization, body }) + '\\n');
      let result = { ok: true };
      if (body.method === 'session.create') result = ${JSON.stringify(BINDING)};
      else if (body.method === 'openTab') { currentUrl = body.params.url; result = { tabId: 73 }; }
      else if (body.method === 'getTabInfo') result = { tabId: body.params.tabId, url: currentUrl, status: 'complete' };
      else if (body.method === 'setViewport') {
        active = { w: body.params.width, h: body.params.height };
        result = { ...active, tabId: body.params.tabId };
      } else if (body.method === 'do' && process.env.MOCK_SCENARIO === 'denied') {
        result = { completed: true, results: [{ ok: false, code: 'GATE_DENIED', error: 'nested denial' }] };
      } else if (body.method === 'do') {
        const viewport = process.env.MOCK_SCENARIO === 'mismatch' ? { w: 999, h: active.h } : { ...active };
        const ui = { viewport, issues: active.w === 320 ? [{ sev: 'high', rule: 'page-overflow-x' }] : [] };
        const a11y = { viewport, issues: [] };
        const reads = { responsiveSnapshot: { ui, a11y } };
        for (const step of body.params?.steps ?? []) {
          if (!step.as) continue;
          if (step.as.startsWith('mobilePin')) {
            reads[step.as] = {
              touchPoints: process.env.MOCK_SCENARIO === 'unverified' ? 0 : 5,
              dpr: 3,
              userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36',
              uaDataMobile: true,
              platform: 'Android',
            };
          } else if (step.read === process.env.UI_GATE_SOURCE) reads[step.as] = ui;
          else if (step.read === process.env.A11Y_GATE_SOURCE) reads[step.as] = a11y;
        }
        result = { reads };
      } else if (body.method === 'captureTab') {
        result = {
          savedTo: '/tmp/' + active.w + 'x' + active.h + '.png',
          evidence: { kind: 'screenshot', ref: 'observation:' + active.w + 'x' + active.h, contentHash: 'hash-' + active.w + 'x' + active.h },
        };
      } else if (body.method === 'session.close') {
        result = process.env.MOCK_SCENARIO === 'denied'
          ? { ok: false, code: 'CLOSE_FAILED', error: 'cleanup boom' }
          : { ok: true, closedTabs: 1 };
      }
      const payload = { ok: true, result };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
  `);
  const result = await run(args, {
    DRAGON_RPC: 'http://dragon.invalid/rpc',
    MOCK_LOG: log,
    MOCK_SCENARIO: scenario,
    UI_GATE_SOURCE: extraEnv.uiGate ?? '',
    A11Y_GATE_SOURCE: extraEnv.a11yGate ?? '',
  }, preload);
  let calls = [];
  try { calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  await rm(dir, { recursive: true, force: true });
  return { ...result, calls };
}

test('frozen Dragon responsive matrix contract reaches every target and fails closed', async () => {
  const failures = [];
  const corpus = JSON.parse(await readFile(CORPUS, 'utf8'));
  const [uiGate, a11yGate] = await Promise.all([readFile(UI_GATE, 'utf8'), readFile(A11Y_GATE, 'utf8')]);

  let classifyResponsiveMatrix;
  try {
    ({ classifyResponsiveMatrix } = await import(`${pathToFileURL(PRODUCT).href}?planner-red=1`));
  } catch (error) {
    failures.push(`entry point must exist and import cleanly: ${error?.code === 'ERR_MODULE_NOT_FOUND' ? 'missing module' : 'module unavailable'}`);
  }

  const types = async (rows) => {
    if (typeof classifyResponsiveMatrix !== 'function') return [];
    try {
      const value = await classifyResponsiveMatrix(rows);
      const risks = Array.isArray(value) ? value : value?.risks;
      return Array.isArray(risks)
        ? risks.map((risk) => typeof risk === 'string' ? risk : risk?.type).filter(Boolean)
        : [];
    } catch { return []; }
  };
  let caught = 0;
  for (const item of corpus.hard) if ((await types(item.rows)).includes(item.expected)) caught += 1;
  let falsePositives = 0;
  for (const item of corpus.ordinary) if ((await types(item.rows)).length > 0) falsePositives += 1;
  const recall = caught / corpus.hard.length;
  const falsePositiveRate = falsePositives / corpus.ordinary.length;
  if (typeof classifyResponsiveMatrix !== 'function') failures.push('classifyResponsiveMatrix must be exported');
  if (corpus.hard.length !== 9 || new Set(corpus.hard.map((item) => item.expected)).size !== 9) failures.push('the frozen nine-family corpus must be graded whole');
  if (recall < 0.90) failures.push(`responsive recall ${recall} is below 0.90`);
  if (falsePositiveRate > 0.05) failures.push(`responsive false-positive rate ${falsePositiveRate} exceeds 0.05`);

  {
    const result = await mockedRun('happy', ['--url', 'https://example.test/responsive', '--json'], { uiGate, a11yGate });
    let output;
    try { output = JSON.parse(result.stdout); } catch {}
    const calls = result.calls;
    const created = calls.find((call) => call.body.method === 'session.create');
    const opened = calls.find((call) => call.body.method === 'openTab');
    const viewports = calls.filter((call) => call.body.method === 'setViewport');
    const reads = calls.filter((call) => call.body.method === 'do');
    const pinReads = reads.filter((call) => (call.body.params?.steps ?? []).some((step) => /^mobilePin\d+$/.test(step.as || '')));
    const gateReads = reads.filter((call) => (call.body.params?.steps ?? []).some((step) => step.as === 'ui'));
    const captures = calls.filter((call) => call.body.method === 'captureTab');
    const closed = calls.at(-1);
    if (result.code !== 0) failures.push('happy-path CLI must exit zero');
    if (created?.body?.params?.forbidSyntheticDOM !== false) failures.push('session must request forbidSyntheticDOM:false');
    if (opened?.body?.params?.active !== false || opened?.body?.params?.url !== 'https://example.test/responsive') failures.push('--url must open one inactive owned tab');
    if (JSON.stringify(viewports.map((call) => ({ w: call.body.params?.width, h: call.body.params?.height }))) !== JSON.stringify(MATRIX)) failures.push('setViewport must run every row from the canonical responsive matrix');
    if (gateReads.length !== MATRIX_WITH_PROFILE.length) failures.push('both Gate-0 reads must run once per canonical viewport');
    if (pinReads.length !== MATRIX_WITH_PROFILE.filter((row) => row.profile === 'mobile').length) failures.push('every mobile row must verify its emulation pin before Gate 0');
    if (captures.length !== MATRIX_WITH_PROFILE.length) failures.push('every canonical viewport must capture one PNG evidence artifact');
    for (const call of gateReads) {
      const scripts = (call.body.params?.steps ?? []).map((step) => step.read);
      if (!scripts.includes(uiGate) || !scripts.includes(a11yGate)) failures.push('each viewport must execute the real bundled UI and accessibility Gate-0 scripts');
    }
    for (const call of calls.slice(1)) {
      if (!['setViewport', 'do', 'captureTab', 'getTabInfo', 'openTab', 'session.close'].includes(call.body.method)) continue;
      const params = call.body.params ?? {};
      if (params.sessionId !== BINDING.sessionId || params.nonce !== BINDING.nonce || params.browserInstanceId !== BINDING.browserInstanceId) failures.push(`Dragon ${call.body.method} must carry the complete session binding`);
    }
    if (closed?.body?.method !== 'session.close') failures.push('session must close after success');
    if (!Array.isArray(output?.matrix) || output.matrix.length !== MATRIX_WITH_PROFILE.length) failures.push('JSON output must expose every canonical measured row');
    if (output?.matrix?.some((row) => !row.evidence?.screenshot || !row.evidence?.ref)) failures.push('every output row must bind saved screenshot evidence');
    if (!output?.risks?.some((risk) => (risk?.type ?? risk) === 'responsive-page-overflow')) failures.push('CLI must aggregate classified responsive risks');
    if (`${result.stdout}${result.stderr}`.includes(TOKEN) || calls.some((call) => call.authorization !== `Bearer ${TOKEN}`)) failures.push('every RPC must authenticate without exposing its bearer token');
  }

  {
    const result = await mockedRun('unverified', ['--tab-id', '42', '--json'], { uiGate, a11yGate });
    let output;
    try { output = JSON.parse(result.stdout); } catch {}
    const mobileRows = output?.matrix?.filter((row) => row.profile === 'mobile') ?? [];
    if (result.code !== 0 || output?.verdict !== 'UNGRADED') failures.push('an unverified mobile profile must return structured UNGRADED');
    if (!mobileRows.length || mobileRows.some((row) => row.verdict !== 'UNGRADED' || row.code !== 'emulation-not-verified')) failures.push('every unverified mobile row must stop before Gate 0 with emulation-not-verified');
    const gateCalls = result.calls.filter((call) => call.body.method === 'do'
      && (call.body.params?.steps ?? []).some((step) => step.as === 'ui'));
    if (gateCalls.length !== MATRIX_WITH_PROFILE.filter((row) => row.profile === 'desktop').length) failures.push('an unverified mobile row must not continue into Gate 0');
  }

  const missingToken = await run(['--tab-id', '42', '--json'], {
    DRAGON_RPC: 'http://127.0.0.1:1/rpc',
    DRAGON_RPC_TOKEN: '',
    DRAGON_RPC_TOKEN_FILE: '/definitely/missing/responsive-token',
  });
  if (missingToken.code === 0 || !/token|bearer/i.test(missingToken.stderr)) failures.push('missing bearer token must fail before useful work');

  {
    const result = await mockedRun('mismatch', ['--tab-id', '42', '--json'], { uiGate, a11yGate });
    if (result.code === 0 || !/viewport|width|mismatch/i.test(result.stderr)) failures.push('reported viewport mismatch must fail closed');
    if (result.calls.at(-1)?.body?.method !== 'session.close') failures.push('session must close after viewport mismatch');
  }

  {
    const result = await mockedRun('denied', ['--tab-id', '42', '--json'], { uiGate, a11yGate });
    if (result.code === 0 || !/GATE_DENIED|nested denial/i.test(result.stderr) || !/CLOSE_FAILED|cleanup boom/i.test(result.stderr)) failures.push('nested denial plus cleanup failure must preserve both errors and fail closed');
    if (result.calls.at(-1)?.body?.method !== 'session.close') failures.push('cleanup must still be attempted after a nested denial');
    if (`${result.stdout}${result.stderr}`.includes(TOKEN)) failures.push('failure output must redact the bearer token');
  }

  const ambiguous = await run(['--url', 'https://example.test', '--tab-id', '42', '--json'], { DRAGON_RPC: 'http://127.0.0.1:1/rpc' });
  if (ambiguous.code === 0 || !/exactly one|--url|--tab-id/i.test(ambiguous.stderr)) failures.push('CLI must accept exactly one of --url and --tab-id');

  assert.deepEqual(failures, [], `Missing frozen Dragon responsive behavior:\n- ${failures.join('\n- ')}`);
});
