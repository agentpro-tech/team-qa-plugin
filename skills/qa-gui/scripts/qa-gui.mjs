#!/usr/bin/env node
// qa-gui evidence commands (upgrade R1f). Node built-ins only.
//   node scripts/qa-gui.mjs recording-manifest --dir <Dragon recording dir> --out <manifest.json>
//                                              [--video <assembled.mp4>] [--receipts <Dragon action receipts .json|.jsonl>]
//   node scripts/qa-gui.mjs evidence fit --in <capture.png> --out <evidence.png> [--max-width 1280]
//                                        [--masks <maskedRects.json> --viewport <WxH>]
//   node scripts/qa-gui.mjs app-map --log <exploration log .json> --out <app-map.json>
//   node scripts/qa-gui.mjs probe-cells --receipt <state receipt> --probe <probe receipt> --kind width-sweep|overlay-check --out <cells.json>
//   node scripts/qa-gui.mjs baseline propose|approve|list --store <approved-baselines.json> ...   (upgrade R3)
//   node scripts/qa-gui.mjs vision decide --store <approved-baselines.json> --png <state.png> ...  (upgrade R3)
//   node scripts/qa-gui.mjs probe classify --in <action.json>
//   node scripts/qa-gui.mjs probe build --in <trials.json> --out <probe.json>
//   node scripts/qa-gui.mjs probe grade --in <probe.json>
// Each prints one JSON line. `recording-manifest` writes qa-gui/recording-manifest/v1 (references/state-receipt-v1.md);
// `evidence fit` writes the downscaled PNG and prints the `screenshot.fit` record to store in the state receipt;
// `app-map` (R1b) writes qa-gui/app-map/v2 from an exploration log, an array of observations or {observations: [...]}
// (references/coverage-cells.md). Team QA reads that file as runs/<run_id>/app-map.json.
// `baseline` keeps the approved-baseline store (lib/baseline-store.mjs); `vision decide` prints the tier-0 vision by diff
// decision of one state (lib/vision-by-diff.mjs, references/speed-flags.md). `probe` (R1d) classifies an action, builds
// the transient probe receipt from its trials and grades it (lib/transient-probe.mjs, references/transient-rules.md).
// Exit codes: 0 done, 2 usage or input error.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isDirectExecution } from './lib/is-direct-execution.mjs';
import { buildRecordingManifest, fitPng, MAX_EVIDENCE_WIDTH, parseViewport } from './lib/evidence-quality.mjs';
import { buildAppMapV2 } from './loop6/app-map.mjs';
import { probeCells } from './lib/probes.mjs';
import { createHash } from 'node:crypto';
import { approveBaseline, emptyStore, proposeBaseline, readStore, storeErrors, writeStore } from './lib/baseline-store.mjs';
import { visionDiffDecision } from './lib/vision-by-diff.mjs';
import { buildTransientProbeReceipt, classifyAction, transientProbeVerdict } from './lib/transient-probe.mjs';

const USAGE = [
  'usage: node scripts/qa-gui.mjs recording-manifest --dir <recording dir> --out <manifest.json> [--video <mp4>] [--receipts <json|jsonl>]',
  '       node scripts/qa-gui.mjs evidence fit --in <capture.png> --out <evidence.png> [--max-width 1280] [--masks <rects.json> --viewport <WxH>]',
  '       node scripts/qa-gui.mjs app-map --log <exploration log .json> --out <app-map.json>',
  '       node scripts/qa-gui.mjs probe-cells --receipt <state receipt> --probe <probe receipt> --kind width-sweep|overlay-check --out <cells.json>',
  '       node scripts/qa-gui.mjs baseline propose --store <file> --png <png> --route <r> --state <s> --viewport <WxH> --build <b> --vision <C10-C16 json> [--mask <rects json>] [--source-run <id>] [--source-case <id>]',
  '       node scripts/qa-gui.mjs baseline approve --store <file> --route <r> --state <s> --viewport <WxH> --build <b> --sha256 <png sha> --by <owner>',
  '       node scripts/qa-gui.mjs baseline list --store <file>',
  '       node scripts/qa-gui.mjs vision decide --store <file> --png <png> --route <r> --state <s> --viewport <WxH> --build <b> [--sweep <{uiSanity,a11y} json>] [--captured-at <iso>] [--min-tier <0-3>]',
  '       node scripts/qa-gui.mjs probe classify --in <action.json>',
  '       node scripts/qa-gui.mjs probe build --in <{caseId,state,action,trials}.json> --out <probe.json>',
  '       node scripts/qa-gui.mjs probe grade --in <probe.json>',
].join('\n');
const KEY_FLAGS = ['--route', '--state', '--viewport', '--build'];
const keyOf = (o) => ({ route: o['--route'], state: o['--state'], viewport: o['--viewport'], build: o['--build'] });
const readJsonFile = (file) => JSON.parse(readFileSync(resolve(file), 'utf8'));

function parseFlags(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!allowed.includes(flag) || value === undefined || value.startsWith('--')) throw new Error(`invalid flag or missing value: ${flag ?? '(none)'}`);
    if (Object.hasOwn(options, flag)) throw new Error(`duplicate flag: ${flag}`);
    options[flag] = value;
  }
  return options;
}

function readReceipts(file) {
  const text = readFileSync(resolve(file), 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    try { return JSON.parse(text); } catch {}
  }
  return text.split('\n').filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`receipts line ${index + 1} is not JSON`); }
  });
}

function writeOut(file, bytes) {
  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return target;
}

export function run(argv) {
  const [command, ...rest] = argv;
  if (command === 'recording-manifest') {
    const o = parseFlags(rest, ['--dir', '--out', '--video', '--receipts']);
    if (!o['--dir'] || !o['--out']) throw new Error('--dir and --out are required');
    const manifest = buildRecordingManifest({
      dir: resolve(o['--dir']),
      video: o['--video'] ? readFileSync(resolve(o['--video'])) : null,
      receipts: o['--receipts'] ? readReceipts(o['--receipts']) : [],
    });
    const out = writeOut(o['--out'], `${JSON.stringify(manifest, null, 2)}\n`);
    return { ok: true, command, out, id: manifest.id, frames: manifest.frames.length, actions: manifest.actions.length,
      actionSource: manifest.actionSource, frameBytes: manifest.frameBytes, video: manifest.video ?? null };
  }
  if (command === 'evidence' && rest[0] === 'fit') {
    const o = parseFlags(rest.slice(1), ['--in', '--out', '--max-width', '--masks', '--viewport']);
    if (!o['--in'] || !o['--out']) throw new Error('--in and --out are required');
    if (resolve(o['--in']) === resolve(o['--out'])) throw new Error('--out must not overwrite --in: the capture is the fit source');
    const maxWidth = o['--max-width'] === undefined ? MAX_EVIDENCE_WIDTH : Number(o['--max-width']);
    if (!Number.isInteger(maxWidth) || maxWidth < 1) throw new Error('--max-width must be a positive integer');
    let masks = null, cssWidth = null;
    if (o['--masks'] !== undefined || o['--viewport'] !== undefined) {
      const viewport = parseViewport(o['--viewport']);
      if (!o['--masks'] || !viewport) throw new Error('--masks and --viewport <WxH> go together');
      masks = JSON.parse(readFileSync(resolve(o['--masks']), 'utf8'));
      if (!Array.isArray(masks)) throw new Error('--masks must be a JSON array of {x,y,w,h} (Dragon maskedRects)');
      cssWidth = viewport.width;
    }
    const result = fitPng(readFileSync(resolve(o['--in'])), { maxWidth, masks, cssWidth });
    const out = writeOut(o['--out'], result.png);
    return { ok: true, command: 'evidence fit', out, sha256: result.sha256, bytes: result.png.length, fit: result.fit };
  }
  if (command === 'app-map') {
    const o = parseFlags(rest, ['--log', '--out']);
    if (!o['--log'] || !o['--out']) throw new Error('--log and --out are required');
    const log = JSON.parse(readFileSync(resolve(o['--log']), 'utf8'));
    const observations = Array.isArray(log) ? log : log?.observations;
    if (!Array.isArray(observations)) throw new Error('--log must hold an array of observations or {observations: [...]}');
    const map = buildAppMapV2(observations);
    const out = writeOut(o['--out'], `${JSON.stringify(map, null, 2)}\n`);
    return { ok: true, command, out, nodes: map.nodes.length, states: map.states.length, frontier: map.frontier.length,
      stop: map.stop.reason, issues: map.issues };
  }
  if (command === 'probe-cells') {
    // R1e: the sealed per-cell result of a probe; name it in the state receipt's probes[].cells {path, sha256}.
    const o = parseFlags(rest, ['--receipt', '--probe', '--kind', '--out']);
    if (!o['--receipt'] || !o['--probe'] || !o['--kind'] || !o['--out']) throw new Error('--receipt, --probe, --kind and --out are required');
    if (!['width-sweep', 'overlay-check'].includes(o['--kind'])) throw new Error('--kind must be width-sweep or overlay-check');
    const receipt = JSON.parse(readFileSync(resolve(o['--receipt']), 'utf8'));
    const probeBytes = readFileSync(resolve(o['--probe']));
    const sealed = probeCells({ receipt, caseId: receipt.caseId, state: receipt.state, kind: o['--kind'], probe: JSON.parse(probeBytes.toString('utf8')),
      probeSha256: createHash('sha256').update(probeBytes).digest('hex') });
    const text = `${JSON.stringify(sealed, null, 2)}\n`;
    const out = writeOut(o['--out'], text);
    return { ok: true, command, out, sha256: createHash('sha256').update(text).digest('hex'), cells: sealed.cells.length };
  }
  if (command === 'baseline' && ['propose', 'approve', 'list'].includes(rest[0])) {
    const sub = rest[0];
    const allowed = { propose: ['--store', '--png', ...KEY_FLAGS, '--vision', '--mask', '--source-run', '--source-case'],
      approve: ['--store', ...KEY_FLAGS, '--sha256', '--by'], list: ['--store'] }[sub];
    const o = parseFlags(rest.slice(1), allowed);
    if (!o['--store']) throw new Error('--store is required');
    const file = resolve(o['--store']);
    if (sub === 'list') {
      const { store, sha256, dir } = readStore(file);
      return { ok: true, command: 'baseline list', store: file, sha256, errors: storeErrors(store, { dir }), entries: store.entries };
    }
    const current = existsSync(file) ? readStore(file) : { store: emptyStore(), dir: dirname(file) };
    let result;
    if (sub === 'propose') {
      if (!o['--png'] || !o['--vision']) throw new Error('--png and --vision are required');
      result = proposeBaseline({ store: current.store, dir: current.dir, key: keyOf(o), png: readFileSync(resolve(o['--png'])),
        mask: o['--mask'] ? readJsonFile(o['--mask']) : [], vision: readJsonFile(o['--vision']),
        source: { ...(o['--source-run'] ? { run: o['--source-run'] } : {}), ...(o['--source-case'] ? { case_id: o['--source-case'] } : {}) } });
    } else {
      if (!o['--sha256'] || !o['--by']) throw new Error('--sha256 and --by are required');
      result = approveBaseline({ store: current.store, key: keyOf(o), sha256: o['--sha256'], by: o['--by'] });
    }
    const sha256 = writeStore(file, result.store);
    return { ok: true, command: `baseline ${sub}`, store: file, sha256, entry: result.entry };
  }
  if (command === 'vision' && rest[0] === 'decide') {
    const o = parseFlags(rest.slice(1), ['--store', '--png', ...KEY_FLAGS, '--sweep', '--captured-at', '--min-tier']);
    if (!o['--store'] || !o['--png']) throw new Error('--store and --png are required');
    const minTier = o['--min-tier'] === undefined ? 0 : Number(o['--min-tier']);
    if (![0, 1, 2, 3].includes(minTier)) throw new Error('--min-tier must be 0, 1, 2 or 3');
    const { store, dir, sha256 } = readStore(o['--store']);
    const decision = visionDiffDecision({ png: readFileSync(resolve(o['--png'])), key: keyOf(o), store, storeDir: dir,
      sweep: o['--sweep'] ? readJsonFile(o['--sweep']) : null, capturedAt: o['--captured-at'] ?? new Date().toISOString(), minTier });
    return { ok: true, command: 'vision decide', store_sha256: sha256, ...decision };
  }
  // Upgrade R1d: the transient probe (references/transient-rules.md).
  if (command === 'probe' && ['classify', 'build', 'grade'].includes(rest[0])) {
    const o = parseFlags(rest.slice(1), rest[0] === 'build' ? ['--in', '--out'] : ['--in']);
    if (!o['--in'] || (rest[0] === 'build' && !o['--out'])) throw new Error(rest[0] === 'build' ? '--in and --out are required' : '--in is required');
    const input = JSON.parse(readFileSync(resolve(o['--in']), 'utf8'));
    if (rest[0] === 'classify') return { ok: true, command: 'probe classify', ...classifyAction(input) };
    if (rest[0] === 'build') {
      const receipt = buildTransientProbeReceipt(input);
      const out = writeOut(o['--out'], `${JSON.stringify(receipt)}\n`);
      return { ok: true, command: 'probe build', out, verdict: receipt.verdict, trials: receipt.trials.length, keyframes: receipt.keyframes.frames.length };
    }
    const graded = transientProbeVerdict(input);
    return { ok: true, command: 'probe grade', verdict: graded.verdict, issues: graded.issues, warnings: graded.warnings, rules: graded.rules };
  }
  throw new Error(`unknown command ${[command, rest[0]].filter(Boolean).join(' ') || '(none)'}`);
}

if (isDirectExecution(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`); }
  catch (error) {
    process.stderr.write(`${USAGE}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
    process.exitCode = 2;
  }
}
