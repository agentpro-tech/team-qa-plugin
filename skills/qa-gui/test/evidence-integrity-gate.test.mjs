import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_APPROVER_ENV, BASELINE_PENDING, baselineApproverError, declaresBaselinePending } from "../scripts/teamwork/board-gates.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = resolve(ROOT, "scripts/qa-gate.mjs");
const PNG = resolve(ROOT, "qa-evidence/fixture-a/round-1/1280x800/after-load.png");
const VISUAL = "C10 PASS · C11 PASS · C12 PASS · C13 PASS · C14 PASS · C15 WAIVE · C16 PASS";
const coverage = ["happy","boundary","empty","loading","error","auth-role","navigation","keyboard","responsive","dark-mode"].map((area) => ({ area, status: area === "dark-mode" ? "waive" : "tick" }));

function makeCase(id, states, kind = "static", evidence = []) {
  return {
    id, desc: id, req: `REQ-${id}`, round: 1, steps: "exercise state", expected: "verified",
    status: "PASS", kind, fn: "PASS", ui: "PASS", visual: VISUAL, states,
    evidence, comments: [], sweeps: states.map((state) => ({ state, uiSanity: "PASS", console: "clean" })),
  };
}

function makeBoard(cases) {
  return {
    schemaVersion: 3, boardId: "integrity-red", title: "Evidence integrity RED", app: "integrity-red",
    envDb: "TEST", build: "abc123", viewport: "1280x800", boardCreated: "2026-08-01T00:00:00Z",
    charter: "Reject evidence reuse", obstacles: [], outlook: ["baseline pending owner approval"],
    untested: [{ area: "dark-mode", reason: "No dark theme" }],
    rounds: [{ n: 1, date: "2026-08-11", agent: "CASE", scope: "integrity", delta: "RED" }],
    cases, defects: [], release: { verdict: "GO", risks: [], by: "CASE", ts: "2026-08-11T00:00:00Z" },
    coverage,
    vision: { version: 1, app: "integrity-red", viewport: "1280x800", baselineManifest: "qa-evidence/integrity-red/baseline/baseline-manifest.json" },
  };
}

function fixture(cases, setup) {
  const dir = mkdtempSync(resolve(tmpdir(), "qa-gui-integrity-"));
  const board = resolve(dir, "QA-Board.html");
  setup(dir);
  writeFileSync(board, `<!-- QA_DATA_START --><script>window.QA_DATA = ${JSON.stringify(makeBoard(cases))};</script><!-- QA_DATA_END -->`);
  return board;
}

function screenshot(dir, state) {
  const path = resolve(dir, `qa-evidence/integrity-red/round-1/1280x800/${state}.png`);
  mkdirSync(dirname(path), { recursive: true });
  cpSync(PNG, path);
  return `qa-evidence/integrity-red/round-1/1280x800/${state}.png`;
}

function rejected(board, pattern) {
  const result = spawnSync(process.execPath, [GATE, board], { encoding: "utf8" });
  assert.notEqual(result.status, 0, `gate incorrectly accepted fixture:\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

function writeReceipt(dir, testCase, state, shot, lifecycleVerdict = "PASS") {
  const rel = `qa-evidence/integrity-red/round-1/receipts/${testCase.id}-${state}.json`;
  const path = resolve(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  const assertion = (id) => ({ id, verdict: "PASS", evidence: `${id} raw result` });
  const body = {
    schema: "qa-gui/state-receipt/v1", caseId: testCase.id, state, capturedAt: "2026-08-11T00:00:00Z",
    url: "https://test.example.invalid/qc", build: "abc123", viewport: "1280x800",
    dragon: { sessionId: "session-1", actionId: `action-${state}`, browserInstanceId: "browser-1", tabId: "tab-1", innerOk: true },
    screenshot: { path: shot, sha256: createHash("sha256").update(readFileSync(resolve(dir, shot))).digest("hex") },
    function: { verdict: "PASS", assertions: [assertion("dom-postcondition")] },
    ui: { verdict: "PASS", uiSanity: assertion("ui-sanity"), a11y: assertion("a11y"), console: assertion("console"), network: assertion("network") },
    preflight: assertion("preflight"),
  };
  if (testCase.kind === "behavioral") {
    body.lifecycle = Object.fromEntries(["before", "action", "network", "readback", "refresh", "postcondition"].map((phase) => [phase, { id: phase, verdict: phase === "postcondition" ? lifecycleVerdict : "PASS", evidence: `${phase} raw result` }]));
  }
  writeFileSync(path, JSON.stringify(body));
  testCase.stateReceipts = [{ state, file: rel }];
  testCase.evidence.push(rel);
}

test("retires schema v3 before grading duplicate screenshot evidence", () => {
  let cases;
  const board = fixture([], (dir) => {
    const a = screenshot(dir, "before");
    const b = screenshot(dir, "after");
    cases = [makeCase("TC-DUP", ["before", "after"], "static", [a, b])];
  });
  writeFileSync(board, `<!-- QA_DATA_START --><script>window.QA_DATA = ${JSON.stringify(makeBoard(cases))};</script><!-- QA_DATA_END -->`);
  rejected(board, /schemaVersion 3 is retired/i);
});

test("retires schema v3 before grading missing machine receipts", () => {
  let cases;
  const board = fixture([], (dir) => {
    const shot = screenshot(dir, "after-load");
    cases = [makeCase("TC-RECEIPT", ["after-load"], "static", [shot])];
  });
  writeFileSync(board, `<!-- QA_DATA_START --><script>window.QA_DATA = ${JSON.stringify(makeBoard(cases))};</script><!-- QA_DATA_END -->`);
  rejected(board, /schemaVersion 3 is retired/i);
});

test("retires schema v3 before grading reused behavioral recordings", () => {
  let cases;
  const board = fixture([], (dir) => {
    const a = screenshot(dir, "case-a");
    const b = screenshot(dir, "case-b");
    const recording = "qa-evidence/integrity-red/round-1/videos/full-run.mp4";
    const videoPath = resolve(dir, recording);
    mkdirSync(dirname(videoPath), { recursive: true });
    writeFileSync(videoPath, Buffer.alloc(60 * 1024, 1));
    cases = [
      makeCase("TC-VIDEO-A", ["case-a"], "behavioral", [a, recording]),
      makeCase("TC-VIDEO-B", ["case-b"], "behavioral", [b, recording]),
    ];
  });
  writeFileSync(board, `<!-- QA_DATA_START --><script>window.QA_DATA = ${JSON.stringify(makeBoard(cases))};</script><!-- QA_DATA_END -->`);
  rejected(board, /schemaVersion 3 is retired/i);
});

test("does not grandfather a formerly valid schema v3 machine receipt", () => {
  let cases;
  const board = fixture([], (dir) => {
    const shot = screenshot(dir, "verified");
    const c = makeCase("TC-VALID", ["verified"], "static", [shot]);
    writeReceipt(dir, c, "verified", shot);
    cases = [c];
  });
  writeFileSync(board, `<!-- QA_DATA_START --><script>window.QA_DATA = ${JSON.stringify(makeBoard(cases))};</script><!-- QA_DATA_END -->`);
  const result = spawnSync(process.execPath, [GATE, board], { encoding: "utf8" });
  assert.equal(result.status, 20, result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, /schemaVersion 3 is retired/i);
  assert.doesNotMatch(result.stdout, /QA gate: PASS/);
});

test("retires schema v3 before grading a failed lifecycle postcondition", () => {
  let cases;
  const board = fixture([], (dir) => {
    const shot = screenshot(dir, "after-write");
    const recording = "qa-evidence/integrity-red/round-1/videos/write.mp4";
    const videoPath = resolve(dir, recording);
    mkdirSync(dirname(videoPath), { recursive: true });
    writeFileSync(videoPath, Buffer.alloc(60 * 1024, 1));
    const c = makeCase("TC-WRITE", ["after-write"], "behavioral", [shot, recording]);
    c.recordingSegments = [{ file: recording, startMs: 0, endMs: 1000 }];
    writeReceipt(dir, c, "after-write", shot, "FAIL");
    cases = [c];
  });
  writeFileSync(board, `<!-- QA_DATA_START --><script>window.QA_DATA = ${JSON.stringify(makeBoard(cases))};</script><!-- QA_DATA_END -->`);
  rejected(board, /schemaVersion 3 is retired/i);
});

test("baseline approval refuses an empty, padded, overlong or missing approvedBy", () => {
  for (const approvedBy of ["", "   ", " Jane Doe", "Jane Doe ", "x".repeat(121), undefined, null, 7]) {
    assert.equal(baselineApproverError(approvedBy, {}), "approvedBy must name the approving owner", JSON.stringify(approvedBy));
  }
});

test("baseline approval accepts any named approver when QA_GUI_BASELINE_APPROVER is unset", () => {
  for (const approvedBy of ["Jane Doe", "release-owner", "x".repeat(120)]) {
    assert.equal(baselineApproverError(approvedBy, {}), null, approvedBy);
  }
});

test("baseline approval refuses any approver other than QA_GUI_BASELINE_APPROVER", () => {
  const env = { [BASELINE_APPROVER_ENV]: "Jane Doe" };
  for (const approvedBy of ["Alex Kim", "jane doe", "Jane Doe."]) {
    assert.equal(baselineApproverError(approvedBy, env), "approvedBy must be Jane Doe", approvedBy);
  }
  assert.equal(baselineApproverError("", env), "approvedBy must name the approving owner");
});

test("baseline approval accepts exactly the QA_GUI_BASELINE_APPROVER value, read from the environment", () => {
  assert.equal(BASELINE_APPROVER_ENV, "QA_GUI_BASELINE_APPROVER");
  assert.equal(baselineApproverError("Jane Doe", { [BASELINE_APPROVER_ENV]: "Jane Doe" }), null);
  const previous = process.env[BASELINE_APPROVER_ENV];
  try {
    process.env[BASELINE_APPROVER_ENV] = "Jane Doe";
    assert.equal(baselineApproverError("Jane Doe"), null);
    assert.equal(baselineApproverError("Alex Kim"), "approvedBy must be Jane Doe");
  } finally {
    if (previous === undefined) delete process.env[BASELINE_APPROVER_ENV];
    else process.env[BASELINE_APPROVER_ENV] = previous;
  }
});

test("baseline pending outlook is the exact owner-neutral value; a person-named variant is not accepted", () => {
  assert.equal(BASELINE_PENDING, "baseline pending owner approval");
  assert.equal(declaresBaselinePending({ outlook: [BASELINE_PENDING] }), true);
  assert.equal(declaresBaselinePending({ untested: [{ area: "vision", reason: BASELINE_PENDING }] }), true);
  for (const value of ["baseline pending Jane approval", "Baseline pending owner approval", "baseline pending owner approval "]) {
    assert.equal(declaresBaselinePending({ outlook: [value] }), false, value);
  }
  const schema = JSON.parse(readFileSync(resolve(ROOT, "scripts/qa-board.schema.json"), "utf8"));
  assert.deepEqual(schema.properties.untested.items.anyOf[1].enum, [BASELINE_PENDING]);
});
