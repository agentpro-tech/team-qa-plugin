import assert from 'node:assert/strict';
import test from 'node:test';

test('V7.4 detects the seven frozen mobile risks without flagging trap cases', async () => {
  const loop7 = await import('../scripts/loop7/index.mjs');

  assert.equal(
    typeof loop7.detectMobileRisks,
    'function',
    'scripts/loop7/index.mjs must export detectMobileRisks',
  );

  const input = {
    viewport: '360x800',
    viewportMeta: { present: false, fixedWidth: false },
    elements: [
      { selector: '#email', kind: 'input', fontSize: 15 },
      { selector: '#message', kind: 'textarea', fontSize: 16 },
      {
        selector: '.checkout-shell',
        height: '100vh',
        hasDynamicViewportFallback: false,
        bottomCritical: true,
      },
      {
        selector: '.decorative-hero',
        height: '100vh',
        hasDynamicViewportFallback: false,
        bottomCritical: false,
      },
      {
        selector: '.fixed-banner',
        position: 'fixed',
        permanentlyOccludes: true,
        scrollCanRecover: false,
      },
      {
        selector: '.recoverable-banner',
        position: 'fixed',
        permanentlyOccludes: true,
        scrollCanRecover: true,
      },
      {
        selector: '.toolbar-actions',
        adjacentControlGap: 7,
        inlineTextLinks: false,
      },
      {
        selector: '.inline-links',
        adjacentControlGap: 4,
        inlineTextLinks: true,
      },
      {
        selector: '.bottom-cta',
        position: 'fixed',
        edge: 'bottom',
        hasSafeAreaInsetBottom: false,
      },
      {
        selector: '.safe-bottom-cta',
        position: 'fixed',
        edge: 'bottom',
        hasSafeAreaInsetBottom: true,
      },
      { selector: '.article-copy', role: 'body-text', fontSize: 11 },
      {
        selector: '.photo-caption',
        role: 'body-text',
        fontSize: 11,
        shortCaption: true,
      },
    ],
  };

  const expected = [
    { rule: 'R1', selector: '#email', viewport: '360x800', evidence: null },
    {
      rule: 'R2',
      selector: '.checkout-shell',
      viewport: '360x800',
      evidence: null,
    },
    {
      rule: 'R3',
      selector: '.fixed-banner',
      viewport: '360x800',
      evidence: null,
    },
    {
      rule: 'R4',
      selector: '.toolbar-actions',
      viewport: '360x800',
      evidence: null,
    },
    {
      rule: 'R5',
      selector: '.bottom-cta',
      viewport: '360x800',
      evidence: null,
    },
    { rule: 'R6', selector: 'meta[name="viewport"]', viewport: '360x800', evidence: null },
    {
      rule: 'R7',
      selector: '.article-copy',
      viewport: '360x800',
      evidence: null,
    },
  ];

  assert.deepEqual(loop7.detectMobileRisks(input), expected);
  assert.deepEqual(
    loop7.detectMobileRisks(input),
    expected,
    'the detector must be deterministic',
  );

  assert.deepEqual(
    loop7.detectMobileRisks({
      viewport: '320x740',
      viewportMeta: { present: true, fixedWidth: true },
      elements: [],
    }),
    [
      {
        rule: 'R6',
        selector: 'meta[name="viewport"]',
        viewport: '320x740',
        evidence: null,
      },
    ],
    'a fixed-width viewport meta is R6 even when the tag is present',
  );
});
