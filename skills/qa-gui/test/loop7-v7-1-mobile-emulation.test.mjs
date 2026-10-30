import test from 'node:test';
import assert from 'node:assert/strict';

const loop7 = await import('../scripts/loop7/index.mjs').catch(() => ({}));

const expected = {
  touch: true,
  dpr: 3,
  identity: 'Android Chrome',
};

const verifiedSample = {
  touchPoints: 5,
  dpr: 3,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  uaDataMobile: true,
  platform: 'Android',
};

test('V7.1 verifies the frozen mobile-emulation pin and rejects unverified readback', () => {
  assert.equal(
    typeof loop7.verifyMobileEmulation,
    'function',
    'scripts/loop7/index.mjs must export verifyMobileEmulation',
  );

  assert.deepEqual(
    loop7.verifyMobileEmulation({
      expected,
      samples: Array.from({ length: 5 }, () => ({ ...verifiedSample })),
    }),
    { verdict: 'PASS' },
  );

  const ungraded = { verdict: 'UNGRADED', code: 'emulation-not-verified' };
  const negativeSamples = [
    Array.from({ length: 5 }, () => ({ ...verifiedSample, touchPoints: 0 })),
    Array.from({ length: 5 }, () => ({ ...verifiedSample, dpr: 2 })),
    Array.from({ length: 5 }, () => ({
      ...verifiedSample,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      uaDataMobile: false,
      platform: 'macOS',
    })),
    [
      { ...verifiedSample },
      { ...verifiedSample, touchPoints: 1 },
      { ...verifiedSample },
      { ...verifiedSample },
      { ...verifiedSample },
    ],
  ];

  for (const samples of negativeSamples) {
    assert.deepEqual(loop7.verifyMobileEmulation({ expected, samples }), ungraded);
  }
});
