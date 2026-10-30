import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertToolPreflight, readHostToolEvidence } from '../../scripts/lib/tool-preflight.mjs';
import { sha256 } from '../../scripts/lib/core.mjs';
import { readContract } from '../../scripts/lib/release-truth.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const childRoot = realpathSync(process.env.TEAMQA_PREFLIGHT_TEST_QA_CODE_ROOT || join(homedir(), '.agents/skills/qa-code'));
const { sealObject } = await import(fileURLToPath(new URL('file://' + join(childRoot, 'scripts/lib/release-receipt.mjs'))));
const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).stdout.trim();
function setup() {
  // Preserve temporary evidence for diagnosis; no destructive cleanup.
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-tool-preflight-')));
  const roster = { run_id: 'fixture', round: 1, roster_hash: 'a'.repeat(64), target: { project_id: 'fixture', preview_url: 'http://localhost:3000', version: git('rev-parse', 'HEAD') }, roles: [{ role: 'executor_code' }, { role: 'executor_gui' }], catalog_source: { kind: 'fixture' } };
  const source = spawnSync('git', ['-C', root, 'show', 'HEAD:SKILL.md'], { encoding: 'utf8' }).stdout;
  const p = { schema: 'team-qa/tool-preflight/v1', run_id: roster.run_id, round: roster.round, roster_hash: roster.roster_hash, target: roster.target, runtime: { node_version: process.version, contract_sha256: readContract().contract_sha256 }, target_access: { kind: 'git', repo_root: root, source_path: 'SKILL.md', source_sha256: sha256(source) } };
  let next = 0;
  function evidence(name, input, output, wrapper = false) {
    const path = join(runDir, `raw-${next++}.jsonl`);
    const marker = `TEAMQA_PREFLIGHT run=${roster.run_id} round=${roster.round} roster=${roster.roster_hash}`;
    const timestamp = new Date().toISOString();
    const rows = [{ type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', channel: 'commentary', content: marker } }, { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'c', name: wrapper ? 'functions.exec' : name, arguments: wrapper ? `const r = await tools.${name}(${JSON.stringify(input)}); text(r);` : JSON.stringify(input) } }, { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'c', output: JSON.stringify(wrapper ? { content: [{ type: 'text', text: JSON.stringify(output) }] } : output) } }].map(JSON.stringify);
    writeFileSync(path, rows.join('\n') + '\n');
    assert.equal(readFileSync(path, 'utf8'), rows.join('\n') + '\n');
    return { path, call_line: 2, result_line: 3, call_sha256: sha256(rows[1]), result_sha256: sha256(rows[2]) };
  }
  const session = { sessionId: 's', nonce: 'n', browserInstanceId: 'b', forbidSyntheticDOM: false };
  function dragon(method, result = {}, params = {}, wrapper = false) {
    return evidence('mcp__Dragon_Browser__dragon_rpc', { method, params: { ...session, tabId: 42, ...params } }, { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }, wrapper);
  }
  function gui() {
    p.gui = {
      status: evidence('exec_command', { cmd: 'curl --fail --silent http://127.0.0.1:9233/status' }, { exit_code: 0, output: JSON.stringify({ ok: true, ready: true, bridgeVersion: '1.6.9', versionMatch: true, extension: { version: '1.6.9' } }) }),
      session: dragon('session.create', session),
      open: dragon('openTab', { tabId: 42 }, { url: roster.target.preview_url, active: false }),
      read: dragon('do', { reads: { target: { url: roster.target.preview_url, dom: '<main>Fixture target content</main>' } } }, { steps: [{ read: '({url:location.href,dom:document.body.innerHTML})', as: 'target' }] }),
    };
    return p.gui;
  }
  function code() {
    p.qa_code = ['scanner', 'runner'].map(tier => {
      const command = `bash '${childRoot}/scripts/gate0.sh' --repo '${root}' --base HEAD`;
      const result = { schema: 'qa-code/gate0/v1', status: 'pass', repo: root, runtime: { node: { version: process.version }, checkers: [{ path: process.execPath, version: process.version }] } };
      if (tier === 'runner') {
        const selected = 'test/chat-preflight/tool-preflight.test.mjs', reportPath = join(runDir, 'execution.jsonl');
        const report = JSON.stringify({ type: 'test:pass', data: { file: resolve(root, selected), name: 'fixture test', nesting: 0, line: 8, column: 1 } }) + '\n';
        writeFileSync(reportPath, report);
        result.native_test_runners = { records: { coverage: { exit_status: 0, records: [{ runner: 'node', files: [selected], status: 0, stdout: '# tests 1\n# fail 0', stderr: '', receipt: { path: process.execPath, sha256: sha256(readFileSync(process.execPath)), version: process.version }, execution_report: { path: reportPath, sha256: sha256(report), files: [{ file: realpathSync(resolve(root, selected)), passed: 1, skipped: 0, failed: 0 }] } }] } } };
      }
      return { tier, runtime: childRoot, command, tools: [{ path: process.execPath, sha256: sha256(readFileSync(process.execPath)) }], evidence: evidence('functions.exec_command', { cmd: command }, { exit_code: 0, output: JSON.stringify(sealObject(result)) }) };
    });
  }
  function run(stage = 'basic', role, requirements = { code: false, gui: false, recording: false }) {
    writeFileSync(join(runDir, 'preflight.json'), JSON.stringify(p));
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'preflight.json'), 'utf8')), p);
    return assertToolPreflight({ runDir, roster, stage, role, requirements });
  }
  return { runDir, roster, p, evidence, dragon, gui, code, run };
}
const blocked = (fn, code) => assert.throws(fn, e => e.exitCode === 3 && e.code === code);
test('basic uses actual Git source access and canonical schema tooling before model dispatch', () => assert.equal(setup().run().verified, true));
test('signed scope alone permits N/A', () => assert.equal(setup().run('plan').lanes.code, 'N/A'));
test('missing lane blocks that lane; analysis remains available', () => {
  const f = setup(), requirements = { code: true, gui: false, recording: false };
  assert.equal(f.run('plan', undefined, requirements).lanes.code.status, 'BLOCKED');
  blocked(() => f.run('execute', 'executor_code', requirements), 'PREFLIGHT_CODE_SMOKE_MISSING');
});
test('positive original command/result fixture scanner and runner smoke', () => { const f = setup(); f.code(); assert.equal(f.run('execute', 'executor_code', { code: true, gui: true, recording: false }).lanes.code, 'verified'); });
test('positive direct Dragon DOM/image fixture and static functions wrapper', () => {
  const f = setup(), path = join(f.runDir, 'image.png');
  const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1Z0AAAAASUVORK5CYII=', 'base64'); writeFileSync(path, pixels);
  f.gui(); f.p.gui.image = { path, sha256: sha256(pixels) };
  f.p.gui.screenshot = f.dragon('screenshot', { savedTo: path, privacyMasked: true, maskedRects: [] }, { toFile: path }, true);
  assert.equal(f.run('plan', undefined, { code: false, gui: true, recording: false }).lanes.gui, 'verified');
  assert.equal(f.run('execute', 'executor_gui', { code: true, gui: true, recording: false }).lanes.gui, 'verified');
});
test('plan reports missing GUI proof BLOCKED while Code executor remains available', () => {
  const f = setup(); f.code(); const req = { code: true, gui: true, recording: false };
  const status = f.run('plan', undefined, req);
  assert.equal(status.lanes.gui.status, 'BLOCKED'); assert.equal(status.lanes.code, 'verified');
  assert.equal(f.run('execute', 'executor_code', req).verified, true);
});
test('recording demands observed behavior, media and separate privacy operation', () => {
  const f = setup(), image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1Z0AAAAASUVORK5CYII=', 'base64'), video = Buffer.alloc(64);
  video.write('ftyp', 4); writeFileSync(join(f.runDir, 'image.png'), image); writeFileSync(join(f.runDir, 'video.mp4'), video);
  f.gui(); f.p.gui.image = { path: join(f.runDir, 'image.png'), sha256: sha256(image) }; f.p.gui.video = { path: join(f.runDir, 'video.mp4'), sha256: sha256(video) };
  f.p.gui.screenshot = f.dragon('screenshot', { savedTo: f.p.gui.image.path, privacyMasked: true, maskedRects: [] });
  f.p.gui.start = f.dragon('startRecording', { id: 'r' });
  const stopped = { id: 'r', ok: true, frameCount: 2, events: 1, privacy: { masked: true, maskFailures: 0, cleanup: { ok: true } }, delivery: { persistedFrames: 2, extensionFrames: 2, ingestErrors: 0, captureErrors: 0, pushErrors: 0 } };
  f.p.gui.recording = f.dragon('stopRecording', stopped, { id: 'r' });
  f.p.gui.assemble = f.dragon('assembleRecording', { id: 'r', video: f.p.gui.video.path, frames: 2 }, { id: 'r' });
  const requirements = { code: false, gui: true, recording: true };
  assert.equal(f.run('execute', 'executor_gui', requirements).lanes.recording, 'verified');
  f.p.gui.recording = f.dragon('stopRecording', { ...stopped, privacy: { masked: false } }, { id: 'r' });
  blocked(() => f.run('execute', 'executor_gui', requirements), 'PREFLIGHT_RECORDING_PRIVACY');
  f.p.gui.recording = f.dragon('stopRecording', { ...stopped, frameCount: 1, events: 0 }, { id: 'r' });
  blocked(() => f.run('execute', 'executor_gui', requirements), 'PREFLIGHT_RECORDING_BEHAVIOR');
});
test('host records remain valid when transcript appends', () => {
  const f = setup(), ref = f.evidence('functions.exec_command', { cmd: 'x' }, { exit_code: 0 });
  appendFileSync(ref.path, JSON.stringify({ payload: { role: 'assistant', content: 'later' } }) + '\n');
  assert.equal(readHostToolEvidence(ref, { runDir: f.runDir, roster: f.roster }).input.cmd, 'x');
});
for (const [name, mutate, code] of [
  ['forged summary', f => { f.p.status = 'pass'; }, 'PREFLIGHT_FIELDS'],
  ['wrong target', f => { f.p.target = { ...f.p.target, preview_url: 'https://wrong.example' }; }, 'PREFLIGHT_BINDING'],
  ['wrong roster', f => { f.p.roster_hash = 'b'.repeat(64); }, 'PREFLIGHT_BINDING'],
  ['schema drift', f => { f.p.runtime.contract_sha256 = 'f'.repeat(64); }, 'PREFLIGHT_SCHEMA_RUNTIME'],
  ['runtime mismatch', f => { f.p.runtime.node_version = 'v22.0.0'; }, 'PREFLIGHT_NODE_VERSION'],
  ['target hash mismatch', f => { f.p.target_access.source_sha256 = 'f'.repeat(64); }, 'PREFLIGHT_TARGET_READ'],
  ['target version mismatch', f => { f.roster.target.version = 'invalid-version'; }, 'PREFLIGHT_TARGET_VERSION'],
]) test(name, () => { const f = setup(); mutate(f); blocked(() => f.run(), code); });
test('self-created run source never becomes official host evidence', () => {
  const f = setup(), ref = f.dragon('do', { reads: { target: '<main>content from fixture target</main>' } }); f.roster.catalog_source.kind = 'runtime';
  blocked(() => readHostToolEvidence(ref, { runDir: f.runDir, roster: f.roster }), 'PREFLIGHT_SOURCE_UNTRUSTED');
});
test('fresh host without Codex session storage rejects run-created evidence with the typed gate error', () => {
  const f = setup(), ref = f.evidence('functions.exec_command', { cmd: 'x' }, { exit_code: 0 });
  f.roster.catalog_source.kind = 'runtime';
  const freshHost = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-fresh-host-')));
  assert.equal(existsSync(join(freshHost, '.codex')), false);
  const script = `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; os.homedir=()=>process.argv[4]; syncBuiltinESMExports(); const {readHostToolEvidence}=await import(${JSON.stringify(new URL('../../scripts/lib/tool-preflight.mjs', import.meta.url).href)}); try { readHostToolEvidence(JSON.parse(process.argv[2]), {runDir:process.argv[1], roster:JSON.parse(process.argv[3])}); console.log(JSON.stringify({accepted:true})); } catch(e) { console.log(JSON.stringify({exitCode:e.exitCode,code:e.code})); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.runDir, JSON.stringify(ref), JSON.stringify(f.roster), freshHost], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { exitCode: 3, code: 'PREFLIGHT_SOURCE_UNTRUSTED' });
  assert.equal(existsSync(join(freshHost, '.codex')), false);
});
test('missing source and changed line metadata fail closed', () => {
  const f = setup(), ref = f.evidence('functions.exec_command', { cmd: 'x' }, {});
  blocked(() => readHostToolEvidence({ ...ref, path: join(f.runDir, 'absent') }, { runDir: f.runDir, roster: f.roster }), 'PREFLIGHT_SOURCE_MISSING');
  blocked(() => readHostToolEvidence({ ...ref, call_sha256: 'f'.repeat(64) }, { runDir: f.runDir, roster: f.roster }), 'PREFLIGHT_SOURCE_DRIFT');
});
test('HTTP 2xx is not Dragon operational evidence', () => {
  const f = setup(); f.gui(); f.p.gui.session = f.dragon('session.create', { ok: false, code: 'CIRCUIT_OPEN' }); f.p.target_access = { kind: 'dragon', gui: f.p.gui };
  blocked(() => f.run(), 'PREFLIGHT_DRAGON_OPERATION');
});
test('usage error and arbitrary echo command cannot count as Code readiness', () => {
  const f = setup(); f.code(); const c = f.p.qa_code[0]; c.evidence = f.evidence('functions.exec_command', { cmd: c.command }, { exit_code: 2, output: 'Usage: gate0' });
  blocked(() => f.run('execute', 'executor_code', { code: true, gui: false, recording: false }), 'PREFLIGHT_CODE_OPERATION');
  c.command = `echo ${c.command}`;
  blocked(() => f.run('execute', 'executor_code', { code: true, gui: false, recording: false }), 'PREFLIGHT_CODE_COMMAND');
});
test('N/A cannot authorize either executor role', () => {
  for (const role of ['executor_code', 'executor_gui']) blocked(() => setup().run('execute', role), 'PREFLIGHT_ROLE_OUT_OF_SCOPE');
});
test('frozen presentation file is verified independently of current receipt', () => {
  const f = setup(); f.run(); writeFileSync(join(f.runDir, 'snapshot.json'), JSON.stringify(f.p));
  writeFileSync(join(f.runDir, 'preflight.json'), JSON.stringify({ status: 'pass' }));
  assert.equal(assertToolPreflight({ runDir: f.runDir, roster: f.roster, stage: 'basic', file: 'snapshot.json' }).verified, true);
  blocked(() => assertToolPreflight({ runDir: f.runDir, roster: f.roster, stage: 'basic', file: '../snapshot.json' }), 'PREFLIGHT_FILE_OUTSIDE_RUN');
});
test('literal exec wrapper uses actual nested tool output and assistant binding', () => {
  const f = setup(), ref = f.evidence('exec_command', { cmd: 'fixture' }, { exit_code: 0, output: 'readback' }, true);
  assert.equal(readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir }).output.output, 'readback');
});
test('Pages structured-only readback preserves the complete original envelope', () => {
  const f = setup(), output = { content: [], structuredContent: { metadata: { page_id: 'page-fixture', url: 'https://chatgpt.com/space/page-fixture' }, content: { page_id: 'page-fixture', title: 'QA draft', blocks: [] } }, isError: false };
  for (const wrapper of [false, true]) {
    const ref = f.evidence('mcp__pages__read_page', { page_id: 'page-fixture', view: 'full' }, output, wrapper);
    assert.doesNotThrow(() => assert.deepEqual(readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir }).output, output));
    blocked(() => readHostToolEvidence({ ...ref, result_sha256: 'f'.repeat(64) }, { roster: f.roster, runDir: f.runDir }), 'PREFLIGHT_SOURCE_DRIFT');
  }
});
test('Pages structured-only readback rejects tool errors and truncated payloads', () => {
  const f = setup(), base = { content: [], structuredContent: { content: { page_id: 'page-fixture' } }, isError: false };
  for (const [output, code] of [
    [{ ...base, isError: true }, 'PREFLIGHT_TOOL_ERROR'],
    [{ ...base, structuredContent: { error: 'access denied' } }, 'PREFLIGHT_TOOL_ERROR'],
    [{ ...base, structuredContent: { isError: true } }, 'PREFLIGHT_TOOL_ERROR'],
    ...['truncated', 'isTruncated'].flatMap(key => [
      [{ ...base, [key]: true }, 'PREFLIGHT_EXEC_OUTPUT_TRUNCATED'],
      [{ ...base, structuredContent: { ...base.structuredContent, [key]: true } }, 'PREFLIGHT_EXEC_OUTPUT_TRUNCATED'],
    ]),
  ]) {
    const ref = f.evidence('mcp__pages__read_page', { page_id: 'page-fixture' }, output);
    blocked(() => readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir }), code);
  }
});
test('Pages structured-only readback rejects absent or invalid structured data', () => {
  const f = setup();
  for (const structuredContent of [undefined, null, false, 1, 'unparsed', []]) {
    const ref = f.evidence('mcp__pages__read_page', { page_id: 'page-fixture' }, { content: [], structuredContent, isError: false });
    blocked(() => readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir }), 'PREFLIGHT_ADAPTER_UNSUPPORTED');
  }
  const ref = f.evidence('mcp__pages__read_page', { page_id: 'page-fixture' }, { content: [{ type: 'image', data: 'opaque' }], structuredContent: { content: {} } });
  blocked(() => readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir }), 'PREFLIGHT_ADAPTER_UNSUPPORTED');
});
test('desktop custom exec grammar accepts exactly one completed JSON payload with unquoted literal keys', () => {
  const f = setup(), ref = f.evidence('exec_command', { cmd: 'fixture' }, {});
  const rows = readFileSync(ref.path, 'utf8').trim().split('\n').map(JSON.parse);
  rows[1].payload = { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: 'text(await tools.exec_command({cmd:"fixture",max_output_tokens:10}));' };
  rows[2].payload = { type: 'custom_tool_call_output', call_id: 'c', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: 'readback' }) }] };
  const save = () => { const lines = rows.map(JSON.stringify); writeFileSync(ref.path, lines.join('\n') + '\n'); ref.call_sha256 = sha256(lines[1]); ref.result_sha256 = sha256(lines[2]); };
  save();
  const parsed = readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir });
  assert.equal(parsed.input.cmd, 'fixture'); assert.equal(parsed.input.max_output_tokens, 10); assert.equal(parsed.output.output, 'readback');
  rows[1].payload.input = 'text(await tools.exec_command({cmd:dynamicCommand}));'; save();
  blocked(() => readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir }), 'PREFLIGHT_RAW_INVALID');
});
test('desktop exec rejects running/error headers and multiple output payloads', () => {
  const f = setup();
  for (const [header, extra, code] of [
    ['Script running with cell ID x\n', false, 'PREFLIGHT_EXEC_NOT_COMPLETED'],
    ['Script failed\nWall time 0.2 seconds\nOutput:\n', false, 'PREFLIGHT_EXEC_NOT_COMPLETED'],
    ['Script completed\nWall time 0.2 seconds\nOutput:\n', true, 'PREFLIGHT_EXEC_OUTPUT_SHAPE'],
  ]) {
    const ref = f.evidence('exec_command', { cmd: 'fixture' }, {}), rows = readFileSync(ref.path, 'utf8').trim().split('\n').map(JSON.parse);
    rows[1].payload = { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: 'text(await tools.exec_command({cmd:"fixture"}));' };
    rows[2].payload = { type: 'custom_tool_call_output', call_id: 'c', output: [{ type: 'input_text', text: header }, { type: 'input_text', text: '{"exit_code":0}' }, ...(extra ? [{ type: 'input_text', text: '{"status":"PASS"}' }] : [])] };
    const lines = rows.map(JSON.stringify); writeFileSync(ref.path, lines.join('\n') + '\n'); ref.call_sha256 = sha256(lines[1]); ref.result_sha256 = sha256(lines[2]);
    blocked(() => readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir }), code);
  }
});
test('user-only and assistant analysis markers cannot declare machine run intent', () => {
  const f = setup();
  for (const [role, channel] of [['user', undefined], ['assistant', 'analysis']]) {
    const ref = f.evidence('exec_command', { cmd: 'fixture' }, {}), rows = readFileSync(ref.path, 'utf8').trim().split('\n').map(JSON.parse);
    rows[0].payload.role = role; rows[0].payload.channel = channel; writeFileSync(ref.path, rows.map(JSON.stringify).join('\n') + '\n');
    blocked(() => readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir }), 'PREFLIGHT_CALL_BINDING');
  }
});
test('fresh dispatch rejects missing original event timestamps', () => {
  const f = setup(), ref = f.evidence('exec_command', { cmd: 'fixture' }, {});
  const rows = readFileSync(ref.path, 'utf8').trim().split('\n').map(JSON.parse);
  delete rows[1].timestamp; delete rows[2].timestamp;
  const lines = rows.map(JSON.stringify); writeFileSync(ref.path, lines.join('\n') + '\n');
  ref.call_sha256 = sha256(lines[1]); ref.result_sha256 = sha256(lines[2]);
  blocked(() => readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir, requireFresh: true }), 'PREFLIGHT_TIMESTAMP_METADATA');
});
test('fresh dispatch accepts recent original timestamps and rejects stale proof without expiring replay', () => {
  const f = setup(), ref = f.evidence('exec_command', { cmd: 'fixture' }, { exit_code: 0 });
  assert.equal(readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir, requireFresh: true }).output.exit_code, 0);
  const rows = readFileSync(ref.path, 'utf8').trim().split('\n').map(JSON.parse);
  const old = new Date(Date.now() - 301000).toISOString(); rows[1].timestamp = old; rows[2].timestamp = old;
  const lines = rows.map(JSON.stringify); writeFileSync(ref.path, lines.join('\n') + '\n');
  ref.call_sha256 = sha256(lines[1]); ref.result_sha256 = sha256(lines[2]);
  blocked(() => readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir, requireFresh: true }), 'PREFLIGHT_STALE');
  assert.equal(readHostToolEvidence(ref, { roster: f.roster, runDir: f.runDir }).output.exit_code, 0);
});
test('actual Dragon request binding rejects changed nonce and target URL', () => {
  const f = setup(); f.gui(); f.p.target_access = { kind: 'dragon', gui: f.p.gui };
  f.p.gui.open = f.dragon('openTab', { tabId: 42 }, { url: f.roster.target.preview_url, active: false, nonce: 'wrong' });
  blocked(() => f.run(), 'PREFLIGHT_GUI_SESSION_DRIFT');
  f.p.gui.open = f.dragon('openTab', { tabId: 42 }, { url: 'https://wrong.example', active: false });
  blocked(() => f.run(), 'PREFLIGHT_TARGET_ACCESS');
});
test('compatible installed and extension versions must be observed separately', () => {
  const f = setup(); f.gui(); f.p.target_access = { kind: 'dragon', gui: f.p.gui };
  f.p.gui.status = f.evidence('exec_command', { cmd: 'curl --fail --silent http://127.0.0.1:9233/status' }, { exit_code: 0, output: JSON.stringify({ ok: true, ready: true, bridgeVersion: '1.6.9', versionMatch: false, extension: { version: '1.6.3' } }) });
  blocked(() => f.run(), 'PREFLIGHT_DRAGON_EXTENSION_OLD');
});
test('changed operational binary and pinned config deny Code readiness', () => {
  const f = setup(); f.code(); f.p.qa_code[0].tools[0].sha256 = 'f'.repeat(64);
  const req = { code: true, gui: false, recording: false };
  blocked(() => f.run('execute', 'executor_code', req), 'PREFLIGHT_SOURCE_DRIFT');
  f.code(); const c = f.p.qa_code[0], configPath = join(f.runDir, 'config.json'); writeFileSync(configPath, '{}');
  c.config = { path: configPath, sha256: sha256('{}') }; c.command += ` --config '${configPath}'`;
  const output = readHostToolEvidence(c.evidence, { roster: f.roster, runDir: f.runDir }).output;
  c.evidence = f.evidence('exec_command', { cmd: c.command }, output); appendFileSync(configPath, '\n');
  blocked(() => f.run('execute', 'executor_code', req), 'PREFLIGHT_SOURCE_DRIFT');
});
test('runner claims require retained selected execution artifacts', () => {
  const f = setup(); f.code(); const c = f.p.qa_code[1], output = readHostToolEvidence(c.evidence, { roster: f.roster, runDir: f.runDir }).output;
  const receipt = JSON.parse(output.output), report = receipt.native_test_runners.records.coverage.records[0].execution_report;
  appendFileSync(report.path, '{}\n');
  blocked(() => f.run('execute', 'executor_code', { code: true, gui: false, recording: false }), 'PREFLIGHT_SOURCE_DRIFT');
  const forged = { verdict: 'PASS' }; c.evidence = f.evidence('exec_command', { cmd: c.command }, { exit_code: 0, output: JSON.stringify(forged) });
  blocked(() => f.run('execute', 'executor_code', { code: true, gui: false, recording: false }), 'PREFLIGHT_CODE_SMOKE_RESULT');
});
