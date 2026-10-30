#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { verifyBoardDelivery } from '../lib/board-quality.mjs';

function die(code, message) {
  console.error(message);
  process.exit(code);
}

const operation = process.argv[2];
const names = {
  probe: 'TEAMQA_NOTION_BOARD_PROBE_CMD',
  push: 'TEAMQA_NOTION_BOARD_PUSH_CMD',
  readback: 'TEAMQA_NOTION_BOARD_READBACK_CMD',
};
const envName = names[operation];
if (!envName) die(2, `NOTION_BOARD_OPERATION_UNKNOWN ${operation ?? ''}`);
if (operation === 'push') {
  const file = process.env.TEAMQA_BOARD_PATH;
  const artifactPath = process.env.TEAMQA_BOARD_SNAPSHOT;
  if (!file || !artifactPath) die(5, 'NOTION_BOARD_QUALITY_INPUT_REQUIRED');
  try { verifyBoardDelivery({ file, artifactPath, renderer: 'notion' }); }
  catch (error) { die(5, `NOTION_BOARD_QUALITY_UNVERIFIED ${error?.code || error?.message || 'unknown'}`); }
}
const raw = process.env[envName];
if (!raw) die(operation === 'probe' ? 9 : 5, 'NOTION_BOARD_UNAVAILABLE');
let command;
try { command = JSON.parse(raw); }
catch { die(5, `${envName}_INVALID`); }
if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string')) die(5, `${envName}_INVALID`);
const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 60_000, env: process.env });
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.status !== 0 || result.signal) die(5, result.error?.message ?? `NOTION_BOARD_COMMAND_FAILED exit=${result.status}`);
if (operation === 'readback') {
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { die(5, 'NOTION_BOARD_READBACK_INVALID'); }
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : null;
  if (!out) die(2, 'NOTION_BOARD_READBACK_OUT_REQUIRED');
  writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
if (result.stdout) process.stdout.write(result.stdout);
