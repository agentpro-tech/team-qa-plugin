// Fix round 1, TQ-5 / D6: the adjudicator is blind on disk. Each engine call runs in a fresh directory outside the run
// directory that holds only the payload's evidence copies (at the paths the payload names), never board.jsonl, a
// receipt, the executor's stream or its draft; the images it is given are those copies; the directory is removed after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { adjudicateCase } from '../../scripts/lib/adjudicator.mjs';
import { fakeEngine } from './fake-engine.mjs';
import { SEAT, fixtureRun } from './support.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function listing(dir) {
  const out = [];
  const walk = (d) => { for (const name of readdirSync(d)) { const p = join(d, name); if (statSync(p).isDirectory()) walk(p); else out.push(relative(dir, p)); } };
  walk(dir);
  return out.sort();
}

test('TQ-5: every adjudicator call runs in a fresh directory with only the payload evidence, removed after', async () => {
  const f = fixtureRun({ notesEvidence: true });
  const seen = [];
  const inner = fakeEngine();
  const engine = { ...inner, async call(args) {
    const cwd = resolve(args.runDir);
    seen.push({ phase: args.phase, cwd, files: listing(cwd), images: args.images, hashes: Object.fromEntries(listing(cwd).map((rel) => [rel, sha(readFileSync(join(cwd, rel)))])) });
    return inner.call(args);
  } };
  const result = await adjudicateCase({ runDir: f.runDir, caseId: f.caseId, seat: SEAT, engine, attestationPath: f.attestation, boardPath: f.qaBoard,
    evidencePaths: [f.rel.dom, f.rel.shot, f.rel.notes, f.rel.receipt] });
  assert.equal(result.outcome, 'CONFIRM', JSON.stringify(result.codes));
  const payload = JSON.parse(readFileSync(join(f.runDir, 'adjudication', f.caseId, 'attempt-1', 'payload.json'), 'utf8'));
  const wanted = payload.evidence.map((e) => e.rel).sort();
  assert.ok(wanted.includes(f.rel.shot) && wanted.includes(f.rel.dom));
  const runDir = resolve(f.runDir);
  assert.deepEqual(seen.map((s) => s.phase), ['checklist', 'judge']);
  for (const call of seen) {
    assert.ok(!call.cwd.startsWith(`${runDir}/`) && call.cwd !== runDir, `the engine cwd ${call.cwd} is outside the run dir`);
    assert.equal(existsSync(call.cwd), false, 'the workspace is removed after the call');
  }
  const [checklist, judge] = seen;
  assert.deepEqual(checklist.files, [], 'the checklist call sees an empty directory');
  assert.deepEqual(judge.files, wanted, 'the judge sees exactly the payload evidence, at the paths the payload names');
  for (const e of payload.evidence) assert.equal(judge.hashes[e.rel], e.sha256, `${e.rel} is a byte copy`);
  for (const leak of ['board.jsonl', 'tracked-plan.json', '.receipt.json', 'stdout', 'attestation']) assert.ok(!judge.files.some((p) => p.includes(leak)), `no ${leak} in the workspace`);
  assert.ok(judge.images.length >= 1 && judge.images.every((p) => p.startsWith(`${judge.cwd}/`)), 'the images given are the workspace copies');
});
