#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { validateCanonical } from './canonical.mjs';

function extractData(text) {
  const start = text.indexOf('QA_DATA_START');
  if (start < 0) return JSON.parse(text);
  const end = text.indexOf('QA_DATA_END', start + 1);
  const block = text.slice(start, end);
  const assignment = /window\.QA_DATA\s*=/.exec(block);
  if (!assignment) throw new Error('board: missing window.QA_DATA assignment');
  const after = block.slice(assignment.index + assignment[0].length).trim();
  const terminator = after.lastIndexOf(';');
  return JSON.parse((terminator >= 0 ? after.slice(0, terminator) : after).trim());
}

const path = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
if (!path) {
  process.stderr.write('usage: node scripts/teamwork/validate-canonical.mjs <canonical.json|board.html>\n');
  process.exit(2);
}

let data;
try {
  data = extractData(readFileSync(path, 'utf8'));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const deleteIndex = process.argv.indexOf('--delete');
if (deleteIndex >= 0) {
  const target = process.argv[deleteIndex + 1];
  if (!target) {
    process.stderr.write('--delete requires a dotted field path\n');
    process.exit(2);
  }
  const parts = target.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  const field = parts.pop();
  const parent = parts.reduce((value, key) => value?.[key], data);
  if (!parent || !Object.hasOwn(parent, field)) {
    process.stderr.write(`${target}: mutation target does not exist\n`);
    process.exit(2);
  }
  delete parent[field];
}

const result = validateCanonical(data);
if (!result.ok) {
  for (const error of result.errors) process.stderr.write(`${error.path}: ${error.message}\n`);
  process.exit(1);
}
process.stdout.write('Canonical QA data: PASS\n');
