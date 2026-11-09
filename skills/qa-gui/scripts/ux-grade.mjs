#!/usr/bin/env node
// ux-grade.mjs — grade one UX rule (U1–U10, R1c) from a JSON input the executor saved, and optionally fold the
// result into the Gate-0 sweep report of the same settled state (references/ux-rules.md).
//
//   node scripts/ux-grade.mjs --rule <U1|U2|U3|U6|U9|U7|U8|U10> --input <in.json> [--settings <prereg.json>]
//                             [--fold <sweep.json> [--require U2,U3]]
//   node scripts/ux-grade.mjs --vision-request <ctx.json> [--settings <prereg.json>]
//
// --input   U1/U2/U3: the grader input ({action, before, during, after, writes, env, sensors, ...});
//           U6/U9: a Dragon paintSnapshot result;
//           U7/U8/U10: {request, outputs} = the vision request and the structured answer(s) to it.
// --vision-request  {rules, state, image:{path,width,height}, viewport, context}: prints the prompt and schema.
// --settings  the pre-registered UX block ({version:1, levels, thresholds}); defaults when left out.
// --fold    the `__uiSanity` / `__a11yB` report of that state; prints the folded report instead of the result.
// Prints JSON on stdout and exits 0 when the rule was graded (PASS, FAIL or UNGRADED alike); exits 2 on bad usage,
// unreadable files or invalid settings. Pure: no browser, no network.
import { readFileSync } from 'node:fs';

import { isDirectExecution } from './lib/is-direct-execution.mjs';
import { foldUx, gradeU1, gradeU2, gradeU3, gradeU6Paint, gradeU9Paint, uxSettings } from './lib/ux-rules.mjs';
import { gradeUxVision, uxVisionRequest } from './lib/ux-vision.mjs';

const vision = (id) => (input, settings) => {
  const result = gradeUxVision(input?.outputs ?? null, input?.request, settings)[id];
  if (!result) throw new Error(`UX_GRADE_RULE_NOT_IN_REQUEST:${id}`);
  return result;
};
const GRADERS = { U1: gradeU1, U2: gradeU2, U3: gradeU3, U6: gradeU6Paint, U9: gradeU9Paint, U7: vision('U7'), U8: vision('U8'), U10: vision('U10') };

export function gradeFromFiles({ rule, input, settings, fold, require, 'vision-request': visionRequest }) {
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const resolved = uxSettings(settings ? json(settings) : {});
  if (visionRequest) return uxVisionRequest(json(visionRequest), resolved);
  const grade = GRADERS[rule];
  if (!grade) throw new Error(`UX_GRADE_RULE_UNSUPPORTED:${rule ?? 'missing'}`);
  if (!input) throw new Error('UX_GRADE_INPUT_REQUIRED');
  const result = grade(json(input), resolved);
  if (!fold) return result;
  return foldUx(json(fold), [result], { require: require ? String(require).split(',').filter(Boolean) : [] });
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!['rule', 'input', 'settings', 'fold', 'require', 'vision-request'].includes(key) || argv[i + 1] === undefined) throw new Error(`UX_GRADE_USAGE:${argv[i]}`);
    out[key] = argv[i + 1];
  }
  return out;
}

if (isDirectExecution(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(gradeFromFiles(parse(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ux-grade: ${error.message}\n`);
    process.exitCode = 2;
  }
}
