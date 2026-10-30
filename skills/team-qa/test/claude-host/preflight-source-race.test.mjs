import test from 'node:test';
import assert from 'node:assert/strict';
import { retryWhileSourceChanges } from '../../scripts/lib/tool-preflight.mjs';
import { rereadWhileSourceChanges } from '../../scripts/lib/run-contract.mjs';

// A detached dispatch can check the preflight while the root keeps writing its transcript,
// and the read then sees the file change (ORIGINAL_SOURCE_CHANGED). The check reads again before blocking; nothing else retries.
const raced = (code = 'PREFLIGHT_VERIFICATION_BLOCKED') => Object.assign(new Error(code), { code, detail: 'ORIGINAL_SOURCE_CHANGED', exitCode: 3 });
test('a transcript that changed during the read is read again, a few times; other refusals stand at once', () => {
  const pauses = [];
  const pause = (ms) => pauses.push(ms);
  let n = 0;
  assert.deepEqual(retryWhileSourceChanges(() => { if (++n < 3) throw raced(); return { verified: true }; }, { pause }), { verified: true });
  assert.deepEqual([n, pauses], [3, [150, 300]]);
  n = 0;
  assert.throws(() => retryWhileSourceChanges(() => { n++; throw raced(); }, { pause }), (e) => e.detail === 'ORIGINAL_SOURCE_CHANGED');
  assert.equal(n, 5);
  n = 0;
  assert.throws(() => retryWhileSourceChanges(() => { n++; throw Object.assign(new Error('x'), { code: 'PREFLIGHT_VERIFICATION_BLOCKED', detail: 'CLAUDE_REFS_STALE' }); }, { pause }),
    (e) => e.detail === 'CLAUDE_REFS_STALE');
  assert.equal(n, 1);
  // A lane blocked by the same race is read again too; a lane blocked for another reason is returned as it is.
  n = 0;
  const lane = (code) => ({ verified: false, lanes: { gui: { status: 'BLOCKED', code } } });
  assert.deepEqual(retryWhileSourceChanges(() => (++n < 2 ? lane('ORIGINAL_SOURCE_CHANGED') : { verified: true }), { pause }), { verified: true });
  assert.deepEqual(retryWhileSourceChanges(() => lane('PREFLIGHT_GUI_BLOCKED'), { pause }), lane('PREFLIGHT_GUI_BLOCKED'));
  // A bare ORIGINAL_SOURCE_CHANGED (not wrapped) is the same race.
  n = 0;
  assert.equal(retryWhileSourceChanges(() => { if (++n < 2) throw Object.assign(new Error('changed'), { code: 'ORIGINAL_SOURCE_CHANGED' }); return 'ok'; }, { pause }), 'ok');
});

// The run contract and role attestation checks (dispatch, COMPLETE, QA GUI's gate) run again the same way: a raw
// ORIGINAL_SOURCE_CHANGED was seen from a detached dispatch and inside QA GUI's gate.
test('the run contract checks run again on a fresh read only when the transcript changed during the read', () => {
  const pause = () => {};
  let n = 0;
  assert.equal(rereadWhileSourceChanges(() => { if (++n < 4) throw Object.assign(new Error('changed'), { code: 'ORIGINAL_SOURCE_CHANGED' }); return 'contract'; }, { pause }), 'contract');
  assert.equal(n, 4);
  n = 0;
  assert.throws(() => rereadWhileSourceChanges(() => { n++; throw raced('ROLE_ATTESTATION_INVALID'); }, { pause }), (e) => e.code === 'ROLE_ATTESTATION_INVALID');
  assert.equal(n, 5);
  n = 0;
  assert.throws(() => rereadWhileSourceChanges(() => { n++; throw Object.assign(new Error('x'), { code: 'RUN_PHASE_REQUIRED' }); }, { pause }), (e) => e.code === 'RUN_PHASE_REQUIRED');
  assert.equal(n, 1);
});
