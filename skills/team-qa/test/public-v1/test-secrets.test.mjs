import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertNoTestSecrets, collectRunSecrets, maskSecrets, scanRunOutputs, secretsFromText } from '../../scripts/lib/test-secrets.mjs';
import { diagnosticBundle } from '../../scripts/lib/doctor.mjs';
import { readRequirements } from '../../scripts/lib/dragon-requirements.mjs';

// Public v1, S6: a test-account password may sit in a worker's prompt or log, never in the board, the report, the RTM
// or the plan. Values here are made up.
const CLI = new URL('../../scripts/teamqa.mjs', import.meta.url).pathname;
const ADMIN = 'Adm1n&<Pass>"x', BUYER = 'buyer-Secret-77', EXTRA = 'Extra-Value-9';
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'teamqa-secrets-')), runDir = join(ws, 'runs', 'r1');
  put(ws, 'accounts.txt', `admin: admin@example.org / ${ADMIN}\n`);
  put(runDir, 'exec-inputs/TC-01/accounts.txt', `# test accounts\nbuyer: buyer@example.org / ${BUYER}\nshort: s@example.org / abc\n`);
  put(runDir, `dispatch/executor_gui/1111/inputs/accounts.txt`, `buyer: buyer@example.org / ${BUYER}\n`);
  put(runDir, 'dispatch/executor_gui/1111/stdout.jsonl', JSON.stringify({ text: `typed ${ADMIN} and ${BUYER}` }) + '\n');
  put(runDir, 'prompts/TC-01.md', `Sign in with ${BUYER}\n`);
  put(runDir, 'board/qa-board.json', JSON.stringify({ cases: [{ id: 'TC-01', note: 'signed in as the buyer' }] }));
  put(runDir, 'summary-report.md', '# Report\nGO\n');
  return { ws, runDir };
}

test('secrets come from the shapes accounts files use, and short values are ignored', () => {
  assert.deepEqual(secretsFromText(`admin: a@example.org / ${ADMIN}\npassword = Hunter-22x\nb@example.org:abcdef12\n# c@example.org / Comment-1\nd@example.org / abc\n`).sort(),
    [ADMIN, 'Hunter-22x', 'abcdef12'].sort());
  assert.deepEqual(secretsFromText(JSON.stringify({ accounts: [{ email: 'a@example.org', password: BUYER, note: 'Not-A-Secret-1' }] })), [BUYER]);
});

test('the run inputs, the workspace accounts file and TEAMQA_TEST_SECRETS_FILE are the sources', () => {
  const { ws, runDir } = workspace();
  put(ws, 'elsewhere/keys.txt', `pin: ${EXTRA}\n`);
  const found = collectRunSecrets(runDir, { env: { TEAMQA_TEST_SECRETS_FILE: join(ws, 'elsewhere/keys.txt') } });
  assert.deepEqual(found.secrets.sort(), [ADMIN, BUYER, EXTRA].sort());
  assert.equal(found.sources, 4);
});

test('prompts, logs and inputs may hold a value; the board and the report may not, in any encoding', () => {
  const { runDir } = workspace();
  const { secrets } = collectRunSecrets(runDir, { env: {} });
  assert.deepEqual(scanRunOutputs(runDir, secrets), []);
  assert.equal(assertNoTestSecrets(runDir, { env: {} }).findings.length, 0);
  put(runDir, 'board/qa-board.json', JSON.stringify({ cases: [{ id: 'TC-01', note: `typed ${ADMIN}` }] }));
  put(runDir, 'board/draft-html/index.html', `<p>${ADMIN.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</p>`);
  put(runDir, 'summary-report.md', `# Report\nlogin ${BUYER}\n`);
  const findings = scanRunOutputs(runDir, secrets);
  assert.deepEqual(findings.map((f) => f.file).sort(), ['board/draft-html/index.html', 'board/qa-board.json', 'summary-report.md']);
  assert.throws(() => assertNoTestSecrets(runDir, { env: {} }), (e) => e.code === 'TEST_SECRET_IN_OUTPUT' && !e.message.includes(ADMIN) && !e.message.includes(BUYER));
  assert.equal(maskSecrets(`a ${BUYER} b ${JSON.stringify(ADMIN)}`, secrets), 'a [test-secret] b "[test-secret]"');
});

test('teamqa secrets scan says clean or names the files, never the value', () => {
  const { ws, runDir } = workspace();
  const env = { ...process.env }; delete env.TEAMQA_TEST_SECRETS_FILE;
  const clean = spawnSync(process.execPath, [CLI, 'secrets', 'scan', '--run', 'r1'], { cwd: ws, encoding: 'utf8', env });
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  assert.match(clean.stdout, /verdict=pass TEST_SECRETS_CLEAN values=2 sources=3/);
  put(runDir, 'rtm.md', `| Requirement | Case |\n| REQ-1 | ${BUYER} |\n`);
  const leak = spawnSync(process.execPath, [CLI, 'secrets', 'scan', '--run', 'r1'], { cwd: ws, encoding: 'utf8', env });
  assert.equal(leak.status, 3);
  assert.match(leak.stdout + leak.stderr, /TEST_SECRET_IN_OUTPUT rtm\.md \(1\)/);
  assert.ok(!(leak.stdout + leak.stderr).includes(BUYER));
});

test('the diagnostic bundle masks the run\'s test passwords', async () => {
  const { ws, runDir } = workspace();
  put(runDir, 'roster.json', JSON.stringify({ run_id: 'r1', note: `login hint ${BUYER}` }));
  const overrides = { platform: 'darwin', nodeVersion: '24.1.0', env: {}, home: ws, requirements: readRequirements(), exists: () => false,
    which: () => null, fetchStatus: () => ({ reachable: false }), fetchMethods: () => null, verifyProvider: async () => {} };
  const bundle = await diagnosticBundle({ run: 'r1', runsDir: join(ws, 'runs'), overrides });
  assert.equal(bundle.run['roster.json'].note, 'login hint [test-secret]');
  assert.ok(!JSON.stringify(bundle).includes(BUYER));
});
