import assert from 'node:assert/strict';
import test from 'node:test';

test('V7.3 detects only essential hover-only controls on mobile viewports', async () => {
  const loop7 = await import('../scripts/loop7/index.mjs');

  assert.equal(
    typeof loop7.detectHoverOnly,
    'function',
    'scripts/loop7/index.mjs must export detectHoverOnly',
  );

  const mobileViewport = { id: 'phone-360', w: 360, h: 800, profile: 'mobile' };
  const candidates = [
    {
      selector: '#account-actions',
      essential: true,
      revealedByHover: true,
      tapEquivalent: false,
      clickEquivalent: false,
    },
    {
      selector: '#hover-nav-with-tap',
      essential: true,
      revealedByHover: true,
      tapEquivalent: true,
      clickEquivalent: false,
    },
    {
      selector: '#decorative-tooltip',
      essential: false,
      revealedByHover: true,
      tapEquivalent: false,
      clickEquivalent: false,
    },
    {
      selector: '#ordinary-click-menu',
      essential: true,
      revealedByHover: false,
      tapEquivalent: false,
      clickEquivalent: true,
    },
  ];

  const expected = [
    {
      rule: 'HOVER_ONLY',
      selector: '#account-actions',
      viewport: mobileViewport,
      evidence: null,
    },
  ];

  assert.deepEqual(
    loop7.detectHoverOnly({ viewport: mobileViewport, candidates }),
    expected,
  );
  assert.deepEqual(
    loop7.detectHoverOnly({ viewport: mobileViewport, candidates }),
    expected,
    'the detector must be deterministic',
  );

  assert.deepEqual(
    loop7.detectHoverOnly({
      viewport: { id: 'desktop-1280', w: 1280, h: 800, profile: 'desktop' },
      candidates: [candidates[0]],
    }),
    [],
    'desktop-only rows must not produce hover-only mobile findings',
  );
});
