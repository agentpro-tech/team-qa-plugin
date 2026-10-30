import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.TEAMQA_TEST_CLI ?? join(root, 'scripts/teamqa.mjs');
const qaGuiRoot = process.env.TEAMQA_REAL_QA_GUI_ROOT;
const docColabRoot = process.env.TEAMQA_REAL_DOC_COLAB_ROOT;
const available = qaGuiRoot && docColabRoot
  && existsSync(join(qaGuiRoot, 'scripts/teamwork/cli.mjs'))
  && existsSync(join(docColabRoot, 'scripts/make_doc.py'));

function run(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      TEAMQA_QA_GUI_ROOT: qaGuiRoot,
      TEAMQA_DOC_COLAB_SCRIPT: join(docColabRoot, 'scripts/make_doc.py'),
      ...extraEnv,
    },
  });
}

test('board prepare routes real projections Space then Notion then verified Doc-Colab', { skip: !available }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-real-prepare-'));
  const canonical = join(qaGuiRoot, 'scripts/teamwork/example-canonical.json');
  const caps = join(dir, 'capabilities.json');
  const yes = {status:'available',evidence:'synthetic connector availability for routing test'};
  const no = {status:'unavailable',evidence:'synthetic connector absence for routing test'};
  for (const [renderer, capabilities] of [['space',{space:yes,notion:yes}], ['notion',{space:no,notion:yes}], ['doc-colab',{space:no,notion:no}]]) {
    writeFileSync(caps, JSON.stringify(capabilities));
    const out=join(dir, renderer+'.json');
    const result=run(dir,['board','prepare','--file',canonical,'--capabilities',caps,'--out',out]);
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,new RegExp(`renderer=${renderer}`));
    assert.equal(result.stdout.trim().split('\n').length,1,'one machine receipt per preparation');
    if(renderer==='doc-colab') {
      assert.ok(existsSync(out+'.html'));
      const verified=run(dir,['board','verify','--file',canonical,'--artifact',out+'.html']);
      assert.equal(verified.status,0,verified.stderr||verified.stdout);
    } else assert.ok(existsSync(out));
  }
});

test('real QA board opens only after verification; template tampering prevents the opener', { skip: !available }, () => {
  const dir=mkdtempSync(join(tmpdir(),'teamqa-real-open-'));
  const canonical=join(qaGuiRoot,'scripts/teamwork/example-canonical.json');
  const html=join(dir,'index.html');
  const rendered=run(dir,['board','render','--file',canonical,'--out',html]);
  assert.equal(rendered.status,0,rendered.stderr||rendered.stdout);
  const marker=join(dir,'opened.txt');
  const opener=JSON.stringify([process.execPath,'-e','require("node:fs").writeFileSync(process.argv[1],process.argv[2]);',marker]);
  const opened=run(dir,['board','open','--file',html,'--canonical',canonical],{TEAMQA_OPEN_CMD:opener});
  assert.equal(opened.status,0,opened.stderr||opened.stdout);
  assert.equal(readFileSync(marker,'utf8'),html);
  appendFileSync(html,'<script>window.templateWorkaround=true;</script>');
  const rejectedMarker=join(dir,'must-not-open.txt');
  const rejected=run(dir,['board','open','--file',html,'--canonical',canonical],{TEAMQA_OPEN_CMD:JSON.stringify([process.execPath,'-e','require("node:fs").writeFileSync(process.argv[1],"opened");',rejectedMarker])});
  assert.notEqual(rejected.status,0);
  assert.match(rejected.stderr,/BOARD_INTEGRITY_FAILED/);
  assert.equal(existsSync(rejectedMarker),false);
});

test('Team QA opens a board through the current qa-gui and Doc-Colab runtime interfaces', { skip: !available }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-real-board-'));
  const canonical = join(dir, 'canonical.json');
  const html = join(dir, 'index.html');
  const created = run(dir, [
    'board', 'init', '--run', 'runtime-contract', '--title', 'Runtime integration QA', '--language', 'en', '--out', canonical,
    '--environment', 'TEST', '--database', 'fixture-db', '--viewport', '1280x800',
    '--scope', 'runtime integration', '--actor', 'Team QA', '--at', '2026-08-11T14:50:00.000Z',
  ]);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const data = JSON.parse(readFileSync(canonical, 'utf8'));
  assert.equal(data.canonicalVersion, 'qa-board-teamwork/v2');
  assert.equal(data.envDb, 'TEST / fixture-db');

  const rendered = run(dir, ['board', 'render', '--file', canonical, '--out', html]);
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  const page = readFileSync(html, 'utf8');
  assert.match(page, /window\.DOC_DATA = \{/);
  assert.match(page, /"qaBoard": \{/);
  assert.match(page, /window\.__docColabState/);
});

test('Team QA seeds and renders exact tracked source references through qa-gui canonical', { skip: !available }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-real-source-traceability-'));
  const tracked = join(dir, 'tracked-plan.json');
  const canonical = join(dir, 'canonical.json');
  const html = join(dir, 'index.html');
  const fixture = JSON.parse(readFileSync(join(root, 'test/fixtures/source-traceability/tracked-v2.valid.json'), 'utf8'));
  writeFileSync(tracked, `${JSON.stringify(fixture, null, 2)}\n`);
  const created = run(dir, [
    'board', 'init', '--run', 'runtime-source-contract', '--title', 'Source traceability QA',
    '--tracked', tracked, '--language', 'en', '--out', canonical, '--environment', 'LOCAL', '--database', 'fixture-db',
    '--at', '2026-08-28T12:00:00.000Z',
  ]);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const data = JSON.parse(readFileSync(canonical, 'utf8'));
  assert.deepEqual(data.sourceItems, fixture.sourceItems);
  assert.deepEqual(data.cases.map(({ id, sourceRefs }) => ({ id, sourceRefs })), fixture.cases.map(({ id, sourceRefs }) => ({ id, sourceRefs })));

  const rendered = run(dir, ['board', 'render', '--file', canonical, '--out', html]);
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  const page = readFileSync(html, 'utf8');
  assert.match(page, /SRC-JIRA-42/);
  assert.match(page, /SRC-QA-EMPTY/);
  const verified = run(dir, ['board', 'verify', '--file', canonical, '--artifact', html]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
});

test('Team QA applies a Doc-Colab qaDelta through the current qa-gui hardener', { skip: !available }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-real-apply-'));
  const canonical = join(dir, 'canonical.json');
  const packet = join(dir, 'packet.json');
  const output = join(dir, 'canonical-next.json');
  writeFileSync(canonical, readFileSync(join(qaGuiRoot, 'scripts/teamwork/example-canonical.json')));
  writeFileSync(packet, JSON.stringify({
    protocol: 'doc-colab/v2',
    qaDelta: {
      baseRev: 0,
      updates: [{ entity: 'case', id: 'TC-01', field: 'assignee', from: 'qa-agent', to: 'Owner' }],
      comments: [], evidence: [],
    },
  }));
  const applied = run(dir, [
    'board', 'apply', '--file', canonical, '--change', packet, '--out', output,
    '--actor', 'Owner', '--actor-role', 'qa',
  ]);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const data = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(data.rev, 1);
  assert.equal(data.cases[0].assignee, 'Owner');
});

test('Team QA final verifier rejects a source-code workaround added after render', { skip: !available }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-real-final-verify-'));
  const canonical = join(dir, 'canonical.json');
  const html = join(dir, 'index.html');
  const created = run(dir, [
    'board', 'init', '--run', 'runtime-final-verify', '--title', 'Final-byte QA', '--out', canonical,
    '--language', 'en', '--environment', 'LOCAL', '--database', 'not-applicable', '--at', '2026-08-12T00:00:00.000Z',
  ]);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const rendered = run(dir, ['board', 'render', '--file', canonical, '--out', html]);
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  const clean = run(dir, ['board', 'verify', '--file', canonical, '--artifact', html]);
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  assert.match(clean.stdout, /integrity=verified/);

  appendFileSync(html, '\n<script>window.docColabWorkaround = true;</script>\n');
  const tampered = run(dir, ['board', 'verify', '--file', canonical, '--artifact', html]);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /BOARD_INTEGRITY_FAILED/);
});
