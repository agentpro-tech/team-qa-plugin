#!/usr/bin/env node
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";

const [operation, ...args] = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
let emitted = false;
if (process.env.TEAMQA_TEST_CALL_LOG) appendFileSync(process.env.TEAMQA_TEST_CALL_LOG, `${JSON.stringify({ tool: "qa-gui", operation, args })}\n`);
if (operation === "init") {
  const seedPath = value("--source-seed");
  const seed = seedPath ? JSON.parse(readFileSync(seedPath, "utf8")) : { sourceItems: [], cases: [] };
  writeFileSync(value("--out"), `${JSON.stringify({
    schemaVersion: 6,
    canonicalVersion: "qa-board-teamwork/v2",
    boardKind: "team-qa-board",
    boardId: value("--board-id"),
    title: value("--title"),
    revision: 1,
    metadata: {},
    sourceItems: seed.sourceItems,
    cases: seed.cases.map((item) => ({ ...item, status: "TODO" })),
    defects: [], rounds: [], coverage: [], untested: [], release: {}, history: [],
  }, null, 2)}\n`);
} else if (operation === "apply" || operation === "sync-notion") {
  const source = value("--file");
  const output = value("--out") || source;
  if (source !== output) copyFileSync(source, output);
} else if (operation === "validate") {
  JSON.parse(readFileSync(value("--file"), "utf8"));
} else if (operation === "export-notion") {
  const board = JSON.parse(readFileSync(value("--file"), "utf8"));
  writeFileSync(value("--out"), JSON.stringify({ cases: board.cases ?? [], defects: board.defects ?? [] }));
} else if (operation === "export-page") {
  const board = JSON.parse(readFileSync(value("--file"), "utf8"));
  writeFileSync(value("--out"), JSON.stringify({ title: board.title, cases: board.cases ?? [], defects: board.defects ?? [] }));
} else if (operation === "compare-page") {
  console.log(JSON.stringify({ protocol: "qa-gui/page-readback/v1", operation, ok: true, matchPercent: 100, pageId: "fixture-page", url: "https://example.test/fixture-page", mismatches: [], seal: "a".repeat(64) }));
  emitted = true;
} else if (operation === "compare-notion") {
  const mismatches = process.env.TEAMQA_TEST_NOTION_MISMATCH ? [{ key: "defect:DF-001:status" }] : [];
  console.log(JSON.stringify({ ok: mismatches.length === 0, operation, mismatches }));
  emitted = true;
  if (mismatches.length) process.exitCode = 1;
} else {
  process.exitCode = 2;
}
if (!process.exitCode && !emitted) console.log(JSON.stringify({ ok: true, operation }));
