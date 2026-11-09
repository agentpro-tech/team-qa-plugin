#!/usr/bin/env node
// A fake `claude -p --output-format stream-json` for the adjudicator CLI engine (upgrade R2a tests). It reads the
// prompt from stdin, logs argv and stdin when TEAMQA_TEST_ADJUDICATOR_LOG is set, and answers with the fake engine.
import { appendFileSync } from 'node:fs';
import { respond } from './fake-engine.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('2.1.284 (Claude Code)\n'); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (process.env.TEAMQA_TEST_ADJUDICATOR_LOG) appendFileSync(process.env.TEAMQA_TEST_ADJUDICATOR_LOG, `${JSON.stringify({ harness: 'claude', argv, input, env: Object.keys(process.env).sort() })}\n`);
const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const session = value('--session-id'), model = value('--model');
const text = respond(input, { mode: process.env.TEAMQA_TEST_ADJUDICATOR_MODE || 'honest' });
for (const event of [
  { type: 'system', subtype: 'init', session_id: session, model },
  { type: 'assistant', session_id: session, message: { role: 'assistant', model, content: [{ type: 'text', text }] } },
  { type: 'result', subtype: 'success', session_id: session, result: text, total_cost_usd: 0.01, duration_ms: 1200, usage: { input_tokens: 10, output_tokens: 20 } },
]) process.stdout.write(`${JSON.stringify(event)}\n`);
