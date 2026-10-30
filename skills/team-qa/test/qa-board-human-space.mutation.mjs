import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sealBoardDelivery } from './qa-board-teamwork/support/board-quality-fixture.mjs';

const root = new URL('../', import.meta.url).pathname;
const archive = mkdtempSync(join(tmpdir(), 'teamqa-policy-mutation-'));
const mutations = [
  ['prefer-notion', 'board-destination.mjs', "for (const provider of ['space', 'notion'])", "for (const provider of ['notion', 'space'])", "assert.equal(m.selectBoardDestination({space:{status:'available',evidence:'probe'},notion:{status:'available',evidence:'probe'}}),'space')"],
  ['drop-affected-regression', 'retest-scope.mjs', '...change.affected_cases,', '', "assert.deepEqual(m.selectRetestCases({cases:[{id:'A'},{id:'B'},{id:'C'}]},input).caseIds,['A','B','C'])"],
  ['skip-unknown-full-suite', 'retest-scope.mjs', "const full = ['unknown', 'full-release'].includes(change.impact);", "const full = change.impact === 'full-release';", "assert.equal(m.selectRetestCases({cases:[{id:'A'},{id:'B'},{id:'C'}]},{...input,impact:'unknown'}).mode,'full')"],
];
for (const [name, file, before, after, assertion] of mutations) {
  const dir = join(archive, name); mkdirSync(dir, { recursive: true });
  const source = readFileSync(join(root, 'scripts/lib', file), 'utf8');
  if (!source.includes(before)) throw new Error(`mutation anchor missing ${name}`);
  const mutated = source.replace(before, after);
  writeFileSync(join(dir, file), mutated);
  writeFileSync(join(dir, 'core.mjs'), readFileSync(join(root, 'scripts/lib/core.mjs')));
  const script = `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(pathToFileURL(join(dir,file)).href)}; const input={target_version:'new',impact:'bounded',defect_cases:['B'],affected_cases:['A'],smoke_cases:['C'],rationale:'observed diff'}; ${assertion};`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  writeFileSync(join(dir, 'result.txt'), result.stdout + result.stderr);
  if (result.status === 0 || !result.stderr.includes('AssertionError')) throw new Error(`mutation not behaviorally detected ${name}`);
  console.log(`KILLED ${name}`);
}
const receiptDir = join(archive, 'incomplete-page-receipt'); mkdirSync(receiptDir);
symlinkSync(join(root, 'scripts/lib'), join(receiptDir, 'lib'), 'dir');
// Keep production dependencies intact while isolating the review authenticator.
const boardSource = readFileSync(join(root, 'scripts/board-teamwork.mjs'), 'utf8')
  .replace("'./lib/board-quality.mjs'", JSON.stringify(pathToFileURL(join(root, 'test/qa-board-teamwork/support/board-quality-fixture.mjs')).href));
const receiptStart = boardSource.indexOf("  if (observed.protocol !== 'qa-gui/page-readback/v1'");
const receiptEnd = boardSource.indexOf("  if (!quiet) emit('pass', 'renderer=space'", receiptStart);
assert.ok(receiptStart >= 0 && receiptEnd > receiptStart, 'receipt mutation anchor');
writeFileSync(join(receiptDir, 'board-teamwork.mjs'), boardSource.slice(0, receiptStart) + boardSource.slice(receiptEnd));
writeFileSync(join(receiptDir, 'canonical.json'), '{}');
writeFileSync(join(receiptDir, 'snapshot.json'), '{}');
const payload = join(receiptDir, 'payload.json'), review = join(receiptDir, 'review.fixture.json');
writeFileSync(payload, '{}');
writeFileSync(review, JSON.stringify({ fixture: 'board-quality-cli-contract-test', board_sha256: createHash('sha256').update('{}').digest('hex') }));
sealBoardDelivery({ file: join(receiptDir, 'canonical.json'), reviewPath: review, artifactPath: payload, renderer: 'space' });
writeFileSync(join(receiptDir, 'tool.mjs'), 'console.log(process.argv[2] === "validate" ? "{}" : JSON.stringify({ok:true}));');
const receiptRun = spawnSync(process.execPath, ['--input-type=module', '-e',
  `import {boardComparePage} from ${JSON.stringify(pathToFileURL(join(receiptDir,'board-teamwork.mjs')).href)}; boardComparePage(['--file',${JSON.stringify(join(receiptDir,'canonical.json'))},'--snapshot',${JSON.stringify(join(receiptDir,'snapshot.json'))},'--payload',${JSON.stringify(payload)}]);`],
  {encoding:'utf8',env:{...process.env,TEAMQA_QA_GUI_BOARD_TOOL:join(receiptDir,'tool.mjs')}});
writeFileSync(join(receiptDir,'result.txt'), receiptRun.stdout + receiptRun.stderr);
const receiptAssertion = spawnSync(process.execPath, ['--input-type=module', '-e',
  `import assert from 'node:assert/strict'; assert.notEqual(${receiptRun.status},0,'incomplete receipt must be rejected');`], {encoding:'utf8'});
writeFileSync(join(receiptDir,'assertion.txt'), receiptAssertion.stdout + receiptAssertion.stderr);
assert.notEqual(receiptAssertion.status, 0);
assert.match(receiptAssertion.stderr, /AssertionError/);
assert.match(receiptRun.stdout, /integrity=verified/, 'behavioral mutant must execute the false certification');
console.log('KILLED incomplete-page-receipt');
console.log(`MUTATION_PASS count=${mutations.length + 1} archive=${archive}`);
