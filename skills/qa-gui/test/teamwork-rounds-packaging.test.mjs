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

// M12: the "self-contained" board put the asset paths as given on the command line (/Users/<name>/...) into alt text,
// captions and video links: a personal path that also broke on any other machine.
test('the packaged board holds no absolute machine path; a linked video is copied next to the board', async () => {
  const { mkdirSync, mkdtempSync, existsSync, readFileSync, realpathSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-package-')));
  const home = join(work, 'Users', 'someone', 'Desktop', 'shots'), board = join(work, 'out');
  mkdirSync(home, { recursive: true }); mkdirSync(join(board, 'evidence'), { recursive: true });
  writeFileSync(join(home, 'login.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(home, 'run.mp4'), Buffer.alloc(25 * 1024 * 1024 + 1));
  writeFileSync(join(board, 'evidence', 'inside.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(work, 'canonical.json'), JSON.stringify(fixture));
  const out = join(board, 'board.html');
  const run = spawnSync(process.execPath, [new URL('../scripts/teamwork/evidence-packager.mjs', import.meta.url).pathname, join(work, 'canonical.json'),
    '--asset', join(home, 'login.png'), '--asset', join(home, 'run.mp4'), '--asset', join(board, 'evidence', 'inside.png'), '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const html = readFileSync(out, 'utf8');
  assert.equal(html.includes(work), false, 'an absolute path of this machine is in the board');
  assert.equal(html.includes('someone'), false, 'the home folder name is in the board');
  assert.match(html, /alt="login\.png"/);
  assert.match(html, /alt="evidence\/inside\.png"/);
  const href = /<a class="linked-video" href="([^"]+)"/.exec(html)?.[1];
  assert.ok(href && !href.startsWith('/') && !href.includes('..'), href);
  assert.ok(existsSync(join(board, href)), `the linked video is inside the package at ${href}`);
});
