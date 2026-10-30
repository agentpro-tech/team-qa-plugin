#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const operation = process.argv[2];
const names = {
  probe: 'TEAMQA_NOTION_PROBE_CMD',
  publish: 'TEAMQA_NOTION_PUBLISH_CMD',
  readback: 'TEAMQA_NOTION_READBACK_CMD',
};
const envName = names[operation];
if (!envName) {
  console.error(`NOTION_OPERATION_UNKNOWN ${operation ?? ''}`);
  process.exit(2);
}
const raw = process.env[envName];
if (!raw) {
  console.error('NOTION_UNAVAILABLE');
  process.exit(operation === 'probe' ? 9 : 5);
}
let command;
try {
  command = JSON.parse(raw);
} catch {
  console.error(`${envName}_INVALID`);
  process.exit(5);
}
if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string')) {
  console.error(`${envName}_INVALID`);
  process.exit(5);
}
const result = spawnSync(command[0], command.slice(1), {
  encoding: 'utf8',
  timeout: 30_000,
  env: process.env,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(String(result.error.message ?? result.error));
process.exit(result.status ?? 1);
