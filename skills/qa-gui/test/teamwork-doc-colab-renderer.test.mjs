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

// L1: Doc-Colab was looked for in ~/.agents/skills only, so a QA GUI installed elsewhere with Doc-Colab beside it (a
// suite install into another root, the Team QA plugin's skills folder) did not find it.
test('Doc-Colab installed next to this QA GUI is found without DOC_COLAB_SKILL_ROOT', async () => {
  const { cpSync, existsSync, realpathSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-doc-colab-sibling-')));
  const skills = join(dir, 'plugin', 'skills'), gui = join(skills, 'qa-gui'), generator = join(skills, 'doc-colab', 'scripts', 'make_doc.py');
  cpSync(fileURLToPath(new URL('../scripts', import.meta.url)), join(gui, 'scripts'), { recursive: true });
  mkdirSync(join(skills, 'doc-colab', 'scripts'), { recursive: true });
  writeFileSync(generator, `import argparse
p=argparse.ArgumentParser(); p.add_argument('--template'); p.add_argument('--data'); p.add_argument('--out'); p.add_argument('--verify'); a=p.parse_args()
if not a.verify: open(a.out, 'w').write('<html>sibling</html>')
print('verdict=pass')
`);
  mkdirSync(join(dir, 'home'));
  const env = { ...process.env, HOME: join(dir, 'home') };
  delete env.DOC_COLAB_SKILL_ROOT;
  const output = join(dir, 'QA-Board.html');
  const run = spawnSync(process.execPath, [join(gui, 'scripts', 'teamwork', 'doc-colab-renderer.mjs'), fixture.pathname, '--out', output], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(output, 'utf8'), '<html>sibling</html>');
  assert.ok(existsSync(generator));
  // DOC_COLAB_SKILL_ROOT still wins.
  const other = join(dir, 'missing-doc-colab');
  const pinned = spawnSync(process.execPath, [join(gui, 'scripts', 'teamwork', 'doc-colab-renderer.mjs'), fixture.pathname, '--out', join(dir, 'b.html')], { encoding: 'utf8', env: { ...env, DOC_COLAB_SKILL_ROOT: other } });
  assert.notEqual(pinned.status, 0);
  assert.match(pinned.stderr, /missing-doc-colab/);
});
