#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const log = process.env.TEAMQA_TEST_CALL_LOG;
const argv = process.argv.slice(2);
if (log) appendFileSync(log, `${JSON.stringify({ harness: 'claude', argv })}\n`);
const modelArg = argv.findIndex(value => value === '--model' || value === '-m');
const model = modelArg >= 0 ? argv[modelArg + 1] : argv.find(value => /^(--model|-m)=/.test(value))?.split('=').slice(1).join('=');
const effortFlag = argv.findIndex(value => value === '--effort' || value === '--reasoning-effort');
const effort = effortFlag >= 0 ? argv[effortFlag + 1] : argv.find(value => /^(--effort|--reasoning-effort)=/.test(value))?.split('=').at(-1);
process.stdout.write(`${JSON.stringify({
  provider: 'anthropic',
  model,
  effort,
  session_id: 'fixture-claude-session-001',
  request: { model, output_config: { effort } },
  fixture: true
})}\n`);
