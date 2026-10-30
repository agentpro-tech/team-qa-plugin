#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const log = process.env.TEAMQA_TEST_CALL_LOG;
const argv = process.argv.slice(2);
if (log) appendFileSync(log, `${JSON.stringify({ harness: 'codex', argv })}\n`);
const modelArg = argv.findIndex(value => value === '--model' || value === '-m');
const model = modelArg >= 0 ? argv[modelArg + 1] : argv.find(value => /^(--model|-m)=/.test(value))?.split('=').slice(1).join('=');
const effortConfig = argv.join(' ').match(/model_reasoning_effort=["']?(low|medium|high|max)["']?/i);
const effortFlag = argv.findIndex(value => value === '--effort' || value === '--reasoning-effort');
const effort = effortConfig?.[1]?.toLowerCase() || (effortFlag >= 0 ? argv[effortFlag + 1] : null);
process.stdout.write(`${JSON.stringify({
  provider: 'openai',
  model,
  effort,
  session_id: 'fixture-codex-session-001',
  request: { model, reasoning: { effort } },
  fixture: true
})}\n`);
