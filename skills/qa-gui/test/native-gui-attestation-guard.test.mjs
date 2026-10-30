import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertNativeGuiPolicyGuard} from '../scripts/lib/teamqa-attestation.mjs';
const hash = 'a'.repeat(64);
test('native GUI guard blocks old parent proofs missing mandatory policy verification', () => {
  for (const native of [undefined, {}, {gui_policy: {path: '/fixture/policy.json', sha256: hash}},
    {gui_policy: {path: '/fixture/policy.json', sha256: hash}, gui_verification: {verdict: 'UNGRADED', policy_sha256: hash}},
    {gui_policy: {path: '/fixture/policy.json', sha256: hash}, gui_verification: {verdict: 'PASS', policy_sha256: 'b'.repeat(64)}}]) {
    assert.throws(() => assertNativeGuiPolicyGuard({source: {kind: 'codex-native', metadata_source: {native}}}), /TEAMQA_NATIVE_GUI_POLICY_REQUIRED/);
  }
});
test('guard shape accepts matching verification after parent independent verification only', () => {
  const value = {source: {kind: 'codex-native', metadata_source: {native: {
    gui_policy: {path: '/fixture/policy.json', sha256: hash}, gui_verification: {verdict: 'PASS', policy_sha256: hash},
  }}}};
  assert.equal(assertNativeGuiPolicyGuard(value), value);
  // This pure shape fixture is not a trusted attestation or product acceptance.
});
test('non-native parent routes retain existing contract', () => {
  const value = {source: {kind: 'claude-stream'}}; assert.equal(assertNativeGuiPolicyGuard(value), value);
});
test('emission and receipt readback delegate parent provenance before requiring native GUI guard', () => {
  const source = readFileSync(new URL('../scripts/lib/teamqa-attestation.mjs', import.meta.url), 'utf8');
  assert.match(source, /assertNativeGuiPolicyGuard\(JSON\.parse\(verified\.stdout\),\{targetBindingSha256\}\)/);
  assert.match(source, /const result=verifyTeamQaGuiAttestation/);
  assert.ok(source.indexOf("if(verified.status!==0)") < source.indexOf('dispatch_proof=assertNativeGuiPolicyGuard'));
});
