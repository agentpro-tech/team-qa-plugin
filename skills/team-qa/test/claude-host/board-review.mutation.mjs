import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Each Claude-host board review guard must be load-bearing: removing it turns the suite red.
const root = fileURLToPath(new URL('../../', import.meta.url));
const test = 'test/claude-host/board-review.test.mjs';
const file = 'scripts/lib/board-review-claude.mjs';
const cases = [
  { id: 'tool-less', from: "if (!Array.isArray(parsed?.tool_log) || parsed.tool_log.length !== 0) errors.push('REVIEWER_TOOL_USED');", to: '', failed: 'reviewer proof requires' },
  { id: 'independent', from: "if (parsed?.session_id === intent.host.session_id || parsed?.session_id === intent.author.session_id) errors.push('REVIEWER_NOT_INDEPENDENT');", to: '', failed: 'reviewer proof requires' },
  { id: 'locked-message', from: "!child.text.includes(intent.spawn.message.trim())", to: 'false', failed: 'reviewer proof requires' },
  { id: 'observed-model', from: "if (parsed?.observed?.model !== intent.spawn.model) errors.push('REVIEWER_MODEL');", to: '', failed: 'reviewer proof requires' },
  { id: 'observed-effort', from: "if (parsed?.observed?.reasoning !== intent.spawn.reasoning_effort) errors.push('REVIEWER_EFFORT');", to: '', failed: 'reviewer proof requires' },
  { id: 'no-tools-flag', from: "'--tools', ''", to: "'--tools', 'Read'", failed: 'reviewer argv runs one tool-less turn' },
  { id: 'marker-filter', from: "!String(pair.output.output).includes(marker)", to: 'false', failed: 'root Bash calls are found by marker' },
];
for (const item of cases) {
  const copy = mkdtempSync(join(tmpdir(), `tq-claude-board-mutant-${item.id}-`));
  for (const name of ['scripts', 'test/claude-host']) {
    mkdirSync(join(copy, name, '..'), { recursive: true });
    cpSync(join(root, name), join(copy, name), { recursive: true });
  }
  const path = join(copy, file), before = readFileSync(path, 'utf8');
  assert.ok(before.includes(item.from), `mutation missing: ${item.id}`);
  const control = spawnSync(process.execPath, ['--test', join(copy, test)], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(control.status, 0, `positive control failed: ${item.id}\n${control.stdout}${control.stderr}`);
  writeFileSync(path, before.replace(item.from, item.to));
  const result = spawnSync(process.execPath, ['--test', join(copy, test)], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 1, `surviving mutation: ${item.id}\n${result.stdout}${result.stderr}`);
  assert.ok(result.stdout.includes(item.failed), `${item.id}: expected failure in "${item.failed}"\n${result.stdout}`);
  console.log(`MUTATION_KILLED ${item.id} retained=${copy}`);
}
