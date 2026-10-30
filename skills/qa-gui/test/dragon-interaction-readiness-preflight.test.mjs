import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const PRODUCT = resolve(ROOT, 'scripts/dragon-interaction-readiness-preflight.mjs');
const CORPUS = resolve(ROOT, '.teamcode/interaction-readiness/corpus.json');
const TOKEN = 'interaction-readiness-red-proof-token';

test('frozen interaction-readiness classifier and Dragon sampling contract are satisfied', async () => {
  const failures = [];
  const corpus = JSON.parse(await readFile(CORPUS, 'utf8'));
  let classifyInteractionReadiness;
  try {
    ({ classifyInteractionReadiness } = await import(`${pathToFileURL(PRODUCT).href}?planner-red=1`));
  } catch {
    failures.push('entry point must exist and be importable');
  }

  const types = async (samples) => {
    if (typeof classifyInteractionReadiness !== 'function') return [];
    const value = await classifyInteractionReadiness(samples);
    const risks = Array.isArray(value) ? value : value?.risks;
    return Array.isArray(risks)
      ? risks.map((risk) => typeof risk === 'string' ? risk : risk?.type).filter(Boolean)
      : [];
  };
  let caught = 0;
  for (const item of corpus.hard) if ((await types(item.samples)).includes(item.expected)) caught += 1;
  let falsePositives = 0;
  for (const item of corpus.ordinary) if ((await types(item.samples)).length > 0) falsePositives += 1;
  if (caught / corpus.hard.length < 0.9) failures.push('classifier recall must be at least 0.90');
  if (falsePositives / corpus.ordinary.length > 0.05) failures.push('classifier false-positive rate must be at most 0.05');

  const dir = await mkdtemp(resolve(tmpdir(), 'interaction-readiness-test-'));
  const preload = resolve(dir, 'mock-fetch.mjs');
  const log = resolve(dir, 'calls.jsonl');
  await writeFile(preload, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (_url, options = {}) => {
      const body = JSON.parse(options.body || '{}');
      appendFileSync(process.env.MOCK_LOG, JSON.stringify({ authorization: options.headers?.Authorization ?? options.headers?.authorization, body }) + '\\n');
      let result = { ok: true };
      if (body.method === 'session.create') result = { sessionId: 'ready-session', nonce: 'ready-nonce', browserInstanceId: 'ready-browser', forbidSyntheticDOM: false };
      else if (body.method === 'do') result = { reads: {
        sample1: { busy: [{ key: 'main' }] }, sample2: { busy: [{ key: 'main' }] }, sample3: { busy: [{ key: 'main' }] },
      } };
      const payload = { ok: true, result };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
  `);
  const child = spawn(process.execPath, ['--import', preload, PRODUCT, '--tab-id', '42', '--json'], {
    cwd: ROOT,
    env: { ...process.env, DRAGON_RPC: 'http://dragon.invalid/rpc', DRAGON_RPC_TOKEN: TOKEN, MOCK_LOG: log },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveExit) => child.once('exit', (value) => resolveExit(value ?? 1)));
  let calls = [];
  try { calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  await rm(dir, { recursive: true, force: true });

  const created = calls.find((call) => call.body.method === 'session.create');
  const sampled = calls.find((call) => call.body.method === 'do');
  const closed = calls.at(-1);
  const steps = sampled?.body?.params?.steps ?? [];
  if (code !== 0) failures.push('CLI must exit successfully for valid samples');
  if (created?.body?.params?.forbidSyntheticDOM !== false) failures.push('session must request forbidSyntheticDOM:false');
  if (sampled?.body?.params?.tabId !== 42 || sampled?.body?.params?.sessionId !== 'ready-session'
    || sampled?.body?.params?.nonce !== 'ready-nonce' || sampled?.body?.params?.browserInstanceId !== 'ready-browser') failures.push('sample call must carry the complete binding');
  if (calls.filter((call) => call.body.method === 'do').length !== 1
    || steps.filter((step) => typeof step.read === 'string').length !== 3
    || steps.filter((step) => Number.isFinite(Number(step.wait)) && Number(step.wait) > 0).length !== 2) failures.push('CLI must take three reads with two numeric waits in one do call');
  if (closed?.body?.method !== 'session.close') failures.push('CLI must close its created session');
  if (`${stdout}${stderr}`.includes(TOKEN) || calls.some((call) => call.authorization !== `Bearer ${TOKEN}`)) failures.push('every RPC must authenticate without exposing the token');
  let output;
  try { output = JSON.parse(stdout); } catch {}
  if (!Array.isArray(output?.samples) || output.samples.length !== 3
    || !output?.risks?.some((risk) => (risk?.type ?? risk) === 'readiness-persistent-busy')) failures.push('JSON output must preserve samples and normalized risks');

  assert.deepEqual(failures, [], `Missing Dragon interaction-readiness behavior:\n- ${failures.join('\n- ')}`);
});
