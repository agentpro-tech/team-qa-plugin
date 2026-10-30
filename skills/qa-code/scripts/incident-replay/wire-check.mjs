#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== '--build') {
  process.stderr.write('Usage: node scripts/incident-replay/wire-check.mjs --build <build-package.sh>\n');
  process.exit(2);
}

let source;
try { source = readFileSync(resolve(argv[1]), 'utf8'); }
catch (error) {
  process.stderr.write(`INCIDENT_REPLAY_WIRE_FAIL cannot read build gate: ${error.message}\n`);
  process.exit(1);
}

const required = [
  'scripts/incident-replay/wire-check.mjs',
  'scripts/incident-replay/release-truth.test.mjs',
  'scripts/incident-replay/session2.test.mjs',
  'scripts/incident-replay/session2-mutation.test.mjs',
  'INCIDENT_REPLAY_PASS',
  'scripts/escaped-defect/gate-wiring-detector.mjs',
  'test/release-c-gate-wiring.acceptance.test.mjs',
  'test/release-c-gate-wiring.mutation.test.mjs',
  'RELEASE_C_GATE_WIRING_PASS',
];
const missing = required.filter((marker) => !source.includes(marker));
if (missing.length > 0) {
  process.stderr.write(`INCIDENT_REPLAY_WIRE_FAIL missing marker: ${missing.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write('INCIDENT_REPLAY_WIRE_PASS\n');
