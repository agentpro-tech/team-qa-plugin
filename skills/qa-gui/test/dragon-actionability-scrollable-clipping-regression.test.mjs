import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const PRODUCT = resolve(ROOT, 'scripts/dragon-actionability-preflight.mjs');

function element(tagName, id, rect) {
  return {
    tagName,
    id,
    disabled: false,
    parentElement: null,
    textContent: '',
    getAttribute(name) {
      return name === 'id' ? id : null;
    },
    getBoundingClientRect() {
      return rect;
    },
    contains(candidate) {
      return candidate === this;
    },
    closest() {
      return null;
    },
  };
}

test('a control below a scrollable panel fold remains reachable, not occluded', async () => {
  const { ACTIONABILITY_SNAPSHOT_SCRIPT, classifyActionabilityObservation } = await import(
    `${pathToFileURL(PRODUCT).href}?scrollable-clipping=1`
  );

  const html = element('HTML', '', { left: 0, top: 0, right: 320, bottom: 740, width: 320, height: 740 });
  const body = element('BODY', '', { left: 0, top: 0, right: 320, bottom: 740, width: 320, height: 740 });
  const panel = element('DIV', 'panel', { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 });
  const control = element('BUTTON', 'deep-row', { left: 20, top: 150, right: 120, bottom: 190, width: 100, height: 40 });
  control.parentElement = panel;
  panel.parentElement = body;
  body.parentElement = html;

  const styles = new Map([
    [html, { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', position: 'static', overflow: 'visible', overflowX: 'visible', overflowY: 'visible' }],
    [body, { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', position: 'static', overflow: 'visible', overflowX: 'visible', overflowY: 'visible' }],
    [panel, { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', position: 'static', overflow: 'auto', overflowX: 'auto', overflowY: 'auto' }],
    [control, { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', position: 'static', overflow: 'visible', overflowX: 'visible', overflowY: 'visible' }],
  ]);
  const document = {
    documentElement: Object.assign(html, { scrollHeight: 740 }),
    body: Object.assign(body, { scrollHeight: 740 }),
    querySelectorAll(selector) {
      return selector.includes('aria-modal') ? [] : [control];
    },
    elementFromPoint() {
      return panel;
    },
  };
  const context = {
    document,
    getComputedStyle: (candidate) => styles.get(candidate),
    innerWidth: 320,
    innerHeight: 740,
    location: { href: 'https://fixture.test/scrollable-panel' },
  };

  const observation = vm.runInNewContext(ACTIONABILITY_SNAPSHOT_SCRIPT, context);
  assert.equal(observation.targets.length, 1);
  const [target] = observation.targets;
  assert.equal(target.clipping.clipped, true);
  assert.equal(target.clipping.scrollable, true);
  assert.equal(target.clipping.hardClipped, false);
  assert.equal(target.clipping.reachableByScroll, true);
  assert.deepEqual(classifyActionabilityObservation(observation), []);
});
