import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL("../", import.meta.url));
const qaTool = join(root, "test/qa-board-teamwork/support/qa-board-tool-stub.mjs");
const docTool = join(root, "test/qa-board-teamwork/support/doc-colab-stub.py");
const notionTool = join(root, "test/qa-board-teamwork/support/notion-board-stub.mjs");
const openTool = join(root, "test/qa-board-teamwork/support/open-stub.mjs");
const rendererTool = join(root, "test/qa-board-teamwork/support/doc-colab-renderer-stub.mjs");
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "teamqa-board-"));
  const log = join(dir, "calls.jsonl");
  const board = join(dir, "qa-board.json");
  const candidate = join(dir, 'candidate');
  cpSync(join(root, 'scripts'), join(candidate, 'scripts'), { recursive: true });
  cpSync(join(root, 'schemas'), join(candidate, 'schemas'), { recursive: true });
  writeFileSync(join(candidate, 'scripts/lib/board-quality.mjs'), readFileSync(join(root, 'test/qa-board-teamwork/support/board-quality-fixture.mjs')));
  const cli = join(candidate, 'scripts/teamqa.mjs');
  writeFileSync(board, `${JSON.stringify({ schemaVersion: 4, boardKind: "team-qa-board", boardId: "tq-test", title: "QA", revision: 1, metadata: {}, cases: [], defects: [], rounds: [], coverage: [], untested: [], release: {}, history: [] })}\n`);
  const qualityReview = join(dir, 'quality-review.fixture.json');
  writeFileSync(qualityReview, JSON.stringify({ fixture: 'board-quality-cli-contract-test', board_sha256: sha256File(board) }));
  return { dir, log, board, cli, qualityReview, html: join(dir, "index.html"), change: join(dir, "change.json"), snapshot: join(dir, "notion.json") };
}

function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function quality(p) { return ['--quality-review', p.qualityReview]; }
function refreshReview(p) { writeFileSync(p.qualityReview, JSON.stringify({ fixture: 'board-quality-cli-contract-test', board_sha256: sha256File(p.board) })); }

function run(paths, args, extraEnv = {}) {
  return spawnSync(process.execPath, [paths.cli, ...args], {
    cwd: paths.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      TEAMQA_QA_GUI_BOARD_TOOL: qaTool,
      TEAMQA_QA_GUI_BOARD_RENDERER: rendererTool,
      TEAMQA_DOC_COLAB_SCRIPT: docTool,
      TEAMQA_NOTION_BOARD_ADAPTER: notionTool,
      TEAMQA_OPEN_CMD: JSON.stringify([process.execPath, openTool]),
      TEAMQA_TEST_CALL_LOG: paths.log,
      ...extraEnv,
    },
  });
}

function calls(paths) {
  return readFileSync(paths.log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("Team QA board init delegates canonical creation to qa-gui", () => {
  const p = setup();
  const result = run(p, ["board", "init", "--run", "tq-test", "--title", "Sample Shop QA", "--out", p.board]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(calls(p)[0].operation, "init");
});

test("Team QA board init passes QA GUI evidence policy v1 through, and refuses another value", () => {
  const p = setup();
  const result = run(p, ["board", "init", "--run", "tq-test", "--title", "Sample Shop QA", "--out", p.board, "--evidence-policy", "1"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const init = calls(p).find((item) => item.operation === "init");
  assert.deepEqual(init.args.slice(init.args.indexOf("--evidence-policy"), init.args.indexOf("--evidence-policy") + 2), ["--evidence-policy", "1"]);
  const refused = run(setup(), ["board", "init", "--run", "tq-test", "--title", "Sample Shop QA", "--out", p.board + ".2", "--evidence-policy", "2"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /BOARD_EVIDENCE_POLICY_INVALID/);
});

test("native render is default, gates before render and never calls Notion", () => {
  const p = setup();
  const result = run(p, ["board", "render", "--file", p.board, "--out", p.html, ...quality(p)]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const observed = calls(p);
  assert.deepEqual(observed.filter(item => item.tool === 'qa-gui' || item.tool === 'doc-colab').map((item) => item.tool), ["qa-gui", "doc-colab"]);
  assert.equal(observed.find(item => item.tool === 'qa-gui').operation, "validate");
  assert.ok(observed.findIndex(item => item.operation === 'verify-review') < observed.findIndex(item => item.tool === 'qa-gui'));
  assert.ok(observed.findIndex(item => item.operation === 'seal') > observed.findIndex(item => item.tool === 'doc-colab'));
  assert.match(readFileSync(p.html, "utf8"), /DOC_DATA_START/);
  assert.ok(readFileSync(p.html + '.quality.json', 'utf8').includes('doc-colab'));
});

test("native render survives script-like canonical text without weakening readback", () => {
  const p = setup();
  const board = JSON.parse(readFileSync(p.board, "utf8"));
  board.title = "Bug quote };<\/script><script>window.pwned=true<\/script>";
  writeFileSync(p.board, JSON.stringify(board));
  refreshReview(p);
  const result = run(p, ["board", "render", "--file", p.board, "--out", p.html, ...quality(p)]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = readFileSync(p.html, "utf8");
  assert.match(html, /<\\\/script>/);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
});

test('Space prepare seals the exact payload and page compare requires that payload receipt', () => {
  const p = setup(), capabilities = join(p.dir, 'capabilities.json'), payload = join(p.dir, 'page-payload.json'), snapshot = join(p.dir, 'page-readback.json'), map = join(p.dir, 'evidence-map.json'), wrongMap = join(p.dir, 'wrong-evidence-map.json');
  writeFileSync(capabilities, JSON.stringify({ space: { status: 'available', evidence: 'fixture probe' }, notion: { status: 'available', evidence: 'fixture probe' } }));
  writeFileSync(snapshot, JSON.stringify({ pageId: 'fixture-page' }));
  writeFileSync(map, JSON.stringify({ case: 'TC-001', source: 'SRC-001' }));
  writeFileSync(wrongMap, JSON.stringify({ case: 'TC-001', source: 'SRC-OTHER' }));
  const prepared = run(p, ['board', 'prepare', '--file', p.board, '--capabilities', capabilities, '--out', payload, '--evidence-map', map, ...quality(p)]);
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  assert.ok(readFileSync(payload + '.quality.json', 'utf8').includes('space'));
  const missingPayload = run(p, ['board', 'compare-page', '--file', p.board, '--snapshot', snapshot, '--out', join(p.dir, 'missing-receipt.json')]);
  assert.notEqual(missingPayload.status, 0);
  assert.match(missingPayload.stderr, /ARG_REQUIRED/);
  const compared = run(p, ['board', 'compare-page', '--file', p.board, '--snapshot', snapshot, '--payload', payload]);
  assert.notEqual(compared.status, 0);
  assert.match(compared.stderr, /ARG_REQUIRED/);
  const wrongProjection = run(p, ['board', 'compare-page', '--file', p.board, '--snapshot', snapshot, '--payload', payload, '--evidence-map', wrongMap]);
  assert.notEqual(wrongProjection.status, 0);
  assert.match(wrongProjection.stderr, /BOARD_PAGE_QUALITY_PROJECTION_MISMATCH/);
  const matchingProjection = run(p, ['board', 'compare-page', '--file', p.board, '--snapshot', snapshot, '--payload', payload, '--evidence-map', map]);
  assert.equal(matchingProjection.status, 0, matchingProjection.stderr || matchingProjection.stdout);
  assert.match(matchingProjection.stdout, /quality=verified/);
  const qualityEvents = calls(p).filter(item => item.tool === 'board-quality-fixture').map(item => item.operation);
  assert.ok(qualityEvents.includes('seal') && qualityEvents.includes('verify-delivery'));
});

test('board delivery requires a current authenticated review before render or external adapters', () => {
  const missing = setup();
  const noReview = run(missing, ['board', 'render', '--file', missing.board, '--out', missing.html]);
  assert.equal(noReview.status, 5);
  assert.match(noReview.stderr, /BOARD_QUALITY_REVIEW_REQUIRED/);
  assert.equal(existsSync(missing.log), false);

  const stale = setup();
  const changed = JSON.parse(readFileSync(stale.board, 'utf8')); changed.title = 'changed after review';
  writeFileSync(stale.board, JSON.stringify(changed));
  const staleReview = run(stale, ['board', 'render', '--file', stale.board, '--out', stale.html, ...quality(stale)]);
  assert.notEqual(staleReview.status, 0);
  assert.match(staleReview.stderr, /BOARD_QUALITY_REVIEW_UNVERIFIED/);
  assert.equal(existsSync(stale.log), false);
});

test("apply delegates to qa-gui, validates readback and keeps audit ownership outside board.jsonl", () => {
  const p = setup();
  writeFileSync(p.change, JSON.stringify({ entity: "defect", id: "DF-001", field: "status", to: "RETEST", actor: "dev", actorRole: "developer", at: "2026-08-11T03:00:00.000Z", fixEvidence: ["proof.png"], source: "native" }));
  const result = run(p, ["board", "apply", "--file", p.board, "--change", p.change, "--actor", "dev", "--actor-role", "developer"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const qaCalls = calls(p).filter((item) => item.tool === "qa-gui");
  assert.deepEqual(qaCalls.map((item) => item.operation), ["apply", "validate"]);
  assert.deepEqual(qaCalls[0].args.slice(-4), ["--actor", "dev", "--actor-role", "developer"]);
  assert.equal(readFileSync(p.board, "utf8").includes("board.jsonl"), false);
});

test("Notion sync is fail-closed unless explicitly selected", () => {
  const p = setup();
  writeFileSync(p.snapshot, JSON.stringify({ cases: [], defects: [] }));
  const denied = run(p, ["board", "sync", "--file", p.board, "--snapshot", p.snapshot, "--actor", "owner"]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /NOTION_OPT_IN_REQUIRED/);
  const allowed = run(p, ["board", "sync", "--file", p.board, "--snapshot", p.snapshot, "--actor", "owner", "--renderer", "notion"]);
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
  assert.deepEqual(calls(p).filter((item) => item.tool === "qa-gui").map((item) => item.operation), ["sync-notion", "validate"]);
});

test("Notion push gates probe, push, readback and exact compare", () => {
  const happy = setup();
  const ok = run(happy, ["board", "sync", "--file", happy.board, "--snapshot", happy.snapshot, "--actor", "owner", "--renderer", "notion", "--mode", "push", ...quality(happy)]);
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  assert.match(ok.stdout, /mismatches=0/);
  assert.deepEqual(calls(happy).filter(item => item.tool !== 'board-quality-fixture').map((item) => `${item.tool}:${item.operation}`), ["qa-gui:export-notion", "notion:probe", "notion:push", "notion:readback", "qa-gui:compare-notion"]);
  assert.ok(readFileSync(happy.snapshot + '.quality.json', 'utf8').includes('notion'));
  const qualityEvents = calls(happy).filter(item => item.tool === 'board-quality-fixture').map(item => item.operation);
  assert.ok(qualityEvents.includes('seal') && qualityEvents.filter(name => name === 'verify-delivery').length >= 2);

  const unavailable = setup();
  const probe = run(unavailable, ["board", "sync", "--file", unavailable.board, "--snapshot", unavailable.snapshot, "--actor", "owner", "--renderer", "notion", "--mode", "push", ...quality(unavailable)], { TEAMQA_TEST_NOTION_FAIL: "probe" });
  assert.equal(probe.status, 5);
  assert.match(probe.stderr, /NOTION_BOARD_UNAVAILABLE/);

  const failed = setup();
  const push = run(failed, ["board", "sync", "--file", failed.board, "--snapshot", failed.snapshot, "--actor", "owner", "--renderer", "notion", "--mode", "push", ...quality(failed)], { TEAMQA_TEST_NOTION_FAIL: "push" });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /NOTION_PUSH_FAILED/);

  const mismatched = setup();
  const compare = run(mismatched, ["board", "sync", "--file", mismatched.board, "--snapshot", mismatched.snapshot, "--actor", "owner", "--renderer", "notion", "--mode", "push", ...quality(mismatched)], { TEAMQA_TEST_NOTION_MISMATCH: "1" });
  assert.notEqual(compare.status, 0);
  assert.match(compare.stderr, /NOTION_COMPARE_FAILED/);
});

test("missing child dependency reports its exact path as ungraded", () => {
  const p = setup();
  const missing = join(p.dir, "missing-qa-board-tool.mjs");
  const result = run(p, ["board", "validate", "--file", p.board], { TEAMQA_QA_GUI_BOARD_TOOL: missing });
  assert.equal(result.status, 5);
  assert.match(result.stderr, /QA_GUI_BOARD_TOOL_UNAVAILABLE/);
  assert.match(result.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("board open launches only the explicit local artifact through a configurable opener", () => {
  const p = setup();
  writeFileSync(p.html, "<html>QA</html>");
  const result = run(p, ["board", "open", "--file", p.html]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const call = calls(p)[0];
  assert.equal(call.tool, "open");
  assert.deepEqual(call.args, [p.html]);
});

test('QA board open verifies the sealed canonical delivery before calling the opener', () => {
  const p = setup();
  const rendered = run(p, ['board', 'render', '--file', p.board, '--out', p.html, ...quality(p)]);
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  const opened = run(p, ['board', 'open', '--file', p.html, '--canonical', p.board], { TEAMQA_OPEN_CMD: JSON.stringify([process.execPath, openTool]) });
  assert.equal(opened.status, 0, opened.stderr || opened.stdout);
  appendFileSync(p.html, '<!-- stale after delivery seal -->');
  const blockedMarker = join(p.dir, 'blocked-open');
  const blocked = run(p, ['board', 'open', '--file', p.html, '--canonical', p.board], {
    TEAMQA_OPEN_CMD: JSON.stringify([process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1],"opened")', blockedMarker]),
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /BOARD_QUALITY_DELIVERY_STALE/);
  assert.equal(existsSync(blockedMarker), false);
  assert.ok(calls(p).some(item => item.tool === 'open'));
});

test("help exposes the complete board workflow", () => {
  const p = setup();
  const result = run(p, ["--help"]);
  assert.equal(result.status, 0);
  for (const action of ["init", "validate", "render", "apply", "sync", "open"]) assert.match(result.stdout, new RegExp(`board .*${action}`));
});
