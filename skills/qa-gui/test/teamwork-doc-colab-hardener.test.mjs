import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { hardenDocColabPacket } from '../scripts/teamwork/doc-colab-hardener.mjs';

const fixture = JSON.parse(await readFile(new URL('../scripts/teamwork/example-canonical.json', import.meta.url), 'utf8'));

test('Doc-Colab image evidence is materialized before RETEST is hardened', () => {
  const canonical = structuredClone(fixture);
  canonical.defects[0].status = 'FIXING';
  const dir = mkdtempSync(join(tmpdir(), 'qa-gui-doc-colab-harden-'));
  const packet = {
    protocol: 'doc-colab/v2', stagedRev: canonical.rev,
    qaDelta: {
      baseRev: canonical.rev,
      updates: [{ entity: 'defect', id: 'DF-01', field: 'status', from: 'FIXING', to: 'RETEST' }],
      comments: [],
      evidence: [{
        id: 'proof-1', entity: 'defect', entityId: 'DF-01', type: 'image', path: 'proof.png',
        mime: 'image/png', size: 8, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', addedAt: '2026-08-11T08:20:00Z',
      }],
    },
  };

  const result = hardenDocColabPacket({
    canonical, packet, evidenceDir: dir,
    context: { actor: 'Owner', now: '2026-08-11T08:20:00Z', qaActors: ['Owner'] },
  });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(result.data.defects[0].status, 'RETEST');
  const proof = result.data.defects[0].fixEvidence.at(-1);
  assert.equal(existsSync(proof.path), true);
  assert.equal(readFileSync(proof.path).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('hardener rejects in-place canonical output', () => {
  assert.throws(
    () => hardenDocColabPacket({ canonical: fixture, packet: { protocol: 'doc-colab/v2', rev: fixture.rev }, evidenceDir: '/tmp', input: '/tmp/canonical.json', output: '/tmp/canonical.json', context: { actor: 'Owner', now: '2026-08-11T08:20:00Z' } }),
    /refuses to overwrite the input canonical/,
  );
});
