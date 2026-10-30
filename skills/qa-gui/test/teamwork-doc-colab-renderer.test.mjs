import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderDocColabBoard } from '../scripts/teamwork/doc-colab-renderer.mjs';

const fixture = new URL('../scripts/teamwork/example-canonical.json', import.meta.url);

test('Doc-Colab renderer receives the validated canonical file directly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-gui-doc-colab-renderer-'));
  const skill = join(dir, 'doc-colab');
  const scripts = join(skill, 'scripts');
  const output = join(dir, 'QA-Board.html');
  mkdirSync(scripts, { recursive: true });
  const generator = join(scripts, 'make_doc.py');
  writeFileSync(generator, `#!/usr/bin/env python3
import argparse, json
p=argparse.ArgumentParser(); p.add_argument('--template'); p.add_argument('--data'); p.add_argument('--out'); p.add_argument('--verify'); a=p.parse_args()
if a.verify:
    print('verdict=pass template=task-board')
    raise SystemExit(0)
with open(a.data, encoding='utf-8') as f: data=json.load(f)
with open(a.out, 'w', encoding='utf-8') as f: f.write('<html>'+data['canonicalVersion']+'|'+a.data+'</html>')
print('verdict=pass')
`);
  chmodSync(generator, 0o755);

  const result = renderDocColabBoard({ input: fixture.pathname, output, docColabRoot: skill });
  assert.equal(result.ok, true);
  const html = readFileSync(output, 'utf8');
  assert.match(html, /qa-board-teamwork\/v2/);
  assert.match(html, new RegExp(fixture.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('invalid canonical stops before Doc-Colab is invoked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-gui-doc-colab-invalid-'));
  const input = join(dir, 'invalid.json');
  writeFileSync(input, JSON.stringify({ canonicalVersion: 'qa-board-teamwork/v1' }));
  assert.throws(
    () => renderDocColabBoard({ input, output: join(dir, 'out.html'), docColabRoot: join(dir, 'missing') }),
    /canonical gate failed before Doc-Colab render/,
  );
});
