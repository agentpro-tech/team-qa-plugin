import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fail, readJson, rejectUnknownFields, sha256File, stableJson } from './core.mjs';
import { readLockedRunDocuments } from './run-contract.mjs';
import { verifyBoardDelivery } from './board-quality.mjs';

export const SPACE_CREATE_PAGE_TOOL = 'mcp__codex_apps__chatgpt_space_create_page';
const WRITE_SCHEMA = 'team-qa/board-write/v1';
const requireValue = (ok, code, detail = '') => { if (!ok) fail(3, code, detail, 'ungraded'); };

function pinnedFile(runDir, lock, name) {
  const artifact = lock.artifacts?.[name];
  requireValue(artifact && typeof artifact.path === 'string', 'BOARD_WRITE_LOCK_REF_MISSING', name);
  const path = resolve(runDir, artifact.path);
  const rel = relative(resolve(runDir), path);
  requireValue(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'BOARD_WRITE_LOCK_PATH', name);
  requireValue(existsSync(path) && sha256File(path) === artifact.sha256, 'BOARD_WRITE_LOCK_STALE', name);
  return realpathSync(path);
}

function validateDestination(destination) {
  rejectUnknownFields(destination, ['space_id', 'parent_page_id', 'idempotency_key', 'position'], 'BOARD_WRITE_DESTINATION_FIELDS');
  requireValue(destination && typeof destination === 'object' && !Array.isArray(destination), 'BOARD_WRITE_DESTINATION_INVALID');
  for (const key of ['space_id', 'parent_page_id', 'idempotency_key']) {
    if (Object.hasOwn(destination, key)) requireValue(typeof destination[key] === 'string' && destination[key].trim(), 'BOARD_WRITE_DESTINATION_INVALID', key);
  }
  if (Object.hasOwn(destination, 'position')) requireValue(destination.position === null || (Number.isInteger(destination.position) && destination.position >= 0), 'BOARD_WRITE_DESTINATION_INVALID', 'position');
  return destination;
}

function pageProjection(file, payloadPath, destination, verifyDelivery) {
  verifyDelivery({ file, artifactPath: payloadPath, renderer: 'space' });
  const payload = readJson(payloadPath);
  rejectUnknownFields(payload, ['protocol', 'title', 'initial_blocks', 'canonical'], 'BOARD_WRITE_PAYLOAD_FIELDS');
  requireValue(payload.protocol === 'qa-gui/page-export/v1' && typeof payload.title === 'string' && payload.title.trim()
    && Array.isArray(payload.initial_blocks) && payload.canonical && typeof payload.canonical === 'object', 'BOARD_WRITE_PAYLOAD_INVALID');
  const destinationFields = validateDestination(destination);
  const toolInput = { ...destinationFields, title: payload.title, initial_blocks: payload.initial_blocks };
  return { payload, toolInput };
}

function ref(path) { return { path: realpathSync(path), sha256: sha256File(path) }; }
function writeOnce(out, value) {
  const bytes = stableJson(value);
  requireValue(!existsSync(out), 'BOARD_WRITE_OUTPUT_EXISTS', out);
  writeFileSync(out, bytes, { flag: 'wx' });
  requireValue(readFileSync(out, 'utf8') === bytes, 'BOARD_WRITE_READBACK', out);
}

export function prepareBoardWrite({ file, artifactPath, destination, out, verifyDelivery = verifyBoardDelivery }) {
  requireValue(typeof file === 'string' && existsSync(file) && typeof artifactPath === 'string' && existsSync(artifactPath), 'BOARD_WRITE_INPUT_MISSING');
  const canonical = realpathSync(file), payloadPath = realpathSync(artifactPath);
  requireValue(typeof out === 'string' && out.trim(), 'BOARD_WRITE_OUTPUT_REQUIRED');
  const { toolInput } = pageProjection(canonical, payloadPath, destination, verifyDelivery);
  const request = { schema: WRITE_SCHEMA, canonical: ref(canonical), payload: ref(payloadPath), tool_name: SPACE_CREATE_PAGE_TOOL, tool_input: toolInput };
  writeOnce(resolve(out), request);
  return request;
}

export function inspectBoardWrite({ runDir, toolName, toolInput, verifyDelivery = verifyBoardDelivery }) {
  try {
    requireValue(toolName === SPACE_CREATE_PAGE_TOOL, 'BOARD_CONNECTOR_UNSUPPORTED_PROJECTION', toolName);
    requireValue(toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput), 'BOARD_WRITE_TOOL_INPUT_INVALID');
    const rosterPath = resolve(runDir, 'roster.json');
    const roster = { ...readJson(rosterPath), roster_hash: sha256File(rosterPath) };
    const lock = readLockedRunDocuments(runDir, roster, { requirePublication: true });
    const canonical = pinnedFile(runDir, lock, 'board');
    const payloadPath = pinnedFile(runDir, lock, 'board_payload');
    const qualityPath = pinnedFile(runDir, lock, 'board_quality');
    const requestPath = pinnedFile(runDir, lock, 'board_write');
    requireValue(realpathSync(qualityPath) === realpathSync(`${payloadPath}.quality.json`), 'RUN_BOARD_QUALITY_PATH');
    const request = readJson(requestPath);
    rejectUnknownFields(request, ['schema', 'canonical', 'payload', 'tool_name', 'tool_input'], 'BOARD_WRITE_REQUEST_FIELDS');
    requireValue(request.schema === WRITE_SCHEMA && request.tool_name === SPACE_CREATE_PAGE_TOOL, 'BOARD_WRITE_REQUEST_SCHEMA');
    const actual = pageProjection(canonical, payloadPath, Object.fromEntries(Object.entries(request.tool_input || {})
      .filter(([key]) => ['space_id', 'parent_page_id', 'idempotency_key', 'position'].includes(key))), verifyDelivery);
    requireValue(stableJson(request.canonical) === stableJson(ref(canonical))
      && stableJson(request.payload) === stableJson(ref(payloadPath)), 'BOARD_WRITE_REQUEST_BINDING');
    requireValue(stableJson(request.tool_input) === stableJson(actual.toolInput)
      && stableJson(toolInput) === stableJson(actual.toolInput), 'BOARD_WRITE_TOOL_INPUT_MISMATCH');
    return { allowed: true, code: 'BOARD_WRITE_ADMITTED', canonical, payload: payloadPath, quality: qualityPath, request: requestPath };
  } catch (error) {
    return { allowed: false, code: error?.code || error?.message || 'BOARD_WRITE_ADMISSION_FAILED' };
  }
}
