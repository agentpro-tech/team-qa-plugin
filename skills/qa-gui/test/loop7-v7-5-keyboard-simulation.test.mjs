import test from 'node:test';
import assert from 'node:assert/strict';

const loop7 = await import('../scripts/loop7/index.mjs');

test('V7.5 evaluates the frozen keyboard simulation contract', () => {
  assert.equal(
    typeof loop7.evaluateKeyboardSimulation,
    'function',
    'scripts/loop7/index.mjs must export evaluateKeyboardSimulation'
  );

  const evaluate = loop7.evaluateKeyboardSimulation;
  const unavailable = evaluate({
    viewport: '360x800',
    canShrink: false,
    visibleHeightRatio: 0.6,
    focused: { selector: '#email', fullyVisible: false },
    submit: { selector: '#submit', reachable: false }
  });
  assert.deepEqual(unavailable, {
    verdict: 'UNGRADED',
    code: 'keyboard-sim-unavailable',
    findings: []
  });

  const occluded = evaluate({
    viewport: '360x800',
    canShrink: true,
    visibleHeightRatio: 0.6,
    focused: { selector: '#email', fullyVisible: false },
    submit: { selector: '#submit', reachable: true }
  });
  assert.equal(occluded.verdict, 'FAIL');
  assert.deepEqual(
    occluded.findings.map(({ rule, selector, viewport }) => ({ rule, selector, viewport })),
    [{ rule: 'KEYBOARD_INPUT_OCCLUDED', selector: '#email', viewport: '360x800' }]
  );

  const unreachable = evaluate({
    viewport: '320x740',
    canShrink: true,
    visibleHeightRatio: 0.6,
    focused: { selector: '#search', fullyVisible: true },
    submit: { selector: '.continue', reachable: false }
  });
  assert.equal(unreachable.verdict, 'FAIL');
  assert.deepEqual(
    unreachable.findings.map(({ rule, selector, viewport }) => ({ rule, selector, viewport })),
    [{ rule: 'KEYBOARD_SUBMIT_UNREACHABLE', selector: '.continue', viewport: '320x740' }]
  );

  for (const viewport of ['360x800', '800x360']) {
    const clean = evaluate({
      viewport,
      canShrink: true,
      visibleHeightRatio: 0.6,
      focused: { selector: '#message', fullyVisible: true },
      submit: { selector: '#send', reachable: true }
    });
    assert.deepEqual(clean, { verdict: 'PASS', findings: [] });
    assert.equal(clean.code ?? null, null);
  }
});
