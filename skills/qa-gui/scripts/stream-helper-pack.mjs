#!/usr/bin/env node
// Writes QA GUI's stream detector helper pack (scripts/lib/stream-helpers.pack.json, dragon/helper-pack/v1): the page
// helper bodies a Team QA GUI executor defines in Dragon by path and SHA-256 (helpersDefine {pack}). Run it after a
// helper body changes; test/review-fixes-r2.test.mjs keeps the shipped file equal to what this writes.
//   node scripts/stream-helper-pack.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { HELPER_PACK_SHA256, helperPack, helperPackText } from './lib/stream-detectors.mjs';

const { path } = helperPack();
const text = helperPackText();
if (process.argv.includes('--check')) {
  let current = null;
  try { current = readFileSync(path, 'utf8'); } catch { current = null; }
  if (current !== text) { console.error(`stale helper pack: ${path} (run node scripts/stream-helper-pack.mjs)`); process.exit(1); }
  console.log(`helper pack ok sha256=${HELPER_PACK_SHA256}`);
} else {
  writeFileSync(path, text);
  console.log(`wrote ${path} sha256=${HELPER_PACK_SHA256}`);
}
