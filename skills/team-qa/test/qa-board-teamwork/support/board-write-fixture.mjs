import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from '../../../scripts/lib/core.mjs';
import { prepareBoardWrite } from '../../../scripts/lib/board-write-admission.mjs';

export function boardWriteFixture(runDir) {
  mkdirSync(runDir, { recursive: true });
  const canonical = join(runDir, 'qa-board.json');
  const payload = join(runDir, 'page-payload.json');
  const destination = join(runDir, 'destination.json');
  const quality = `${payload}.quality.json`;
  const requestPath = join(runDir, 'board-write.json');
  writeFileSync(canonical, JSON.stringify({ boardId: 'fixture-board', rev: 3, cases: [] }));
  writeFileSync(payload, JSON.stringify({ protocol: 'qa-gui/page-export/v1', title: 'Fixture QA', initial_blocks: [{ type: 'markdown', markdown: '# Fixture QA' }], canonical: { boardId: 'fixture-board', rev: 3, sha256: 'a'.repeat(64) } }));
  writeFileSync(quality, JSON.stringify({ fixture: 'explicit-board-write-admission-test' }));
  writeFileSync(destination, JSON.stringify({ space_id: 'space-fixture', idempotency_key: 'fixture-key', position: 0 }));
  const verifyDelivery = ({ file, artifactPath, renderer }) => {
    if (realpathSync(file) !== realpathSync(canonical) || realpathSync(artifactPath) !== realpathSync(payload) || renderer !== 'space'
      || !JSON.parse(readFileSync(quality, 'utf8')).fixture) throw new Error('BOARD_QUALITY_FIXTURE_REJECTED');
    return { fixture: true };
  };
  const request = prepareBoardWrite({ file: canonical, artifactPath: payload,
    destination: JSON.parse(readFileSync(destination, 'utf8')), out: requestPath, verifyDelivery });
  const roster = { schema: 'team-qa/roster/v1', run_id: 'fixture-run', round: 1, target: { preview_url: 'https://fixture.invalid', version: 'v1' } };
  writeFileSync(join(runDir, 'roster.json'), JSON.stringify(roster));
  const rosterHash = sha256File(join(runDir, 'roster.json'));
  const artifacts = Object.fromEntries([['board', canonical], ['board_payload', payload], ['board_quality', quality], ['board_write', requestPath]]
    .map(([name, path]) => [name, { path: path.slice(runDir.length + 1), sha256: sha256File(path) }]));
  writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ schema: 'team-qa/docs-lock/v1', run_id: roster.run_id, round: roster.round, roster_hash: rosterHash, artifacts }));
  return { runDir, canonical, payload, quality, requestPath, request, roster, toolInput: request.tool_input, verifyDelivery };
}
