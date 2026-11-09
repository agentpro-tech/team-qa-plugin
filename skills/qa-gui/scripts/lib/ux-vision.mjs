// ux-vision.mjs — the vision-judged UX rules U7, U8, U10 (R1c): one prompt, a closed structured output, a grader.
// ============================================================
// These rules ride the existing per-state vision pass (Layer C, C10–C16): the same canonical PNG, the same pass,
// one extra structured answer. The machine supplies what it measured (forced empty response, the dialog or undo a
// destructive click produced, the Dragon native-dialog record, the U10 ink pre-screen from `__uxObserve`), and the
// grader only accepts an answer that is complete, consistent with its own yes/no fields, confident enough and
// pointed at a region inside the image. Anything else is UNGRADED with a reason, never PASS. Pure: no I/O.
import { uxResult, uxSettings } from './ux-rules.mjs';

export const UX_VISION_RULES = Object.freeze(['U7', 'U8', 'U10']);
const QUESTIONS = { U7: ['explains', 'offersAction'], U8: ['confirmation', 'undo'], U10: ['clipped'] };
const COMMON = ['rule', 'applies', 'verdict', 'confidence', 'evidence', 'reason'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const DEFAULTS = uxSettings();

const region = { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } };
/** JSON Schema of the structured output (one entry per asked rule). */
export const UX_VISION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', additionalProperties: false, required: ['schema', 'rules'],
  properties: {
    schema: { const: 'qa-gui/ux-vision/v1' },
    rules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['rule', 'applies', 'verdict', 'confidence', 'evidence', 'reason'],
        properties: {
          rule: { enum: [...UX_VISION_RULES] },
          applies: { type: 'boolean' },
          verdict: { enum: ['PASS', 'FAIL', 'UNGRADED'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          explains: { type: 'boolean' }, offersAction: { type: 'boolean' },
          confirmation: { type: 'boolean' }, undo: { type: 'boolean' },
          clipped: { type: 'boolean' },
          evidence: { type: 'object', additionalProperties: false, required: ['region', 'quote'],
            properties: { region: { anyOf: [region, { type: 'null' }] }, quote: { type: 'string', maxLength: 200 } } },
          reason: { type: 'string', maxLength: 400 },
        },
      },
    },
  },
});

// The schema shown in the prompt: only the asked rules and their own yes/no fields.
function promptSchema(asked) {
  const items = UX_VISION_SCHEMA.properties.rules.items;
  const keep = new Set([...COMMON, ...asked.flatMap((id) => QUESTIONS[id])]);
  const properties = Object.fromEntries(Object.entries(items.properties).filter(([key]) => keep.has(key)));
  properties.rule = { enum: [...asked] };
  return { ...UX_VISION_SCHEMA, properties: { ...UX_VISION_SCHEMA.properties, rules: { type: 'array', items: { ...items, properties } } } };
}

const RULE_TEXT = {
  U7: (ctx, t) => [
    'U7 empty state. applies: the main list, table or content area of this screen shows no items.',
    'explains: the screen says that it is empty or why (for example "No orders yet").',
    'offersAction: a visible next step: a button or link to create, import, clear filters or search, go elsewhere, or an instruction that tells the user what to do.',
    t.requireAction ? 'verdict: FAIL when offersAction is false; otherwise PASS.' : 'verdict: FAIL when explains and offersAction are both false; otherwise PASS.',
    ctx.forcedEmpty ? 'Machine fact: the test forced an empty response for this list.' : null,
    Number.isInteger(ctx.itemCount) ? `Machine fact: the list ${ctx.listSelector ? `${ctx.listSelector} ` : ''}holds ${ctx.itemCount} items.` : null,
  ],
  U8: (ctx) => [
    `U8 destructive action. The image is the screen right after the user activated ${JSON.stringify(ctx.action?.label ?? 'the control under test')}.`,
    'applies: that control deletes, removes, discards or overwrites something.',
    'confirmation: before it happens, the user is asked to confirm (a dialog, a typed confirmation, a second step).',
    'undo: an undo or restore is offered after it happened.',
    'verdict: FAIL when confirmation and undo are both false; otherwise PASS.',
    ctx.dialogOpened ? 'Machine fact: a dialog opened after the click.' : 'Machine fact: no dialog opened after the click.',
    ctx.undoOffered ? 'Machine fact: an undo control is visible.' : 'Machine fact: no undo control was found.',
  ],
  U10: (ctx, t, regions) => [
    'U10 Vietnamese diacritics. applies: the image shows Vietnamese text with a mark above the letters (stacked marks such as \u1eb6 \u1ed6 \u1eaa) or a dot below (such as \u1ea1 \u1ec7).',
    'clipped: a mark above a letter or a dot below it is cut off by the edge of its box, its line or its container.',
    'verdict: FAIL when clipped is true; otherwise PASS.',
    regions.length ? `Look first at these text boxes (image pixels): ${regions.map((r) => `${r.sel} at x=${r.x} y=${r.y} w=${r.w} h=${r.h}${r.clipped ? ' (machine: ink outside its clip box)' : ''}`).join('; ')}.` : null,
  ],
};

/**
 * Build the vision request for the rules a settled state needs.
 *   rules     subset of U7, U8, U10
 *   state     the state label; image {path, width, height} = the canonical PNG of that state
 *   viewport  {w, h} CSS px (to scale machine rectangles to image pixels; default = image size)
 *   context   {U7:{forcedEmpty, listSelector, itemCount}, U8: uxDestructiveContext(...), U10:{candidates}}
 * Returns {schema, rules, state, image, context, regions, prompt, outputSchema}. The prompt asks for JSON only.
 */
export function uxVisionRequest({ rules, state = null, image, viewport, context = {} } = {}, settings = DEFAULTS) {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('UX_VISION_RULES_REQUIRED');
  for (const id of rules) if (!UX_VISION_RULES.includes(id)) throw new Error(`UX_VISION_RULE:${id}`);
  if (!isObject(image) || !(image.width > 0) || !(image.height > 0)) throw new Error('UX_VISION_IMAGE');
  const scaleX = image.width / (viewport?.w > 0 ? viewport.w : image.width), scaleY = image.height / (viewport?.h > 0 ? viewport.h : image.height);
  const candidates = Array.isArray(context.U10?.candidates) ? context.U10.candidates : [];
  const regions = { U10: candidates.filter((c) => isObject(c?.rect)).map((c) => ({
    x: Math.round(c.rect.x * scaleX), y: Math.round(c.rect.y * scaleY), w: Math.round(c.rect.w * scaleX), h: Math.round(c.rect.h * scaleY), sel: c.sel, clipped: c.clipped === true,
  })).sort((a, b) => Number(b.clipped) - Number(a.clipped)) };
  const asked = rules.filter((id) => id !== 'U10' || candidates.length > 0);
  const lines = [
    `You check one screenshot (${image.width}x${image.height} px${state ? `, state "${state}"` : ''}) of a web app for UX defects.`,
    'Judge only what is visible in the image. Answer with JSON only, matching the schema below, one entry per rule.',
    'For each rule: first decide "applies" (does the rule\'s condition occur on this screen?); if it does not, set applies=false and verdict="UNGRADED".',
    'Then answer the rule\'s yes/no fields, set the verdict from those answers exactly as the rule says, and point at the evidence:',
    'evidence.region = the box in image pixels (x, y from the top-left, w, h); evidence.quote = the visible text there, verbatim, or "" when there is none.',
    'confidence is between 0 and 1. If you cannot tell, set verdict="UNGRADED". Machine facts below were measured; do not contradict them without visible evidence.',
    '',
    ...asked.flatMap((id) => [...RULE_TEXT[id](context[id] ?? {}, settings.thresholds[id], regions.U10).filter(Boolean), '']),
    `Schema: ${JSON.stringify(promptSchema(asked))}`,
  ];
  return { schema: 'qa-gui/ux-vision-request/v1', rules: [...rules], asked, state, image: { ...image }, context, regions, prompt: lines.join('\n'), outputSchema: UX_VISION_SCHEMA };
}

/** U8 machine facts from the observations around the destructive action and Dragon's `do.dialogHandled`. */
export function uxDestructiveContext({ before, after, action, dialogHandled } = {}) {
  const opened = (after?.dialogs ?? []).some((d) => !(before?.dialogs ?? []).includes(d));
  return {
    action: action ? { ...action } : null,
    dialogOpened: opened,
    undoOffered: (after?.undo ?? []).length > 0,
    nativeConfirm: ['confirm', 'prompt'].includes(String(dialogHandled?.type ?? '').toLowerCase()),
  };
}

function entryFor(output, id) {
  if (output === null || output === undefined) return { reason: 'NO_VISION_OUTPUT' };
  if (!isObject(output) || output.schema !== 'qa-gui/ux-vision/v1' || !Array.isArray(output.rules)) return { reason: 'OUTPUT_INVALID' };
  const matches = output.rules.filter((entry) => entry?.rule === id);
  if (matches.length === 0) return { reason: 'NO_VISION_OUTPUT' };
  if (matches.length > 1) return { reason: 'OUTPUT_INVALID' };
  const entry = matches[0];
  const allowed = new Set([...COMMON, ...QUESTIONS[id]]);
  if (!isObject(entry) || Object.keys(entry).some((key) => !allowed.has(key))) return { reason: 'OUTPUT_INVALID' };
  if (typeof entry.applies !== 'boolean' || !['PASS', 'FAIL', 'UNGRADED'].includes(entry.verdict)
    || !(typeof entry.confidence === 'number' && entry.confidence >= 0 && entry.confidence <= 1)
    || !isObject(entry.evidence) || typeof entry.evidence.quote !== 'string' || typeof entry.reason !== 'string') return { reason: 'OUTPUT_INVALID' };
  if (entry.applies && QUESTIONS[id].some((key) => typeof entry[key] !== 'boolean')) return { reason: 'OUTPUT_INVALID' };
  return { entry };
}

function derived(id, entry, t) {
  if (id === 'U7') return (!entry.offersAction && (t.requireAction || !entry.explains)) ? 'FAIL' : 'PASS';
  if (id === 'U8') return (!entry.confirmation && !entry.undo) ? 'FAIL' : 'PASS';
  return entry.clipped ? 'FAIL' : 'PASS';
}

function inside(box, image) {
  return isObject(box) && [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0
    && box.x + box.w <= image.width + 1 && box.y + box.h <= image.height + 1;
}

function judge(id, output, request, settings) {
  const { entry, reason } = entryFor(output, id);
  if (reason) return { reason };
  if (!entry.applies) return { reason: 'NOT_APPLICABLE' };
  if (entry.confidence < settings.thresholds[id].minConfidence) return { reason: 'LOW_CONFIDENCE', confidence: entry.confidence };
  const verdict = derived(id, entry, settings.thresholds[id]);
  if (entry.verdict !== verdict) return { reason: 'INCONSISTENT_OUTPUT' };
  if (verdict === 'FAIL' && !inside(entry.evidence.region, request.image)) return { reason: 'NO_EVIDENCE' };
  return { verdict, entry };
}

/**
 * Grade the structured answer(s) for every rule of the request. `outputs` is one answer or an array of answers from
 * independent judges; judges that disagree make the rule UNGRADED (JUDGES_DISAGREE). Machine facts win where vision
 * cannot see (a native confirm dialog passes U8) and block a PASS they contradict (a measured U10 clip, or a dialog /
 * undo a U8 FAIL denies, is MACHINE_VISION_DISAGREE). Returns {U7?, U8?, U10?} rule results (see uxResult).
 */
export function gradeUxVision(outputs, request, settings = DEFAULTS) {
  if (!isObject(request) || !Array.isArray(request.rules) || !isObject(request.image)) throw new Error('UX_VISION_REQUEST_REQUIRED');
  const list = Array.isArray(outputs) ? outputs : [outputs];
  const results = {};
  for (const id of request.rules) {
    const ctx = request.context?.[id] ?? {};
    if (id === 'U8' && ctx.nativeConfirm === true) {
      results[id] = uxResult(id, 'PASS', { settings, source: 'observe', measured: { nativeConfirm: true } });
      continue;
    }
    if (id === 'U10' && !(Array.isArray(ctx.candidates) && ctx.candidates.length > 0)) {
      results[id] = uxResult(id, 'UNGRADED', { settings, reason: 'NO_DIACRITIC_TEXT' });
      continue;
    }
    const judged = list.map((output) => judge(id, output, request, settings));
    const open = judged.find((j) => j.reason);
    if (open) { results[id] = uxResult(id, 'UNGRADED', { settings, source: 'vision', reason: open.reason, measured: { judges: list.length } }); continue; }
    if (new Set(judged.map((j) => j.verdict)).size > 1) { results[id] = uxResult(id, 'UNGRADED', { settings, source: 'vision', reason: 'JUDGES_DISAGREE', measured: { judges: list.length } }); continue; }
    const { verdict, entry } = judged[0];
    const machineClip = id === 'U10' && ctx.candidates.some((c) => c?.clipped === true);
    const machineGuard = id === 'U8' && (ctx.dialogOpened === true || ctx.undoOffered === true);
    if ((machineClip && verdict === 'PASS') || (machineGuard && verdict === 'FAIL')) {
      results[id] = uxResult(id, 'UNGRADED', { settings, source: 'vision', reason: 'MACHINE_VISION_DISAGREE', measured: { vision: verdict } });
      continue;
    }
    const measured = { judges: list.length, confidence: Math.min(...judged.map((j) => j.entry.confidence)) };
    for (const key of QUESTIONS[id]) measured[key] = entry[key];
    const findings = verdict === 'FAIL'
      ? [{ sel: null, region: { ...entry.evidence.region }, detail: `${entry.reason}${entry.evidence.quote ? ` ("${entry.evidence.quote.slice(0, 80)}")` : ''}`, text: entry.evidence.quote.slice(0, 60) }]
      : [];
    results[id] = uxResult(id, verdict, { settings, source: 'vision', findings, measured });
  }
  return results;
}
