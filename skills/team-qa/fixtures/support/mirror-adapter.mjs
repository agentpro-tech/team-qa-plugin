import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const operation = process.argv[2];
const state = join(process.cwd(), '.teamqa-fixture-mirror.json');
if (operation === 'probe-fail') {
  console.error('NOTION_UNAVAILABLE');
  process.exit(9);
}
if (operation === 'publish') {
  const payload = process.env.TEAMQA_MIRROR_PAYLOAD;
  if (!payload) process.exit(2);
  JSON.parse(payload);
  writeFileSync(state, `${payload}\n`, 'utf8');
  JSON.parse(readFileSync(state, 'utf8'));
  console.log(JSON.stringify({ published: true }));
  process.exit(0);
}
if (operation === 'readback') {
  if (!existsSync(state)) process.exit(2);
  console.log(JSON.stringify(JSON.parse(readFileSync(state, 'utf8'))));
  process.exit(0);
}
console.error(`MIRROR_OPERATION_UNKNOWN ${operation ?? ''}`);
process.exit(2);
