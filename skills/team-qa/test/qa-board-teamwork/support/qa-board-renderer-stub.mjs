#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.TEAMQA_TEST_CALL_LOG) {
  appendFileSync(process.env.TEAMQA_TEST_CALL_LOG, `${JSON.stringify({ tool: 'qa-gui-renderer', operation: args.includes('--verify-existing') ? 'verify-existing' : 'render', args })}\n`);
}

if (process.env.TEAMQA_TEST_RENDERER_FAIL) {
  process.stderr.write('verdict=fail code=TEMPLATE_TAMPERED\n');
  process.exit(1);
}

process.stdout.write('Verified: fixture.html\n');
if (!process.env.TEAMQA_TEST_RENDERER_NO_VERDICT) {
  process.stdout.write('verdict=pass template=task-board receipt=fixture.lock.json\n');
}
