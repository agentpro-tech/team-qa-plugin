import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { addRoundResult } from '../scripts/teamwork/canonical.mjs';
import { packageSelfContained } from '../scripts/teamwork/evidence-packager.mjs';

const fixture = JSON.parse(await readFile(new URL('../.teamcode/qa-board-teamwork/fixtures/canonical.valid.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);

test('round results are append-only and duplicate rounds fail without mutation', () => {
  const data = clone(fixture);
  const before = JSON.stringify(data);
  const duplicate = addRoundResult(data, 'TC-01', {
    round: 2,
    functionVerdict: 'PASS',
    uiVerdict: 'PASS',
    recordedAt: '2026-08-11T13:00:00+07:00',
    evidence: [],
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join('\n'), /append-only/);
  assert.equal(JSON.stringify(data), before);

  const added = addRoundResult(data, 'TC-01', {
    round: 3,
    functionVerdict: 'PASS',
    uiVerdict: 'FAIL',
    recordedAt: '2026-08-11T13:01:00+07:00',
    evidence: ['round-3.png'],
  }, { actor: 'qa-agent' });
  assert.equal(added.ok, true);
  assert.deepEqual(added.data.cases[0].results.map((result) => result.round), [1, 2, 3]);
  assert.equal(added.data.cases[0].status, 'FAIL');
  assert.equal(added.data.cases[0].history.at(-1).to, 'FAIL');
});

test('videos remain inline below the threshold and all become disclosed links above it', () => {
  const image = { path: 'proof.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
  const smallVideo = { path: 'small.mp4', mime: 'video/mp4', bytes: new Uint8Array([4, 5, 6]) };
  const small = packageSelfContained(clone(fixture), [image, smallVideo]);
  assert.equal(small.ok, true);
  assert.deepEqual(small.inlineVideos, ['small.mp4']);
  assert.match(small.html, /data:video\/mp4;base64,/);

  const largeVideo = { path: 'large.mp4', mime: 'video/mp4', bytes: new Uint8Array(25 * 1024 * 1024) };
  const large = packageSelfContained(clone(fixture), [image, smallVideo, largeVideo]);
  assert.equal(large.ok, true);
  assert.deepEqual(large.inlineVideos, []);
  assert.deepEqual(large.linkedVideos, ['small.mp4', 'large.mp4']);
  assert.match(large.html, /data:image\/png;base64,/);
  assert.doesNotMatch(large.html, /data:video\/mp4;base64,/);
  assert.match(large.html, /vượt 25MB/);
});
