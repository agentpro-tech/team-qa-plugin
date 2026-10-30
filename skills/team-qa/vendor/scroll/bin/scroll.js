#!/usr/bin/env node
// SCROLL CLI entry point. Thin dispatcher → lib/scroll.js
import { run } from '../lib/scroll.js';

run(process.argv.slice(2)).catch((err) => {
  console.error(`\x1b[31m✖\x1b[0m ${err.message}`);
  process.exit(1);
});
