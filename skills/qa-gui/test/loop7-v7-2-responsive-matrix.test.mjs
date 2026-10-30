import assert from 'node:assert/strict';
import test from 'node:test';

const EXPECTED_MATRIX = [
  { id: 'phone-320', w: 320, h: 740, profile: 'mobile', dpr: 3 },
  { id: 'phone-360', w: 360, h: 800, profile: 'mobile', dpr: 3 },
  { id: 'desktop-767', w: 767, h: 800, profile: 'desktop', dpr: 1 },
  { id: 'desktop-768', w: 768, h: 800, profile: 'desktop', dpr: 1 },
  { id: 'desktop-769', w: 769, h: 800, profile: 'desktop', dpr: 1 },
  { id: 'desktop-1280', w: 1280, h: 800, profile: 'desktop', dpr: 1 },
  { id: 'phone-landscape', w: 800, h: 360, profile: 'mobile', dpr: 3 },
];

test('V7.2 exports the canonical responsive matrix from one source', async () => {
  const loop7 = await import('../scripts/loop7/index.mjs');

  assert.ok(
    Object.hasOwn(loop7, 'RESPONSIVE_MATRIX'),
    'scripts/loop7/index.mjs must export RESPONSIVE_MATRIX',
  );
  assert.ok(
    Object.hasOwn(loop7, 'responsiveMatrix'),
    'scripts/loop7/index.mjs must export responsiveMatrix',
  );
  assert.equal(typeof loop7.responsiveMatrix, 'function');
  assert.deepEqual(loop7.RESPONSIVE_MATRIX, EXPECTED_MATRIX);
  assert.deepEqual(loop7.responsiveMatrix(), EXPECTED_MATRIX);
});
