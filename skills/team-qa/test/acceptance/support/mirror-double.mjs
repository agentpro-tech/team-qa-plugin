import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const operation = process.argv[2];
const statePath = join(process.cwd(), '.mirror-state.json');

if (operation === 'probe-fail') {
  console.error('NOTION_UNAVAILABLE');
  process.exit(9);
}

if (operation === 'probe-pass') {
  console.log('{"available":true}');
  process.exit(0);
}

if (operation === 'publish') {
  const payload = process.env.TEAMQA_MIRROR_PAYLOAD;
  if (!payload) {
    console.error('MIRROR_PAYLOAD_MISSING');
    process.exit(2);
  }
  JSON.parse(payload);
  writeFileSync(statePath, `${payload}\n`, 'utf8');
  console.log('{"published":true}');
  process.exit(0);
}

if (operation === 'readback' || operation === 'readback-mismatch') {
  if (!existsSync(statePath)) {
    console.error('MIRROR_STATE_MISSING');
    process.exit(2);
  }
  const payload = JSON.parse(readFileSync(statePath, 'utf8'));
  if (operation === 'readback-mismatch') payload.plan_sha256 = '0'.repeat(64);
  console.log(JSON.stringify(payload));
  process.exit(0);
}

console.error(`MIRROR_OPERATION_UNKNOWN ${operation ?? ''}`);
process.exit(2);
