import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateCanonical } from '../scripts/teamwork/canonical.mjs';
import { migrateCanonicalSourceTraceability } from '../scripts/teamwork/source-traceability-migration.mjs';
import { renderNativeBoard } from '../scripts/teamwork/native-renderer.mjs';
import { compareNotionRows, mapCanonicalRows, syncCanonicalToNotion } from '../scripts/teamwork/notion-sync.mjs';

const fixtureUrl = new URL('./fixtures/source-traceability/canonical-v6.valid.json', import.meta.url);
const mutationUrl = new URL('./fixtures/source-traceability/canonical-v6.unknown-ref.json', import.meta.url);
const mappingUrl = new URL('./fixtures/source-traceability/migration-map.valid.json', import.meta.url);
const cli = fileURLToPath(new URL('../scripts/teamwork/cli.mjs', import.meta.url));
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const mutation = JSON.parse(readFileSync(mutationUrl, 'utf8'));
const mapping = JSON.parse(readFileSync(mappingUrl, 'utf8'));
const clone = (value) => structuredClone(value);

function cliRun(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('schema 6 accepts deterministic many-to-many source references', () => {
  assert.deepEqual(validateCanonical(clone(fixture)), { ok: true, errors: [] });
  const refs = fixture.cases.flatMap((entry) => entry.sourceRefs.map((sourceRef) => [sourceRef, entry.id]));
  assert.deepEqual(refs.filter(([sourceRef]) => sourceRef === 'SRC-JIRA-42'), [
    ['SRC-JIRA-42', 'TC-01'],
    ['SRC-JIRA-42', 'TC-02'],
  ]);
  assert.deepEqual(fixture.cases[0].sourceRefs, ['SRC-JIRA-42', 'SRC-SPEC-7']);
});

test('missing, duplicate, and unknown source references fail at the exact case path', () => {
  const missing = clone(fixture);
  delete missing.cases[0].sourceRefs;
  assert.match(validateCanonical(missing).errors.map(({ path, message }) => `${path}: ${message}`).join('\n'), /cases\[0\]\.sourceRefs/);

  const duplicate = clone(fixture);
  duplicate.cases[0].sourceRefs.push('SRC-JIRA-42');
  assert.match(validateCanonical(duplicate).errors.map(({ path, message }) => `${path}: ${message}`).join('\n'), /cases\[0\]\.sourceRefs.*duplicate SRC-JIRA-42/);

  const unknown = clone(fixture);
  unknown.cases[0].sourceRefs[1] = mutation.mutation.value;
  assert.match(validateCanonical(unknown).errors.map(({ path, message }) => `${path}: ${message}`).join('\n'), new RegExp(mutation.expectedErrorPath.replace(/[\[\]]/g, '\\$&')));
});

test('QA-derived guardrails require an explicit origin and reason', () => {
  const noReason = clone(fixture);
  delete noReason.sourceItems[2].qaDerivedReason;
  assert.match(validateCanonical(noReason).errors.map(({ path, message }) => `${path}: ${message}`).join('\n'), /sourceItems\[2\]\.qaDerivedReason/);

  const impersonated = clone(fixture);
  impersonated.sourceItems[2].origin = 'upstream';
  assert.match(validateCanonical(impersonated).errors.map(({ path, message }) => `${path}: ${message}`).join('\n'), /sourceItems\[2\].*qa-derived.*origin/i);
});

test('legacy schema 4 and 5 remain valid while new fields are version-gated', () => {
  for (const schemaVersion of [4, 5]) {
    const legacy = clone(fixture);
    legacy.schemaVersion = schemaVersion;
    legacy.canonicalVersion = 'qa-board-teamwork/v1';
    delete legacy.boardKind;
    delete legacy.sourceItems;
    legacy.cases.forEach((entry) => delete entry.sourceRefs);
    assert.deepEqual(validateCanonical(legacy), { ok: true, errors: [] });

    legacy.sourceItems = [];
    assert.match(validateCanonical(legacy).errors.map(({ path, message }) => `${path}: ${message}`).join('\n'), /sourceItems.*schema 6|version/i);
  }
});

test('defects trace only through caseId and Issue Group is not canonical data', () => {
  const defect = {
    id: 'DF-01', title: 'Fixture defect', caseId: 'TC-01', status: 'TODO', priority: 'P2',
    assignee: 'dev-agent', createdBy: 'qa-agent', repro: 'Run the source case.', expected: 'Expected.',
    actual: 'Actual.', findings: [], evidence: [], fixEvidence: [], lastRetestFixEvidenceCount: 0,
    comments: [], history: [], rejectionReason: null, sourceRefs: ['SRC-JIRA-42'],
  };
  const data = clone(fixture);
  data.defects.push(defect);
  const errors = validateCanonical(data).errors.map(({ path, message }) => `${path}: ${message}`).join('\n');
  assert.match(errors, /defects\[0\]\.sourceRefs.*unknown field/);

  const issueGroup = clone(fixture);
  issueGroup.cases[0].issueGroup = 'APP-42';
  assert.match(validateCanonical(issueGroup).errors.map(({ path, message }) => `${path}: ${message}`).join('\n'), /cases\[0\]\.issueGroup.*unknown field/);
});

test('migration requires an explicit mapping for every case and never infers from IDs or titles', () => {
  const legacy = clone(fixture);
  legacy.schemaVersion = 5;
  legacy.canonicalVersion = 'qa-board-teamwork/v1';
  delete legacy.boardKind;
  delete legacy.sourceItems;
  legacy.cases.forEach((entry) => delete entry.sourceRefs);

  const incomplete = clone(mapping);
  incomplete.caseMappings.pop();
  assert.throws(() => migrateCanonicalSourceTraceability(legacy, incomplete), /TC-03.*explicit mapping/i);

  const migrated = migrateCanonicalSourceTraceability(legacy, mapping);
  assert.equal(migrated.schemaVersion, 6);
  assert.equal(migrated.canonicalVersion, 'qa-board-teamwork/v2');
  assert.equal(migrated.boardKind, 'team-qa-board');
  assert.deepEqual(migrated.cases.map(({ id, sourceRefs }) => ({ id, sourceRefs })), [
    { id: 'TC-01', sourceRefs: ['SRC-LEGACY-1'] },
    { id: 'TC-02', sourceRefs: ['SRC-LEGACY-1'] },
    { id: 'TC-03', sourceRefs: ['SRC-LEGACY-1'] },
  ]);
  assert.deepEqual(validateCanonical(migrated), { ok: true, errors: [] });
});

test('CLI initializes v2 and migrates without overwriting either input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-source-traceability-'));
  const initializedPath = join(dir, 'initialized.json');
  const initialized = cliRun(['init', '--board-id', 'init-v2', '--title', 'Traceability board', '--language', 'en', '--out', initializedPath]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const initializedData = JSON.parse(readFileSync(initializedPath, 'utf8'));
  assert.equal(initializedData.schemaVersion, 6);
  assert.equal(initializedData.canonicalVersion, 'qa-board-teamwork/v2');
  assert.deepEqual(initializedData.sourceItems, []);

  const legacy = clone(fixture);
  legacy.schemaVersion = 5;
  legacy.canonicalVersion = 'qa-board-teamwork/v1';
  delete legacy.boardKind;
  delete legacy.sourceItems;
  legacy.cases.forEach((entry) => delete entry.sourceRefs);
  const legacyPath = join(dir, 'legacy.json');
  const mappingPath = join(dir, 'mapping.json');
  const migratedPath = join(dir, 'migrated.json');
  writeFileSync(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);
  writeFileSync(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`);
  const before = readFileSync(legacyPath, 'utf8');
  const migrated = cliRun(['migrate-sources', '--file', legacyPath, '--mapping', mappingPath, '--out', migratedPath]);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(readFileSync(legacyPath, 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(migratedPath, 'utf8')).schemaVersion, 6);
  const overwrite = cliRun(['migrate-sources', '--file', legacyPath, '--mapping', mappingPath, '--out', migratedPath]);
  assert.notEqual(overwrite.status, 0);
});

test('CLI source seed preserves exact upstream references and refuses inferred or unknown input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-source-seed-'));
  const seedPath = join(dir, 'seed.json');
  const output = join(dir, 'canonical.json');
  writeFileSync(seedPath, `${JSON.stringify({
    seedVersion: 'qa-source-seed/v1',
    sourceItems: fixture.sourceItems,
    cases: [{
      id: 'TC-SEED-01',
      title: 'Seeded source case',
      requirement: 'Explicit seeded requirement',
      requirements: ['REQ-SEED-01'],
      sourceRefs: ['SRC-JIRA-42', 'SRC-SPEC-7'],
      steps: ['Open the fixture', 'Check the explicit result'],
      expected: 'The explicit result is visible.',
    }],
  }, null, 2)}\n`);
  const result = cliRun([
    'init', '--board-id', 'seeded-v2', '--title', 'Seeded traceability board', '--language', 'en',
    '--source-seed', seedPath, '--out', output,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const initialized = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(initialized.cases[0].sourceRefs, ['SRC-JIRA-42', 'SRC-SPEC-7']);
  assert.equal(initialized.sourceItems[0].title, fixture.sourceItems[0].title);
  assert.equal(initialized.cases[0].steps, '1. Open the fixture\n2. Check the explicit result');
  assert.deepEqual(validateCanonical(initialized), { ok: true, errors: [] });

  const missingTitlePath = join(dir, 'seed-missing-title.json');
  const missingTitle = JSON.parse(readFileSync(seedPath, 'utf8'));
  delete missingTitle.cases[0].title;
  writeFileSync(missingTitlePath, `${JSON.stringify(missingTitle, null, 2)}\n`);
  const missingTitleResult = cliRun([
    'init', '--board-id', 'no-inference', '--title', 'No inference', '--language', 'en',
    '--source-seed', missingTitlePath, '--out', join(dir, 'missing-title.json'),
  ]);
  assert.notEqual(missingTitleResult.status, 0);
  assert.match(missingTitleResult.stderr, /cases\[0\]\.title is required/);

  const unknownRefPath = join(dir, 'seed-unknown-ref.json');
  const unknownRef = JSON.parse(readFileSync(seedPath, 'utf8'));
  unknownRef.cases[0].sourceRefs = ['SRC-UNKNOWN'];
  writeFileSync(unknownRefPath, `${JSON.stringify(unknownRef, null, 2)}\n`);
  const unknownRefResult = cliRun([
    'init', '--board-id', 'unknown-ref', '--title', 'Unknown ref', '--language', 'en',
    '--source-seed', unknownRefPath, '--out', join(dir, 'unknown-ref.json'),
  ]);
  assert.notEqual(unknownRefResult.status, 0);
  assert.match(unknownRefResult.stderr, /unknown source ref SRC-UNKNOWN/);
});

test('native board renders Source Issue details and the QA-derived reason from exact refs', () => {
  const html = renderNativeBoard(clone(fixture));
  assert.match(html, /Source Issue/);
  assert.match(html, /data-source-ref="SRC-JIRA-42"/);
  assert.match(html, /APP-42/);
  assert.match(html, /QA added this guardrail after a repeated empty-state regression/);
});

test('Notion uses exact relation mappings and stable external fallback; defects do not duplicate sources', async () => {
  const options = { notionSourcePages: { 'SRC-JIRA-42': 'notion-page-app-42' } };
  const rows = mapCanonicalRows(clone(fixture), options);
  const first = rows.find((row) => row.externalId === 'TC-01');
  assert.deepEqual(first.sourceIssue.relation, [{ sourceRef: 'SRC-JIRA-42', pageId: 'notion-page-app-42' }]);
  assert.deepEqual(first.sourceIssue.external.map(({ sourceRef, externalKey, url }) => ({ sourceRef, externalKey, url })), [
    { sourceRef: 'SRC-SPEC-7', externalKey: 'SPEC-7', url: 'https://github.example.test/specs/7' },
  ]);
  assert.equal(first.issueGroup.derived, true);
  assert.equal(Object.hasOwn(fixture.cases[0], 'issueGroup'), false);

  const rowsById = new Map();
  const transport = {
    async listRows() { return [...rowsById.values()]; },
    async upsertRow(row) { rowsById.set(row.externalId, clone(row)); },
  };
  const firstSync = await syncCanonicalToNotion(clone(fixture), transport, options);
  const secondSync = await syncCanonicalToNotion(clone(fixture), transport, options);
  assert.equal(firstSync.ok, true, firstSync.errors?.join('\n'));
  assert.equal(secondSync.ok, true, secondSync.errors?.join('\n'));
  assert.equal(secondSync.synced, 0);
  assert.equal(compareNotionRows(clone(fixture), [...rowsById.values()], options).matchPercent, 100);
});
