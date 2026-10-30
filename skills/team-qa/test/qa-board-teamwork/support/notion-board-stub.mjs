#!/usr/bin/env node
import { appendFileSync, copyFileSync } from "node:fs";

const [operation, ...args] = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (process.env.TEAMQA_TEST_CALL_LOG) appendFileSync(process.env.TEAMQA_TEST_CALL_LOG, `${JSON.stringify({ tool: "notion", operation, args })}\n`);
if (process.env.TEAMQA_TEST_NOTION_FAIL === operation) {
  console.error(`NOTION_STUB_${operation.toUpperCase()}_FAILED`);
  process.exit(1);
}
if (operation === "readback") copyFileSync(process.env.TEAMQA_BOARD_SNAPSHOT, value("--out"));
else if (!["probe", "push"].includes(operation)) process.exit(2);
console.log(JSON.stringify({ ok: true, operation }));
