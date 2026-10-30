import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Each deployed-lane guard of the Claude-host tooling must be load-bearing: removing it turns the suite red.
// Needs the SCROLL runtime (TEAMQA_SCROLL_ROOT); the preflight guard also needs Node 24/26 like assertToolPreflight.
const root = fileURLToPath(new URL('../../', import.meta.url));
const test = 'test/claude-host/deployed-lane.test.mjs';
const scroll = process.env.TEAMQA_SCROLL_ROOT || join(homedir(), 'Dev', 'scroll');
assert.ok(existsSync(join(scroll, 'lib', 'effects.js')), 'SCROLL runtime required: set TEAMQA_SCROLL_ROOT');
const node24 = /^v(?:24|26)\./.test(process.version);
const cases = [
  { id: 'passive-order', file: 'scripts/lib/claude-refs.mjs', from: "if (passive.length < 3 || !PAGE_READS.includes(page.method) || network.method !== 'getNetwork' || tab.method !== 'getTabInfo') {", to: 'if (passive.length < 3) {', failed: 'prove rejects sidechain' },
  { id: 'latest-marker', file: 'scripts/lib/claude-refs.mjs', from: 'markerLine = index; calls.clear(); records = [];', to: 'markerLine = index;', failed: 'prove rejects sidechain' },
  { id: 'visible-marker', file: 'scripts/lib/claude-refs.mjs', from: "entry?.type === 'assistant' && visibleClaudeAssistantText(entry)?.includes(marker)", to: 'raw.includes(marker)', failed: 'prove rejects sidechain' },
  { id: 'target-env', file: 'scripts/lib/web-identity.mjs', from: "if (set.length) bad('WEB_TARGET_ENV_SET'", to: "if (false) bad('WEB_TARGET_ENV_SET'", failed: 'identity artifacts are byte stable' },
  { id: 'no-overwrite', file: 'scripts/lib/web-identity.mjs', from: "if (readFileSync(path, 'utf8') !== content) blocked(code, `${display(path)} already exists with different bytes`);", to: '', failed: 'identity artifacts are byte stable' },
  { id: 'verified-only', file: 'scripts/lib/preflight-build.mjs', from: "if (!verdict.verified) blocked('PREFLIGHT_BUILD_NOT_VERIFIED', JSON.stringify(verdict.lanes));", to: '', failed: 'preflight build refuses stale', node24: true },
  { id: 'persisted-original', file: 'scripts/lib/host-transcript.mjs', from: '  if (!isPersistedPreview(out.content)) return toolResultText(out.content);', to: '  return toolResultText(out.content);', failed: 'prove reads a persisted getPageHtml result' },
  { id: 'persisted-preview-only', file: 'scripts/lib/host-transcript.mjs', from: '  if (isPersistedPreview(original)) return null;', to: '', failed: 'prove rejects sidechain' },
  { id: 'gui-route-permission', file: 'scripts/lib/roster.mjs', from: "'--permission-mode',claudeRoute?'default':'plan'", to: "'--permission-mode','plan'", failed: 'GUI executor seats on the Claude host' },
  { id: 'gui-dragon-captures', file: 'scripts/lib/roster.mjs', from: ",'--add-dir',dragonOutputRoot(),...(toolResultsDir", to: ",...(toolResultsDir", failed: 'GUI executor seats on the Claude host' },
  { id: 'gui-stream-buffer', file: 'scripts/lib/roster.mjs', from: "route?256*1024*1024:16*1024*1024", to: "route?16*1024*1024:16*1024*1024", failed: 'GUI executor seats on the Claude host' },
];
const run = dir => spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(dir, test)],{ encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TEAMQA_SCROLL_ROOT: scroll } });
const copy = id => {
  const dir = mkdtempSync(join(tmpdir(), `tq-deployed-mutant-${id}-`));
  for (const name of ['scripts', 'references', 'agents', 'SKILL.md', 'contracts', 'schemas', 'test/claude-host', 'test/roster-dynamic']) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    cpSync(join(root, name), join(dir, name), { recursive: true });
  }
  return dir;
};
const control = copy('control'), positive = run(control);
assert.equal(positive.status, 0, `positive control failed\n${positive.stdout}${positive.stderr}`);
for (const item of cases) {
  if (item.node24 && !node24) { console.log(`MUTATION_SKIPPED ${item.id} needs Node 24/26`); continue; }
  const dir = copy(item.id), path = join(dir, item.file), before = readFileSync(path, 'utf8');
  assert.ok(before.includes(item.from), `mutation missing: ${item.id}`);
  writeFileSync(path, before.replace(item.from, item.to));
  const result = run(dir);
  assert.equal(result.status, 1, `surviving mutation: ${item.id}\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, new RegExp(`^not ok \\d+ - ${item.failed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'), `${item.id}: expected failure in "${item.failed}"\n${result.stdout}`);
  console.log(`MUTATION_KILLED ${item.id} retained=${dir}`);
}
