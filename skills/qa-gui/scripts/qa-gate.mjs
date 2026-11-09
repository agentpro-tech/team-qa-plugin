#!/usr/bin/env node
// qa-gate.mjs v6 — one semantic gate for teamwork schemas 4/5/6 plus sealed qa-gui receipts.
// Schema 3 keeps its proven visual/state receipt path. Unversioned and unknown schemas are
// UNGRADED; no board may fall through to a structural-only PASS.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { comparePngFiles, decodePng } from "./visual-diff.mjs";
import { validateCanonical } from "./teamwork/canonical.mjs";
import { baselineApproverError, BASELINE_PENDING, boardVerdict, declaresBaselinePending } from "./teamwork/board-gates.mjs";
import { caseEnvResetIssues, cellRow, cellSummaryLine, checkGuiReleaseTruthV2, evaluateGuiWebRun, evidenceIssue, evidencePolicyOn, probeVerdict, recordingSegmentIssues, stateCellIssues, stateEnvIssues, stateImageIssues } from "./lib/qa-gui-v2.mjs";
import { caseEvidenceSessionIssues,createGuiReceiptV2,createGuiReceiptWeb,sealObject,verifyTeamQaGuiAttestation } from "./lib/release-receipt-v2.mjs";
import { readGuiReleaseTruthContext,readGuiWebContext,webBindingAfterAttestation } from "./lib/release-truth-v2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, "qa-board.schema.json");
const RE_FAIL = /\bFAIL\b/;
const RE_PASS = /\bPASS\b/;
const TAXONOMY = ["happy","boundary","empty","loading","error","auth-role","navigation","keyboard","responsive","dark-mode"];
const VISION_RULES = ["C10","C11","C12","C13","C14","C15","C16"];
const MIN_RECORDING = 50 * 1024;
const RECEIPT_SCHEMA = "qa-gui/receipt/v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/i;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const isFail = (v) => typeof v === "string" && RE_FAIL.test(v);
const isPassClean = (v) => typeof v === "string" && RE_PASS.test(v) && !RE_FAIL.test(v);
function fail(m) { process.stderr.write(m + "\n"); }

function extractQaData(html) {
  const start = html.indexOf("QA_DATA_START");
  const end = html.indexOf("QA_DATA_END", start + 1);
  if (start < 0 || end < 0 || end <= start) throw new Error("board: missing QA_DATA_START/QA_DATA_END markers");
  const block = html.slice(start, end);
  const asg = /window\.QA_DATA\s*=/.exec(block);
  if (!asg) throw new Error("board: missing window.QA_DATA assignment");
  const after = block.slice(asg.index + asg[0].length).trim();
  const term = after.lastIndexOf(";");
  const json = (term >= 0 ? after.slice(0, term) : after).trim();
  if (!json) throw new Error("board: window.QA_DATA is empty");
  try { return JSON.parse(json); } catch (e) { throw new Error(`board: invalid QA_DATA JSON (${e.message})`); }
}
function loadQaData(path) {
  const text = readFileSync(path, "utf8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(text); }
    catch (error) { throw new Error(`canonical: invalid JSON (${error.message})`); }
  }
  return extractQaData(text);
}
function typeOf(v) { if (Array.isArray(v)) return "array"; if (v === null) return "null"; if (typeof v === "number" && Number.isInteger(v)) return "integer"; return typeof v; }
function resolveRef(root, ref) { const parts = ref.replace(/^#\//, "").split("/"); let cur = root; for (const p of parts) cur = cur && cur[p]; return cur; }
function validate(schema, data, root, path, errors) {
  if (!schema) return;
  if (schema.$ref) return validate(resolveRef(root, schema.$ref), data, root, path, errors);
  if (schema.anyOf) {
    const accepted = schema.anyOf.some((candidate) => { const candidateErrors = []; validate(candidate, data, root, path, candidateErrors); return candidateErrors.length === 0; });
    if (!accepted) errors.push(`${path || "root"}: value does not match any allowed schema`);
    return;
  }
  if (schema.type) { const a = typeOf(data), t = schema.type; const ok = t === "number" ? (a === "integer" || a === "number") : a === t; if (!ok) { errors.push(`${path || "root"}: expected ${t}, got ${a}`); return; } }
  if (schema.enum && !schema.enum.includes(data)) errors.push(`${path}: value ${JSON.stringify(data)} not allowed`);
  if (typeof data === "string" && schema.minLength != null && data.length < schema.minLength) errors.push(`${path}: below minLength ${schema.minLength}`);
  if (typeof data === "number" && schema.minimum != null && data < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
  if (data && typeof data === "object" && !Array.isArray(data) && (schema.properties || schema.required)) {
    for (const req of schema.required || []) if (!Object.hasOwn(data, req)) errors.push(`${path || "root"}: missing required "${req}"`);
    if (schema.properties) for (const [k, sub] of Object.entries(schema.properties)) if (Object.hasOwn(data, k)) validate(sub, data[k], root, path ? `${path}.${k}` : k, errors);
  }
  if (Array.isArray(data) && schema.items) data.forEach((it, i) => validate(schema.items, it, root, `${path}[${i}]`, errors));
}
function humanize(errs, data) {
  return errs.map((e) => { const m = /^cases\[(\d+)\]/.exec(e); if (m) { const c = (data.cases || [])[+m[1]]; const id = c && c.id ? c.id : `#${m[1]}`; return `case ${id} (schema): ${e}`; } return e; });
}
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function checkPng(path, label, errors) {
  try { decodePng(readFileSync(path)); return true; }
  catch (error) { errors.push(`${label}: missing or invalid PNG (${error.message})`); return false; }
}
function relativeVisionPath(data, round, state, suffix = ".png") {
  return `qa-evidence/${data.app}/round-${round}/${data.vision.viewport}/${state}${suffix}`;
}
function safePathSegment(value) { return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && !/[\\/\0]/.test(value); }
function safeEvidencePath(boardDir, value) {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  const absolute = resolve(boardDir, value);
  const prefix = boardDir.endsWith("/") ? boardDir : `${boardDir}/`;
  return absolute.startsWith(prefix) ? absolute : null;
}
function triVerdict(values) {
  if (values.some((value) => value === "FAIL")) return "FAIL";
  if (values.some((value) => value !== "PASS")) return "UNGRADED";
  return "PASS";
}
function cleanVerdict(value) {
  const match = /\b(PASS|FAIL|UNGRADED)\b/.exec(String(value || "").toUpperCase());
  return match ? match[1] : "UNGRADED";
}
function assertionVerdict(item, label, errors) {
  if (!item || typeof item !== "object" || Array.isArray(item)) { errors.push(`${label}: expected object assertion`); return "UNGRADED"; }
  if (typeof item.id !== "string" || !item.id.trim()) errors.push(`${label}: assertion id is required`);
  if (typeof item.evidence !== "string" || !item.evidence.trim()) errors.push(`${label}: raw evidence is required`);
  const verdict = cleanVerdict(item.verdict);
  if (!['PASS','FAIL','UNGRADED'].includes(item.verdict)) errors.push(`${label}: verdict must be PASS, FAIL, or UNGRADED`);
  return verdict;
}
function checkEvidenceIntegrity(data, boardPath, errors) {
  if (data.schemaVersion !== 3) return;
  const boardDir = dirname(resolve(boardPath));
  const screenshots = new Map();
  const videoSegments = new Map();
  const cases = Array.isArray(data.cases) ? data.cases : [];

  for (const c of cases) {
    const id = c?.id || "<unknown>";
    const states = Array.isArray(c?.states) ? c.states : [];
    const links = Array.isArray(c?.stateReceipts) ? c.stateReceipts : [];
    const derivedFunction = [];
    const derivedUi = [];
    for (const state of states) {
      const matches = links.filter((link) => link?.state === state);
      const expectedShot = `qa-evidence/${data.app}/round-${c.round}/${data.viewport}/${state}.png`;
      const expectedShotPath = safeEvidencePath(boardDir, expectedShot);
      if (expectedShotPath && existsSync(expectedShotPath)) {
        const hash = sha256(expectedShotPath);
        const key = `${id}:${state}`;
        const prior = screenshots.get(hash);
        const receiptHintPath = matches.length === 1 ? safeEvidencePath(boardDir, matches[0]?.file) : null;
        let receiptHint = null;
        try { if (receiptHintPath) receiptHint = JSON.parse(readFileSync(receiptHintPath, "utf8")); } catch {}
        if (prior && prior.key !== key) {
          const allowed = receiptHint?.equivalentTo === prior.key && typeof receiptHint?.equivalenceReason === "string" && receiptHint.equivalenceReason.trim();
          if (!allowed) errors.push(`case ${id} state "${state}": duplicate screenshot content also used by ${prior.key}; declare equivalentTo and equivalenceReason only when equivalence is intentional`);
        } else if (!prior) screenshots.set(hash, { key });
      }
      if (matches.length !== 1) {
        errors.push(`case ${id} state "${state}": exactly one state receipt is required`);
        derivedFunction.push("UNGRADED"); derivedUi.push("UNGRADED");
        continue;
      }
      const rel = matches[0]?.file;
      if (!(Array.isArray(c.evidence) && c.evidence.includes(rel))) errors.push(`case ${id} state "${state}": state receipt must be listed in evidence (${String(rel)})`);
      const path = safeEvidencePath(boardDir, rel);
      if (!path) { errors.push(`case ${id} state "${state}": unsafe state receipt path`); derivedFunction.push("UNGRADED"); derivedUi.push("UNGRADED"); continue; }
      let receipt;
      try { receipt = JSON.parse(readFileSync(path, "utf8")); }
      catch (error) { errors.push(`case ${id} state "${state}": missing or invalid state receipt (${error.message})`); derivedFunction.push("UNGRADED"); derivedUi.push("UNGRADED"); continue; }
      const label = `case ${id} state "${state}" receipt`;
      if (receipt?.schema !== "qa-gui/state-receipt/v1") errors.push(`${label}: schema must be qa-gui/state-receipt/v1`);
      if (receipt?.caseId !== id || receipt?.state !== state) errors.push(`${label}: caseId/state binding mismatch`);
      if (receipt?.build !== data.build || receipt?.viewport !== data.viewport) errors.push(`${label}: build/viewport binding mismatch`);
      if (typeof receipt?.capturedAt !== "string" || Number.isNaN(Date.parse(receipt.capturedAt))) errors.push(`${label}: valid capturedAt is required`);
      if (typeof receipt?.url !== "string" || !/^https?:\/\//.test(receipt.url)) errors.push(`${label}: http(s) URL is required`);
      for (const field of ["sessionId", "actionId", "browserInstanceId", "tabId"]) if (typeof receipt?.dragon?.[field] !== "string" || !receipt.dragon[field]) errors.push(`${label}: dragon.${field} is required`);
      if (receipt?.dragon?.innerOk !== true) errors.push(`${label}: Dragon innerOk must be true`);

      const shotRel = receipt?.screenshot?.path;
      if (shotRel !== expectedShot) errors.push(`${label}: screenshot.path must be ${expectedShot}`);
      const shotPath = safeEvidencePath(boardDir, shotRel);
      let hash = null;
      if (shotPath && checkPng(shotPath, `${label} screenshot`, errors)) {
        hash = sha256(shotPath);
        if (receipt?.screenshot?.sha256 !== hash) errors.push(`${label}: screenshot SHA-256 mismatch`);
      }
      const fnAssertions = Array.isArray(receipt?.function?.assertions) ? receipt.function.assertions : [];
      if (fnAssertions.length === 0) errors.push(`${label}: function.assertions[] must contain raw assertions`);
      const fnInputs = fnAssertions.map((item, index) => assertionVerdict(item, `${label} function.assertions[${index}]`, errors));
      if (c.kind === "behavioral") {
        const required = ["before", "action", "network", "readback", "refresh", "postcondition"];
        const lifecycle = receipt?.lifecycle;
        for (const phase of required) fnInputs.push(assertionVerdict(lifecycle?.[phase], `${label} lifecycle.${phase}`, errors));
      }
      const fn = triVerdict(fnInputs);
      if (receipt?.function?.verdict !== fn) errors.push(`${label}: function.verdict ${String(receipt?.function?.verdict)} does not match computed ${fn}`);
      derivedFunction.push(fn);

      const uiParts = [];
      for (const sweep of ["uiSanity", "a11y", "console", "network"]) uiParts.push(assertionVerdict(receipt?.ui?.[sweep], `${label} ui.${sweep}`, errors));
      uiParts.push(assertionVerdict(receipt?.preflight, `${label} preflight`, errors));
      const ui = triVerdict(uiParts);
      if (receipt?.ui?.verdict !== ui) errors.push(`${label}: ui.verdict ${String(receipt?.ui?.verdict)} does not match computed ${ui}`);
      derivedUi.push(ui);

    }
    const fn = triVerdict(derivedFunction);
    const ui = triVerdict(derivedUi);
    if (cleanVerdict(c?.fn) !== fn) errors.push(`case ${id}: fn ${String(c?.fn)} does not match receipt-computed ${fn}`);
    if (cleanVerdict(c?.ui) !== ui) errors.push(`case ${id}: ui ${String(c?.ui)} does not match receipt-computed ${ui}`);
    if (data.release?.verdict === "GO" && (fn !== "PASS" || ui !== "PASS")) errors.push(`case ${id}: release GO requires receipt-computed PASS/PASS`);

    if (c?.kind === "behavioral") {
      const segments = Array.isArray(c.recordingSegments) ? c.recordingSegments : [];
      if (segments.length === 0) errors.push(`case ${id}: behavioral recording segment is required`);
      for (const [index, segment] of segments.entries()) {
        const label = `case ${id} recording segment ${index}`;
        if (typeof segment?.file !== "string" || !(Array.isArray(c.evidence) && c.evidence.includes(segment.file))) errors.push(`${label}: file must be listed in evidence`);
        if (!Number.isFinite(segment?.startMs) || !Number.isFinite(segment?.endMs) || segment.startMs < 0 || segment.endMs <= segment.startMs) errors.push(`${label}: require 0 <= startMs < endMs`);
        const path = safeEvidencePath(boardDir, segment?.file);
        if (!path) { errors.push(`${label}: unsafe file path`); continue; }
        try { if (statSync(path).size < MIN_RECORDING) errors.push(`${label}: recording too small`); }
        catch { errors.push(`${label}: recording is missing`); }
        const used = videoSegments.get(segment.file) || [];
        for (const prior of used) if (Math.max(prior.startMs, segment.startMs) < Math.min(prior.endMs, segment.endMs)) errors.push(`${label}: overlaps ${prior.caseId} in the same recording`);
        used.push({ caseId: id, startMs: segment.startMs, endMs: segment.endMs });
        videoSegments.set(segment.file, used);
      }
    }
  }
}
function checkVision(data, boardPath, errors, notes) {
  if (data.schemaVersion !== 3) return;
  const boardDir = dirname(resolve(boardPath));
  const vision = data.vision;
  if (!vision || typeof vision !== "object" || Array.isArray(vision)) { errors.push("vision: schemaVersion 3 requires vision metadata"); return; }
  if (vision.version !== 1) errors.push("vision.version: expected 1");
  if (!data.app || vision.app !== data.app) errors.push("vision.app: must exactly match board app");
  if (!vision.viewport || vision.viewport !== data.viewport) errors.push("vision.viewport: must exactly match board viewport");
  const appSafe = safePathSegment(data.app), viewportSafe = safePathSegment(vision.viewport);
  if (!appSafe) errors.push("vision.app: must be a safe qa-evidence path segment");
  if (!viewportSafe) errors.push("vision.viewport: must be a safe qa-evidence path segment");
  if (typeof vision.baselineManifest !== "string" || !vision.baselineManifest) { errors.push("vision.baselineManifest: required for schemaVersion 3"); return; }
  if (!appSafe || !viewportSafe) return;
  const canonicalManifest = `qa-evidence/${data.app}/baseline/baseline-manifest.json`;
  if (vision.baselineManifest !== canonicalManifest) errors.push(`vision.baselineManifest: must be canonical (${canonicalManifest})`);

  const manifestPath = resolve(boardDir, canonicalManifest);
  let manifest = null;
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
    catch (error) { errors.push(`vision baseline manifest: invalid JSON (${error.message})`); }
  }
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  if (manifest && !Array.isArray(manifest.entries)) errors.push("vision baseline manifest: entries[] is required");
  for (const [index, entry] of entries.entries()) {
    const label = `vision baseline manifest entry ${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { errors.push(`${label}: expected object`); continue; }
    for (const field of ["state", "viewport", "sha256", "status", "approvedBy", "approvedTs"]) if (!Object.hasOwn(entry, field)) errors.push(`${label}: missing ${field}`);
    if (!safePathSegment(entry.state)) errors.push(`${label}: state must be a safe path segment`);
    if (!safePathSegment(entry.viewport)) errors.push(`${label}: viewport must be a safe path segment`);
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) errors.push(`${label}: invalid sha256`);
    if (entry.status !== "proposed" && entry.status !== "approved") errors.push(`${label}: status must be proposed or approved`);
    if (entry.status === "proposed" && (entry.approvedBy !== "" || entry.approvedTs !== "")) errors.push(`${label}: proposed baseline approval fields must be blank`);
    if (entry.status === "approved") {
      const approverError = baselineApproverError(entry.approvedBy);
      if (approverError) errors.push(`${label}: ${approverError}`);
      if (typeof entry.approvedTs !== "string" || Number.isNaN(Date.parse(entry.approvedTs))) errors.push(`${label}: invalid approvedTs`);
      if (safePathSegment(entry.state) && safePathSegment(entry.viewport)) {
        const entryBaseline = resolve(dirname(manifestPath), entry.viewport, `${entry.state}.png`);
        try { if (/^[a-f0-9]{64}$/i.test(entry.sha256 || "") && sha256(entryBaseline) !== entry.sha256.toLowerCase()) errors.push(`${label}: baseline SHA-256 mismatch`); }
        catch { errors.push(`${label}: approved baseline PNG is missing`); }
      }
    }
  }
  const pending = declaresBaselinePending(data);
  let pendingUsed = false;
  let maskPath;
  const canonicalMask = `qa-evidence/${data.app}/baseline/baseline-mask.json`;
  const configuredMask = typeof vision.baselineMask === "string" && vision.baselineMask ? resolve(boardDir, canonicalMask) : null;
  const defaultMask = join(dirname(manifestPath), "baseline-mask.json");
  if (configuredMask) {
    if (vision.baselineMask !== canonicalMask) errors.push(`vision.baselineMask: must be canonical (${canonicalMask})`);
    if (existsSync(configuredMask)) maskPath = configuredMask;
    else errors.push(`vision baseline mask: missing file (${vision.baselineMask})`);
  } else if (existsSync(defaultMask)) maskPath = defaultMask;

  for (const c of Array.isArray(data.cases) ? data.cases : []) {
    const id = c?.id || "<unknown>";
    const states = Array.isArray(c?.states) ? c.states : [];
    for (const rule of VISION_RULES) {
      const verdict = new RegExp(`(?:^|[^A-Z0-9-])${rule}\\s+(PASS|FAIL|WAIVE)\\b`, "i");
      if (!verdict.test(c?.visual || "")) errors.push(`case ${id}: visual checklist missing ${rule} PASS/FAIL/WAIVE`);
      if (new RegExp(`(?:^|[^A-Z0-9-])${rule}\\s+FAIL\\b`, "i").test(c?.visual || "")) {
        const defect = (Array.isArray(data.defects) ? data.defects : []).find((d) => d?.rule === rule && d.caseId === c.id);
        if (!defect) errors.push(`case ${id}: ${rule} FAIL without matching defect entry`);
      }
    }
    if (/(?:^|[^A-Z0-9-])C15\s+WAIVE\b/i.test(c?.visual || "")) {
      const darkWaiver = (Array.isArray(data.untested) ? data.untested : []).some((item) => item?.area === "dark-mode" && typeof item.reason === "string" && item.reason.length > 0);
      if (!darkWaiver) errors.push(`case ${id}: C15 WAIVE requires untested[] dark-mode reason`);
    }
    for (const state of states) {
      if (!safePathSegment(state)) { errors.push(`case ${id} state "${state}": must be a safe screenshot filename segment`); continue; }
      const actualRel = relativeVisionPath(data, c.round, state);
      const actualPath = resolve(boardDir, actualRel);
      const evidence = Array.isArray(c.evidence) ? c.evidence : [];
      if (!evidence.includes(actualRel)) errors.push(`case ${id} state "${state}": screenshot missing from evidence (${actualRel})`);
      const actualValid = checkPng(actualPath, `case ${id} state "${state}" screenshot`, errors);

      const matching = entries.filter((entry) => entry?.state === state && entry?.viewport === vision.viewport);
      if (matching.length > 1) errors.push(`case ${id} state "${state}": duplicate baseline manifest entries`);
      const approved = matching.find((entry) => entry.status === "approved");
      if (!approved) {
        const proposed = matching.find((entry) => entry?.status === "proposed");
        if (!pending) errors.push(`case ${id} state "${state}": ${proposed ? "proposed baseline is not approved; " : "no approved baseline; "}declare exact outlook "${BASELINE_PENDING}"`);
        else pendingUsed = true;
        continue;
      }
      const approverError = baselineApproverError(approved.approvedBy);
      if (approverError) errors.push(`case ${id} state "${state}": approved baseline ${approverError}`);
      if (typeof approved.approvedTs !== "string" || Number.isNaN(Date.parse(approved.approvedTs))) errors.push(`case ${id} state "${state}": approved baseline has invalid approvedTs`);
      if (!/^[a-f0-9]{64}$/i.test(approved.sha256 || "")) errors.push(`case ${id} state "${state}": approved baseline has invalid sha256`);
      const baselineRel = `qa-evidence/${data.app}/baseline/${vision.viewport}/${state}.png`;
      const baselinePath = resolve(boardDir, baselineRel);
      const baselineValid = checkPng(baselinePath, `case ${id} state "${state}" baseline`, errors);
      if (baselineValid && /^[a-f0-9]{64}$/i.test(approved.sha256 || "") && sha256(baselinePath) !== approved.sha256.toLowerCase()) errors.push(`case ${id} state "${state}": approved baseline SHA-256 mismatch`);
      if (!actualValid || !baselineValid) continue;

      let result;
      try { result = comparePngFiles(baselinePath, actualPath, { state, maskPath }); }
      catch (error) { errors.push(`case ${id} state "${state}": visual diff failed (${error.message})`); continue; }
      const records = Array.isArray(c.visualEvidence) ? c.visualEvidence : [];
      const record = records.find((item) => item?.state === state && item?.viewport === vision.viewport);
      if (result.verdict === "FAIL") {
        const diffRel = relativeVisionPath(data, c.round, state, ".diff.png");
        const diffPath = resolve(boardDir, diffRel);
        const defect = (Array.isArray(data.defects) ? data.defects : []).find((d) => d?.rule === "C-REG" && d.caseId === c.id && d.state === state);
        if (!new RegExp(`\\bC-REG\\s+FAIL\\b`, "i").test(c.visual || "") || !(c.visual || "").includes(diffRel)) errors.push(`case ${id} state "${state}": failing diff must be disclosed as C-REG FAIL with ${diffRel} in visual`);
        if (!record) errors.push(`case ${id} state "${state}": failing diff missing visualEvidence`);
        else {
          if (record.diff !== diffRel) errors.push(`case ${id} state "${state}": visualEvidence.diff must be ${diffRel}`);
          if (record.severity !== result.severity) errors.push(`case ${id} state "${state}": visualEvidence severity ${record.severity || "<none>"} does not match ${result.severity}`);
          if (typeof record.diffPercent !== "number" || Math.abs(record.diffPercent - result.diffPercent) > 0.000001) errors.push(`case ${id} state "${state}": visualEvidence diffPercent does not match recomputed ${result.diffPercent}`);
        }
        if (!defect) errors.push(`case ${id} state "${state}": failing diff missing C-REG defect`);
        else {
          if (defect.sev !== result.severity) errors.push(`case ${id} state "${state}": C-REG severity ${defect.sev || "<none>"} does not match ${result.severity}`);
          if (!(Array.isArray(defect.evidence) && defect.evidence.includes(diffRel))) errors.push(`case ${id} state "${state}": C-REG defect evidence missing ${diffRel}`);
        }
        if (!evidence.includes(diffRel)) errors.push(`case ${id} state "${state}": diff image missing from case evidence (${diffRel})`);
        try {
          if (!readFileSync(diffPath).equals(result.diffPng)) errors.push(`case ${id} state "${state}": diff image is stale or does not match recomputed pixels (${diffRel})`);
        } catch { errors.push(`case ${id} state "${state}": missing diff image (${diffRel})`); }
      } else if (record) {
        if (typeof record.diffPercent !== "number" || Math.abs(record.diffPercent - result.diffPercent) > 0.000001) errors.push(`case ${id} state "${state}": visualEvidence diffPercent does not match recomputed ${result.diffPercent}`);
      }
    }
  }
  if (pendingUsed) notes.push(BASELINE_PENDING);
}

function checkSemantics(data, boardPath, errors, notes) {
  const boardDir = dirname(resolve(boardPath));
  const defects = Array.isArray(data.defects) ? data.defects : [];
  const cases = Array.isArray(data.cases) ? data.cases : [];
  for (const c of cases) {
    const id = (c && typeof c === "object" && c.id) ? c.id : "<unknown>";
    const states = (c && Array.isArray(c.states)) ? c.states : [];
    if (c && c.kind === "behavioral") {
      const rec = (Array.isArray(c.evidence) ? c.evidence : []).filter((e) => typeof e === "string" && e.toLowerCase().endsWith(".mp4"));
      if (rec.length === 0) errors.push(`case ${id}: behavioral case missing recording (<none>)`);
      for (const r of rec) {
        try { const sz = statSync(resolve(boardDir, r)).size; if (sz < MIN_RECORDING) errors.push(`case ${id}: recording too small ${sz}B < 50KB (${r})`); }
        catch { errors.push(`case ${id}: behavioral case missing recording (${r})`); }
      }
    }
    if (c && (isFail(c.fn) || isFail(c.ui))) {
      const has = defects.some((d) => d && typeof d === "object" && d.caseId === c.id && typeof d.rule === "string" && d.rule && typeof d.sev === "string" && d.sev);
      if (!has) errors.push(`case ${id}: FAIL without defect entry`);
    }
    const sw = (c && Array.isArray(c.sweeps)) ? c.sweeps : [];
    const swStates = new Set(sw.filter((x) => x && typeof x === "object").map((x) => x.state));
    if (states.length === 0) errors.push(`case ${id}: no states[] declared (cannot verify per-state sweeps)`);
    for (const st of states) if (!swStates.has(st)) errors.push(`case ${id} state "${st}": missing per-state sweep (ui-sanity + console — spec 4.4.3)`);
  }
  const cov = Array.isArray(data.coverage) ? data.coverage : [];
  const done = new Set(cov.filter((x) => x && (x.status === "tick" || x.status === "waive")).map((x) => x.area));
  for (const tax of TAXONOMY) if (!done.has(tax)) errors.push(`coverage: taxonomy area "${tax}" not tick/waive (Orient checklist incomplete)`);
  const rel = data.release;
  if (rel && typeof rel === "object" && rel.verdict === "GO-WITH-RISKS") {
    const risks = Array.isArray(rel.risks) ? rel.risks : [];
    for (const d of defects) { if (!d || typeof d !== "object" || d.status === "closed") continue; if (!risks.includes(d.id)) errors.push(`release GO-WITH-RISKS missing risk ${d.id || "<unknown>"}`); }
  }
  if (cases.length > 3) {
    let earliest = Infinity;
    for (const c of cases) for (const e of (Array.isArray(c.evidence) ? c.evidence : [])) { if (typeof e !== "string") continue; try { const m = statSync(resolve(boardDir, e)).mtimeMs; if (m < earliest) earliest = m; } catch {} }
    if (earliest !== Infinity) { const bc = Date.parse(data.boardCreated); if (Number.isNaN(bc)) errors.push(`boardCreated: missing/invalid datetime (spec 4.4.1)`); else if (bc >= earliest) errors.push(`plan-after-run: boardCreated (${data.boardCreated}) not before earliest evidence (${new Date(Math.round(earliest)).toISOString()}) (spec 4.4.1)`); }
  }
  checkVision(data, boardPath, errors, notes);
  checkEvidenceIntegrity(data, boardPath, errors);
}

function addIssue(issues, message, ungraded = false) {
  issues.push({ message, ...(ungraded ? { ungraded: true } : {}) });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function integrityOf(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function unknownKeys(value, allowed, label, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addIssue(issues, `L22 ${label}: unknown field ${key}`, true);
  }
}

function receiptAssertion(item, label, evidencePaths, issues, options = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    addIssue(issues, `${options.rule || "A05"} ${label}: machine-readable assertion is required`, true);
    return { verdict: "UNGRADED", evidenceRef: null, requirementId: null };
  }
  const allowed = options.requirement
    ? new Set(["requirement_id", "verdict", "evidence_ref"])
    : new Set(["verdict", "evidence_ref", "writes_data", "expect_net"]);
  unknownKeys(item, allowed, label, issues);
  const verdict = ["PASS", "FAIL", "UNGRADED"].includes(item.verdict) ? item.verdict : "UNGRADED";
  if (verdict === "UNGRADED" && item.verdict !== "UNGRADED") addIssue(issues, `${options.rule || "A05"} ${label}: verdict is missing or invalid`, true);
  const evidenceRef = typeof item.evidence_ref === "string" && item.evidence_ref ? item.evidence_ref : null;
  if (!evidenceRef) addIssue(issues, `${options.rule || "A05"} ${label}: evidence_ref is required`, true);
  else if (!evidencePaths.has(evidenceRef)) addIssue(issues, `A06 ${label}: evidence_ref is absent from evidenceManifest (${evidenceRef})`);
  const requirementId = options.requirement && typeof item.requirement_id === "string" && item.requirement_id
    ? item.requirement_id : null;
  if (options.requirement && !requirementId) addIssue(issues, `A09 ${label}: requirement_id is required`);
  return { verdict, evidenceRef, requirementId };
}

function legacyUiAssertion(item, label, issues) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    addIssue(issues, `A05 ${label}: raw machine assertion is required`, true);
    return "UNGRADED";
  }
  unknownKeys(item, new Set(["id", "verdict", "evidence"]), label, issues);
  if (typeof item.id !== "string" || !item.id) addIssue(issues, `A05 ${label}: id is required`, true);
  if (typeof item.evidence !== "string" || !item.evidence) addIssue(issues, `A05 ${label}: raw evidence is required`, true);
  if (!["PASS", "FAIL", "UNGRADED"].includes(item.verdict)) {
    addIssue(issues, `A05 ${label}: verdict is missing or invalid`, true);
    return "UNGRADED";
  }
  return item.verdict;
}

function loadReleaseTruthReceipt(path, label, issues) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    addIssue(issues, `A05 ${label}: missing or invalid state receipt (${error.message})`, true);
    return null;
  }
}

function checkReleaseTruthSemantics(data, boardPath, issues, notes, computed) {
  const boardDir = dirname(resolve(boardPath));
  for (const [field, value] of [
    ["build", data.build], ["env", data.env], ["db", data.db], ["role", data.role], ["testProfile", data.testProfile],
  ]) {
    if (typeof value !== "string" || !value.trim()) addIssue(issues, `${field}: UNGRADED runtime binding is required`, true);
  }
  if (!UUID_RE.test(data.runUuid || "")) addIssue(issues, "runUuid: UNGRADED valid UUID is required", true);
  if (!/^[0-9a-f]{40}$/i.test(data.commit || "")) addIssue(issues, "commit: UNGRADED full 40-character SHA is required", true);
  if (!Array.isArray(data.evidenceManifest)) addIssue(issues, "evidenceManifest: UNGRADED array is required", true);
  const manifest = Array.isArray(data.evidenceManifest) ? data.evidenceManifest : [];
  const evidencePaths = new Map();
  for (const [index, entry] of manifest.entries()) {
    const label = `evidenceManifest[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      addIssue(issues, `A11 ${label}: expected {path,sha256}`, true);
      continue;
    }
    const rel = entry.path;
    const path = safeEvidencePath(boardDir, rel);
    if (!path) {
      addIssue(issues, `A11 ${label}: unsafe path ${String(rel)}`);
      continue;
    }
    if (evidencePaths.has(rel)) addIssue(issues, `A11 ${label}: duplicate manifest path ${rel}`);
    evidencePaths.set(rel, entry);
    if (!existsSync(path)) {
      addIssue(issues, `A06 ${label}: evidence file is missing (${rel})`);
      continue;
    }
    if (!SHA_RE.test(entry.sha256 || "")) addIssue(issues, `A11 ${label}: invalid SHA-256 for ${rel}`, true);
    else if (sha256(path) !== entry.sha256.toLowerCase()) addIssue(issues, `A11 ${label}: SHA-256 mismatch for ${rel}`);
  }

  const screenshots = new Map();
  const cases = Array.isArray(data.cases) ? data.cases : [];
  const completedCases = cases.filter((entry) => entry?.status !== "TODO");
  // Evidence policy v1 (R1f): image and recording checks that can keep a case from PASS (lib/evidence-quality.mjs).
  const policy = evidencePolicyOn(data);
  let covered = 0;
  let total = 0;

  for (const c of completedCases) {
    const id = c?.id || "<unknown>";
    const requirements = Array.isArray(c?.requirements) ? c.requirements : [];
    if (requirements.length === 0) addIssue(issues, `A09 case ${id}: requirements[] is required`, true);
    if (!["static", "behavioral"].includes(c?.kind)) addIssue(issues, `A25 case ${id}: kind must be static or behavioral`, true);
    total += requirements.length;
    const states = Array.isArray(c?.states) ? c.states : [];
    const links = Array.isArray(c?.stateReceipts) ? c.stateReceipts : [];
    const assertionGroups = new Map(requirements.map((requirement) => [requirement, []]));
    const functionParts = [];
    const uiParts = [];
    const networks = [];
    let readback = null;
    let lifecycle = null;
    let derivedBehavioral = false;
    let receiptUnavailable = false;
    let evidenceRejected = false;
    const envStates = [];

    if (states.length === 0) {
      addIssue(issues, `A05 case ${id}: states[] is required before grading`, true);
      receiptUnavailable = true;
    }
    for (const evidence of Array.isArray(c?.evidence) ? c.evidence : []) {
      if (!evidencePaths.has(evidence)) addIssue(issues, `A06 case ${id}: evidence is absent from evidenceManifest (${evidence})`);
    }

    for (const state of states) {
      const matches = links.filter((link) => link?.state === state);
      if (matches.length !== 1) {
        addIssue(issues, `A05 case ${id} state "${state}": exactly one state receipt is required`, true);
        functionParts.push("UNGRADED");
        uiParts.push("UNGRADED");
        receiptUnavailable = true;
        continue;
      }
      const rel = matches[0].file;
      if (!(Array.isArray(c.evidence) && c.evidence.includes(rel))) addIssue(issues, `A06 case ${id} state "${state}": receipt must be listed in case evidence (${rel})`);
      if (!evidencePaths.has(rel)) addIssue(issues, `A06 case ${id} state "${state}": receipt is absent from evidenceManifest (${rel})`);
      const path = safeEvidencePath(boardDir, rel);
      if (!path) {
        addIssue(issues, `A05 case ${id} state "${state}": unsafe state receipt path`, true);
        receiptUnavailable = true;
        continue;
      }
      const receipt = loadReleaseTruthReceipt(path, `case ${id} state "${state}"`, issues);
      if (!receipt) { receiptUnavailable = true; continue; }
      const label = `case ${id} state "${state}" receipt`;
      unknownKeys(receipt, new Set([
        "schema", "caseId", "state", "capturedAt", "url", "build", "viewport", "domHash",
        "dragon", "screenshot", "function", "ui", "preflight", "network", "readback", "lifecycle",
        "equivalentTo", "equivalenceReason", "target", "cell", "env", "probes",
      ]), label, issues);
      if (receipt.schema !== "qa-gui/state-receipt/v1") addIssue(issues, `A05 ${label}: schema must be qa-gui/state-receipt/v1`, true);
      if (receipt.caseId !== id || receipt.state !== state) addIssue(issues, `A05 ${label}: caseId/state binding mismatch`, true);
      if (receipt.build !== data.build || receipt.viewport !== data.viewport) addIssue(issues, `A05 ${label}: build/viewport binding mismatch`, true);
      if (typeof receipt.capturedAt !== "string" || Number.isNaN(Date.parse(receipt.capturedAt))) addIssue(issues, `A05 ${label}: capturedAt is required`, true);
      if (typeof receipt.url !== "string" || !/^https?:\/\//.test(receipt.url)) addIssue(issues, `A05 ${label}: http(s) URL is required`, true);
      if (!SHA_RE.test(receipt.domHash || "")) addIssue(issues, `A05 ${label}: domHash SHA-256 is required`, true);
      unknownKeys(receipt.dragon, new Set(["sessionId", "actionId", "browserInstanceId", "tabId", "innerOk"]), `${label}.dragon`, issues);
      unknownKeys(receipt.screenshot, new Set(["path", "sha256", "capture", "fit"]), `${label}.screenshot`, issues);
      unknownKeys(receipt.function, new Set(["verdict", "assertions"]), `${label}.function`, issues);
      unknownKeys(receipt.ui, new Set(["verdict", "uiSanity", "a11y", "console", "network"]), `${label}.ui`, issues);
      if (receipt.readback != null) unknownKeys(receipt.readback, new Set(["value", "evidence_ref"]), `${label}.readback`, issues);
      if (receipt.lifecycle != null) unknownKeys(receipt.lifecycle, new Set(["before", "action", "network", "readback", "refresh", "postcondition"]), `${label}.lifecycle`, issues);
      for (const field of ["sessionId", "actionId", "browserInstanceId", "tabId"]) {
        if (typeof receipt?.dragon?.[field] !== "string" || !receipt.dragon[field]) addIssue(issues, `A05 ${label}: dragon.${field} is required`, true);
      }
      if (receipt?.dragon?.innerOk !== true) addIssue(issues, `A05 ${label}: dragon.innerOk must be true`, true);

      let stateRejected = false;
      const shotRel = receipt?.screenshot?.path;
      const shotPath = safeEvidencePath(boardDir, shotRel);
      if (!shotRel || !evidencePaths.has(shotRel)) addIssue(issues, `A06 ${label}: screenshot is absent from evidenceManifest (${String(shotRel)})`);
      if (!shotPath || !existsSync(shotPath)) addIssue(issues, `A06 ${label}: screenshot is missing (${String(shotRel)})`);
      else {
        const shotHash = sha256(shotPath);
        if (receipt?.screenshot?.sha256 !== shotHash) addIssue(issues, `A11 ${label}: screenshot SHA-256 mismatch`);
        const key = `${id}:${state}`;
        const prior = screenshots.get(shotHash);
        if (prior && prior.key !== key) {
          const equivalent = receipt.equivalentTo === prior.key
            && typeof receipt.equivalenceReason === "string" && receipt.equivalenceReason.trim()
            && receipt.domHash === prior.domHash;
          if (!equivalent) addIssue(issues, `A11 ${label}: equivalentTo requires the referenced state and identical machine-measured domHash`);
        } else if (!prior) screenshots.set(shotHash, { key, domHash: receipt.domHash });
        if (policy) {
          const problems = stateImageIssues({ png: readFileSync(shotPath), receipt, caseId: id, state });
          for (const problem of problems) addIssue(issues, problem.message, true);
          if (problems.length) { evidenceRejected = true; stateRejected = true; functionParts.push("UNGRADED"); uiParts.push("UNGRADED"); }
        }
      }
      // R1b: a coverage cell the receipt cannot back (malformed, or contradicted by its own row count or viewport) keeps
      // the state from PASS, like rejected evidence (lib/coverage-cell.mjs, references/coverage-cells.md).
      const cellProblems = stateCellIssues(receipt);
      for (const problem of cellProblems) addIssue(issues, `A05 ${label}: cell ${problem.code}${problem.detail ? ` ${problem.detail}` : ""}`, true);
      if (cellProblems.length) { evidenceRejected = true; stateRejected = true; functionParts.push("UNGRADED"); uiParts.push("UNGRADED"); }

      const assertions = Array.isArray(receipt?.function?.assertions) ? receipt.function.assertions : [];
      if (assertions.length === 0) addIssue(issues, `A09 ${label}: function.assertions[] is required`);
      const stateFunction = [];
      for (const [index, item] of assertions.entries()) {
        const parsed = receiptAssertion(item, `${label}.function.assertions[${index}]`, evidencePaths, issues, { requirement: true, rule: "A09" });
        stateFunction.push(parsed.verdict);
        if (parsed.requirementId && assertionGroups.has(parsed.requirementId)) assertionGroups.get(parsed.requirementId).push(parsed);
        else if (parsed.requirementId) addIssue(issues, `A09 ${label}: assertion names undeclared requirement ${parsed.requirementId}`);
      }
      const computedStateFunction = triVerdict(stateFunction);
      if (receipt?.function?.verdict !== computedStateFunction) addIssue(issues, `A08 ${label}: function.verdict ${String(receipt?.function?.verdict)} does not match computed ${computedStateFunction}`);
      functionParts.push(computedStateFunction);

      const stateUi = [];
      for (const field of ["uiSanity", "a11y", "console", "network"]) stateUi.push(legacyUiAssertion(receipt?.ui?.[field], `${label}.ui.${field}`, issues));
      stateUi.push(legacyUiAssertion(receipt.preflight, `${label}.preflight`, issues));
      // R1e/R1d: the detectors' probe receipts (width sweep, overlay check, transient probe) join the state's UI verdict.
      const probed = probeVerdict({ receipt, caseId: id, state, read: readFileSync,
        locate: (rel) => { const path = evidencePaths.has(rel) ? safeEvidencePath(boardDir, rel) : null; return path ? { absolute: path, sha256: evidencePaths.get(rel)?.sha256 ?? null } : null; } });
      if (probed) { for (const entry of probed.issues) addIssue(issues, entry.message, entry.ungraded); stateUi.push(probed.verdict); }
      const computedStateUi = triVerdict(stateUi);
      if (receipt?.ui?.verdict !== computedStateUi) addIssue(issues, `A08 ${label}: ui.verdict ${String(receipt?.ui?.verdict)} does not match computed ${computedStateUi}`);
      uiParts.push(computedStateUi);
      // R1d: the Dragon environment conditions the state ran under, and the case's env.reset (lib/dragon-env.mjs).
      const envState = stateEnvIssues({ receipt, caseId: id, state, read: readFileSync,
        locate: (rel) => { const path = evidencePaths.has(rel) ? safeEvidencePath(boardDir, rel) : null; return path && existsSync(path) ? { absolute: path } : null; } });
      envStates.push(envState);
      for (const entry of envState.issues) addIssue(issues, entry.message, true);
      if (envState.issues.length) { evidenceRejected = true; stateRejected = true; functionParts.push("UNGRADED"); uiParts.push("UNGRADED"); }
      if (Object.hasOwn(receipt, "cell")) computed.cells.push(cellRow({ caseId: id, state, receipt, receiptRef: rel, verdict: stateRejected ? "UNGRADED" : triVerdict([computedStateFunction, computedStateUi]) }));

      const stateNetwork = Array.isArray(receipt.network) ? receipt.network : [];
      for (const [index, entry] of stateNetwork.entries()) {
        const networkLabel = `${label}.network[${index}]`;
        unknownKeys(entry, new Set(["method", "url", "status"]), networkLabel, issues);
        const method = String(entry?.method || "").toUpperCase();
        if (!method || typeof entry?.url !== "string" || !Number.isInteger(entry?.status)) addIssue(issues, `A08 ${networkLabel}: method, url and integer status are required`, true);
        if (MUTATING_METHODS.has(method)) derivedBehavioral = true;
        networks.push({ method, url: entry?.url, status: entry?.status });
      }
      if (receipt?.lifecycle?.action?.writes_data === true || receipt?.lifecycle?.network?.expect_net === true) derivedBehavioral = true;
      if (receipt.lifecycle) lifecycle = receipt.lifecycle;
      if (receipt.readback != null) readback = receipt.readback;
    }

    // R1d: a case that ran with env conditions or a transient probe ends with a verified env.reset, or it cannot PASS.
    const envReset = caseEnvResetIssues({ caseId: id, states: envStates });
    for (const entry of envReset) addIssue(issues, entry.message, true);
    if (envReset.length) { evidenceRejected = true; functionParts.push("UNGRADED"); uiParts.push("UNGRADED"); }
    if (receiptUnavailable) {
      computed.cases.push({ id, requirements, assertions: [], kind: c.kind, lifecycle: null, network: [], readback: null });
      computed.functionParts.push("UNGRADED");
      computed.uiParts.push("UNGRADED");
      continue;
    }

    const passingRequirements = [];
    for (const requirement of requirements) {
      const assertions = assertionGroups.get(requirement) || [];
      if (assertions.length === 0) addIssue(issues, `A09 case ${id}: requirement ${requirement} has no matching assertion`);
      else if (triVerdict(assertions.map((entry) => entry.verdict)) === "PASS") passingRequirements.push(requirement);
    }
    if (derivedBehavioral && c.kind !== "behavioral") addIssue(issues, `A25 case ${id}: mutating network/expectNet derives kind behavioral, not ${c.kind}`);
    if (derivedBehavioral) {
      const mutating = networks.filter((entry) => MUTATING_METHODS.has(entry.method));
      if (mutating.length === 0) {
        addIssue(issues, `A08 case ${id}: write lifecycle requires a raw mutating network entry`, true);
        functionParts.push("UNGRADED");
      } else {
        functionParts.push(mutating.every((entry) => entry.status >= 200 && entry.status < 400) ? "PASS" : "FAIL");
      }
      if (!readback || !Object.hasOwn(readback, "value") || typeof readback.evidence_ref !== "string") {
        addIssue(issues, `A08 case ${id}: write lifecycle requires machine readback value and evidence_ref`, true);
        functionParts.push("UNGRADED");
      }
      else if (!evidencePaths.has(readback.evidence_ref)) addIssue(issues, `A06 case ${id}: readback evidence_ref is absent from evidenceManifest (${readback.evidence_ref})`);
    }
    if (c.kind === "behavioral") {
      for (const phase of ["before", "action", "network", "readback", "refresh", "postcondition"]) {
        const parsed = receiptAssertion(lifecycle?.[phase], `case ${id}.lifecycle.${phase}`, evidencePaths, issues, { rule: "A08" });
        functionParts.push(parsed.verdict);
      }
      const recordings = (Array.isArray(c.evidence) ? c.evidence : []).filter((path) => typeof path === "string" && path.toLowerCase().endsWith(".mp4"));
      if (recordings.length === 0) {
        addIssue(issues, `A08 case ${id}: behavioral case missing screen recording`, true);
        functionParts.push("UNGRADED");
      }
      for (const recording of recordings) {
        const path = safeEvidencePath(boardDir, recording);
        try { if (!path || statSync(path).size < MIN_RECORDING) addIssue(issues, `A08 case ${id}: recording is missing or smaller than 50KB (${recording})`); }
        catch { addIssue(issues, `A08 case ${id}: recording is missing (${recording})`); }
      }
      if (policy) {
        const segments = Array.isArray(c.recordingSegments) ? c.recordingSegments : [];
        const problems = [];
        if (segments.length === 0) problems.push(evidenceIssue("EVIDENCE_VIDEO_MANIFEST", `${id}:segment-0`, "a behavioral case needs recordingSegments[{file,startMs,endMs,manifest}]"));
        for (const [index, segment] of segments.entries()) {
          const scope = `${id}:segment-${index}`;
          const listed = (ref) => typeof ref === "string" && Array.isArray(c.evidence) && c.evidence.includes(ref) && evidencePaths.has(ref);
          const videoPath = safeEvidencePath(boardDir, segment?.file);
          const manifestPath = safeEvidencePath(boardDir, segment?.manifest);
          if (!listed(segment?.file) || !videoPath || !existsSync(videoPath)) { problems.push(evidenceIssue("EVIDENCE_VIDEO_MANIFEST", scope, `recording ${String(segment?.file)} must be in the case evidence and the evidence manifest`)); continue; }
          if (!listed(segment?.manifest) || !manifestPath || !existsSync(manifestPath)) { problems.push(evidenceIssue("EVIDENCE_VIDEO_MANIFEST", scope, `manifest ${String(segment?.manifest)} must be in the case evidence and the evidence manifest`)); continue; }
          let manifest = null;
          try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch {}
          problems.push(...recordingSegmentIssues({ manifest, segment, videoSha256: sha256(videoPath), caseId: id, index }));
        }
        for (const problem of problems) addIssue(issues, problem.message, true);
        if (problems.length) { evidenceRejected = true; functionParts.push("UNGRADED"); }
      }
    }

    if (!evidenceRejected) covered += passingRequirements.length;
    const functionVerdict = triVerdict(functionParts);
    const uiVerdict = triVerdict(uiParts);
    if (functionVerdict === "FAIL" || uiVerdict === "FAIL") addIssue(issues, `case ${id}: receipt-computed semantic FAIL`);
    if (functionVerdict === "UNGRADED" || uiVerdict === "UNGRADED") addIssue(issues, `case ${id}: receipt-computed verdict is UNGRADED`, true);
    if (c.functionVerdict !== functionVerdict) addIssue(issues, `A08 case ${id}: board functionVerdict ${c.functionVerdict} does not match receipt-computed ${functionVerdict}`);
    if (c.uiVerdict !== uiVerdict) addIssue(issues, `A08 case ${id}: board uiVerdict ${c.uiVerdict} does not match receipt-computed ${uiVerdict}`);

    // Rejected evidence cannot back a PASS: the receipt's requirement rows say UNGRADED instead.
    const assertions = [...assertionGroups.entries()].map(([requirement_id, entries]) => {
      const verdict = entries.length ? triVerdict(entries.map((entry) => entry.verdict)) : "UNGRADED";
      return { requirement_id, verdict: evidenceRejected && verdict === "PASS" ? "UNGRADED" : verdict, evidence_ref: entries.at(-1)?.evidenceRef || "" };
    });
    computed.cases.push({ id, requirements, assertions, kind: derivedBehavioral ? "behavioral" : c.kind, lifecycle, network: networks, readback });
    computed.functionParts.push(functionVerdict);
    computed.uiParts.push(uiVerdict);
  }

  const openDefects = (Array.isArray(data.defects) ? data.defects : []).filter((entry) => !["CLOSED", "REJECTED", "closed", "rejected"].includes(entry?.status));
  if (data.release?.verdict === "GO") {
    for (const c of completedCases) {
      if (["FAIL", "BLOCKED"].includes(c.status) || c.functionVerdict !== "PASS" || c.uiVerdict !== "PASS") addIssue(issues, `A18 H16 release GO blocked by case ${c.id}`);
    }
    for (const defect of openDefects) addIssue(issues, `A18 H16 release GO blocked by open defect ${defect.id}`);
  }
  if (data.release?.verdict === "GO-WITH-RISKS") {
    const approval = data.release.approval;
    if (typeof approval?.by !== "string" || !approval.by.trim() || typeof approval?.ts !== "string" || Number.isNaN(Date.parse(approval.ts))) {
      addIssue(issues, "release GO-WITH-RISKS requires a named approval with a valid timestamp", true);
    }
  }
  computed.acceptance = { covered, total };
  // No completed case means no part to combine: that is UNGRADED, not the PASS triVerdict([]) gives. The empty case is
  // handled here because the receipt-level callers of triVerdict compare its result with receipt-authored verdicts.
  computed.functionVerdict = computed.functionParts.length ? triVerdict(computed.functionParts) : "UNGRADED";
  computed.uiVerdict = computed.uiParts.length ? triVerdict(computed.uiParts) : "UNGRADED";
  notes.push(`Requirements: ${covered}/${total}`);
}

// Where a receipt goes: <base>/.teamcode/runs/<run uuid>/receipts/qa-gui.receipt.json. The base is the working folder,
// as before, unless that folder is inside an installed skill or plugin (this QA GUI when it is installed, that is holds
// SOURCE.json; ~/.agents/skills, ~/.claude/skills, ~/.codex/skills, a Claude Code or Codex plugin folder;
// CLAUDE_CONFIG_DIR honoured): then it is the board's folder, next to the run, so a receipt never lands inside an
// install that an update replaces (L1). A source checkout keeps the working folder.
const QA_GUI_ROOT = fileURLToPath(new URL("../", import.meta.url));
const realOr = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
function receiptBase(boardPath, { cwd = process.cwd(), home = homedir(), env = process.env } = {}) {
  const claude = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, ".claude");
  const installs = [...(existsSync(join(QA_GUI_ROOT, "SOURCE.json")) ? [QA_GUI_ROOT] : []), join(home, ".agents", "skills"), join(claude, "skills"), join(claude, "plugins"), join(home, ".claude", "skills"), join(home, ".claude", "plugins"),
    join(home, ".codex", "skills"), join(home, ".codex", "plugins")].map(realOr);
  const here = realOr(cwd);
  return installs.some((root) => here === root || here.startsWith(root.endsWith(sep) ? root : root + sep)) ? dirname(resolve(boardPath)) : cwd;
}

function writeGateReceipt(data, computed, semanticVerdict, boardPath) {
  if (!UUID_RE.test(data.runUuid || "")) return null;
  const unsigned = {
    schema: RECEIPT_SCHEMA,
    run_uuid: data.runUuid,
    commit: data.commit,
    build: data.build,
    env: data.env,
    db: data.db,
    role: data.role,
    test_profile: data.testProfile,
    cases: computed.cases,
    evidence_manifest: data.evidenceManifest,
    function_verdict: computed.functionVerdict,
    ui_verdict: computed.uiVerdict,
    execution_status: "completed",
    semantic_verdict: semanticVerdict,
    created_at: new Date().toISOString(),
  };
  const receipt = { ...unsigned, integrity: integrityOf(unsigned) };
  const target = resolve(receiptBase(boardPath), ".teamcode", "runs", data.runUuid, "receipts", "qa-gui.receipt.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
  return target;
}

function writeGateReceiptV2(data, context, semanticVerdict, atomicCoverage, teamqa=null, boardPath=".") {
  if (!UUID_RE.test(data.runUuid || "")) return null;
  const receipt = sealObject({...createGuiReceiptV2({ context, data, semanticVerdict, atomicCoverage }),...(teamqa||{})});
  const target = resolve(receiptBase(boardPath), ".teamcode", "runs", data.runUuid, "receipts", "qa-gui.receipt.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
  return target;
}

function printSummary(data, notes, verdict = "PASS", receiptPath = null, computed = null) {
  const cases = Array.isArray(data.cases) ? data.cases : [];
  const teamwork = [4, 5, 6].includes(data.schemaVersion);
  const passed = cases.filter((c) => teamwork
    ? c.functionVerdict === "PASS" && c.uiVerdict === "PASS"
    : isPassClean(c.fn) && isPassClean(c.ui)).length;
  const total = cases.length;
  const pct = total === 0 ? "0.0" : ((passed / total) * 100).toFixed(1);
  process.stdout.write(`QA gate: ${verdict}\n`);
  process.stdout.write(`Pass rate: ${passed}/${total} (${pct}%)\n`);
  if (teamwork) {
    process.stdout.write(`Defects: ${(data.defects || []).length} · Canonical: ${data.canonicalVersion}\n`);
    if (data.schemaVersion === 6) {
      const links = cases.reduce((total, entry) => total + (Array.isArray(entry.sourceRefs) ? entry.sourceRefs.length : 0), 0);
      const sourceCount = Array.isArray(data.sourceItems) ? data.sourceItems.length : 0;
      process.stdout.write(`Source traceability: ${sourceCount} ${sourceCount === 1 ? "source" : "sources"} · ${links} ${links === 1 ? "case link" : "case links"}\n`);
    }
  }
  else {
    const sev = { critical: 0, major: 0, minor: 0 };
    for (const d of (data.defects || [])) if (d && Object.hasOwn(sev, d.sev)) sev[d.sev]++;
    process.stdout.write(`Defects: critical=${sev.critical} major=${sev.major} minor=${sev.minor}\n`);
  }
  process.stdout.write(`Coverage: ${(data.coverage || []).length}/${TAXONOMY.length} · Release: ${data.release && data.release.verdict ? data.release.verdict : "—"}\n`);
  if (computed?.acceptance) process.stdout.write(`Requirement coverage: ${computed.acceptance.covered}/${computed.acceptance.total}\n`);
  // R1b: printed only when some state receipt named its coverage cell, so older boards print what they always printed.
  const cells = cellSummaryLine(computed?.cells);
  if (cells) process.stdout.write(`${cells}\n`);
  if (receiptPath) process.stdout.write(`Receipt: ${receiptPath}\n`);
  for (const note of notes) process.stdout.write(`Vision: ${note}\n`);
}
function loadSchema() { try { return JSON.parse(readFileSync(SCHEMA_PATH, "utf8")); } catch { return null; } }

function parseCli(argv) {
  if (argv.length === 0 || argv[0].startsWith("--")) throw new Error("missing canonical board");
  const boardPath = argv[0];
  const options = {};
  const allowed = new Set(["--plan", "--requirements", "--repo", "--evidence-root", "--teamqa-attestation", "--teamqa-runtime", "--web-binding", "--run-dir", "--case"]);
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--")) throw new Error(`invalid flag or missing value: ${flag || "(empty)"}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (Object.hasOwn(options, key)) throw new Error(`duplicate flag: ${flag}`);
    options[key] = value;
  }
  const supplied = ["plan", "requirements", "repo", "evidenceRoot"].filter((key) => Object.hasOwn(options, key));
  if (options.webBinding) {
    if (!options.plan || !options.requirements || !options.evidenceRoot || !options.runDir || !options.teamqaAttestation || options.repo) throw new Error("web-v1 needs --web-binding, --run-dir, --plan, --requirements, --evidence-root and --teamqa-attestation; it does not accept --repo");
    return { boardPath, ...options, webMode: true, releaseTruthV2: false };
  }
  if (options.case) throw new Error("--case is only used with web-v1 (--web-binding)");
  if (supplied.length !== 0 && supplied.length !== 4) throw new Error("release-truth v2 requires all of --plan, --requirements, --repo and --evidence-root");
  return { boardPath, ...options, webMode: false, releaseTruthV2: supplied.length === 4 };
}

// The gate ends by setting process.exitCode and returning, never process.exit(): on macOS, process.exit() while a V8
// worker thread is busy can hang forever in platform shutdown (uv_thread_join); a QA GUI release test hung 16 minutes on
// Node 26 and again on Node 24 on 30/10. A normal return also flushes stdout to a pipe in full.
function main() {
  let cli;
  try { cli = parseCli(process.argv.slice(2)); }
  catch (error) {
    fail("usage: node scripts/qa-gate.mjs <canonical.json|board.html> [--plan <tracked-plan.json> --requirements <REQUIREMENTS.json> --repo <git> --evidence-root <run-root>] | [--web-binding <run/binding.json> --run-dir <run> --plan <tracked-plan.json> --requirements <REQUIREMENTS.json> --evidence-root <run-root> --teamqa-attestation <executor_gui.json> [--teamqa-runtime <team-qa-runtime>]]");
    fail(error.message);
    { process.exitCode = 2; return; }
  }
  const { boardPath } = cli;
  let data;
  try { data = loadQaData(boardPath); }
  catch (e) { fail(`UNGRADED: ${e.message}`); { process.exitCode = 20; return; } }
  if (data === null || typeof data !== "object" || Array.isArray(data)) { fail("UNGRADED: board QA_DATA must be an object"); { process.exitCode = 20; return; } }
  if (!Object.hasOwn(data, "schemaVersion")) {
    fail("A17 H15 UNGRADED: schemaVersion is required; migrate the board to schema 4, 5, or 6");
    process.stdout.write("QA gate: UNGRADED\n");
    { process.exitCode = 20; return; }
  }
  if (![3, 4, 5, 6].includes(data.schemaVersion)) {
    fail(`A17 UNGRADED: unsupported schemaVersion ${String(data.schemaVersion)}; migrate to schema 4, 5, or 6`);
    process.stdout.write("QA gate: UNGRADED\n");
    { process.exitCode = 20; return; }
  }
  if (data.schemaVersion === 3) {
    fail("A17 H15 UNGRADED: schemaVersion 3 is retired; migrate the board to canonical schema 5");
    process.stdout.write("QA gate: UNGRADED\n");
    { process.exitCode = 20; return; }
  }
  const issues = [];
  const notes = [];
  const computed = { cases: [], functionParts: [], uiParts: [], functionVerdict: "PASS", uiVerdict: "PASS", acceptance: { covered: 0, total: 0 }, cells: [] };
  let v2 = null;
  let v2Context = null;
  let canonicalOk = false;
  let teamqa = null;
  if (cli.webMode) {
    const result = validateCanonical(data);
    for (const error of result.errors) addIssue(issues, `${error.path}: ${error.message}`, true);
    canonicalOk = result.ok && [5, 6].includes(data.schemaVersion);
    try {
      const binding = JSON.parse(readFileSync(cli.webBinding, 'utf8'));
      teamqa = verifyTeamQaGuiAttestation({
        attestationPath: cli.teamqaAttestation, runtimeRoot: cli.teamqaRuntime,
        runUuid: data.runUuid, requirementsHash: binding.requirements_hash,
        targetBindingSha256: binding.target_binding_sha256, caseId: cli.case ?? null,
      });
      v2Context = readGuiWebContext({ bindingPath: cli.webBinding, requirementsPath: cli.requirements,
        planPath: cli.plan, runDir: cli.runDir, verifyWebBinding: webBindingAfterAttestation });
    } catch (error) { addIssue(issues, error.message, true); }
    if (canonicalOk && v2Context && teamqa) {
      v2 = evaluateGuiWebRun({ data, boardPath, evidenceRoot: cli.evidenceRoot, context: v2Context });
      issues.push(...v2.issues); notes.push(...(v2.notes || []));
      if (v2.computed) Object.assign(computed, v2.computed);
      if (!v2.receiptEligible) addIssue(issues, 'WEB_RECEIPT_EVIDENCE_INELIGIBLE', true);
      if (cli.case) for (const problem of caseEvidenceSessionIssues({ data, caseId: cli.case, evidenceRoot: cli.evidenceRoot, sessions: teamqa.teamqa_provenance.executor_route?.dragon_sessions })) addIssue(issues, problem, true);
    }
  } else if (cli.releaseTruthV2) {
    if (![5, 6].includes(data.schemaVersion)) addIssue(issues, "RELEASE_TRUTH_V2_REQUIRES_SCHEMA_5_OR_6", true);
    const result = validateCanonical(data);
    for (const error of result.errors) addIssue(issues, `${error.path}: ${error.message}`, true);
    canonicalOk = result.ok && [5, 6].includes(data.schemaVersion);
    try {
      v2Context = readGuiReleaseTruthContext(cli.requirements, { plan: cli.plan, repo: cli.repo });
    } catch (error) {
      addIssue(issues, error.message, true);
    }
    if (canonicalOk && v2Context) {
      v2 = checkGuiReleaseTruthV2({
        data,
        boardPath,
        evidenceRoot: cli.evidenceRoot,
        context: v2Context,
      });
      issues.push(...v2.issues);
      notes.push(...v2.notes);
      Object.assign(computed, v2.computed);
    }
  } else {
    const result = validateCanonical(data);
    for (const error of result.errors) addIssue(issues, `${error.path}: ${error.message}`, true);
    if (result.ok) checkReleaseTruthSemantics(data, boardPath, issues, notes, computed);
  }
  // Every mode: a board on which no case ran has nothing to grade, and a GO cannot stand while a case is still TODO.
  // Without this the default mode skipped TODO cases and graded an all-TODO board (the shipped example) as PASS.
  const boardCases = Array.isArray(data.cases) ? data.cases : [];
  const todoIds = boardCases.filter((entry) => entry?.status === 'TODO').map((entry) => String(entry?.id || '<unknown>'));
  if (todoIds.length === boardCases.length) addIssue(issues, cli.webMode ? 'WEB_CASES_NOT_EXECUTED' : 'CASES_NOT_EXECUTED', true);
  if (data.release?.verdict === 'GO' && todoIds.length > 0) addIssue(issues, `RELEASE_GO_WITH_TODO_CASES:${todoIds.join(',')}`, true);
  const semanticVerdict = boardVerdict(issues);
  for (const issue of issues) fail(`${issue.ungraded ? "UNGRADED " : ""}${issue.message}`);
  const completed = Array.isArray(data.cases) && data.cases.some((entry) => entry?.status !== "TODO");
  if(!cli.webMode && (cli.teamqaAttestation||cli.teamqaRuntime)){try{if(!cli.teamqaAttestation||!v2Context)throw new Error("TEAMQA_GUI_ATTESTATION_AND_V2_REQUIRED");teamqa=verifyTeamQaGuiAttestation({attestationPath:cli.teamqaAttestation,runtimeRoot:cli.teamqaRuntime,runUuid:data.runUuid,exactFinalSha:v2Context.exactFinalSha,requirementsHash:v2Context.requirementsHash});}catch(error){fail("UNGRADED: "+error.message);{ process.exitCode = 20; return; }}}
  let receiptPath = null;
  if (completed && cli.webMode && canonicalOk && v2Context && teamqa && v2?.receiptEligible) {
    try {
      const receipt = createGuiReceiptWeb({ context: v2Context, data, semanticVerdict, atomicCoverage: v2.atomicCoverage, teamqa });
      receiptPath = resolve(receiptBase(boardPath), '.teamcode', 'runs', data.runUuid, 'receipts', 'qa-gui.receipt.json');
      mkdirSync(dirname(receiptPath), { recursive: true });
      if (existsSync(receiptPath)) {
        const archive = resolve(dirname(dirname(receiptPath)), 'archive', 'receipts');
        mkdirSync(archive, { recursive: true });
        copyFileSync(receiptPath, resolve(archive, `qa-gui-${sha256(receiptPath)}.receipt.json`));
      }
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    } catch (error) { fail(error.message); { process.exitCode = 20; return; } }
  } else if (completed && cli.releaseTruthV2 && canonicalOk && v2Context && v2?.receiptEligible) {
    try { receiptPath = writeGateReceiptV2(data, v2Context, semanticVerdict, v2.atomicCoverage, teamqa, boardPath); }
    catch (error) {
      fail(error.message);
      { process.exitCode = 20; return; }
    }
  } else if (completed && !cli.releaseTruthV2 && !cli.webMode) {
    receiptPath = writeGateReceipt(data, computed, semanticVerdict, boardPath);
  }
  printSummary(data, notes, semanticVerdict, receiptPath, computed);
  if (semanticVerdict === "PASS") { process.exitCode = 0; return; }
  if (semanticVerdict === "UNGRADED") { process.exitCode = 20; return; }
  { process.exitCode = 1; return; }
}
main();
