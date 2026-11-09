#!/usr/bin/env node
// Upgrade R3 flags-off fixture run: builds the same synthetic boards every time and prints, as one JSON document, what
// the QA GUI found in <qa-gui root> makes of them (canonical validation, the release-truth v2 checks, and the gate CLI
// in its default mode). `golden.json` beside this file is this run against the pre-R3 code (branch upgrade/full);
// test/speed-r3-flags-off.test.mjs runs it against the current code and expects the same document. Only APIs present
// before R3 are used. Regenerate the golden from a pre-R3 tree: node run-fixture.mjs <pre-R3 qa-gui root> > golden.json
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? new URL('../../../', import.meta.url).pathname);
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const { encodePng } = await load('scripts/visual-diff.mjs');
const { checkGuiReleaseTruthV2 } = await load('scripts/lib/qa-gui-v2.mjs');
const { validateCanonical } = await load('scripts/teamwork/canonical.mjs');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const RUN_UUID = '33333333-3333-4333-8333-333333333333';
const COMMIT = 'd'.repeat(40);
const RULES = ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];

function page(rows) {
  const width = 320, height = 200, data = Buffer.alloc(width * height * 4);
  const fill = (x0, y0, w, h, rgb) => { for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) data.set([...rgb, 255], (y * width + x) * 4); };
  fill(0, 0, width, height, [250, 250, 250]);
  fill(0, 0, width, 24, [30, 30, 40]);
  for (let r = 0; r < rows; r += 1) fill(16, 40 + r * 30, 288, 20, [225, 228, 235]);
  return encodePng({ width, height, data });
}

// Two cases: TC-01 static, every sweep and every vision rule PASS; TC-02 with a C12 FAIL and a ui-sanity warn.
function build(dir, variant) {
  const write = (rel, bytes) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), bytes); return rel; };
  const manifest = [], cases = [], vision = [];
  for (const [index, id] of ['TC-01', 'TC-02'].entries()) {
    const state = `${id.toLowerCase()}-list`;
    const shot = write(`evidence/${id}/${state}.png`, page(index + 2));
    const raw = write(`evidence/${id}/raw.json`, `{"rows":${index + 2}}\n`);
    const warn = id === 'TC-02' && variant !== 'clean';
    const receipt = {
      schema: 'qa-gui/state-receipt/v1', caseId: id, state, capturedAt: '2026-11-04T03:00:00.000Z',
      url: `https://app.test/${id.toLowerCase()}`, build: 'build-7', viewport: '320x200', domHash: 'e'.repeat(64),
      dragon: { sessionId: 's-1', actionId: `act-${id}`, browserInstanceId: 'bi-1', tabId: 'tab-1', innerOk: true },
      screenshot: { path: shot, sha256: sha(readFileSync(join(dir, shot))) },
      function: { verdict: 'PASS', assertions: [{ requirement_id: 'REQ-1', assertion_id: `${id}-A1`, verdict: 'PASS', evidence_ref: shot, evidence_type: 'gui-screenshot' }] },
      ui: { verdict: 'PASS', uiSanity: { id: 'ui-sanity', verdict: 'PASS', evidence: JSON.stringify({ v: 'PASS', c: { high: 0, warn: warn ? 1 : 0 } }) },
        a11y: { id: 'a11y', verdict: 'PASS', evidence: '{"v":"PASS"}' },
        console: { id: 'console', verdict: 'PASS', evidence: 'raw' }, network: { id: 'network', verdict: 'PASS', evidence: 'raw' } },
      preflight: { id: 'preflight', verdict: 'PASS', evidence: 'raw' }, network: [], network_summary: { failed_requests: 0 },
      readback: { value: { rows: index + 2 }, evidence_ref: raw },
    };
    const rec = write(`evidence/${id}/${state}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
    const evidence = [shot, raw, rec];
    for (const path of evidence) {
      manifest.push({ path, sha256: sha(readFileSync(join(dir, path))), evidence_type: path.endsWith('.png') ? 'gui-screenshot' : 'machine-receipt',
        metadata: { run_uuid: RUN_UUID, task_base: COMMIT, commit: COMMIT, case_id: id, state, captured_at: '2026-11-04T03:00:00.000Z' } });
    }
    for (const rule of RULES) {
      vision.push({ assertion_id: `${id}-${state}-${rule}`, case_id: id, state, rule, verdict: id === 'TC-02' && rule === 'C12' && variant !== 'clean' ? 'FAIL' : 'PASS',
        evidence_ref: shot, evidence_type: 'gui-screenshot' });
    }
    cases.push({
      id, title: `List ${id}`, requirement: 'REQ-1', requirements: ['REQ-1'], sourceRefs: ['SRC-1'], steps: 'Open the list.', expected: 'Rows are listed.',
      status: 'PASS', priority: 'P2', assignee: 'qa-agent', functionVerdict: 'PASS', uiVerdict: 'PASS', humanSummary: { function: 'Listed.', ui: 'Clean.' },
      machine: { rule: 'r3', selector: '#list' }, kind: 'static', states: [state], stateReceipts: [{ state, file: rec }],
      results: [{ round: 1, functionVerdict: 'PASS', uiVerdict: 'PASS', recordedAt: '2026-11-04T03:01:00.000Z', evidence }], evidence, comments: [], history: [],
    });
  }
  const data = {
    schemaVersion: 6, canonicalVersion: 'qa-board-teamwork/v2', boardKind: 'team-qa-board', rev: 1, boardId: 'r3-off', title: 'R3 flags-off fixture',
    boardCreated: '2026-11-04T01:00:00.000Z', language: 'en', deepCheck: 'available', app: 'r3-off', envDb: 'TEST / fixture', viewport: '320x200',
    runUuid: RUN_UUID, commit: COMMIT, build: 'build-7', env: 'TEST', db: 'fixture', role: 'qa-agent', testProfile: 'r3-off',
    evidenceManifest: manifest, vision: { version: 2, assertions: vision }, currentRound: 1,
    sourceItems: [{ id: 'SRC-1', kind: 'spec', sourceSystem: 'fixture', externalKey: 'REQ-1', title: 'Lists', origin: 'upstream' }],
    cases, defects: variant === 'clean' ? [] : [{ id: 'D-1', title: 'Off-theme colour', caseId: 'TC-02', rule: 'C12', sev: 'minor', status: 'TODO', priority: 'P3',
      assignee: 'dev', steps: 'Open the list.', expected: 'Theme colour.', actual: 'Off-theme colour.', evidence: [cases[1].evidence[0]], history: [], comments: [] }],
    rounds: [{ round: 1, startedAt: '2026-11-04T01:00:00.000Z', scope: 'R3 flags-off fixture' }],
    coverage: ['happy', 'boundary', 'empty', 'loading', 'error', 'auth-role', 'navigation', 'keyboard', 'responsive', 'dark-mode'].map((area) => ({ area, status: 'tick' })),
    untested: [], release: { verdict: variant === 'clean' ? 'GO' : 'NO-GO', risks: [] },
  };
  const file = join(dir, 'board.json');
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { file, data };
}

const out = {};
const requirement = { id: 'REQ-1', acceptance_ids: ['TC-01', 'TC-02'], risk_dimensions: [], evidence_contract: { allowed_types: ['gui-screenshot'] } };
const context = { kind: 'git', exactFinalSha: COMMIT, taskBase: COMMIT, activeGuiRequirements: [requirement], guiIds: ['REQ-1'],
  planById: new Map([['TC-01', { requirementId: 'REQ-1', data: {} }], ['TC-02', { requirementId: 'REQ-1', data: {} }]]) };
for (const variant of ['clean', 'findings']) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r3-off-')));
  const norm = (text) => String(text).split(dir).join('<DIR>').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TS>');
  try {
    const { file, data } = build(dir, variant);
    const v2 = checkGuiReleaseTruthV2({ data, boardPath: file, evidenceRoot: dir, context });
    const gate = spawnSync(process.execPath, [join(root, 'scripts/qa-gate.mjs'), file], { cwd: dir, encoding: 'utf8' });
    out[variant] = {
      canonical: validateCanonical(data).errors,
      v2: JSON.parse(norm(JSON.stringify({ issues: v2.issues, notes: v2.notes, atomicCoverage: v2.atomicCoverage, receiptEligible: v2.receiptEligible,
        computed: { functionVerdict: v2.computed.functionVerdict, uiVerdict: v2.computed.uiVerdict, cases: v2.computed.cases } }))),
      gate: { status: gate.status, stdout: norm(gate.stdout).split('\n').filter((line) => !/^Receipt/.test(line)), stderr: norm(gate.stderr).split('\n') },
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
