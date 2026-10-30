import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { renderDocColabBoard, verifyDocColabBoard } from '../scripts/teamwork/doc-colab-renderer.mjs';

const fixture = new URL('../scripts/teamwork/example-canonical.json', import.meta.url);
const renderer = join(dirname(fileURLToPath(import.meta.url)), '../scripts/teamwork/doc-colab-renderer.mjs');

function fakeSkill({ rejectVerify = false, misleadingVerify = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-gui-doc-colab-integrity-'));
  const skill = join(dir, 'doc-colab');
  const scripts = join(skill, 'scripts');
  const log = join(dir, 'calls.jsonl');
  mkdirSync(scripts, { recursive: true });
  const generator = join(scripts, 'make_doc.py');
  writeFileSync(generator, `#!/usr/bin/env python3
import json, pathlib, sys
args=sys.argv[1:]
with open(${JSON.stringify(log)}, 'a', encoding='utf-8') as f: f.write(json.dumps(args)+'\\n')
if '--verify' in args:
    if ${rejectVerify ? 'True' : 'False'}:
        print('verdict=fail code=TEMPLATE_TAMPERED', file=sys.stderr); sys.exit(1)
    if ${misleadingVerify ? 'True' : 'False'}:
        print('expected verdict=pass, got verdict=fail: TEMPLATE_TAMPERED'); sys.exit(0)
    print('verdict=pass template=task-board'); sys.exit(0)
out=args[args.index('--out')+1]
pathlib.Path(out).write_text('<html>generated</html>', encoding='utf-8')
print('verdict=pass')
`);
  chmodSync(generator, 0o755);
  return { dir, skill, log };
}

test('renderer verifies the exact generated board against canonical JSON before returning success', () => {
  const { dir, skill, log } = fakeSkill();
  const output = join(dir, 'QA-Board.html');
  const result = renderDocColabBoard({ input: fixture.pathname, output, docColabRoot: skill });
  assert.equal(result.ok, true);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['--verify', output, '--data', fixture.pathname, '--template', 'task-board']);
  assert.match(result.verification, /verdict=pass/);
});

test('renderer fails closed when the Doc-Colab integrity verifier rejects the board', () => {
  const { dir, skill } = fakeSkill({ rejectVerify: true });
  assert.throws(
    () => renderDocColabBoard({ input: fixture.pathname, output: join(dir, 'QA-Board.html'), docColabRoot: skill }),
    /Doc-Colab integrity gate failed: verdict=fail code=TEMPLATE_TAMPERED/,
  );
});

test('direct final-byte verification rejects a misleading diagnostic that merely mentions verdict=pass', () => {
  const { dir, skill } = fakeSkill({ misleadingVerify: true });
  const output = join(dir, 'QA-Board.html');
  writeFileSync(output, '<html>generated</html>');
  assert.throws(
    () => verifyDocColabBoard({ input: fixture.pathname, output, docColabRoot: skill }),
    /verifier must emit exactly one machine verdict=pass line/,
  );
});

test('direct final-byte verification rejects a missing rendered board', () => {
  const { dir, skill } = fakeSkill();
  assert.throws(
    () => verifyDocColabBoard({ input: fixture.pathname, output: join(dir, 'missing.html'), docColabRoot: skill }),
    /Doc-Colab board not found/,
  );
});

test('CLI verify-existing parses a flag placed before the canonical positional path', () => {
  const { dir, skill } = fakeSkill();
  const output = join(dir, 'QA-Board.html');
  writeFileSync(output, '<html>generated</html>');
  const run = spawnSync(process.execPath, [renderer, '--doc-colab-root', skill, fixture.pathname, '--verify-existing', output], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /^Verified:/);
  assert.match(run.stdout, /verdict=pass/);
});
