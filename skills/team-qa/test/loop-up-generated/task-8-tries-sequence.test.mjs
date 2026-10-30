import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const signalId = "RED-TQ-TRIES-SEQUENCE-001";

test(`${signalId}: requires attempts, timing and timeout`, () => {
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...env } = process.env;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-name-pattern",
      signalId,
      "test/loop-up-red/teamqa-dogfood-red.mjs",
    ],
    { cwd: process.cwd(), encoding: "utf8", env },
  );

  assert.equal(
    result.status,
    0,
    `Frozen contract ${signalId} is still RED.\n${result.stdout}${result.stderr}`,
  );
});
