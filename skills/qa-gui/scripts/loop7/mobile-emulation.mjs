/**
 * V7.1 — verifyMobileEmulation
 *
 * Grade a mobile-emulation pin from what the page actually read back. A round
 * that thinks it is driving a phone, but is really driving a desktop Chrome
 * window that was merely resized, produces mobile findings that are not about
 * mobile at all. So the pin is not "we asked for mobile"; it is "every repeated
 * readback proves mobile".
 *
 * Three things have to be proven, on every sample:
 *
 *   - touch: the target reports touch points, matching what the pin expects.
 *   - dpr: the device pixel ratio is *exactly* the pinned number. A DPR of 2
 *     where 3 was pinned is a different device, not a close-enough one.
 *   - identity: the target says it is the pinned device family through all
 *     three channels it has — the user-agent string, the UA-CH mobile flag and
 *     the platform. One channel agreeing while another disagrees is a spoof or
 *     a half-applied emulation, and reads as unproven.
 *
 * And one thing has to be proven across samples: repeated readbacks must agree.
 * Emulation that is only sometimes in effect — a first paint before the
 * override lands, a page that renegotiates mid-round — is not a pin, even when
 * some of its samples look perfect on their own.
 *
 * Anything unproven is UNGRADED, never FAIL: a readback we could not verify is
 * a gap in the evidence, not a defect found in the app. This helper is pure —
 * it only grades a readback that Dragon collected; it performs no browser
 * action itself.
 */

/** The single code an unproven pin reports; what failed is always the same fact. */
const UNVERIFIED_CODE = 'emulation-not-verified';

/**
 * What each pinned identity must say about itself, through every channel.
 *
 * A table, not a parser: an identity that is not pinned here cannot be proven,
 * and an unprovable identity fails closed rather than being waved through on a
 * substring guess.
 */
const IDENTITY_PINS = new Map([
  [
    'Android Chrome',
    {
      platform: 'Android',
      uaDataMobile: true,
      userAgent: [/\bAndroid\b/, /\bChrome\/\d/, /\bMobile\b/],
    },
  ],
]);

/** The fields a sample is made of; repeated samples must agree on all of them. */
const SAMPLE_FIELDS = ['touchPoints', 'dpr', 'userAgent', 'uaDataMobile', 'platform'];

/** A readback field is only evidence when it arrived in the shape it claims. */
const isWellFormed = (sample) =>
  sample !== null &&
  typeof sample === 'object' &&
  Number.isFinite(sample.touchPoints) &&
  Number.isFinite(sample.dpr) &&
  typeof sample.userAgent === 'string' &&
  typeof sample.uaDataMobile === 'boolean' &&
  typeof sample.platform === 'string';

/**
 * Whether one sample proves the pin on its own.
 *
 * @param {object} expected the pin `{touch, dpr, identity}`
 * @param {object} sample one readback
 * @returns {boolean}
 */
function provesPin(expected, sample) {
  if (!isWellFormed(sample)) return false;
  if (expected.touch !== sample.touchPoints > 0) return false;
  if (sample.dpr !== expected.dpr) return false;

  const identity = IDENTITY_PINS.get(expected.identity);
  if (identity === undefined) return false;
  if (sample.platform !== identity.platform) return false;
  if (sample.uaDataMobile !== identity.uaDataMobile) return false;
  return identity.userAgent.every((mark) => mark.test(sample.userAgent));
}

/** Two readbacks are the same readback only when every field matches. */
const agree = (a, b) => SAMPLE_FIELDS.every((field) => Object.is(a[field], b[field]));

/**
 * Grade a mobile-emulation pin against the readback it was answered with.
 *
 * @param {object} input `{expected, samples}` — the pin, and the repeated
 *   readbacks collected for it
 * @returns {{verdict: 'PASS'}|{verdict: 'UNGRADED', code: string}} PASS only
 *   when every sample proves the pin and all samples agree; otherwise UNGRADED
 *   with `emulation-not-verified`.
 */
export function verifyMobileEmulation({ expected, samples } = {}) {
  const unverified = { verdict: 'UNGRADED', code: UNVERIFIED_CODE };

  if (expected === null || typeof expected !== 'object') return unverified;
  if (typeof expected.touch !== 'boolean' || !Number.isFinite(expected.dpr)) return unverified;
  if (!Array.isArray(samples) || samples.length === 0) return unverified;

  if (!samples.every((sample) => provesPin(expected, sample))) return unverified;
  if (!samples.every((sample) => agree(sample, samples[0]))) return unverified;

  return { verdict: 'PASS' };
}
