// roles.json names the child skills at the default suite install (~/.agents/skills/<skill>/...). An installed Team QA
// (plugin or any root with SOURCE.json) uses the children installed next to it, so those paths follow that root too;
// TEAMQA_QA_GUI_ROOT / TEAMQA_QA_CODE_ROOT still win, and a source checkout keeps the default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { anchorChildSkillPaths } from '../scripts/lib/install-layout.mjs';

const skills = {
  'qa-gui': { verdict_schema: '~/.agents/skills/qa-gui/scripts/qa-board.schema.json', supported_major: 3,
    receipt_schema: '~/.agents/skills/qa-gui/contracts/x.json', supported_receipt_major: 2,
    commands: { gate: ['node', '~/.agents/skills/qa-gui/scripts/qa-gate.mjs'] } },
  'qa-code': { verdict_schema: '~/.agents/skills/qa-code/references/verdict.schema.json', supported_major: 1,
    commands: { run: ['bash', '~/.agents/skills/qa-code/scripts/qa-run.sh'], other: ['node', '/abs/kept.mjs'] } },
};

test('an installed Team QA anchors child skill paths to the children installed next to it', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tq-layout-')));
  const root = join(base, 'skills', 'team-qa'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'SOURCE.json'), '{}');
  const out = anchorChildSkillPaths(skills, { root, env: {} });
  assert.equal(out['qa-gui'].verdict_schema, join(base, 'skills', 'qa-gui', 'scripts/qa-board.schema.json'));
  assert.equal(out['qa-gui'].receipt_schema, join(base, 'skills', 'qa-gui', 'contracts/x.json'));
  assert.deepEqual(out['qa-gui'].commands.gate, ['node', join(base, 'skills', 'qa-gui', 'scripts/qa-gate.mjs')]);
  assert.deepEqual(out['qa-code'].commands.run, ['bash', join(base, 'skills', 'qa-code', 'scripts/qa-run.sh')]);
  assert.deepEqual(out['qa-code'].commands.other, ['node', '/abs/kept.mjs']);
  assert.equal(skills['qa-gui'].verdict_schema, '~/.agents/skills/qa-gui/scripts/qa-board.schema.json', 'the input is not changed');
});

test('the environment roots win; a source checkout keeps the default paths', () => {
  const env = { TEAMQA_QA_GUI_ROOT: '/opt/qa-gui' };
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'tq-checkout-')));
  const out = anchorChildSkillPaths(skills, { root: checkout, env });
  assert.equal(out['qa-gui'].receipt_schema, '/opt/qa-gui/contracts/x.json');
  assert.equal(out['qa-code'].verdict_schema, '~/.agents/skills/qa-code/references/verdict.schema.json');
  assert.equal(anchorChildSkillPaths(null), null);
});
