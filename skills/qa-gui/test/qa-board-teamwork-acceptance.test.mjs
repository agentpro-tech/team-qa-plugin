import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('../.teamcode/qa-board-teamwork/fixtures/canonical.valid.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);
const frozenBytes = JSON.stringify(fixture);

async function canonical() {
  return import(new URL('../scripts/teamwork/canonical.mjs', import.meta.url));
}

async function native() {
  return import(new URL('../scripts/teamwork/native-renderer.mjs', import.meta.url));
}

async function notion() {
  return import(new URL('../scripts/teamwork/notion-sync.mjs', import.meta.url));
}

async function packager() {
  return import(new URL('../scripts/teamwork/evidence-packager.mjs', import.meta.url));
}

test('V1 canonical validator catches three missing required fields by exact name', async () => {
  const { validateCanonical } = await canonical();
  assert.deepEqual(validateCanonical(clone(fixture)), { ok: true, errors: [] });

  const mutations = [
    ['language', (data) => delete data.language],
    ['results', (data) => delete data.cases[0].results],
    ['assignee', (data) => delete data.defects[0].assignee],
  ];
  for (const [field, mutate] of mutations) {
    const data = clone(fixture);
    mutate(data);
    const result = validateCanonical(data);
    assert.equal(result.ok, false, `${field} deletion must fail`);
    assert.match(result.errors.map((entry) => `${entry.path} ${entry.message}`).join('\n'), new RegExp(field));
  }
});

test('V2 native renderer stages dropdown edits and hardens exact history', async () => {
  const { renderNativeBoard, applyNativePacket } = await native();
  const html = renderNativeBoard(clone(fixture));
  assert.match(html, /window\.__docColabState/);
  assert.match(html, /data-edit-field="status"/);
  assert.match(html, /data-edit-field="priority"/);
  assert.match(html, /data-machine-value="PASS"/);

  const packet = {
    protocol: 'doc-colab/v2',
    baseRev: fixture.rev,
    edits: [
      { entity: 'defect', id: 'DF-01', field: 'priority', from: 'P1', to: 'P2' },
      { entity: 'defect', id: 'DF-01', field: 'assignee', from: 'dev-agent-a', to: 'human-dev' },
    ],
    comments: [],
  };
  const result = applyNativePacket(clone(fixture), packet, {
    actor: 'Owner',
    now: '2026-08-11T10:00:00+07:00',
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.defects[0].priority, 'P2');
  assert.equal(result.data.defects[0].assignee, 'human-dev');
  assert.deepEqual(result.data.defects[0].history.slice(-2).map(({ who, field, from, to, when }) => ({ who, field, from, to, when })), [
    { who: 'Owner', field: 'priority', from: 'P1', to: 'P2', when: '2026-08-11T10:00:00+07:00' },
    { who: 'Owner', field: 'assignee', from: 'dev-agent-a', to: 'human-dev', when: '2026-08-11T10:00:00+07:00' },
  ]);
  assert.equal(JSON.stringify(fixture), frozenBytes, 'input fixture must remain immutable');
});

test('V4 three defects require fresh fix evidence before RETEST', async () => {
  const { applyChanges } = await canonical();
  for (const id of ['DF-01', 'DF-02', 'DF-03']) {
    const blocked = applyChanges(clone(fixture), [
      { entity: 'defect', id, field: 'status', to: 'RETEST' },
    ], { actor: 'dev-agent', now: '2026-08-11T10:10:00+07:00', source: 'native', qaActors: ['qa-agent'] });
    assert.equal(blocked.ok, false);
    assert.match(blocked.errors.join('\n'), new RegExp(id));

    const withEvidence = clone(fixture);
    const defect = withEvidence.defects.find((entry) => entry.id === id);
    defect.fixEvidence.push({ id: `${id}-EV-1`, type: 'image', path: `${id}-fix.png`, addedBy: 'dev-agent', addedAt: '2026-08-11T10:11:00+07:00' });
    const accepted = applyChanges(withEvidence, [
      { entity: 'defect', id, field: 'status', to: 'RETEST' },
    ], { actor: 'dev-agent', now: '2026-08-11T10:12:00+07:00', source: 'native', qaActors: ['qa-agent'] });
    assert.equal(accepted.ok, true, accepted.errors?.join('\n'));
    assert.equal(accepted.data.defects.find((entry) => entry.id === id).status, 'RETEST');
  }

  const selfClose = applyChanges(clone(fixture), [
    { entity: 'defect', id: 'DF-01', field: 'status', to: 'CLOSED' },
  ], { actor: 'qa-agent', now: '2026-08-11T10:20:00+07:00', source: 'native', qaActors: ['qa-agent'] });
  assert.equal(selfClose.ok, false);
  assert.match(selfClose.errors.join('\n'), /DF-01.*creator.*CLOSED/i);

  const untypedReject = applyChanges(clone(fixture), [
    { entity: 'defect', id: 'DF-01', field: 'status', to: 'REJECTED' },
  ], { actor: 'Owner', now: '2026-08-11T10:21:00+07:00', source: 'native', qaActors: ['qa-agent'] });
  assert.equal(untypedReject.ok, false);
  assert.match(untypedReject.errors.join('\n'), /DF-01.*rejectionReason/i);
});

test('V5 a new round result preserves every earlier result', async () => {
  const { addRoundResult } = await canonical();
  const before = clone(fixture.cases[0].results);
  const result = addRoundResult(clone(fixture), 'TC-01', {
    round: 3,
    functionVerdict: 'PASS',
    uiVerdict: 'FAIL',
    recordedAt: '2026-08-11T11:00:00+07:00',
    evidence: ['round-3-ui-fail.png'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.cases[0].results.slice(0, 2), before);
  assert.equal(result.data.cases[0].results.at(-1).round, 3);
  assert.equal(result.data.cases[0].uiVerdict, 'FAIL');
  assert.equal(result.data.currentRound, 3);
});

test('V3 Notion mapping is exact, pull is hardened, and rerun has no duplicates', async () => {
  const { mapCanonicalRows, compareNotionRows, applyNotionPull, syncCanonicalToNotion } = await notion();
  const expected = mapCanonicalRows(clone(fixture), { language: 'vi' });
  assert.equal(compareNotionRows(clone(fixture), expected, { language: 'vi' }).matchPercent, 100);

  const pulled = applyNotionPull(clone(fixture), [
    { externalId: 'DF-01', entity: 'defect', status: 'BLOCKED', comment: 'Need more server logs.', editedBy: 'human-dev', editedAt: '2026-08-11T11:10:00+07:00' },
  ], { qaActors: ['qa-agent'] });
  assert.equal(pulled.ok, true, pulled.errors?.join('\n'));
  assert.equal(pulled.data.defects[0].status, 'BLOCKED');
  assert.equal(pulled.data.defects[0].comments.at(-1).text, 'Need more server logs.');

  const rows = new Map();
  const transport = {
    async listRows() { return [...rows.values()]; },
    async upsertRow(row) { rows.set(row.externalId, clone(row)); },
  };
  assert.equal((await syncCanonicalToNotion(clone(fixture), transport, { language: 'vi' })).ok, true);
  const firstSize = rows.size;
  assert.equal((await syncCanonicalToNotion(clone(fixture), transport, { language: 'vi' })).ok, true);
  assert.equal(rows.size, firstSize);
});

test('H2 partial Notion failure keeps canonical unchanged and retries idempotently', async () => {
  const { syncCanonicalToNotion } = await notion();
  const data = clone(fixture);
  const before = JSON.stringify(data);
  const rows = new Map();
  let writes = 0;
  const flaky = {
    async listRows() { return [...rows.values()]; },
    async upsertRow(row) {
      writes += 1;
      if (writes === 2) throw new Error('fixture network failure');
      rows.set(row.externalId, clone(row));
    },
  };
  const failed = await syncCanonicalToNotion(data, flaky, { language: 'vi' });
  assert.equal(failed.ok, false);
  assert.ok(failed.pendingExternalId);
  assert.equal(JSON.stringify(data), before);

  const stable = {
    async listRows() { return [...rows.values()]; },
    async upsertRow(row) { rows.set(row.externalId, clone(row)); },
  };
  assert.equal((await syncCanonicalToNotion(data, stable, { language: 'vi' })).ok, true);
  assert.equal(rows.size, data.cases.length + data.defects.length);
});

test('H3 unknown Notion status is rejected without canonical mutation', async () => {
  const { applyNotionPull } = await notion();
  const data = clone(fixture);
  const before = JSON.stringify(data);
  const result = applyNotionPull(data, [
    { externalId: 'DF-02', entity: 'defect', status: 'CUSTOM_DONE', editedBy: 'human-dev', editedAt: '2026-08-11T11:20:00+07:00' },
  ], { qaActors: ['qa-agent'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /DF-02.*CUSTOM_DONE/);
  assert.equal(JSON.stringify(data), before);
});

test('H4 two-sided conflict keeps both events and gives QA the final status', async () => {
  const { reconcileChanges } = await canonical();
  const result = reconcileChanges(clone(fixture), [
    { entity: 'defect', id: 'DF-03', field: 'status', from: 'FIXING', to: 'BLOCKED', who: 'human-dev', when: '2026-08-11T11:30:00+07:00', source: 'notion' },
    { entity: 'defect', id: 'DF-03', field: 'status', from: 'FIXING', to: 'REOPENED', who: 'qa-agent', when: '2026-08-11T11:31:00+07:00', source: 'native' },
  ], { qaActors: ['qa-agent'] });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  const defect = result.data.defects.find((entry) => entry.id === 'DF-03');
  assert.equal(defect.status, 'REOPENED');
  assert.deepEqual(defect.history.slice(-2).map(({ who, to, source }) => ({ who, to, source })), [
    { who: 'human-dev', to: 'BLOCKED', source: 'notion' },
    { who: 'qa-agent', to: 'REOPENED', source: 'native' },
  ]);
  assert.equal(result.conflicts[0].winner, 'qa-agent');
});

test('H5 over-25MB package keeps images inline and discloses linked video', async () => {
  const { packageSelfContained } = await packager();
  const assets = [
    { path: 'proof.png', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) },
    { path: 'run.mp4', mime: 'video/mp4', bytes: new Uint8Array(25 * 1024 * 1024) },
  ];
  const result = packageSelfContained(clone(fixture), assets);
  assert.equal(result.ok, true);
  assert.match(result.html, /data:image\/png;base64,/);
  assert.doesNotMatch(result.html, /data:video\/mp4;base64,/);
  assert.match(result.html, /run\.mp4/);
  assert.match(result.html, /25MB|25 MB/);
  assert.deepEqual(result.linkedVideos, ['run.mp4']);
});
