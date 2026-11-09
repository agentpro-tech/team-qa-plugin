// A deterministic stand-in for the adjudicator model (upgrade R2a tests). It implements the engine interface of
// scripts/lib/adjudicator-engine.mjs: it reads only the exact input text it is given and answers in the documented
// output format. No network, no API key. The judge rule is simple on purpose: a step is SUPPORTED when an action of the
// chain carries the step's quoted words, the expected result when a tool result excerpt does.
const START = 'TEAMQA_ADJUDICATOR_PAYLOAD_START', END = 'TEAMQA_ADJUDICATOR_PAYLOAD_END';

export function payloadOf(input) {
  const from = input.indexOf(START), to = input.indexOf(END);
  if (from < 0 || to < from) throw new Error('fake engine: no payload in the input');
  return JSON.parse(input.slice(from + START.length, to));
}
const phaseOf = (input) => /^TEAMQA_ADJUDICATOR v1 phase=(\w+)/.exec(input)?.[1] ?? null;
const quoted = (text) => (/'([^']+)'/.exec(String(text))?.[1] ?? String(text)).toLowerCase();
const block = (marker, value) => `${marker}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

function judge(payload, mode) {
  const actions = payload.action_chain, images = payload.evidence.filter((e) => e.kind === 'image');
  const lastImage = images.at(-1) ?? null;
  const stepText = (ref) => payload.case.steps.find((s) => s.id === ref)?.text ?? '';
  const expectedToken = quoted(payload.case.expected);
  const resultHit = actions.find((a) => String(a.result_excerpt ?? '').toLowerCase().includes(expectedToken));
  const fallback = actions.length ? [{ kind: 'action', action: actions.at(-1).id }] : lastImage ? [{ kind: 'file', evidence: lastImage.id }] : [{ kind: 'timestamp', at: '1970-01-01T00:00:00.000Z' }];
  const items = payload.checklist.items.map((item) => {
    const ref = item.refs[0];
    if (ref.startsWith('step:')) {
      const token = quoted(stepText(ref));
      const hit = actions.find((a) => JSON.stringify(a.params).toLowerCase().includes(token));
      if (!hit) return { id: item.id, status: 'INSUFFICIENT', pointers: fallback, note: 'No action of the chain does this step.' };
      const selector = JSON.stringify(hit.params).match(/"selector":"((?:[^"\\]|\\.)*)"/)?.[1];
      return { id: item.id, status: 'SUPPORTED', pointers: [{ kind: 'action', action: hit.id }, ...(selector ? [{ kind: 'selector', selector: JSON.parse(`"${selector}"`) }] : [])] };
    }
    if (!resultHit) return { id: item.id, status: 'INSUFFICIENT', pointers: fallback };
    return { id: item.id, status: 'SUPPORTED', pointers: [{ kind: 'action', action: resultHit.id },
      ...(lastImage ? [{ kind: 'image_region', evidence: lastImage.id, x: 0, y: 0, w: lastImage.width, h: lastImage.height }] : [])] };
  });
  if (mode === 'bad-pointer' && lastImage) items[0].pointers = [{ kind: 'image_region', evidence: lastImage.id, x: 0, y: 0, w: lastImage.width + 100, h: 10 }];
  if (mode === 'ghost-evidence') items[0].pointers = [{ kind: 'file', evidence: 'E99' }];
  if (mode === 'ghost-action') items[0].pointers = [{ kind: 'action', action: 'A999' }];
  const derived = items.some((i) => i.status !== 'SUPPORTED') ? 'CONTEST' : 'CONFIRM';
  if (mode === 'abstain') return { items: [], overall: 'ABSTAIN', abstain_reason: 'The screenshots do not open.' };
  return { items, overall: mode === 'inconsistent' ? (derived === 'CONFIRM' ? 'CONTEST' : 'CONFIRM') : derived };
}

// The answer to one input, as a model would print it.
export function respond(input, { mode = 'honest' } = {}) {
  if (mode === 'garbage') return 'I think this case looks fine.';
  const payload = payloadOf(input), phase = phaseOf(input);
  if (phase === 'checklist') {
    const titles = payload.requirement.sources.map((s) => s.title);
    return block('TEAMQA_ADJUDICATOR_CHECKLIST v1', { items: titles.map((title) => ({ text: `The requirement holds for the shopper: ${title}.` })) });
  }
  if (phase === 'judge') return `Reviewed.\n${block('TEAMQA_ADJUDICATION v1', judge(payload, mode))}`;
  throw new Error(`fake engine: unknown phase ${phase}`);
}

// The engine object: every call is kept so a test can compare what was sent with what was recorded.
export function fakeEngine({ mode = 'honest', checklistMode = 'honest', calls = [] } = {}) {
  return {
    interface: 'team-qa/adjudicator-engine/v1', kind: 'fake', calls,
    async call({ phase, input, attempt }) {
      calls.push({ phase, input, attempt });
      return { output: respond(input, { mode: phase === 'checklist' ? checklistMode : mode }), session_id: `fake-${attempt}` };
    },
  };
}
