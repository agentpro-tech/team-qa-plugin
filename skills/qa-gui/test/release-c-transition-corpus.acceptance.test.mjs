import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  verifyTransitionCorpus,
  verifyTransitionCorpusReceipt,
} from '../scripts/transition-corpus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/transition-corpus.mjs');
const roots = [];
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`);
};

function fixture(name = 'positive') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qa-gui-release-c-${name}-`));
  roots.push(root);
  const caseId = 'RC-QA-GUI-TRANSITIONS';
  const build = 'release-c-build-001';
  const states = ['draft', 'submitted', 'confirmed'];
  const evidenceManifest = [];
  const stateReceipts = [];
  for (const [index, state] of states.entries()) {
    const raw = `evidence/${state}.raw.json`;
    const shot = `evidence/${state}.png`;
    const receiptFile = `evidence/${state}.state.json`;
    write(path.join(root, raw), `${JSON.stringify({ state, observed: true })}\n`);
    write(path.join(root, shot), Buffer.from(`png-${state}-${index}`));
    const lifecycle = Object.fromEntries(
      ['before', 'action', 'network', 'readback', 'refresh', 'postcondition']
        .map((phase) => [phase, { verdict: 'PASS', evidence_ref: raw }]),
    );
    const receipt = {
      schema: 'qa-gui/state-receipt/v1',
      caseId,
      state,
      capturedAt: `2026-09-02T00:00:0${index}.000Z`,
      url: 'https://test.example.invalid/workflow',
      build,
      viewport: '1280x800',
      domHash: String(index + 1).repeat(64),
      dragon: {
        sessionId: 'release-c-session', actionId: `action-${state}`,
        browserInstanceId: 'browser-1', tabId: 'tab-1', innerOk: true,
      },
      screenshot: { path: shot, sha256: sha256(fs.readFileSync(path.join(root, shot))) },
      function: {
        verdict: 'PASS',
        assertions: [{ requirement_id: 'REQ-STATE-MACHINE', verdict: 'PASS', evidence_ref: raw }],
      },
      ui: {
        verdict: 'PASS',
        uiSanity: { id: 'ui-sanity', verdict: 'PASS', evidence: 'raw ui-sanity result' },
        a11y: { id: 'a11y', verdict: 'PASS', evidence: 'raw accessibility result' },
        console: { id: 'console', verdict: 'PASS', evidence: 'raw console result' },
        network: { id: 'network', verdict: 'PASS', evidence: 'raw network result' },
      },
      preflight: { id: 'preflight', verdict: 'PASS', evidence: 'raw preflight result' },
      network: [],
      readback: { value: { state }, evidence_ref: raw },
      lifecycle,
    };
    write(path.join(root, receiptFile), receipt);
    evidenceManifest.push(
      { path: raw, sha256: sha256(fs.readFileSync(path.join(root, raw))) },
      { path: shot, sha256: receipt.screenshot.sha256 },
      { path: receiptFile, sha256: sha256(fs.readFileSync(path.join(root, receiptFile))) },
    );
    stateReceipts.push({ state, file: receiptFile, sha256: evidenceManifest.at(-1).sha256 });
  }
  const corpus = {
    schema: 'qa-gui/transition-corpus/v1',
    registry_sha256: 'a'.repeat(64),
    incident_id: 'INC-SAMPLE-PARTA',
    case_id: caseId,
    machine_id: 'release-truth-workflow',
    build,
    machine: {
      initial_state: 'draft',
      states,
      transitions: [
        { id: 't-submit', from: 'draft', action: 'submit', to: 'submitted' },
        { id: 't-confirm', from: 'submitted', action: 'confirm', to: 'confirmed' },
      ],
    },
    state_receipts: stateReceipts,
    transition_runs: [
      { transition_id: 't-submit', from_receipt: 'evidence/draft.state.json', to_receipt: 'evidence/submitted.state.json' },
      { transition_id: 't-confirm', from_receipt: 'evidence/submitted.state.json', to_receipt: 'evidence/confirmed.state.json' },
    ],
    evidence_manifest: evidenceManifest,
  };
  const corpusPath = path.join(root, 'transition-corpus.json');
  write(corpusPath, corpus);
  return { root, corpus, corpusPath };
}

test('C2 positive: every state and transition has case-bound lifecycle evidence', () => {
  const f = fixture();
  const receipt = verifyTransitionCorpus({ corpusPath: f.corpusPath });
  assert.equal(receipt.schema, 'qa-gui/transition-corpus-receipt/v1');
  assert.equal(receipt.semantic_verdict, 'PASS');
  assert.equal(receipt.state_count, 3);
  assert.equal(receipt.transition_total, 2);
  assert.equal(receipt.transition_covered, 2);
  assert.equal(receipt.coverage_pct, 100);
  assert.deepEqual(verifyTransitionCorpusReceipt(receipt, { corpusBytes: fs.readFileSync(f.corpusPath) }), receipt);
});

test('C2 mutation: a missing required transition is killed', () => {
  const f = fixture('missing-transition');
  f.corpus.transition_runs.pop();
  write(f.corpusPath, f.corpus);
  assert.throws(() => verifyTransitionCorpus({ corpusPath: f.corpusPath }), /TRANSITION_COVERAGE_MISSING:t-confirm/);
});

test('C2 mutation: a foreign case state receipt is killed', () => {
  const f = fixture('foreign-case');
  const file = path.join(f.root, 'evidence/submitted.state.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  receipt.caseId = 'FOREIGN-CASE';
  write(file, receipt);
  const entry = f.corpus.state_receipts.find((item) => item.state === 'submitted');
  entry.sha256 = sha256(fs.readFileSync(file));
  const manifest = f.corpus.evidence_manifest.find((item) => item.path === entry.file);
  manifest.sha256 = entry.sha256;
  write(f.corpusPath, f.corpus);
  assert.throws(() => verifyTransitionCorpus({ corpusPath: f.corpusPath }), /STATE_RECEIPT_CASE:submitted/);
});

test('C2 mutation: an incomplete lifecycle is killed', () => {
  const f = fixture('lifecycle');
  const file = path.join(f.root, 'evidence/submitted.state.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete receipt.lifecycle.refresh;
  write(file, receipt);
  const entry = f.corpus.state_receipts.find((item) => item.state === 'submitted');
  entry.sha256 = sha256(fs.readFileSync(file));
  f.corpus.evidence_manifest.find((item) => item.path === entry.file).sha256 = entry.sha256;
  write(f.corpusPath, f.corpus);
  assert.throws(() => verifyTransitionCorpus({ corpusPath: f.corpusPath }), /LIFECYCLE_PHASE_MISSING:submitted:refresh/);
});

test('C2 mutation: reused screenshot bytes require explicit equivalent state proof', () => {
  const f = fixture('screenshot-reuse');
  const draftShot = fs.readFileSync(path.join(f.root, 'evidence/draft.png'));
  write(path.join(f.root, 'evidence/submitted.png'), draftShot);
  const file = path.join(f.root, 'evidence/submitted.state.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  receipt.screenshot.sha256 = sha256(draftShot);
  write(file, receipt);
  for (const entry of f.corpus.evidence_manifest) {
    if (entry.path === 'evidence/submitted.png' || entry.path === 'evidence/submitted.state.json') {
      entry.sha256 = sha256(fs.readFileSync(path.join(f.root, entry.path)));
    }
  }
  f.corpus.state_receipts.find((item) => item.state === 'submitted').sha256 = sha256(fs.readFileSync(file));
  write(f.corpusPath, f.corpus);
  assert.throws(() => verifyTransitionCorpus({ corpusPath: f.corpusPath }), /SCREENSHOT_REUSE:submitted/);
});

test('C2 mutation: transition evidence must bind the declared from and to receipts', () => {
  const f = fixture('transition-binding');
  f.corpus.transition_runs[0].to_receipt = 'evidence/confirmed.state.json';
  write(f.corpusPath, f.corpus);
  assert.throws(() => verifyTransitionCorpus({ corpusPath: f.corpusPath }), /TRANSITION_RUN_BINDING:t-submit/);
});

test('C2 CLI writes and independently reads back the sealed transition receipt', () => {
  const f = fixture('cli');
  const out = path.join(f.root, 'transition.receipt.json');
  const result = spawnSync(process.execPath, [CLI, '--corpus', f.corpusPath, '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /TRANSITION_CORPUS_PASS/);
  const receipt = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(receipt.coverage_pct, 100);
});

