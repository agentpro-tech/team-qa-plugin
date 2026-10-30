#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.env.TEAMQA_TEST_CALL_LOG) appendFileSync(process.env.TEAMQA_TEST_CALL_LOG, `${JSON.stringify({ tool: "open", args: process.argv.slice(2) })}\n`);
