import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './core.mjs';
import { latestAttemptByCase } from './attempt-sequence.mjs';
import { isRtmEmpty, isRtmRequirementHeaderLine } from './report-tokens.mjs';
import { isDeployedTarget, assertWebBinding, deployedTargetShapeErrors, WEB_CONTRACT_SHA256 } from './deployed-target.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CONTRACT_SHA256 = '77433f4c204e7f32848976b585cfb901152f97b775726467a0a5128eb3ec362c';

export const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const integrityFor = (value) => { const clean = structuredClone(value); delete clean.integrity; return digest(JSON.stringify(stable(clean))); };
export const seal = (value) => ({ ...value, integrity: integrityFor(value) });

export function readContract() {
  const file = path.join(ROOT, 'contracts/release-truth-contract/v2/CONTRACT.json');
  if (!fs.existsSync(file)) fail(2, 'CONTRACT_MISSING', file);
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'));
  const observed = {};
  for (const name of fs.readdirSync(path.dirname(file)).filter((item) => item.endsWith('.schema.json')).sort()) {
    const raw = fs.readFileSync(path.join(path.dirname(file), name));
    const schema = JSON.parse(raw);
    observed[schema.title] = digest(raw);
  }
  if (JSON.stringify(stable(observed)) !== JSON.stringify(stable(contract.schemas))) fail(2, 'CONTRACT_SCHEMA_HASH_MISMATCH');
  if (digest(JSON.stringify(stable(observed))) !== contract.contract_sha256) fail(2, 'CONTRACT_DIGEST_MISMATCH');
  if (contract.contract_sha256 !== CONTRACT_SHA256) fail(2, 'CONTRACT_SHA_MISMATCH');
  return contract;
}

export function verifyReceiptShape(receipt) {
  const web = receipt?.schema === 'team-qa/receipt/web-v1';
  if (!web) readContract();
  if (!receipt || !['team-qa/receipt/v1','team-qa/receipt/v2','team-qa/receipt/web-v1'].includes(receipt.schema)) fail(2, 'RECEIPT_SCHEMA');
  if (web) {
    const keys = ['schema','contract_sha256','run_uuid','requirements_hash','verification_lane','target_kind','target_binding_sha256','target','artifacts','plan_case_total','executed','missing_ids','rtm_filled','rtm_total','release_verdict','created_at','run_provenance','integrity'];
    // board_delivery (upgrade U5) is present only when an unattended run completed with its board undelivered.
    if (Object.keys(receipt).some(key => !keys.includes(key) && key !== 'board_delivery') || keys.some(key => !Object.hasOwn(receipt,key))) fail(2,'WEB_RECEIPT_FIELDS');
    if (Object.hasOwn(receipt,'board_delivery') && receipt.board_delivery !== 'blocked') fail(2,'RECEIPT_BOARD_DELIVERY');
    if (receipt.contract_sha256 !== WEB_CONTRACT_SHA256 || receipt.verification_lane !== 'gui' || receipt.target_kind !== 'deployed-build' || deployedTargetShapeErrors(receipt.target).length || receipt.target_binding_sha256 !== receipt.target.target_binding_sha256) fail(2,'WEB_RECEIPT_BINDING');
    if (receipt.run_provenance?.schema !== 'team-qa/run-provenance/v1' || !Array.isArray(receipt.run_provenance.artifacts) || !receipt.run_provenance.roster_hash) fail(2,'RECEIPT_RUN_PROVENANCE_REQUIRED');
    if (!/^[a-f0-9]{64}$/.test(receipt.requirements_hash || '') || !/^[a-f0-9]{64}$/.test(receipt.integrity || '')) fail(2,'RECEIPT_HASH');
    if (!['GO','NO-GO','UNGRADED'].includes(receipt.release_verdict)) fail(2,'RECEIPT_VERDICT');
    if (integrityFor(receipt) !== receipt.integrity) fail(2,'RECEIPT_INTEGRITY');
    return receipt;
  }
  if (Object.hasOwn(receipt,'board_delivery') && (receipt.schema!=='team-qa/receipt/v2' || receipt.board_delivery !== 'blocked')) fail(2,'RECEIPT_BOARD_DELIVERY');
  if(receipt.schema==='team-qa/receipt/v2' && (receipt.run_provenance?.schema!=='team-qa/run-provenance/v1'||!Array.isArray(receipt.run_provenance.artifacts)||!receipt.run_provenance.roster_hash))fail(2,'RECEIPT_RUN_PROVENANCE_REQUIRED');
  if (receipt.contract_sha256 !== CONTRACT_SHA256) fail(2, 'RECEIPT_CONTRACT_SHA');
  if (!/^[a-f0-9]{40}$/.test(receipt.task_base || '') || !/^[a-f0-9]{40}$/.test(receipt.exact_final_sha || '')) fail(2, 'RECEIPT_BINDING_SHA');
  if (!/^[a-f0-9]{64}$/.test(receipt.requirements_hash || '') || !/^[a-f0-9]{64}$/.test(receipt.integrity || '')) fail(2, 'RECEIPT_HASH');
  if (!['GO', 'NO-GO', 'UNGRADED'].includes(receipt.release_verdict)) fail(2, 'RECEIPT_VERDICT');
  if (integrityFor(receipt) !== receipt.integrity) fail(2, 'RECEIPT_INTEGRITY');
  return receipt;
}

function countRtm(text) {
  const lines = text.split(/\r?\n/);
  // RTM tokens come from report-tokens.mjs; an RTM written with the legacy tokens is counted the same way.
  const sourceHeader = lines.find((line) => line.startsWith('| Source |'));
  if (sourceHeader) {
    const header = sourceHeader.split('|').slice(1, -1).map((part) => part.trim());
    const caseAt = header.indexOf('Case');
    const verdictAt = header.indexOf('Verdict');
    const evidenceAt = header.indexOf('Evidence');
    if ([caseAt, verdictAt, evidenceAt].some((index) => index < 0)) return { total: 0, filled: 0 };
    const rows = lines
      .filter((line) => /^\|[^-].*\|$/.test(line) && line !== sourceHeader)
      .map((line) => line.split('|').slice(1, -1).map((part) => part.trim()))
      .filter((cells) => cells[caseAt] && !isRtmEmpty(cells[caseAt]));
    return {
      total: rows.length,
      filled: rows.filter((cells) => cells[verdictAt] && cells[evidenceAt]).length,
    };
  }
  const rows = text.split(/\r?\n/).filter((line) => /^\|[^-].*\|$/.test(line) && !isRtmRequirementHeaderLine(line));
  const verdicts = rows.map((line) => line.split('|').map((part) => part.trim()).filter((_part, index, all) => index > 0 && index < all.length - 1).at(-1) || '');
  return { total: verdicts.length, filled: verdicts.filter(Boolean).length };
}

export function createTeamQaReceipt({ runDir, runUuid, binding, computedDecision = 'NO_GO' }) {
  const web = binding?.schema === 'team-qa/web-binding/v1';
  if (web) {
    try { assertWebBinding(binding, { runDir, requireProof: false }); }
    catch (error) { fail(2, 'WEB_BINDING_INVALID', error.message); }
  } else {
    readContract();
    if (binding.contract_sha256 !== CONTRACT_SHA256) fail(2, 'BINDING_CONTRACT_SHA');
  }
  if (!['GO', 'NO_GO'].includes(computedDecision)) fail(2, 'COMPUTED_DECISION_INVALID');
  const files = { plan: 'test-plan.md', tracked_plan: 'tracked-plan.json', board: 'board.jsonl', rtm: 'rtm.md', summary: 'summary-report.md' };
  for (const [name, relative] of Object.entries(files)) if (!fs.existsSync(path.join(runDir, relative))) fail(2, 'RECEIPT_ARTIFACT_MISSING', name);
  const tracked = JSON.parse(fs.readFileSync(path.join(runDir, files.tracked_plan), 'utf8'));
  const boardText = fs.readFileSync(path.join(runDir, files.board), 'utf8');
  let rows;
  try { rows = boardText.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { fail(2, 'RECEIPT_BOARD_INVALID'); }
  const history = latestAttemptByCase(rows);
  if (history.issue) fail(2, 'RECEIPT_ATTEMPT_HISTORY_INVALID', history.issue);
  const current = [...history.latestByCase.values()].filter(Boolean);
  const pending = new Set(current.filter((row) => row.verdict === 'pending').map((row) => row.case_id));
  const present = new Set(current.map((row) => row.case_id));
  const missingIds = tracked.cases.filter((item) => !present.has(item.id) || pending.has(item.id)).map((item) => item.req_id || item.id);
  const rtm = countRtm(fs.readFileSync(path.join(runDir, files.rtm), 'utf8'));
  const summary = fs.readFileSync(path.join(runDir, files.summary), 'utf8');
  const releaseVerdict = computedDecision === 'GO' && missingIds.length === 0 && rtm.filled === rtm.total ? 'GO' : 'NO-GO';
  const artifacts = Object.fromEntries(Object.entries(files).map(([name, relative]) => [name, { path: relative, sha256: digest(fs.readFileSync(path.join(runDir, relative))) }]));
  return seal({
    schema: web ? 'team-qa/receipt/web-v1' : 'team-qa/receipt/v1', contract_sha256: web ? WEB_CONTRACT_SHA256 : CONTRACT_SHA256, run_uuid: runUuid,
    ...(web ? { target_kind:'deployed-build', target_binding_sha256:binding.target_binding_sha256, target:binding.target }
      : { task_base:binding.task_base, source_revision:binding.source_revision, exact_final_sha:binding.exact_final_sha }),
    requirements_hash: binding.requirements_hash, verification_lane: web ? 'gui' : 'all', artifacts,
    plan_case_total: tracked.cases.length, executed: current.filter((row) => ['pass', 'fail', 'ungraded'].includes(row.verdict)).length,
    missing_ids: missingIds, rtm_filled: rtm.filled, rtm_total: rtm.total, release_verdict: releaseVerdict,
    created_at: new Date().toISOString(),
  });
}

export function verifyTeamQaReceipt(receipt, receiptFile) {
  verifyReceiptShape(receipt);
  const runDir = path.dirname(receiptFile);
  for (const [name, artifact] of Object.entries(receipt.artifacts || {})) {
    const file = path.resolve(runDir, artifact.path);
    if (!file.startsWith(`${runDir}${path.sep}`) || !fs.existsSync(file)) fail(2, `RECEIPT_ARTIFACT_MISSING:${name}`);
    if (digest(fs.readFileSync(file)) !== artifact.sha256) fail(2, `RECEIPT_ARTIFACT_HASH:${name}`);
  }
  return receipt;
}

export function rtmStats(text) { return countRtm(text); }
