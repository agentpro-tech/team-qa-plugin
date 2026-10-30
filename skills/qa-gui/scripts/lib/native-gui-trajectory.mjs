// Pure policy inspection. The caller must verify original host provenance and policy pins.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const dragonToolName = t => t?.name === 'dragon_rpc' ? `${t.namespace}__${t.name}` : t?.name;
const sha = v => /^[a-f0-9]{64}$/.test(v || '');
// Dragon 1.6.4 is the first release whose receipts this checker reads. A later minor or patch release keeps that
// receipt contract, so it is accepted (Team QA public v1, T1: the Chrome Web Store updates the extension on its own);
// the next major, a pre-release or a malformed version stays refused until it is reviewed.
const DRAGON_MIN = [1, 6, 4], DRAGON_BELOW = [2, 0, 0];
const versionOrder = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const supportedDragonVersion = v => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(typeof v === 'string' ? v : '');
  if (!m) return false;
  const x = m.slice(1).map(Number);
  return versionOrder(x, DRAGON_MIN) >= 0 && versionOrder(x, DRAGON_BELOW) < 0;
};
const quote = v => `'${String(v).replaceAll("'", "'\\''")}'`;
function helperCommand(c) {
  const r = c?.request, timeout = r?.timeout ?? 15000;
  if (!object(r) || !object(r.params) || !methods.has(r.method) || !Number.isInteger(timeout) || timeout < 1 || timeout > 35000) return null;
  return `node ${quote(c.helper?.path)} --method ${quote(r.method)} --params ${quote(JSON.stringify(r.params))} --timeout ${timeout}`;
}
const bound = (v, d) => object(v) && ['sessionId', 'nonce', 'browserInstanceId'].every(k => v[k] === d[k]);
const actions = new Set(['trustedClick', 'trustedType', 'pressKey', 'trustedHover', 'trustedScroll', 'dragDrop', 'clear', 'chord']);
const methods = new Set([...actions, 'do', 'perceive', 'read', 'screenshot', 'captureTab', 'startRecording', 'stopRecording', 'assembleRecording']);
const stepKeys = new Set(['click', 'clickSelector', 'clickXY', 'type', 'fill', 'pressKey', 'hover', 'scroll', 'drag', 'clear', 'chord', 'read', 'as', 'waitFor', 'wait', 'assert', 'expectNet', 'fast', 'fidelity', 'selector', 'nth']);
const requestFields = {
  do: ['steps', 'timeout', 'fast'], read: ['read', 'as'], perceive: ['max', 'selector'],
  screenshot: ['toFile', 'format', 'quality'], captureTab: ['toFile', 'format', 'quality'],
  startRecording: ['fps', 'quality', 'everyNthFrame', 'maxWidth', 'maxHeight', 'aspect', 'width', 'height', 'minFps', 'deviceScaleFactor', 'mobile'],
  stopRecording: ['id'], assembleRecording: ['id', 'out', 'durationMs', 'fps'],
  trustedClick: ['selector', 'nth', 'x', 'y', 'text', 'fast', 'modifiers', 'fidelity'],
  trustedType: ['selector', 'text', 'clear', 'fidelity'], pressKey: ['key', 'modifiers'],
  trustedHover: ['selector', 'text', 'x', 'y', 'dwellMs', 'expect', 'fidelity'],
  trustedScroll: ['scroll', 'axis', 'delta', 'toTarget', 'to', 'container', 'selector', 'budget', 'direction', 'fidelity'],
  dragDrop: ['drag', 'from', 'to', 'hold', 'path', 'steps', 'fidelity'], clear: ['selector', 'clear'], chord: ['chord', 'keys'],
};
function exact(v, keys, errors, label) {
  if (!object(v) || Object.keys(v).some(k => !keys.includes(k))) errors.push(label);
}
function normal(v) { return object(v) && v.fast !== true && v.synthetic !== true && v.trusted !== false && !v.fidelity?.pastePolicy?.enabled; }
function readsOnlyDeclaredStorageKeys(read) {
  if (typeof read !== 'string') return false;
  const storageReference = /\b(?:localStorage|sessionStorage|Storage)\b/;
  if (!storageReference.test(read)) return true;
  return /^\s*(?:return\s+)?(?:localStorage|sessionStorage)\s*\.\s*getItem\s*\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)\s*$/.test(read);
}
function unwrap(raw) {
  if (!object(raw) || raw.isError === true) return null;
  if (!Object.hasOwn(raw, 'content')) return raw;
  if (Object.keys(raw).some(k => !['content', 'isError', 'structuredContent', '_meta'].includes(k)) || !Array.isArray(raw.content) || raw.content.length !== 1 || raw.content[0]?.type !== 'text' || typeof raw.content[0].text !== 'string') return null;
  try {
    const value = JSON.parse(raw.content[0].text);
    if (!object(value) || raw.structuredContent && JSON.stringify(raw.structuredContent) !== JSON.stringify(value)) return null;
    return value;
  } catch { return null; }
}
function receipt(r, dragon, errors, method, call) {
  if (!object(r) || !bound(r.session, dragon) || r.session.tabId !== dragon.tabId || r.input?.trusted !== true || r.firewall?.verdict !== 'allow' || r.postcondition?.pass !== true || r.env?.build?.extVersion !== dragon.version || typeof r.actionId !== 'string' || !r.actionId) errors.push('NATIVE_GUI_TRUSTED_RECEIPT_REQUIRED');
  if (!normal(r?.action?.step || {})) errors.push('NATIVE_GUI_NORMAL_INPUT_REQUIRED');
  if (r?.action?.method !== method) errors.push('NATIVE_GUI_ACTION_RECEIPT_MISMATCH');
  if (!Number.isFinite(r?.ts) || r.ts < Date.parse(call.call_timestamp) - 1000 || r.ts > Date.parse(call.output_timestamp) + 1000) errors.push('NATIVE_GUI_RECEIPT_STALE');
}
export function nativeGuiPolicyErrors(policy) {
  const errors = [];
  exact(policy, ['schema', 'allowed_tools', 'dragon', 'target', 'capabilities', 'max_calls', 'helpers', 'commands', 'reads', 'behavioral'], errors, 'NATIVE_GUI_POLICY_UNKNOWN');
  const d = policy?.dragon;
  exact(d, ['version', 'sessionId', 'nonce', 'browserInstanceId', 'tabId'], errors, 'NATIVE_GUI_DRAGON_UNKNOWN');
  const web = policy?.schema === 'qa-gui/native-policy/v2';
  exact(policy?.target, web ? ['url', 'kind', 'target_binding_sha256'] : ['url', 'commit'], errors, 'NATIVE_GUI_TARGET_UNKNOWN');
  const validTarget = web
    ? policy?.target?.kind === 'deployed-build' && sha(policy?.target?.target_binding_sha256)
    : /^[a-f0-9]{40}$/.test(policy?.target?.commit || '');
  if (!['qa-gui/native-policy/v1', 'qa-gui/native-policy/v2'].includes(policy?.schema) || !supportedDragonVersion(d?.version) || !['sessionId', 'nonce', 'browserInstanceId'].every(k => typeof d?.[k] === 'string' && d[k]) || !Number.isInteger(d?.tabId) || !/^https?:\/\//.test(policy?.target?.url || '') || !validTarget || !Number.isInteger(policy?.max_calls) || policy.max_calls < 1 || typeof policy?.behavioral !== 'boolean') errors.push('NATIVE_GUI_POLICY_REQUIRED');
  if (!Array.isArray(policy?.allowed_tools) || !policy.allowed_tools.length || policy.allowed_tools.some(t => !object(t) || Object.keys(t).some(k => !['namespace', 'name'].includes(k)) || typeof t.name !== 'string' || !/^mcp__.*dragon.*__dragon_rpc$/i.test(dragonToolName(t)) || typeof t.namespace !== 'string')) errors.push('NATIVE_GUI_TOOL_PIN_REQUIRED');
  if (!Array.isArray(policy?.capabilities) || !policy.capabilities.length || policy.capabilities.some(m => !methods.has(m)) || new Set(policy?.capabilities).size !== policy?.capabilities?.length) errors.push('NATIVE_GUI_CAPABILITY_UNKNOWN');
  if (!Array.isArray(policy?.reads) || policy.reads.some(s => typeof s !== 'string' || !s.trim() || !readsOnlyDeclaredStorageKeys(s) || /(?:\.click\s*\(|dispatchEvent\s*\(|fetch\s*\(|XMLHttpRequest|\.submit\s*\(|location\s*=)/.test(s))) errors.push('NATIVE_GUI_READ_POLICY_REQUIRED');
  if (!Array.isArray(policy?.helpers) || policy.helpers.some(h => !object(h) || Object.keys(h).some(k => !['path', 'sha256'].includes(k)) || typeof h.path !== 'string' || !h.path.startsWith('/') || !h.path.endsWith('/scripts/qa_do.mjs') || !sha(h.sha256))) errors.push('NATIVE_GUI_HELPER_PIN_REQUIRED');
  if (!Array.isArray(policy?.commands) || policy.commands.some(c => !object(c) || Object.keys(c).some(k => !['command', 'helper', 'request'].includes(k)) || typeof c.command !== 'string' || !policy.helpers?.some(h => h.path === c.helper?.path && h.sha256 === c.helper?.sha256) || c.command !== helperCommand(c) || c.request?.method === 'do')) errors.push('NATIVE_GUI_HELPER_COMMAND_REQUIRED');
  return [...new Set(errors)];
}

function nativeGuiRequestShape({ request, policy } = {}) {
  const errors = [];
  const d = policy?.dragon, p = request?.params, method = request?.method;
  exact(request, ['method', 'params', 'timeout'], errors, 'NATIVE_GUI_REQUEST_UNKNOWN');
  const timeout = request?.timeout ?? 15000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 35000) errors.push('NATIVE_GUI_TIMEOUT_INVALID');
  if (!methods.has(method) || !policy?.capabilities?.includes(method)) errors.push('NATIVE_GUI_CAPABILITY_UNAPPROVED');
  const common = ['sessionId', 'nonce', 'browserInstanceId', 'tabId', 'runId', 'caseId', 'stateId', 'buildId'];
  if (object(p) && requestFields[method]) exact(p, [...common, ...requestFields[method]], errors, 'NATIVE_GUI_PARAMS_UNKNOWN');
  else if (methods.has(method)) errors.push('NATIVE_GUI_PARAMS_REQUIRED');
  if (!bound(p, d) || !['stopRecording', 'assembleRecording'].includes(method) && p?.tabId !== d?.tabId) errors.push('NATIVE_GUI_SESSION_DRIFT');
  if (object(p) && !normal(p)) errors.push('NATIVE_GUI_NORMAL_INPUT_REQUIRED');
  if (method === 'trustedClick' && p?.fast !== false) errors.push('NATIVE_GUI_NORMAL_INPUT_REQUIRED');
  if (method === 'do' && p?.timeout !== undefined && (!Number.isInteger(p.timeout) || p.timeout < 1 || p.timeout > 35000)) errors.push('NATIVE_GUI_TIMEOUT_INVALID');
  let hasTrustedAction = actions.has(method);
  if (method === 'read' && (!policy?.reads?.includes(p?.read) || typeof p?.as !== 'string' || !p.as || !readsOnlyDeclaredStorageKeys(p?.read))) errors.push('NATIVE_GUI_READ_POLICY_REQUIRED');
  if (method === 'do') {
    if (!Array.isArray(p?.steps) || !p.steps.length) errors.push('NATIVE_GUI_STEPS_REQUIRED');
    for (const step of Array.isArray(p?.steps) ? p.steps : []) {
      if (!object(step) || Object.keys(step).some(k => !stepKeys.has(k)) || !normal(step)) { errors.push('NATIVE_GUI_STEP_UNAPPROVED'); continue; }
      if (Object.hasOwn(step, 'read') && (typeof step.read !== 'string' || !step.read.trim() || !policy.reads?.includes(step.read) || typeof step.as !== 'string' || !step.as.trim() || !readsOnlyDeclaredStorageKeys(step.read))) errors.push('NATIVE_GUI_READ_POLICY_REQUIRED');
      if (Object.hasOwn(step, 'wait') && (!Number.isInteger(step.wait) || step.wait < 0 || step.wait > 8000)) errors.push('NATIVE_GUI_STEP_UNAPPROVED');
      if (Object.hasOwn(step, 'waitFor')) {
        const waitFor = step.waitFor;
        if (!object(waitFor)) errors.push('NATIVE_GUI_STEP_UNAPPROVED');
        else {
          exact(waitFor, ['text', 'selector', 'timeoutMs'], errors, 'NATIVE_GUI_STEP_UNAPPROVED');
          const targetCount = Number(typeof waitFor.text === 'string' && !!waitFor.text.trim()) + Number(typeof waitFor.selector === 'string' && !!waitFor.selector.trim());
          if (targetCount !== 1 || waitFor.text !== undefined && (typeof waitFor.text !== 'string' || !waitFor.text.trim()) || waitFor.selector !== undefined && (typeof waitFor.selector !== 'string' || !waitFor.selector.trim()) || waitFor.timeoutMs !== undefined && (!Number.isInteger(waitFor.timeoutMs) || waitFor.timeoutMs < 1 || waitFor.timeoutMs > 35000)) errors.push('NATIVE_GUI_STEP_UNAPPROVED');
        }
      }
      if (Object.hasOwn(step, 'assert')) {
        const assertion = step.assert;
        if (!object(assertion)) errors.push('NATIVE_GUI_STEP_UNAPPROVED');
        else {
          exact(assertion, ['text', 'selector', 'absent', 'required'], errors, 'NATIVE_GUI_STEP_UNAPPROVED');
          const targetCount = Number(typeof assertion.text === 'string' && !!assertion.text.trim()) + Number(typeof assertion.selector === 'string' && !!assertion.selector.trim());
          if (targetCount !== 1 || assertion.text !== undefined && (typeof assertion.text !== 'string' || !assertion.text.trim()) || assertion.selector !== undefined && (typeof assertion.selector !== 'string' || !assertion.selector.trim()) || assertion.absent !== undefined && typeof assertion.absent !== 'boolean' || assertion.required !== undefined && typeof assertion.required !== 'boolean') errors.push('NATIVE_GUI_STEP_UNAPPROVED');
        }
      }
      if (Object.hasOwn(step, 'expectNet')) {
        const expectation = step.expectNet;
        if (typeof expectation === 'string') { if (!expectation.trim()) errors.push('NATIVE_GUI_STEP_UNAPPROVED'); }
        else if (!object(expectation)) errors.push('NATIVE_GUI_STEP_UNAPPROVED');
        else {
          exact(expectation, ['pattern', 'status', 'method'], errors, 'NATIVE_GUI_STEP_UNAPPROVED');
          if (typeof expectation.pattern !== 'string' || !expectation.pattern.trim() || expectation.status !== undefined && !Number.isInteger(expectation.status) || expectation.method !== undefined && (typeof expectation.method !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/i.test(expectation.method))) errors.push('NATIVE_GUI_STEP_UNAPPROVED');
        }
      }
      if (Object.keys(step).some(k => ['click', 'clickSelector', 'clickXY', 'type', 'fill', 'pressKey', 'hover', 'scroll', 'drag', 'clear', 'chord'].includes(k))) hasTrustedAction = true;
      if (['click', 'clickSelector', 'clickXY'].some(k => Object.hasOwn(step, k)) && step.fast !== false && p.fast !== false) errors.push('NATIVE_GUI_NORMAL_INPUT_REQUIRED');
    }
  }
  const recording = ['startRecording', 'stopRecording', 'assembleRecording'].includes(method);
  const mutating = hasTrustedAction || recording;
  const evidenceCapture = ['screenshot', 'captureTab'].includes(method);
  const actionClass = recording ? 'recording' : evidenceCapture ? 'capture' : hasTrustedAction ? 'trusted-input' : 'read';
  return { verdict: errors.length ? 'UNGRADED' : 'PASS', errors: [...new Set(errors)], requiresLive: true, mutating, hasTrustedAction, actionClass };
}

export function validateNativeGuiRequest({ request, policy, lockedPolicy } = {}) {
  const result = nativeGuiRequestShape({ request, policy });
  const effective = object(lockedPolicy?.policy) ? lockedPolicy.policy : lockedPolicy;
  const errors = [...nativeGuiPolicyErrors(policy), ...result.errors];
  if (!object(effective) || effective.requireTrusted !== true || effective.forbidSyntheticDOM !== false || !['pointer', 'key'].every(kind => effective.allowedInput?.includes(kind)) || lockedPolicy?.expired === true) errors.push('NATIVE_GUI_LOCKED_POLICY_REQUIRED');
  const identity = lockedPolicy?.session;
  if (object(identity) && (!bound(identity, policy?.dragon) || identity.tabId !== undefined && identity.tabId !== policy?.dragon?.tabId)) errors.push('NATIVE_GUI_SESSION_DRIFT');
  return { ...result, verdict: errors.length ? 'UNGRADED' : 'PASS', errors: [...new Set(errors)] };
}

export function validateNativeGuiTrajectory({ calls, policy } = {}) {
  const errors = nativeGuiPolicyErrors(policy), summary = { calls: 0, actions: 0, captures: 0, recordings: 0 };
  const d = policy?.dragon;
  if (!Array.isArray(calls) || !calls.length || calls.length > policy?.max_calls) errors.push('NATIVE_GUI_CALL_CAP');
  if (errors.length) return { verdict: 'UNGRADED', errors: [...new Set(errors)], summary };
  const seen = new Set(), started = new Map(); let previousOutput = 0;
  for (const c of calls) {
    summary.calls++;
    if (!object(c)) { errors.push('NATIVE_GUI_SOURCE_PAIR_REQUIRED'); continue; }
    if (!Number.isFinite(Date.parse(c.call_timestamp)) || !Number.isFinite(Date.parse(c.output_timestamp)) || Date.parse(c.output_timestamp) < Date.parse(c.call_timestamp)) errors.push('NATIVE_GUI_SOURCE_TIME_REQUIRED');
    if (!object(c) || !Number.isInteger(c.call_line) || !Number.isInteger(c.output_line) || c.call_line <= previousOutput || c.output_line <= c.call_line || !sha(c.call_sha256) || !sha(c.output_sha256) || seen.has(c.call_line) || seen.has(c.output_line)) errors.push('NATIVE_GUI_SOURCE_PAIR_REQUIRED');
    previousOutput = c.output_line;
    seen.add(c.call_line); seen.add(c.output_line);
    let request = c.input, raw = c.output;
    if (c.tool === 'exec_command') {
      const locked = policy.commands.find(v => v.command === c.command);
      if (!locked || c.input?.cmd !== locked.command || c.input?.login !== false || raw?.exit_code !== 0 || raw?.session_id || typeof raw?.output !== 'string') { errors.push('NATIVE_GUI_HELPER_UNAPPROVED'); continue; }
      request = locked.request;
      try { raw = JSON.parse(raw.output); } catch { errors.push('NATIVE_GUI_RESULT_INVALID'); continue; }
    } else if (!policy.allowed_tools.some(t => t.name === (c.name || c.tool) && t.namespace === (c.namespace || ''))) { errors.push('NATIVE_GUI_TOOL_UNAPPROVED'); continue; }
    raw = unwrap(raw);
    const method = request?.method, p = request?.params, r = raw?.result;
    const admission = nativeGuiRequestShape({ request, policy });
    errors.push(...admission.errors);
    if (!object(raw) || raw.ok !== true || raw.error || !object(r) || r.ok === false || r.error || r.human_needed || r.completed === false || r.results !== undefined && (!Array.isArray(r.results) || r.results.some(x => x?.ok === false))) { errors.push('NATIVE_GUI_OPERATION_FAILED'); continue; }
    if (actions.has(method)) { receipt(r.receipt, d, errors, method, c); summary.actions++; }
    if (['read', 'do'].includes(method)) {
      const steps = method === 'read' ? [p] : p.steps;
      if (!Array.isArray(steps) || !steps.length) errors.push('NATIVE_GUI_STEPS_REQUIRED');
      if (method === 'do' && (r.completed !== true || !Array.isArray(r.results) || r.results.length !== steps?.length)) errors.push('NATIVE_GUI_STEPS_INCOMPLETE');
      for (const [index, step] of (Array.isArray(steps) ? steps : []).entries()) {
        if (!object(step)) { errors.push('NATIVE_GUI_STEP_UNAPPROVED'); continue; }
        if (!object(step) || method === 'do' && Object.keys(step).some(k => !stepKeys.has(k)) || !normal(step)) errors.push('NATIVE_GUI_STEP_UNAPPROVED');
        if (['click', 'clickSelector', 'clickXY'].some(k => Object.hasOwn(step, k)) && step.fast !== false && p.fast !== false) errors.push('NATIVE_GUI_NORMAL_INPUT_REQUIRED');
        if (step.read && (!policy.reads.includes(step.read) || !step.as || !Object.hasOwn(r.reads || {}, step.as) || r.reads[step.as] == null || r.reads[step.as]?.__read_error)) errors.push('NATIVE_GUI_MEASUREMENT_REQUIRED');
        if (Object.keys(step).some(k => ['click', 'clickSelector', 'clickXY', 'type', 'fill', 'pressKey', 'hover', 'scroll', 'drag', 'clear', 'chord'].includes(k))) {
          const rec = r.results?.[index]?.receipt;
          receipt(rec, d, errors, 'do', c); summary.actions++;
        }
      }
    }
    if (['screenshot', 'captureTab'].includes(method)) {
      if (r.privacyMasked !== true || !Array.isArray(r.maskedRects) || typeof r.savedTo !== 'string' || !r.savedTo.endsWith('.png')) errors.push('NATIVE_GUI_CAPTURE_PRIVACY_REQUIRED');
      else summary.captures++;
    }
    if (method === 'startRecording') { if (!r.id || started.has(r.id) || r.start?.privacyMasked !== true || r.tabId !== d.tabId) errors.push('NATIVE_GUI_RECORDING_START_REQUIRED'); else started.set(r.id, { actions: summary.actions, stopped: false }); }
    if (method === 'stopRecording') {
      const s = started.get(p.id);
      if (!s || s.stopped || r.id !== p.id || summary.actions <= s.actions || !(r.frameCount > 1) || !(r.events > 0) || r.privacy?.masked !== true || r.privacy.maskFailures !== 0 || r.privacy.cleanup?.ok !== true || r.delivery?.persistedFrames !== r.frameCount || r.delivery.extensionFrames !== r.frameCount || ['ingestErrors', 'captureErrors', 'pushErrors'].some(k => r.delivery?.[k] !== 0)) errors.push('NATIVE_GUI_RECORDING_PROOF_REQUIRED');
      else s.stopped = true;
    }
    if (method === 'assembleRecording') {
      const s = started.get(p.id);
      if (!s?.stopped || s.assembled || r.id !== p.id || typeof r.video !== 'string' || !r.video) errors.push('NATIVE_GUI_RECORDING_ASSEMBLY_REQUIRED');
      else { s.assembled = true; summary.recordings++; }
    }
  }
  if (!summary.captures) errors.push('NATIVE_GUI_STATIC_IMAGE_REQUIRED');
  if (policy.behavioral && (!summary.actions || !summary.recordings) || [...started.values()].some(s => !s.assembled)) errors.push('NATIVE_GUI_BEHAVIOR_RECORDING_REQUIRED');
  return { verdict: errors.length ? 'UNGRADED' : 'PASS', errors: [...new Set(errors)], summary };
}
