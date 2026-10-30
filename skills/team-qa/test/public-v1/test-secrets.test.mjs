import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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

// 1.15.1: the shapes real accounts files take. Each value below is made up.
test('keys in snake, kebab, camel and env form, Vietnamese labels, quoted values with spaces and short values under a key', () => {
  const cases = [
    ['ADMIN_EMAIL=admin@example.org\nADMIN_PASSWORD=Env-Secret-1\n', ['Env-Secret-1']],
    ['export DB_PASS="two words here"\n', ['two words here']],
    ["admin:\n  user_password: 'Yaml Secret 2'\n", ['Yaml Secret 2']],
    ['dbPass: Camel-3x\n', ['Camel-3x']],
    ['db-pass = Kebab-4x\n', ['Kebab-4x']],
    ['T\u00e0i kho\u1ea3n: admin@example.org\nM\u1eadt kh\u1ea9u: Abc@12345\n', ['Abc@12345']],
    ['user: admin@example.org\nmk: Mk-Value-5\n', ['Mk-Value-5']],
    ['MAT_KHAU=Mat-Khau-6\nmatkhau: Mat-Khau-7\n', ['Mat-Khau-6', 'Mat-Khau-7']],
    ['pass: Pass-6x\n', ['Pass-6x']],
    ['password: "correct horse battery"\n', ['correct horse battery']],
    ['Login: admin@example.org | Password: Pair-Secret-7\n', ['Pair-Secret-7']],
    ['"password": "Json Line 8",\n', ['Json Line 8']],
    ['pin: 1234\npassword: abcd\n', ['1234', 'abcd']],
    ['x@example.org / abcd\n', []],
    ['password: null\npassword: ********\npassword: <your password>\npassword: ${ADMIN_PASSWORD}\npassword: none\npin: abc\n', []],
  ];
  for (const [text, expected] of cases) assert.deepEqual(secretsFromText(text).sort(), expected.sort(), JSON.stringify(text));
});

test('JSON: numeric values and values with spaces under a password key; placeholders are not values', () => {
  assert.deepEqual(secretsFromText(JSON.stringify({ pin: 123456, password: 98765432, note: 5555, otp: 7 })).sort(), ['123456', '98765432']);
  assert.deepEqual(secretsFromText(JSON.stringify({ users: [{ email: 'a@example.org', password: 'correct horse battery', dbPass: 'Camel-9x' }] })).sort(), ['Camel-9x', 'correct horse battery']);
  assert.deepEqual(secretsFromText(JSON.stringify({ password: null, pin: true, secret: '', token: 'string' })), []);
});

test('.env, creds and credential files are sources; symlinks are followed to regular files only; code files are not sources', () => {
  const { ws, runDir } = workspace();
  put(ws, '.env', 'TEST_USER_PASSWORD=Dot-Env-11\n');
  put(ws, 'creds.txt', 'buyer@example.org / Creds-File-12\n');
  put(ws, 'staging-credential.json', JSON.stringify({ adminPassword: 'Cred-Json-13' }));
  put(ws, 'vite-env.d.ts', 'interface Env { readonly VITE_API_TOKEN: Code-Not-Source-14 }\n');
  put(ws, 'private/real.txt', 'password: Linked-Secret-15\n');
  symlinkSync(join(ws, 'private/real.txt'), join(ws, 'test-accounts.txt'));
  symlinkSync(join(ws, 'private'), join(ws, 'logins'));
  symlinkSync(join(ws, 'missing.txt'), join(ws, 'secrets.txt'));
  put(ws, 'private/input.txt', 'password: Linked-Input-16\n');
  symlinkSync(join(ws, 'private/input.txt'), join(runDir, 'exec-inputs/TC-01/logins.txt'));
  const found = collectRunSecrets(runDir, { env: {} });
  for (const value of ['Dot-Env-11', 'Creds-File-12', 'Cred-Json-13', 'Linked-Secret-15', 'Linked-Input-16']) assert.ok(found.secrets.includes(value), value);
  assert.ok(!found.secrets.includes('Code-Not-Source-14'));
  assert.equal(found.inputs, 3);
});

test('a value is found in any form it takes in an output, short values only as whole words, and maskSecrets agrees', () => {
  const { runDir } = workspace();
  const secrets = ['correct horse battery', 'abcd'];
  put(runDir, 'summary-report.md', 'form body: password=correct+horse+battery\n');
  put(runDir, 'rtm.md', 'url: /login?p=correct%20horse%20battery\n');
  put(runDir, 'board/qa-board.json', JSON.stringify({ note: 'xabcdx and abcdef are other words' }));
  put(runDir, 'plan.md', 'typed abcd at the prompt\n');
  assert.deepEqual(scanRunOutputs(runDir, secrets).map((f) => f.file).sort(), ['plan.md', 'rtm.md', 'summary-report.md']);
  assert.equal(maskSecrets('xabcdx abcd correct+horse+battery correct%20horse%20battery', secrets), 'xabcdx [test-secret] [test-secret] [test-secret]');
});

test('an output over 8 MB is scanned in chunks, including a value split across a chunk boundary', () => {
  const { runDir } = workspace();
  put(runDir, 'board/index.html', `${'x'.repeat(9 * 1024 * 1024)} ${BUYER}\n`);
  assert.deepEqual(scanRunOutputs(runDir, [BUYER]), [{ file: 'board/index.html', values: 1 }]);
  const word = 'M\u1eadt-Kh\u1ea9u-17';
  put(runDir, 'board/index.html', `${'y'.repeat(1000)}${word}${'z'.repeat(1000)}`);
  for (const chunkBytes of [1001, 1003, 1005, 1007, 1009]) assert.deepEqual(scanRunOutputs(runDir, [word], { chunkBytes }), [{ file: 'board/index.html', values: 1 }], `chunk ${chunkBytes}`);
});

test('teamqa secrets scan warns when credential inputs exist but no value is found', () => {
  const env = { ...process.env }; delete env.TEAMQA_TEST_SECRETS_FILE;
  const ws = mkdtempSync(join(tmpdir(), 'teamqa-secrets-none-')), runDir = join(ws, 'runs', 'r1');
  put(runDir, 'exec-inputs/TC-01/products.csv', 'sku,name\n1,Tea\n');
  const inputsOnly = spawnSync(process.execPath, [CLI, 'secrets', 'scan', '--run', 'r1'], { cwd: ws, encoding: 'utf8', env });
  assert.equal(inputsOnly.status, 0, inputsOnly.stderr);
  assert.match(inputsOnly.stderr, /verdict=warn TEST_SECRETS_NOT_FOUND values=0 sources=0 inputs=1/);
  assert.doesNotMatch(inputsOnly.stdout + inputsOnly.stderr, /verdict=pass/);
  put(ws, 'credentials.txt', 'Account for staging, ask the owner\n');
  const unparsed = spawnSync(process.execPath, [CLI, 'secrets', 'scan', '--run', 'r1'], { cwd: ws, encoding: 'utf8', env });
  assert.match(unparsed.stderr, /verdict=warn TEST_SECRETS_NOT_FOUND values=0 sources=1 inputs=1/);
  const empty = mkdtempSync(join(tmpdir(), 'teamqa-secrets-empty-'));
  mkdirSync(join(empty, 'runs', 'r1'), { recursive: true });
  const none = spawnSync(process.execPath, [CLI, 'secrets', 'scan', '--run', 'r1'], { cwd: empty, encoding: 'utf8', env });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /verdict=pass TEST_SECRETS_CLEAN values=0 sources=0 inputs=0/);
});
