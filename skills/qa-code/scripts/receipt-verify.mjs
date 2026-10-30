#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { validateQaReceiptStructure, verifyQaReceiptBindings } from './lib/release-receipt.mjs';

function usage(message = '') {
  process.stderr.write(`Usage: node scripts/receipt-verify.mjs --receipt <file> [--gate0 <file>] [--repo <git> --base <sha>] [--json <out>]\n${message ? `${message}\n` : ''}`);
}

function parse(argv) {
  const options = {};
  const allowed = new Set(['--receipt', '--gate0', '--repo', '--base', '--json']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!allowed.has(flag) || argv[index + 1] === undefined) throw new Error(`invalid flag or missing value: ${flag || '(empty)'}`);
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`repeated flag: ${flag}`);
    options[key] = argv[index + 1];
  }
  if (!options.receipt) throw new Error('missing --receipt');
  if (Boolean(options.repo) !== Boolean(options.base)) throw new Error('--repo and --base must be given together');
  return options;
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`${label}: ${error.message}`); }
}

function main() {
  let options;
  try { options = parse(process.argv.slice(2)); }
  catch (error) { usage(error.message); return 2; }
  let receipt;
  let gate0 = null;
  try {
    receipt = readJson(options.receipt, 'receipt');
    if (options.gate0) gate0 = readJson(options.gate0, 'gate0');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 20;
  }
  const structureErrors = validateQaReceiptStructure(receipt);
  if (structureErrors.length > 0) {
    const result = {
      schema: 'qa-code/receipt-verification/v1',
      ok: false,
      errors: structureErrors,
    };
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (options.json) writeFileSync(options.json, text);
    else process.stdout.write(text);
    return 20;
  }
  let errors;
  try {
    errors = verifyQaReceiptBindings(receipt, {
      gate0,
      gate0Path: options.gate0,
      repo: options.repo,
      base: options.base,
    });
  } catch (error) {
    errors = [error.message];
  }
  const result = {
    schema: 'qa-code/receipt-verification/v1',
    ok: errors.length === 0,
    errors,
    capabilities: receipt.schema === 'qa-code/receipt/v1'
      ? ['CAPABILITY_MISSING:release-truth-v2']
      : [],
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.json) writeFileSync(options.json, text);
  else process.stdout.write(text);
  return errors.length === 0 ? 0 : 1;
}

process.exitCode = main();
