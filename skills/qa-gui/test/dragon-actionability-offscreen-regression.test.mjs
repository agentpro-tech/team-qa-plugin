import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const PRODUCT = resolve(import.meta.dirname, '../scripts/dragon-actionability-preflight.mjs');

test('an offscreen control stays clean when normal page scrolling can reach it', async () => {
  const {
    ACTIONABILITY_SNAPSHOT_SCRIPT,
    classifyActionabilityObservation,
  } = await import(`${pathToFileURL(PRODUCT).href}?offscreen-regression=1`);
  const documentElement = { scrollHeight: 1200 };
  const body = { parentElement: documentElement, scrollHeight: 1200 };
  const control = {
    tagName: 'BUTTON',
    id: 'later',
    textContent: 'Later',
    disabled: false,
    parentElement: body,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 20, right: 120, top: 1000, bottom: 1040, width: 100, height: 40 }),
    closest: () => null,
    contains: () => false,
  };
  const style = {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    overflow: 'visible',
    overflowX: 'visible',
    overflowY: 'visible',
    pointerEvents: 'auto',
    position: 'static',
  };
  const document = {
    documentElement,
    body,
    querySelectorAll: (selector) => selector.includes('aria-modal') ? [] : [control],
    elementFromPoint: () => null,
  };
  const observation = runInNewContext(ACTIONABILITY_SNAPSHOT_SCRIPT, {
    document,
    getComputedStyle: () => style,
    innerWidth: 1280,
    innerHeight: 720,
    location: { href: 'https://example.test/offscreen' },
  });

  assert.equal(observation.scrollLocked, false);
  assert.equal(observation.targets[0].outsideViewport, true);
  assert.equal(observation.targets[0].actionableArea, 4000);
  assert.equal(observation.targets[0].clipping.visibleRatio, 1);
  assert.equal(observation.targets[0].hitTest.sampledPoints, 0);
  assert.deepEqual(classifyActionabilityObservation(observation), []);
});
