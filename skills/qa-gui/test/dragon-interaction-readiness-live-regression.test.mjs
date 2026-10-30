import assert from 'node:assert/strict';
import test from 'node:test';

import { READINESS_SAMPLE_SCRIPT } from '../scripts/dragon-interaction-readiness-preflight.mjs';

test('readiness probe excludes negative-tabindex containers and measures only the target animation', () => {
  assert.match(
    READINESS_SAMPLE_SCRIPT,
    /\[tabindex\]:not\(\[tabindex=["']-1["']\]\)/,
    'tabindex=-1 is programmatic focus plumbing, not a Dragon-actionable target',
  );
  assert.doesNotMatch(
    READINESS_SAMPLE_SCRIPT,
    /getAnimations\(\{\s*subtree\s*:\s*true\s*\}\)/,
    'a stable parent must not inherit animation state from a moving descendant',
  );
});
