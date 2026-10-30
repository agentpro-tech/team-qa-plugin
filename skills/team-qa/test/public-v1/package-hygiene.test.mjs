import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'package-tool.mjs');
function tree(files, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'teamqa-hygiene-'));
  for (const [file, body] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), body); }
  writeFileSync(join(root, 'package-files.json'), JSON.stringify({ schema: 'agentpro/skill-package-files/v1', skill: 'team-qa', version: '0.0.0', include: ['package-files.json', 'scripts', 'test'], ...config }));
  return root;
}
// Sample violations are assembled at run time so the hygiene gate run on this package finds none in this file.
const U = '/' + 'Users', H = '/' + 'home', DB = 'Drop' + 'box', KEY = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----';
const run = (root, extra = '') => spawnSync(process.execPath, [TOOL, 'hygiene', '--root', root], { encoding: 'utf8', env: { ...process.env, TEAMQA_HYGIENE_EXTRA: extra } });

test('a clean package passes', () => {
  const r = run(tree({ 'scripts/a.mjs': 'export const x = 1;\n', 'test/a.test.mjs': `const p = '${U}/x/evals/run';\n` }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PACKAGE_HYGIENE_PASS files=3/);
});

test('personal paths, keys, tokens and internal files are refused without echoing the secret', () => {
  const secret = 'sk-ant-api03-' + 'Q'.repeat(30);
  const root = tree({
    'scripts/home.mjs': `const root = '${U}/someperson/Dev/scroll';\n`,
    'scripts/linux.mjs': `const root = '${H}/alice/work/';\n`,
    'scripts/sync.mjs': `cp ~/${DB}/x .\n`,
    'scripts/key.pem': `${KEY}\nabc\n`,
    'scripts/token.mjs': `const t = '${secret}';\n`,
    'test/notes-worklog.md': 'notes\n',
    'test/ba-internal.md': 'internal\n',
    'runs/r1/board.json': '{}\n',
    'test/fixtures/runs/r1/board.json': '{}\n',
    'test/accounts.txt': 'user pass\n',
    'test/who.mjs': "const by = 'jane.doe@example.org';\n",
  });
  writeFileSync(join(root, 'package-files.json'), JSON.stringify({ schema: 'agentpro/skill-package-files/v1', skill: 'team-qa', version: '0.0.0', include: ['package-files.json', 'scripts', 'test', 'runs'] }));
  const r = run(root, 'jane.doe@example.org');
  assert.equal(r.status, 1);
  for (const [rule, file] of [['PERSONAL_PATH', 'scripts/home.mjs'], ['PERSONAL_PATH', 'scripts/linux.mjs'], ['PERSONAL_PATH', 'scripts/sync.mjs'],
    ['PRIVATE_KEY', 'scripts/key.pem'], ['TOKEN', 'scripts/token.mjs'], ['INTERNAL_FILE', 'test/notes-worklog.md'], ['INTERNAL_FILE', 'test/ba-internal.md'],
    ['INTERNAL_FILE', 'runs/r1/board.json'], ['INTERNAL_FILE', 'test/accounts.txt'], ['PERSONAL_ID', 'test/who.mjs']])
    assert.match(r.stderr, new RegExp(`PACKAGE_HYGIENE ${rule} ${file.replace('.', '\\.')}`), `${rule} ${file}`);
  assert.doesNotMatch(r.stderr, /QQQQQQQQ|someperson|jane\.doe/, 'findings name the rule and the file, not the matched text');
  assert.doesNotMatch(r.stderr, /test\/fixtures\/runs/, 'a runs folder inside a test fixture is a fixture');
});

test('exclude keeps internal files out of the manifest and out of the scan', () => {
  const root = tree({ 'scripts/a.mjs': 'x\n', 'test/evidence/run-1.txt': `cd ${U}/someperson/Dev\n`, 'test/keep.test.mjs': 'ok\n' },
    { exclude: ['test/evidence/**'] });
  assert.equal(run(root).status, 0);
  const out = join(root, 'manifest.json');
  assert.equal(spawnSync(process.execPath, [TOOL, 'manifest', '--root', root, '--out', out], { encoding: 'utf8' }).status, 0);
  const files = JSON.parse(readFileSync(out, 'utf8')).files.map((f) => f.path);
  assert.deepEqual(files, ['package-files.json', 'scripts/a.mjs', 'test/keep.test.mjs']);
  const unsafe = tree({ 'scripts/a.mjs': 'x\n' }, { exclude: ['../etc'] });
  assert.notEqual(run(unsafe).status, 0);
});

test('the shipped package list keeps internal documents out', () => {
  const config = JSON.parse(readFileSync(join(dirname(TOOL), '..', 'package-files.json'), 'utf8'));
  for (const item of ['ba-mo.md', 'docs', 'runs']) assert.ok(!config.include.includes(item), item);
  assert.ok(config.include.includes('scripts'), 'scripts/requirements.json ships with scripts/');
});

test('shipped text is English unless package-files.json lists the file under non_english', () => {
  const vi = 'Xong khi: ng\u01b0\u1eddi d\u00f9ng b\u1ea5m l\u01b0u\n'; // written as escapes so this test file stays English
  const root = tree({ 'scripts/a.mjs': `// ${vi}`, 'scripts/parser/vi-headings.mjs': `export const DONE = '${vi.trim()}';\n`, 'test/keep.txt': 'x\n' });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PACKAGE_HYGIENE NON_ENGLISH scripts\/a\.mjs/);
  assert.match(r.stderr, /PACKAGE_HYGIENE NON_ENGLISH scripts\/parser\/vi-headings\.mjs/);
  const allowed = tree({ 'scripts/a.mjs': 'export const x = 1;\n', 'scripts/parser/vi-headings.mjs': `export const DONE = '${vi.trim()}';\n`, 'test/keep.txt': 'x\n' }, { non_english: ['scripts/parser/**'] });
  assert.equal(run(allowed).status, 0);
  assert.notEqual(run(tree({ 'scripts/a.mjs': 'x\n', 'test/keep.txt': 'x\n' }, { non_english: ['/etc'] })).status, 0);
  // A word in upper case only is caught too (the RTM marker of earlier versions, written as escapes).
  const upper = run(tree({ 'scripts/b.mjs': "export const GAP = '**TR\\u1ed0NG**'.normalize();\n// **TR\u1ed0NG**\n", 'test/keep.txt': 'x\n' }));
  assert.equal(upper.status, 1);
  assert.match(upper.stderr, /PACKAGE_HYGIENE NON_ENGLISH scripts\/b\.mjs/);
});

test('the owner list in a local file marks names, handles and client names as personal', () => {
  const root = tree({ 'scripts/a.mjs': "// approved by Jane Roe for the Acme rollout\n", 'scripts/b.mjs': 'export const ok = 1;\n', 'test/keep.txt': 'x\n' });
  const list = join(mkdtempSync(join(tmpdir(), 'teamqa-hygiene-ids-')), 'ids.txt');
  writeFileSync(list, '# owner identity\nJane Roe\nacme\n');
  const r = spawnSync(process.execPath, [TOOL, 'hygiene', '--root', root], { encoding: 'utf8', env: { ...process.env, TEAMQA_HYGIENE_IDS: list } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PACKAGE_HYGIENE PERSONAL_ID scripts\/a\.mjs/);
  assert.doesNotMatch(r.stderr, /scripts\/b\.mjs|Jane|Acme/i);
});
