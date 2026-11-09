#!/usr/bin/env node
// A fake `codex exec --json` for the adjudicator CLI engine (upgrade R2a tests): prompt on stdin, JSON events out.
import { appendFileSync } from 'node:fs';
import { respond } from './fake-engine.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('codex-cli 0.151.0\n'); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (process.env.TEAMQA_TEST_ADJUDICATOR_LOG) appendFileSync(process.env.TEAMQA_TEST_ADJUDICATOR_LOG, `${JSON.stringify({ harness: 'codex', argv, input, env: Object.keys(process.env).sort() })}\n`);
const text = respond(input, { mode: process.env.TEAMQA_TEST_ADJUDICATOR_MODE || 'honest' });
for (const event of [
  { type: 'thread.started', thread_id: 'fixture-codex-thread' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 20 } },
]) process.stdout.write(`${JSON.stringify(event)}\n`);
