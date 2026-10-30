#!/usr/bin/env node
// annotate-png.mjs — V8.2 CLI over the annotation renderer.
//
// The exit codes mirror the approved render oracle so a human running either one reads the same
// outcome: 64 for a usage error, 73 for an output that already exists, 1 for a render that failed.
// A refusal to overwrite is its own code because it is not a bug — it is the board protecting
// evidence somebody already produced.

import { renderAnnotatedPng } from './annotation-renderer.mjs';

const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 64, exists: 73 });

const USAGE = `usage: annotate-png.mjs --input CAPTURE.png --findings FINDINGS.json --output BOARD.png [--fonts DIR]

  --input     source capture, read only and never modified
  --findings  findings JSON (array, or an object with a "findings" array)
  --output    annotated board to create; an existing path is refused
  --fonts     directory holding NotoSans-Regular.ttf and NotoSans-Bold.ttf
              (defaults to the bundled Noto Sans pack)`;

const FLAGS = Object.freeze({
  '--input': 'inputPath',
  '--findings': 'findingsPath',
  '--output': 'outputPath',
  '--fonts': 'fontDirectory',
});

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') return { help: true };
    const key = FLAGS[flag];
    if (!key) return { error: `unknown argument: ${flag}` };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` };
    options[key] = value;
    index += 1;
  }
  for (const required of ['--input', '--findings', '--output']) {
    if (!options[FLAGS[required]]) return { error: `missing ${required}` };
  }
  return { options };
}

const { help, error, options } = parseArgs(process.argv.slice(2));
if (help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(EXIT.ok);
}
if (error) {
  process.stderr.write(`${error}\n${USAGE}\n`);
  process.exit(EXIT.usage);
}

try {
  const receipt = await renderAnnotatedPng(options);
  // A receipt on stdout, so the caller records what was drawn instead of trusting an exit code.
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exit(EXIT.ok);
} catch (renderError) {
  const message = renderError?.message ?? String(renderError);
  process.stderr.write(`${message}\n`);
  process.exit(/overwrite/i.test(message) ? EXIT.exists : EXIT.failed);
}
