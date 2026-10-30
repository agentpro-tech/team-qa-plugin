const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const RPC_KEYS = new Set(['method', 'params', 'timeout']);
const IDENTITY = ['sessionId', 'nonce', 'browserInstanceId'];

function deny(code, detail) {
  return { allowed: false, code, ...(detail ? { detail } : {}) };
}

function allow(code, { requiresLive, mutating }) {
  return { allowed: true, code, requiresLive, mutating };
}

function exactKeys(value, allowed) {
  return object(value) && Object.keys(value).every(key => allowed.includes(key));
}

function validIdentity(params, session, { tab = false } = {}) {
  return object(params)
    && IDENTITY.every(key => typeof session?.[key] === 'string' && session[key] && params[key] === session[key])
    && (!tab || Number.isInteger(session.tabId) && params.tabId === session.tabId);
}

function requestShape(request) {
  if (!object(request) || !exactKeys(request, [...RPC_KEYS]) || typeof request.method !== 'string' || !object(request.params)) return false;
  return request.timeout === undefined || Number.isInteger(request.timeout) && request.timeout >= 1 && request.timeout <= 35000;
}

function childInspection(childInspector, args) {
  if (typeof childInspector !== 'function') return { errors: ['DRAGON_POLICY_INSPECTOR_MISSING'] };
  try {
    const result = childInspector(args);
    if (!object(result) || !Array.isArray(result.errors)) return { errors: ['DRAGON_POLICY_INSPECTION_INVALID'] };
    if (result.verdict !== 'PASS' || result.errors.length) return { errors: result.errors.length ? result.errors : ['DRAGON_POLICY_INSPECTION_FAILED'] };
    return result;
  } catch (error) {
    return { errors: [typeof error?.message === 'string' && error.message ? error.message : 'DRAGON_POLICY_INSPECTION_FAILED'] };
  }
}

function policyScopeMatches(policy, session, targetUrl) {
  return object(policy) && policy.target?.url === targetUrl
    && policy.dragon?.sessionId === session.sessionId
    && policy.dragon?.nonce === session.nonce
    && policy.dragon?.browserInstanceId === session.browserInstanceId
    && policy.dragon?.tabId === session.tabId;
}

/**
 * Decide whether one actual Dragon RPC may cross PreToolUse. `session` must be
 * the verified receipt-backed registration snapshot, never data from request.
 */
export function inspectDragonAdmission({ request, session, targetUrl, executionAllowed = false, policy, childInspector } = {}) {
  if (!requestShape(request)) return deny('DRAGON_REQUEST_INVALID');
  const { method, params } = request;
  if (!object(session) || typeof session.sessionId !== 'string' || !session.sessionId
    || typeof session.runId !== 'string' || !session.runId || typeof session.owner !== 'string' || !session.owner) {
    return deny('DRAGON_SESSION_UNREGISTERED');
  }
  if (typeof targetUrl !== 'string' || !targetUrl || session.targetUrl !== targetUrl) return deny('DRAGON_TARGET_SCOPE_MISMATCH');
  if (session.closed === true) return deny('DRAGON_SESSION_CLOSED');

  if (method === 'session.create') {
    if (!exactKeys(params, ['sessionId', 'forbidSyntheticDOM'])) return deny('DRAGON_REQUEST_PARAMS_UNKNOWN');
    if (session.created === true) return deny('DRAGON_SESSION_ALREADY_CREATED');
    if (session.created !== false || params.sessionId !== session.sessionId) return deny('DRAGON_CREATE_NOT_RUN_OWNED');
    if (params.forbidSyntheticDOM !== false) return deny('DRAGON_SYNTHETIC_DOM_POLICY');
    return allow('DRAGON_CREATE_SCOPED', { requiresLive: false, mutating: true });
  }

  if (method === 'session.setPolicy') return deny('DRAGON_ACTIVE_POLICY_CHANGE_DENIED');
  if (method === 'session.close') {
    if (!exactKeys(params, IDENTITY) || !validIdentity(params, session)) return deny('DRAGON_CLOSE_NOT_RUN_OWNED');
    if (session.created !== true) return deny('DRAGON_SESSION_NOT_ACTIVE');
    return allow('DRAGON_OWN_SESSION_CLOSE', { requiresLive: true, mutating: true });
  }
  if (method === 'session.list' || method === 'session.getPolicy') {
    if (!exactKeys(params, ['sessionId']) || session.created !== true || params.sessionId !== session.sessionId) return deny('DRAGON_SESSION_READ_NOT_OWNED');
    return allow('DRAGON_OWN_SESSION_READ', { requiresLive: true, mutating: false });
  }
  if (method === 'openTab') {
    if (!exactKeys(params, [...IDENTITY, 'url', 'active']) || session.created !== true || Number.isInteger(session.tabId)) return deny('DRAGON_OPEN_TAB_STATE');
    if (!validIdentity(params, session) || params.url !== targetUrl || params.active !== false) return deny('DRAGON_OPEN_TAB_SCOPE');
    return allow('DRAGON_TARGET_TAB_OPEN', { requiresLive: true, mutating: true });
  }
  const tabRequired = method !== 'stopRecording' && method !== 'assembleRecording';
  if (session.created !== true || !validIdentity(params, session, { tab: tabRequired })) return deny('DRAGON_SESSION_IDENTITY_MISMATCH');
  if (!Number.isInteger(session.tabId)) return deny('DRAGON_SESSION_IDENTITY_MISMATCH');
  if (!policy) return deny('DRAGON_NATIVE_POLICY_INVALID', 'DRAGON_POLICY_MISSING');
  if (!policyScopeMatches(policy, session, targetUrl)) return deny('DRAGON_POLICY_SCOPE_MISMATCH');
  if (!Array.isArray(policy.capabilities) || !policy.capabilities.includes(method)) return deny('DRAGON_CAPABILITY_UNAPPROVED', method);

  const inspected = childInspection(childInspector, { request, policy, session, targetUrl });
  if (inspected.errors.length) return deny('DRAGON_NATIVE_POLICY_INVALID', inspected.errors.join(','));
  if (inspected.requiresLive !== true || typeof inspected.mutating !== 'boolean' || typeof inspected.hasTrustedAction !== 'boolean'
    || inspected.hasTrustedAction && !inspected.mutating) return deny('DRAGON_POLICY_INSPECTION_INVALID');
  if (inspected.hasTrustedAction && executionAllowed !== true) {
    return deny('DRAGON_EXECUTION_NOT_ALLOWED');
  }
  return allow(inspected.mutating ? 'DRAGON_MUTATING_OPERATION_SCOPED' : 'DRAGON_READ_ONLY_SCOPED', { requiresLive: inspected.requiresLive, mutating: inspected.mutating });
}
