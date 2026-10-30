// Team QA plugin BA, C1: an installed QA GUI finds Team QA next to itself (install.sh or the Claude Code plugin).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTeamQaRoot } from '../scripts/lib/teamqa-attestation.mjs';

test('an installed QA GUI looks for Team QA next to it; a checkout keeps ~/.agents/skills', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qagui-sibling-')));
  const own = join(dir, 'plugin', 'skills', 'qa-gui');
  mkdirSync(own, { recursive: true });
  assert.equal(defaultTeamQaRoot({ root: own, home: '/h' }), '/h/.agents/skills/team-qa');
  writeFileSync(join(own, 'SOURCE.json'), '{}');
  assert.equal(defaultTeamQaRoot({ root: own, home: '/h' }), join(dir, 'plugin', 'skills', 'team-qa'));
  symlinkSync(own, join(dir, 'linked-qa-gui'));
  assert.equal(defaultTeamQaRoot({ root: join(dir, 'linked-qa-gui'), home: '/h' }), join(dir, 'plugin', 'skills', 'team-qa'));
});
