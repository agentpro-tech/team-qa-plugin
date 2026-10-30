import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_RTM_EMPTY, LEGACY_RTM_REQUIREMENT, LEGACY_WAIT_MARKER, RTM_EMPTY, RTM_REQUIREMENT, WAIT_MARKER,
  hasRtmEmpty, isRtmEmpty, isRtmRequirementHeaderLine, rtmRequirementIndex, startsWithWaitMarker,
} from '../../scripts/lib/report-tokens.mjs';

// Public v1: Team QA writes English tokens into the RTM and the WAIT report, and still reads the ones that earlier
// versions wrote (Vietnamese, written here as escapes).
test('the tokens Team QA writes are English', () => {
  assert.deepEqual([RTM_REQUIREMENT, RTM_EMPTY, WAIT_MARKER], ['Requirement', '**EMPTY**', 'NOT COMPLETE']);
  for (const token of [RTM_REQUIREMENT, RTM_EMPTY, WAIT_MARKER]) assert.match(token, /^[\x20-\x7e]+$/);
});

test('readers accept the English tokens and the legacy ones', () => {
  assert.equal(LEGACY_RTM_REQUIREMENT, 'Y\u00eau c\u1ea7u');
  assert.ok(isRtmEmpty(RTM_EMPTY) && isRtmEmpty(LEGACY_RTM_EMPTY) && !isRtmEmpty('TC-01') && !isRtmEmpty('EMPTY'));
  assert.ok(hasRtmEmpty(`| REQ-1 | FULL | ${RTM_EMPTY} |`) && hasRtmEmpty(`| REQ-1 | FULL | ${LEGACY_RTM_EMPTY} |`));
  assert.equal(rtmRequirementIndex(['Source', 'Case', RTM_REQUIREMENT]), 2);
  assert.equal(rtmRequirementIndex(['Source', 'Case', LEGACY_RTM_REQUIREMENT]), 2);
  assert.equal(rtmRequirementIndex(['Source', 'Case']), -1);
  assert.ok(isRtmRequirementHeaderLine(`| ${RTM_REQUIREMENT} | Tier | Case |`) && isRtmRequirementHeaderLine(`| ${LEGACY_RTM_REQUIREMENT} | Tier |`));
  assert.ok(!isRtmRequirementHeaderLine('| REQ-1 | Requirement text |x'));
  assert.ok(startsWithWaitMarker('  NOT COMPLETE: GUI blocked') && startsWithWaitMarker(`${LEGACY_WAIT_MARKER}: x`));
  assert.ok(!startsWithWaitMarker('Done. NOT COMPLETE elsewhere') && !startsWithWaitMarker(undefined));
});
