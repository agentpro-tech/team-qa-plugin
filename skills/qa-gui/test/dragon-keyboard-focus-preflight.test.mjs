import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const ROOT = resolve(import.meta.dirname, '..');
const PRODUCT = resolve(ROOT, 'scripts/dragon-keyboard-focus-preflight.mjs');
const CORPUS = resolve(ROOT, '.teamcode/keyboard-focus/corpus.json');
const TOKEN = 'keyboard-focus-red-proof-token';
const BINDING = {
  sessionId: 'focus-session',
  nonce: 'focus-nonce',
  browserInstanceId: 'focus-browser',
  forbidSyntheticDOM: false,
};

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

async function mockedRun(scenario, args) {
  const dir = await mkdtemp(resolve(tmpdir(), 'dragon-keyboard-focus-test-'));
  const preload = resolve(dir, 'mock-fetch.mjs');
  const log = resolve(dir, 'calls.jsonl');
  await writeFile(preload, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (_url, options = {}) => {
      const body = JSON.parse(options.body || '{}');
      appendFileSync(process.env.MOCK_LOG, JSON.stringify({ authorization: options.headers?.Authorization ?? options.headers?.authorization, body }) + '\\n');
      let result = { ok: true };
      if (body.method === 'session.create') result = ${JSON.stringify(BINDING)};
      else if (body.method === 'openTab') result = { tabId: 73 };
      else if (body.method === 'do' && process.env.MOCK_SCENARIO === 'denied') {
        result = { completed: true, results: [{ ok: false, code: 'GATE_DENIED', error: 'trusted key denied' }] };
      } else if (body.method === 'do') {
        const reads = { keyboardBaseline: { candidates: [{ key: 'button:save', visible: true, disabled: false, tabIndex: 0 }] } };
        for (let index = 1; index <= 12; index += 1) reads['focus' + index] = { key: 'button:save', visible: true, hidden: false, indicator: index !== 1, withinViewport: true };
        result = { reads };
      } else if (body.method === 'session.close') {
        result = process.env.MOCK_SCENARIO === 'denied'
          ? { ok: false, code: 'CLOSE_FAILED', error: 'cleanup boom' }
          : { ok: true, closedTabs: 1 };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result }) };
    };
  `);
  const result = await run(args, {
    DRAGON_RPC: 'http://dragon.invalid/rpc',
    MOCK_LOG: log,
    MOCK_SCENARIO: scenario,
  }, preload);
  let calls = [];
  try { calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  await rm(dir, { recursive: true, force: true });
  return { ...result, calls };
}

test('frozen keyboard/focus classifier and trusted Dragon Tab contract are satisfied', async () => {
  const failures = [];
  const corpus = JSON.parse(await readFile(CORPUS, 'utf8'));
  let classifyKeyboardFocusTrail;
  try {
    ({ classifyKeyboardFocusTrail } = await import(`${pathToFileURL(PRODUCT).href}?planner-red=1`));
  } catch {
    failures.push('entry point must exist and be importable');
  }

  const types = async (observation) => {
    if (typeof classifyKeyboardFocusTrail !== 'function') return [];
    try {
      const value = await classifyKeyboardFocusTrail(observation);
      const risks = Array.isArray(value) ? value : value?.risks;
      return Array.isArray(risks)
        ? risks.map((risk) => typeof risk === 'string' ? risk : risk?.type).filter(Boolean)
        : [];
    } catch { return []; }
  };
  let caught = 0;
  for (const item of corpus.hard) if ((await types(item.observation)).includes(item.expected)) caught += 1;
  let falsePositives = 0;
  for (const item of corpus.ordinary) if ((await types(item.observation)).length > 0) falsePositives += 1;
  if (corpus.hard.length !== 10 || new Set(corpus.hard.map((item) => item.expected)).size !== 10) failures.push('the frozen ten-family corpus must be graded whole');
  if (caught / corpus.hard.length < 0.90) failures.push('classifier recall must be at least 0.90');
  if (falsePositives / corpus.ordinary.length > 0.05) failures.push('classifier false-positive rate must be at most 0.05');

  {
    const result = await mockedRun('happy', ['--url', 'https://example.test/focus', '--json']);
    let output;
    try { output = JSON.parse(result.stdout); } catch {}
    const created = result.calls.find((call) => call.body.method === 'session.create');
    const opened = result.calls.find((call) => call.body.method === 'openTab');
    const settled = result.calls.find((call) => call.body.method === 'waitForState');
    const work = result.calls.filter((call) => call.body.method === 'do');
    const closed = result.calls.at(-1);
    const steps = work[0]?.body?.params?.steps ?? [];
    const keys = steps.filter((step) => step.key !== undefined);
    const reads = steps.filter((step) => typeof step.read === 'string');
    if (result.code !== 0) failures.push('happy-path CLI must exit zero');
    if (created?.body?.params?.forbidSyntheticDOM !== false) failures.push('session must request forbidSyntheticDOM:false');
    if (opened?.body?.params?.active !== false || opened?.body?.params?.url !== 'https://example.test/focus') failures.push('--url must open one inactive owned tab');
    if (settled?.body?.params?.tabId !== 73 || settled?.body?.params?.state !== 'complete'
      || settled?.body?.params?.sessionId !== BINDING.sessionId
      || result.calls.indexOf(settled) < result.calls.indexOf(opened)
      || result.calls.indexOf(settled) > result.calls.indexOf(work[0])) failures.push('--url must settle the owned tab before trusted keyboard work');
    if (work.length !== 1) failures.push('all keyboard work must use exactly one Dragon do call');
    if (work[0]?.body?.params?.tabId !== 73 || work[0]?.body?.params?.sessionId !== BINDING.sessionId
      || work[0]?.body?.params?.nonce !== BINDING.nonce || work[0]?.body?.params?.browserInstanceId !== BINDING.browserInstanceId) failures.push('the do call must carry tabId and complete session binding');
    if (steps.length !== 25 || reads[0]?.as !== 'keyboardBaseline'
      || reads.slice(1).map((step) => step.as).join(',') !== Array.from({ length: 12 }, (_, index) => `focus${index + 1}`).join(',')) failures.push('steps must contain baseline then focus1 through focus12 reads');
    if (keys.length !== 12 || keys.some((step) => step.key !== 'Tab')) failures.push('steps must contain exactly twelve trusted Tab keys');
    for (let index = 0; index < 12; index += 1) {
      if (steps[index * 2 + 1]?.key !== 'Tab' || steps[index * 2 + 2]?.as !== `focus${index + 1}`) failures.push('each Tab must be immediately followed by its numbered focus read');
    }
    if (closed?.body?.method !== 'session.close') failures.push('session must close after success');
    if (!Array.isArray(output?.observation?.candidates) || !Array.isArray(output?.observation?.trail)
      || output.observation.trail.length !== 12) failures.push('JSON output must preserve baseline candidates and all twelve focus snapshots');
    if (!output?.risks?.some((risk) => (risk?.type ?? risk) === 'keyboard-no-focus-indicator')) failures.push('JSON output must expose normalized classified risks');
    if (`${result.stdout}${result.stderr}`.includes(TOKEN) || result.calls.some((call) => call.authorization !== `Bearer ${TOKEN}`)) failures.push('every RPC must authenticate without exposing the token');
  }

  const missingToken = await run(['--tab-id', '42', '--json'], {
    DRAGON_RPC: 'http://127.0.0.1:1/rpc',
    DRAGON_RPC_TOKEN: '',
    DRAGON_RPC_TOKEN_FILE: '/definitely/missing/keyboard-focus-token',
  });
  if (missingToken.code === 0 || !/token|bearer/i.test(missingToken.stderr)) failures.push('missing bearer token must fail before useful work');

  {
    const result = await mockedRun('denied', ['--tab-id', '42', '--json']);
    if (result.code === 0 || !/GATE_DENIED|trusted key denied/i.test(result.stderr)
      || !/CLOSE_FAILED|cleanup boom/i.test(result.stderr)) failures.push('nested denial plus cleanup failure must preserve both errors and fail closed');
    if (result.calls.at(-1)?.body?.method !== 'session.close') failures.push('cleanup must still be attempted after a nested denial');
    if (`${result.stdout}${result.stderr}`.includes(TOKEN)) failures.push('failure output must redact the bearer token');
  }

  const ambiguous = await run(['--url', 'https://example.test', '--tab-id', '42', '--json'], { DRAGON_RPC: 'http://127.0.0.1:1/rpc' });
  if (ambiguous.code === 0 || !/exactly one|--url|--tab-id/i.test(ambiguous.stderr)) failures.push('CLI must accept exactly one of --url and --tab-id');

  assert.deepEqual(failures, [], `Missing frozen Dragon keyboard/focus behavior:\n- ${failures.join('\n- ')}`);
});

test('a browser-chrome handoff is clean only after every reachable control was visited', async () => {
  const { classifyKeyboardFocusTrail } = await import(`${pathToFileURL(PRODUCT).href}?chrome-handoff=1`);
  const candidates = [
    { key: 'button:first', visible: true, disabled: false, tabIndex: 0 },
    { key: 'button:second', visible: true, disabled: false, tabIndex: 0 },
  ];
  const types = (trail) => classifyKeyboardFocusTrail({ candidates, trail }).map((risk) => risk.type);

  assert.equal(types([
    { key: 'button:first', indicator: true },
    { key: 'button:second', indicator: true },
    { key: '', isBody: true },
    { key: 'button:first', indicator: true },
  ]).includes('keyboard-focus-lost'), false);
  assert.equal(types([
    { key: 'button:first', indicator: true },
    { key: '', isBody: true },
  ]).includes('keyboard-focus-lost'), true);
  assert.equal(types([
    { key: 'button:first', indicator: true },
    { key: 'button:second', indicator: true },
    { key: '', isBody: true },
  ]).includes('keyboard-focus-lost'), true);
});

test('focus-visible modality without a rendered ring is not counted as an indicator', async () => {
  const { FOCUS_SNAPSHOT_SCRIPT } = await import(`${pathToFileURL(PRODUCT).href}?rendered-indicator=1`);
  const active = {
    id: 'no-ring',
    tagName: 'BUTTON',
    tabIndex: 0,
    textContent: 'No ring',
    disabled: false,
    getAttribute: (name) => name === 'tabindex' ? null : null,
    getBoundingClientRect: () => ({ width: 120, height: 40, top: 50, left: 50, right: 170, bottom: 90 }),
    hasAttribute: () => false,
    closest: () => null,
    matches: (selector) => selector === ':focus-visible',
  };
  const document = {
    activeElement: active,
    body: {},
    documentElement: {},
    querySelectorAll: (selector) => selector.includes('dialog') ? [] : [active],
  };
  const getComputedStyle = () => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    outlineStyle: 'none',
    outlineWidth: '0px',
    boxShadow: 'none',
  });
  const snapshot = runInNewContext(FOCUS_SNAPSHOT_SCRIPT, {
    document,
    getComputedStyle,
    innerHeight: 720,
    innerWidth: 1280,
  });

  assert.equal(snapshot.indicator, false);
});
