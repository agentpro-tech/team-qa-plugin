// A one-case schema 6 board with one state receipt, for the R1d gate tests (default gate mode and release-truth v2).
// Synthetic boards, never evidence of a product run. Built like the R1f fixtures (test/evidence-policy-r1f.test.mjs).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fitPng } from '../../scripts/lib/evidence-quality.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CAPTURE = readFileSync(join(ROOT, 'qa-evidence/fixture-a/round-1/1280x800/after-load.png'));
export const RUN_UUID = '11111111-1111-4111-8111-111111111111';
export const COMMIT = 'a'.repeat(40);
const URL_ = 'https://test.example/orders/1';
const BUILD = 'build-2026-11-04';
const DOM = 'b'.repeat(64);
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// files: {rel: bytes|string|object}; extra files are added to the case evidence and the manifest.
export function r1dBoard({ receipt = () => {}, files = {}, data: edit = () => {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r1d-gate-')));
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const write = (rel, value) => {
    const bytes = Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
    return rel;
  };
  const { png, fit } = fitPng(CAPTURE);
  const shot = write('evidence/TC-01-after-open.png', png);
  const raw = write('evidence/TC-01-raw.json', '{"observed":"open"}\n');
  const extra = Object.entries(files).map(([rel, value]) => write(rel, value));
  const r = {
    schema: 'qa-gui/state-receipt/v1', caseId: 'TC-01', state: 'after-open', capturedAt: '2026-11-04T02:00:00.000Z',
    url: URL_, build: BUILD, viewport: '1280x800', domHash: DOM,
    dragon: { sessionId: 's-1', actionId: 'act-1', browserInstanceId: 'bi-1', tabId: 'tab-1', innerOk: true },
    screenshot: { path: shot, sha256: sha(png), capture: { tabId: 'tab-1', url: URL_, build: BUILD, domHash: DOM, sha256: sha(CAPTURE), viewport: '1280x800', maskedRects: [] }, fit },
    function: { verdict: 'PASS', assertions: [{ requirement_id: 'REQ-1', verdict: 'PASS', evidence_ref: raw }] },
    ui: { verdict: 'PASS', uiSanity: { id: 'ui-sanity', verdict: 'PASS', evidence: 'raw' }, a11y: { id: 'a11y', verdict: 'PASS', evidence: 'raw' },
      console: { id: 'console', verdict: 'PASS', evidence: 'raw' }, network: { id: 'network', verdict: 'PASS', evidence: 'raw' } },
    preflight: { id: 'preflight', verdict: 'PASS', evidence: 'raw' },
    network: [],
  };
  receipt(r, { dir });
  const rec = write('evidence/TC-01-after-open.state.json', r);
  const evidence = [shot, raw, rec, ...extra];
  const data = {
    schemaVersion: 6, canonicalVersion: 'qa-board-teamwork/v2', boardKind: 'team-qa-board', rev: 1, boardId: 'r1d', title: 'R1d fixture',
    boardCreated: '2026-11-04T01:00:00.000Z', language: 'en', deepCheck: 'available', app: 'r1d-fixture', envDb: 'TEST / fixture',
    viewport: '1280x800', runUuid: RUN_UUID, commit: COMMIT, build: BUILD, env: 'TEST', db: 'fixture', role: 'qa-agent', testProfile: 'r1d',
    evidenceManifest: evidence.map((path) => ({ path, sha256: sha(readFileSync(join(dir, path))) })),
    currentRound: 1,
    sourceItems: [{ id: 'SRC-1', kind: 'spec', sourceSystem: 'fixture', externalKey: 'REQ-1', title: 'Open the order', origin: 'upstream' }],
    cases: [{
      id: 'TC-01', title: 'Open the order', requirement: 'REQ-1', requirements: ['REQ-1'], sourceRefs: ['SRC-1'], steps: 'Open the order.',
      expected: 'The order opens.', status: 'PASS', priority: 'P1', assignee: 'qa-agent', functionVerdict: 'PASS', uiVerdict: 'PASS',
      humanSummary: { function: 'Opened.', ui: 'Clean.' }, machine: { rule: 'r1d', selector: '#open' }, kind: 'static', states: ['after-open'],
      stateReceipts: [{ state: 'after-open', file: rec }],
      results: [{ round: 1, functionVerdict: 'PASS', uiVerdict: 'PASS', recordedAt: '2026-11-04T02:01:00.000Z', evidence }],
      evidence, comments: [], history: [],
    }],
    defects: [], rounds: [{ round: 1, startedAt: '2026-11-04T01:00:00.000Z', scope: 'R1d fixture' }],
    coverage: ['happy', 'boundary', 'empty', 'loading', 'error', 'auth-role', 'navigation', 'keyboard', 'responsive', 'dark-mode'].map((area) => ({ area, status: 'tick' })),
    untested: [], release: { verdict: 'GO', risks: [] },
  };
  edit(data);
  const file = join(dir, 'board.json');
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { dir, file, data, receiptPath: join(dir, rec) };
}

// The same board as release-truth v2 reads it (Git target): typed manifest entries and atomic assertions.
export function asReleaseTruthV2(fixture) {
  const types = { png: 'gui-screenshot', json: 'machine-receipt' };
  fixture.data.evidenceManifest = fixture.data.evidenceManifest.map((entry) => ({ ...entry,
    evidence_type: types[entry.path.split('.').pop()] ?? 'machine-receipt',
    metadata: { run_uuid: RUN_UUID, task_base: COMMIT, commit: COMMIT, case_id: 'TC-01', state: 'after-open', captured_at: '2026-11-04T02:00:00.000Z' } }));
  const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
  receipt.function.assertions = [{ requirement_id: 'REQ-1', assertion_id: 'TC-01-A1', verdict: 'PASS', evidence_ref: receipt.screenshot.path, evidence_type: 'gui-screenshot' }];
  receipt.network_summary = { failed_requests: 0 };
  writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
  const entry = fixture.data.evidenceManifest.find((e) => e.path.endsWith('.state.json'));
  entry.sha256 = sha(readFileSync(fixture.receiptPath));
  writeFileSync(fixture.file, JSON.stringify(fixture.data));
  const requirement = { id: 'REQ-1', acceptance_ids: ['TC-01'], risk_dimensions: [], evidence_contract: { allowed_types: ['gui-screenshot', 'gui-recording'] } };
  const context = { kind: 'git', exactFinalSha: COMMIT, taskBase: COMMIT, activeGuiRequirements: [requirement], guiIds: ['REQ-1'],
    planById: new Map([['TC-01', { requirementId: 'REQ-1', data: {} }]]) };
  return { data: fixture.data, boardPath: fixture.file, evidenceRoot: fixture.dir, context };
}

// Dragon R1a shapes (docs/r1a-environment-and-sensors.md §2): the closed conditions record and an env.reset result.
export function conditions(over = {}) {
  return { v: 1, caseId: 'TC-01', role: 'test', network: null, cpu: null, timezone: null, locale: null, media: null, animation: null,
    requests: [], probes: { sensors: false, frames: false }, verified: null, setAt: null, expiresAt: null, ...over };
}
export function resetResult(over = {}) {
  return { ok: true, reason: 'reset', endedCase: 'TC-01', atDefault: true, restored: ['network'], released: 0, sensors: null, frames: null,
    errors: [], mismatches: [], readback: { page: { onLine: true } }, conditions: conditions({ caseId: null, verified: true }), ...over };
}
