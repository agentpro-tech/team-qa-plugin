import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const bboxModuleUrl = new URL('../scripts/loop8/index.mjs', import.meta.url);
const preflightModuleUrl = new URL('../scripts/dragon-responsive-matrix-preflight.mjs', import.meta.url);
const corpusUrl = new URL('./loop8/corpus/bbox-cases.json', import.meta.url);

test('V8.1 attaches exact selector-backed bboxes and carries them into responsive risks', async () => {
  const failures = [];
  let attachFindingBboxes;
  let classifyResponsiveMatrix;

  try {
    ({ attachFindingBboxes } = await import(`${bboxModuleUrl.href}?planner-red=1`));
  } catch {
    failures.push('scripts/loop8/index.mjs must import cleanly');
  }
  try {
    ({ classifyResponsiveMatrix } = await import(`${preflightModuleUrl.href}?planner-red=1`));
  } catch {
    failures.push('Dragon responsive preflight must import cleanly');
  }

  if (typeof attachFindingBboxes !== 'function') {
    failures.push('attachFindingBboxes must be exported');
  } else {
    const cases = JSON.parse(await readFile(corpusUrl, 'utf8'));
    for (const fixture of cases) {
      const original = structuredClone(fixture.input);
      const first = attachFindingBboxes(fixture.input);
      const second = attachFindingBboxes(fixture.input);
      try { assert.deepEqual(first, fixture.expected); }
      catch { failures.push(`${fixture.id}: must match the frozen bbox contract`); }
      try { assert.deepEqual(second, first); }
      catch { failures.push(`${fixture.id}: repeated runs must be deterministic`); }
      try { assert.deepEqual(fixture.input, original); }
      catch { failures.push(`${fixture.id}: input evidence must remain immutable`); }
    }
  }

  if (typeof classifyResponsiveMatrix !== 'function') {
    failures.push('classifyResponsiveMatrix must remain exported');
  } else {
    const [risk] = classifyResponsiveMatrix([{
      requested: { w: 320, h: 800 },
      dpr: 3,
      measurements: [{
        selector: 'div > a.inline-flex',
        rect: { x: 170.9609375, y: 438.5, width: 116.0390625, height: 44 },
      }],
      ui: {
        viewport: { w: 320, h: 800 },
        issues: [{ sev: 'high', rule: 'page-overflow-x', sel: 'div > a.inline-flex' }],
      },
      a11y: { viewport: { w: 320, h: 800 }, issues: [] },
    }]);
    const expected = {
      x: 170.9609375,
      y: 438.5,
      width: 116.0390625,
      height: 44,
      dpr: 3,
      unit: 'css-px',
    };
    try {
      assert.deepEqual(risk?.bbox, expected);
    } catch {
      failures.push('selector-backed responsive risks must carry the measured bbox');
    }
  }

  assert.deepEqual(failures, [], `Missing V8.1 bbox behavior:\n- ${failures.join('\n- ')}`);
});
