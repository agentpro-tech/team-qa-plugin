import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertNativeResponseCap} from '../../scripts/lib/native-dispatch.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const words = n => Array.from({length: n}, () => 'fixture').join(' ');
const capIntent = role => ({role, response_max_words: 140});
test('native response cap accepts exactly 140 words for every bounded role', () => {
  for (const role of ['test_manager', 'analyst', 'designer', 'executor_gui'])
    assert.doesNotThrow(() => assertNativeResponseCap({verdictText: words(140)}, capIntent(role)));
});
test('native response cap rejects 141 words', () => {
  assert.throws(() => assertNativeResponseCap({verdictText: words(141)}, capIntent('analyst')),
    {code: 'NATIVE_RESPONSE_CAP_EXCEEDED'});
});
test('native response cap rejects tampered or missing locked cap', () => {
  for (const cap of [139, 141, 1000, undefined])
    assert.throws(() => assertNativeResponseCap({verdictText: words(1)}, {role: 'analyst', response_max_words: cap}),
      {code: 'NATIVE_RESPONSE_CAP_BINDING'});
});
test('Code JSON is governed by child schema rather than prose word cap', () => {
  const verdictText = JSON.stringify({fixture: words(280), findings: []});
  assert.doesNotThrow(() => assertNativeResponseCap({verdictText}, {role: 'executor_code'}));
});
test('native catalog uses five-role host/cache/model-fit sources and never invokes CLI', () => {
  // Isolated mock source bytes are not live model, readiness or entitlement evidence.
  const home = mkdtempSync(join(tmpdir(), 'teamqa-native-catalog-cap-fixture-'));
  const sessions = join(home, '.codex/sessions/2026/10/07'); mkdirSync(sessions, {recursive: true});
  const host = join(sessions, 'rollout-fixture-host.jsonl');
  writeFileSync(host, JSON.stringify({type: 'session_meta', payload: {id: 'fixture-host', cli_version: '0.200.0'}}) + '\n');
  const roles = ['test_manager', 'analyst', 'designer', 'executor_code', 'executor_gui'];
  const modelId = 'fixture-native-model';
  const cache = join(home, '.codex/models_cache.json'), fit = join(home, '.codex/model-fit.json');
  const cacheBytes = JSON.stringify({client_version: '0.100.0', models: [{slug: modelId, visibility: 'list', supported_in_api: true,
    supported_reasoning_levels: [{effort: 'medium'}]}]}) + '\n';
  const fitBytes = JSON.stringify({schema: 'team-qa/model-fit/v1', models: [{id: modelId, provider: 'openai',
    roles, tools: ['fs.read', 'qa-code', 'qa-gui', 'dragon'], tier: 'general', fit_review: 'source-reviewed',
    benchmark_status: 'not-run', source_url: 'https://example.invalid/fixture-reviewed-source'}]}) + '\n';
  writeFileSync(cache, cacheBytes); writeFileSync(fit, fitBytes);
  const binDir = join(home, 'bin'); mkdirSync(binDir);
  const stub = join(binDir, 'codex'), log = join(home, 'cli-stub.log'); writeFileSync(log, 'untouched\n');
  writeFileSync(stub, `#!/bin/sh\nprintf 'invoked\\n' >> '${log}'\nexit 99\n`); chmodSync(stub, 0o755);
  const code = `
    import {collectCatalog} from ${JSON.stringify(join(ROOT, 'scripts/lib/catalog.mjs'))};
    const [host,cache,fit,stub]=process.argv.slice(1),opts={provider:'openai',harness:'codex-native',hostSourcePath:host,
      codexCachePath:cache,modelFitPath:fit,qaCodeRoot:process.env.HOME+'/fixture-qa-code',qaGuiRoot:process.env.HOME+'/fixture-qa-gui'};
    const invalid=collectCatalog({...opts,codexBin:process.env.HOME+'/missing-invalid-codex'});
    const trapped=collectCatalog({...opts,codexBin:stub});
    process.stdout.write(JSON.stringify({invalid,trapped}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, host, cache, fit, stub],
    {env: {...process.env, HOME: home, PATH: binDir}, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(log, 'utf8'), 'untouched\n', 'native catalog must not invoke the CLI stub');
  assert.equal(existsSync(join(home, 'missing-invalid-codex')), false);
  const catalogs = JSON.parse(result.stdout);
  const sha = value => createHash('sha256').update(value).digest('hex');
  for (const catalog of Object.values(catalogs)) {
    assert.equal(catalog.schema, 'team-qa/model-catalog/v1');
    assert.deepEqual(catalog.harnesses.map(h => h.id), ['codex-native']);
    assert.equal(catalog.harnesses[0].version, '0.200.0');
    assert.equal(catalog.models.length, 1); assert.equal(catalog.models[0].harness, 'codex-native');
    assert.deepEqual(catalog.models[0].roles, roles); assert.equal(catalog.models[0].status, 'available');
    assert.equal(catalog.models[0].quality_evidence.entitlement, 'unprobed');
    assert.equal(catalog.models[0].quality_evidence.benchmark_status, 'not-run');
    const ref = JSON.parse(catalog.source.reference);
    assert.equal(ref.model_calls, 0); assert.equal(ref.collector, 'team-qa/native-catalog/v1');
    assert.equal(ref.cache.sha256, sha(cacheBytes)); assert.equal(ref.model_fit.sha256, sha(fitBytes));
  }
});
