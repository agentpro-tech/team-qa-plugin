#!/usr/bin/env node
const skill = process.argv[2] || 'child';
process.stderr.write(`${skill} canary rejected invalid fixture input\n`);
process.exit(1);
