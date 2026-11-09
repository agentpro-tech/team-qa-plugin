// Upgrade R2a: each pointer kind resolves only to evidence the engine was given, and only inside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adjudicateCase, imageSize, mp4DurationMs, pointerContext, resolvePointer } from '../../scripts/lib/adjudicator.mjs';
import { fakeEngine } from './fake-engine.mjs';
import { SEAT, fixtureRun, jpegHeader, mp4, png } from './support.mjs';

test('image sizes and recording durations are read from the files themselves', () => {
  assert.deepEqual(imageSize(png(320, 200)), { width: 320, height: 200, media_type: 'image/png' });
  assert.deepEqual(imageSize(jpegHeader(1280, 720)), { width: 1280, height: 720, media_type: 'image/jpeg' });
  assert.equal(imageSize(Buffer.from('not an image')), null);
  assert.equal(mp4DurationMs(mp4(5000)), 5000);
  assert.equal(mp4DurationMs(Buffer.from('webm or garbage')), null);
});

async function context() {
  const f = fixtureRun();
  writeFileSync(join(f.runDir, 'evidence/TC-01/clip.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
  await adjudicateCase({ runDir: f.runDir, caseId: f.caseId, seat: SEAT, engine: fakeEngine(), attestationPath: f.attestation, boardPath: f.qaBoard,
    evidencePaths: [f.rel.dom, 'evidence/TC-01/clip.webm'] });
  const payload = JSON.parse(readFileSync(join(f.runDir, 'adjudication', f.caseId, 'attempt-1', 'payload.json'), 'utf8'));
  const ctx = pointerContext({ runDir: f.runDir, payload });
  const id = (rel) => payload.evidence.find((e) => e.rel === rel).id;
  return { f, payload, ctx, ids: { shot: id(f.rel.shot), dom: id(f.rel.dom), video: id(f.rel.video), webm: id('evidence/TC-01/clip.webm') } };
}
const reason = (p, ctx) => { const r = resolvePointer(p, ctx); return r.ok ? 'OK' : r.reason; };

test('every pointer kind resolves inside real evidence, and nowhere else', async () => {
  const { payload, ctx, ids } = await context();
  const first = payload.action_chain[0], last = payload.action_chain.at(-1);
  const cases = [
    [{ kind: 'file', evidence: ids.dom }, 'OK'],
    [{ kind: 'file', evidence: ids.dom, line: 1 }, 'OK'],
    [{ kind: 'file', evidence: ids.dom, line: 99 }, 'FILE_LINE_OUTSIDE'],
    [{ kind: 'file', evidence: ids.shot, line: 1 }, 'FILE_NOT_TEXT'],
    [{ kind: 'file', evidence: 'E99' }, 'EVIDENCE_UNKNOWN'],
    [{ kind: 'image_region', evidence: ids.shot, x: 0, y: 0, w: 320, h: 200 }, 'OK'],
    [{ kind: 'image_region', evidence: ids.shot, x: 300, y: 10, w: 30, h: 10 }, 'IMAGE_REGION_OUTSIDE'],
    [{ kind: 'image_region', evidence: ids.shot, x: 0, y: 0, w: 0, h: 10 }, 'IMAGE_REGION_INVALID'],
    [{ kind: 'image_region', evidence: ids.shot, x: 1.5, y: 0, w: 10, h: 10 }, 'IMAGE_REGION_INVALID'],
    [{ kind: 'image_region', evidence: ids.dom, x: 0, y: 0, w: 1, h: 1 }, 'NOT_IMAGE'],
    [{ kind: 'timestamp', evidence: ids.video, t_ms: 4200 }, 'OK'],
    [{ kind: 'timestamp', evidence: ids.video, t_ms: 6000 }, 'TIMESTAMP_OUTSIDE'],
    [{ kind: 'timestamp', evidence: ids.webm, t_ms: 10 }, 'TIMESTAMP_NO_DURATION'],
    [{ kind: 'timestamp', evidence: ids.shot, t_ms: 10 }, 'TIMESTAMP_NO_DURATION'],
    [{ kind: 'timestamp', at: first.called_at }, 'OK'],
    [{ kind: 'timestamp', at: last.result_at }, 'OK'],
    [{ kind: 'timestamp', at: '2026-11-04T03:00:00.000Z' }, 'TIMESTAMP_OUTSIDE'],
    [{ kind: 'timestamp', at: 'yesterday' }, 'TIMESTAMP_INVALID'],
    [{ kind: 'selector', selector: '#place-order' }, 'OK'],
    [{ kind: 'selector', selector: '[data-testid="add-to-cart"]' }, 'OK'],
    [{ kind: 'selector', selector: 'h1.title.big', evidence: ids.dom }, 'OK'],
    [{ kind: 'selector', selector: 'button[data-testid="place-order"]', evidence: ids.dom }, 'OK'],
    [{ kind: 'selector', selector: '#missing' }, 'SELECTOR_NOT_FOUND'],
    [{ kind: 'selector', selector: '#missing', evidence: ids.dom }, 'SELECTOR_NOT_FOUND'],
    [{ kind: 'selector', selector: 'main > h1', evidence: ids.dom }, 'SELECTOR_UNSUPPORTED'],
    [{ kind: 'selector', selector: '.title', evidence: ids.shot }, 'NOT_DOM_SNAPSHOT'],
    [{ kind: 'action', action: 'A1' }, 'OK'],
    [{ kind: 'action', action: 'A99' }, 'ACTION_UNKNOWN'],
    [{ kind: 'region', evidence: ids.shot }, 'POINTER_KIND_UNKNOWN'],
    [{ kind: 'file', evidence: ids.dom, path: '/etc/passwd' }, 'POINTER_FIELDS'],
    ['E1', 'POINTER_FIELDS'],
  ];
  for (const [pointer, expected] of cases) assert.equal(reason(pointer, ctx), expected, JSON.stringify(pointer));
});

test('a pointer to evidence that changed after it was sent does not resolve', async () => {
  const { f, ctx, ids } = await context();
  writeFileSync(join(f.runDir, f.rel.dom), '<html><body><button id="place-order">changed</button></body></html>');
  const fresh = pointerContext({ runDir: f.runDir, payload: ctx.payload });
  assert.equal(reason({ kind: 'file', evidence: ids.dom }, fresh), 'EVIDENCE_CHANGED');
});
