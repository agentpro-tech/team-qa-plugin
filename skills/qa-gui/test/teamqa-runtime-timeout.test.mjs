import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// L4: the check of the Team QA runtime (package-tool verify-runtime on it) had no bound in QA Code and a 10 s one in
// QA GUI that then reported TEAMQA_RUNTIME_PROVENANCE_INVALID, as if the runtime had been tampered with. Both now
// stop at the same bound and say it timed out. The fixture runtime passes every check before verify-runtime (the git
// route of a source install, in a scratch HOME); a preload makes that one Node process hang.
function slowRuntimeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-runtime-timeout-')));
  const home = join(root, 'home'), canon = join(root, 'canon'), runtime = join(root, 'runtime');
  mkdirSync(join(home, '.agents', 'skills', 'team-qa'), { recursive: true }); mkdirSync(canon); mkdirSync(runtime);
  const manifest = '{"schema":"agentpro/skill-package-manifest/v1","skill":"team-qa","version":"0.0.1","files":[]}\n';
  writeFileSync(join(canon, 'package-manifest.json'), manifest);
  const git = (...args) => { const r = spawnSync('git', ['-C', canon, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q'); git('add', 'package-manifest.json');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture');
  const repo = 'https://github.com/agentpro-tech/team-qa.git';
  writeFileSync(join(home, '.agents', 'skills', 'team-qa', 'release-truth.json'), JSON.stringify({ repo: canon, repo_url: repo, head: git('rev-parse', 'HEAD') }));
  writeFileSync(join(runtime, 'SOURCE.json'), JSON.stringify({ schema: 'agentpro/skill-source/v1', skill: 'team-qa', version: '0.0.1', repo, commit: git('rev-parse', 'HEAD'),
    manifest_sha256: createHash('sha256').update(manifest).digest('hex') }));
  writeFileSync(join(runtime, 'package-manifest.json'), manifest);
  const hang = join(root, 'hang.mjs');
  writeFileSync(hang, "if (process.argv.includes('verify-runtime')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);\n");
  return { root, home, runtime, env: { ...process.env, HOME: home, NODE_OPTIONS: `--import ${pathToFileURL(hang).href}`, NODE_TEST_CONTEXT: undefined } };
}

test('a Team QA runtime check that does not finish is a timeout, not an invalid provenance', () => {
  const f = slowRuntimeFixture();
  const verifier = new URL('../scripts/lib/teamqa-attestation.mjs', import.meta.url).href;
  const code = `import * as m from ${JSON.stringify(verifier)};
const started = Date.now();
try { m.verifyTeamQaGuiAttestation({ attestationPath: 'fixture', runtimeRoot: ${JSON.stringify(f.runtime)}, runUuid: 'fixture', exactFinalSha: 'a'.repeat(40), requirementsHash: 'b'.repeat(64) }); console.log('NO_ERROR'); }
catch (error) { console.log(JSON.stringify({ message: error.message, ms: Date.now() - started, bound: m.TEAMQA_RUNTIME_CHECK_TIMEOUT_MS ?? null })); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: f.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.error, undefined, 'the check hung past 60 s');
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.match(out.message, /^TEAMQA_RUNTIME_CHECK_TIMEOUT/);
  assert.equal(out.bound, 10000, 'the same bound as QA Code');
  assert.ok(out.ms < out.bound + 5000, `${out.ms} ms`);
});
