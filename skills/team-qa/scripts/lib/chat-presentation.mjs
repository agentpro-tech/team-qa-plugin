import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, readJson, rejectUnknownFields, sha256File, stableJson, writeConfirmed, runAdapter, outputJson, visibleCodexAssistantText } from './core.mjs';
import { boardComparePage, boardIntegrityVerify } from '../board-teamwork.mjs';
import { verifyBoardDelivery } from './board-quality.mjs';
import { assertToolPreflight, readHostToolEvidence } from './tool-preflight.mjs';
import { homedir } from 'node:os';
import { scanOriginalSource } from './original-source.mjs';
import { estimateLines } from './cost.mjs';
import { siblingSkillRoot } from './install-layout.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const need = (v, code, detail = '') => { if (!v) fail(3, code, detail, 'ungraded'); };
const cell = v => String(v ?? '—').replaceAll('|', '&#124;').replaceAll(/\r?\n/g, ' ');

export function rosterChat(roster, hash) {
  const labels = readJson(join(ROOT, 'references/chat-labels.json'));
  const rows = roster.roles.map(s => {
    const [name, task] = labels.roles[s.role] ?? [];
    need(name && task && labels.routes[s.harness], 'ROSTER_CHAT_ROLE_UNKNOWN', s.role);
    return `| ${name} | ${cell(s.provider ?? '—')} / ${cell(s.model ?? 'Node')} | ${cell(s.effort)} | ${labels.routes[s.harness]} | ${task} |`;
  });
  const details = roster.roles.map(s => `- ${labels.roles[s.role][0]}: tools=${cell((s.tools ?? []).join(', '))}; permissions=${cell(s.permission_profile)}; timeout=${s.caps.timeout_ms}ms; max_turns=${s.caps.max_turns}.`);
  // R2a: the adjudicator seat, only when the roster has one (a roster without it shows the table of before).
  const a = roster.adjudicator;
  if (a) {
    const [name, task] = labels.adjudicator;
    need(name && task && labels.routes[a.harness], 'ROSTER_CHAT_ROLE_UNKNOWN', 'adjudicator');
    rows.push(`| ${name} (${cell(a.mode)}) | ${cell(a.provider)} / ${cell(a.model)} | ${cell(a.effort)} | ${labels.routes[a.harness]} | ${task} |`);
    details.push(`- ${name}: family=${cell(a.family)}; executor families: ${Object.entries(a.executor_families).map(([role, family]) => `${role}=${cell(family)}`).join(', ')}; mode=${cell(a.mode)} (${labels.adjudicator_modes[a.mode]}); scope=${cell(a.scope)} (${labels.adjudicator_scopes[a.scope]}); tools=${cell(a.tools.join(', '))}; permissions=${cell(a.permission_profile)}; timeout=${a.caps.timeout_ms}ms; max_turns=${a.caps.max_turns}.`);
  }
  return [`**${labels.roster_title}**`, '', `Run: ${cell(roster.run_id)} · Round: ${roster.round}`,
    `Scope: ${cell(roster.scope)}`, `Target: ${cell(roster.target.project_id)} · ${cell(roster.target.preview_url)} · ${cell(roster.target.version)}`,
    ...(roster.run_mode === 'unattended' ? ['Run mode: unattended (nobody watching). If the board review is still not PASS after 3 fix rounds, the board is not handed over and the run still reaches COMPLETE with board_delivery: blocked.'] : []), '',
    labels.roster_columns, '|---|---|---|---|---|', ...rows, '', ...details, '', ...estimateLines(roster).flatMap(line => [line, '']), labels.availability, '', labels.approval, '',
    `TEAMQA_ROSTER run=${roster.run_id} round=${roster.round} sha256=${hash}`].join('\n');
}

function latestAssistantMessage(event, marker) {
  // The caller verifies the original human event first. Tool stdout is never a chat message.
  let latest;
  scanOriginalSource(event.source.path,(line,i) => {
    if(i>=event.source.line-1||!line.includes(marker))return;
    try {
      const e = JSON.parse(line), p = e.payload ?? e.message ?? e;
      if (p.role !== 'assistant' || (p.type && p.type !== 'message')) return;
      const codex = e.type === 'response_item';
      if (codex && !visibleCodexAssistantText(e)) return;
      if (!codex && (e.type !== 'assistant' || p.channel === 'analysis' || e.isSidechain === true || e.isApiErrorMessage === true)) return;
      const text = typeof p.content === 'string' ? p.content : (p.content ?? []).filter(c => ['output_text', 'text'].includes(c.type)).map(c => c.text ?? '').join('\n');
      if (text?.includes(marker)) latest={ text: text.replaceAll('\r\n', '\n'), line: i + 1 };
    } catch { return; }
  });
  return latest;
}

export function assertRosterPresented(event, roster, hash) {
  const latest = latestAssistantMessage(event,'TEAMQA_ROSTER run=');
  need(latest?.text.includes(rosterChat(roster, hash)), 'ROSTER_CHAT_NOT_PRESENTED', 'full latest roster table must appear in assistant chat before approval');
  return latest;
}

function compareNotionBoard({ canonical, snapshot }) {
  const tool = resolve(process.env.TEAMQA_QA_GUI_BOARD_TOOL ?? join(siblingSkillRoot('qa-gui'), 'scripts/teamwork/cli.mjs'));
  const result = runAdapter([process.execPath, tool, 'compare-notion', '--file', canonical, '--snapshot', snapshot]);
  need(result.status === 0 && !result.error && !result.signal, 'QA_BOARD_NOTION_READBACK_FAILED');
  const receipt = outputJson(result, 'QA_BOARD_NOTION_READBACK_INVALID');
  need(receipt.ok === true && receipt.operation === 'compare-notion' && receipt.matchPercent === 100 && receipt.mismatches.length === 0, 'QA_BOARD_NOTION_READBACK_FAILED');
  return receipt;
}

export function verifyBoardLink({ runDir, roster, file, readToolEvidence = readHostToolEvidence,
  verifyDelivery = verifyBoardDelivery, comparePage = boardComparePage, compareNotion = compareNotionBoard }) {
  const path = file ?? join(runDir, 'board-link.json');
  need(existsSync(path), 'QA_BOARD_LINK_MISSING');
  const link = readJson(path);
  rejectUnknownFields(link, ['schema', 'run_id', 'round', 'roster_hash', 'target', 'provider', 'canonical', 'canonical_sha256', 'snapshot', 'snapshot_sha256', 'artifact', 'artifact_sha256', 'payload', 'payload_sha256', 'quality', 'quality_sha256', 'evidence_map', 'url', 'read_source'], 'QA_BOARD_LINK_FIELDS');
  need(link.schema === 'team-qa/board-link/v1' && link.run_id === roster.run_id && link.round === roster.round && link.roster_hash === roster.roster_hash && stableJson(link.target) === stableJson(roster.target), 'QA_BOARD_LINK_BINDING');
  const canonical = resolve(runDir, link.canonical ?? '');
  need(existsSync(canonical) && sha256File(canonical) === link.canonical_sha256, 'QA_BOARD_LINK_STALE');
  const board = readJson(canonical);
  need(board.boardId === roster.run_id && board.currentRound === roster.round, 'QA_BOARD_LINK_BINDING');
  if (link.provider === 'doc-colab') {
    const artifact = resolve(runDir, link.artifact ?? '');
    need(existsSync(artifact) && sha256File(artifact) === link.artifact_sha256 && link.url === artifact, 'QA_BOARD_LOCAL_LINK');
    boardIntegrityVerify(['--file', canonical, '--artifact', artifact], true);
  } else {
    need(['space', 'notion'].includes(link.provider) && /^https:\/\//.test(link.url ?? ''), 'QA_BOARD_CLOUD_LINK');
    const snapshot = resolve(runDir, link.snapshot ?? '');
    need(existsSync(snapshot) && sha256File(snapshot) === link.snapshot_sha256, 'QA_BOARD_LINK_STALE');
    const payload = resolve(runDir, link.payload ?? '');
    const quality = resolve(runDir, link.quality ?? '');
    need(link.payload && link.payload_sha256 && link.quality && link.quality_sha256
      && existsSync(payload) && sha256File(payload) === link.payload_sha256
      && existsSync(quality) && sha256File(quality) === link.quality_sha256
      && resolve(quality) === resolve(`${payload}.quality.json`), 'QA_BOARD_QUALITY_REQUIRED');
    verifyDelivery({ file: canonical, artifactPath: payload, renderer: link.provider });
    need(typeof readToolEvidence === 'function' && link.read_source, 'QA_BOARD_READ_SOURCE_REQUIRED');
    const observed = readToolEvidence(link.read_source, { roster, runDir });
    need(/mcp__.*(?:read_page|fetch_page|get_page|retrieve_page|read_database|query_database)/i.test(observed.name), 'QA_BOARD_READ_TOOL_REQUIRED');
    const raw = typeof observed.output === 'string' ? JSON.parse(observed.output) : observed.output;
    const serialized = stableJson(raw);
    need(serialized.includes(link.url), 'QA_BOARD_URL_NOT_OBSERVED');
    const stored = readJson(snapshot);
    need(stableJson(stored) === serialized, 'QA_BOARD_SNAPSHOT_NOT_ORIGINAL');
    if (link.provider === 'space') {
      const args = ['--file', canonical, '--snapshot', snapshot, '--payload', payload];
      if (link.evidence_map) args.push('--evidence-map', resolve(runDir, link.evidence_map));
      const receipt = comparePage(args, true);
      need(receipt.url === link.url, 'QA_BOARD_URL_MISMATCH');
    } else {
      compareNotion({ canonical, snapshot });
    }
  }
  return { ...link, board, label: `QA board — ${board.title} — ${board.env}` };
}

function preflightRows(preflight) {
  const labels = { runtime: 'Runtime / skill', target: 'Target / read access', code: 'QA Code', gui: 'Dragon / QA GUI', recording: 'Recording / privacy' };
  const actions = {runtime:'The orchestrator checks the skill version and source.',target:'The orchestrator checks read access and the exact target.',code:'The orchestrator reruns the scanner and the test runner.',gui:'The orchestrator restores Dragon, reads the DOM and captures images again.',recording:'The orchestrator checks the recording, privacy and the video file.'};
  return Object.entries(preflight.lanes).map(([key, value]) => {
    const status = value === 'verified' ? 'PASS' : value === 'pending' ? 'NOT RUN' : value === 'N/A' ? 'N/A' : value.status;
    const detail = status === 'BLOCKED' ? `${actions[key]} Rerun this role only when the preflight passes (${value.code}).` : status === 'NOT RUN' ? 'Operation not verified yet.' : status === 'N/A' ? 'Outside the plan scope; grants no permission to run this role.' : 'Tools verified; not a product PASS yet.';
    return `| ${labels[key]} | ${cell(status)} | ${cell(detail)} |`;
  });
}

export function planChat({ roster, plan, planHash, boardLink, preflight }) {
  const url = boardLink.provider === 'doc-colab' ? `<${boardLink.url}>` : boardLink.url;
  const rosterText = rosterChat(roster, roster.roster_hash).replace('Proposed roster — approve before planning', 'Approved roster').replace('Approve this roster to plan QA. The user does not need to type the hash.', 'This roster is approved for this exact run/round.');
  return [`**QA plan — awaiting approval**`, '', rosterText, '',
    `[${cell(boardLink.label)}](${url})`, '',
    `Plan P${plan.plan_version}: ${cell(plan.app)}; lanes: ${plan.lanes.length}; requirements: ${Object.keys(plan.tiers).length}.`,
    `Criteria: P0 ≤ ${plan.exit_criteria.p0_max}; P1 ≤ ${plan.exit_criteria.p1_max}; FULL ≥ ${plan.exit_criteria.coverage_high_pct}%; SMOKE ≥ ${plan.exit_criteria.coverage_low_pct}%.`,
    '', '| Tool preflight | Status | Details |', '|---|---|---|', ...preflightRows(preflight), '',
    `Approve plan P${plan.plan_version} to design cases and run the lanes whose preflight passed.`, '',
    `TEAMQA_PLAN run=${roster.run_id} round=${roster.round} sha256=${planHash} board=${boardLink.canonical_sha256}`].join('\n');
}

export function assertPlanPresented(event, input) {
  const latest = latestAssistantMessage(event,'TEAMQA_PLAN run=');
  need(latest?.text.includes(planChat(input)), 'PLAN_CHAT_NOT_PRESENTED', 'latest plan, roster, verified QA board link and preflight must appear in chat');
  return latest;
}

export function loadPlanPresentation({ runDir, roster, plan, planPath, verifyDelivery, comparePage, compareNotion }) {
  const packet = readJson(join(runDir, 'plan-chat.json'));
  rejectUnknownFields(packet, ['schema', 'run_id', 'round', 'roster_hash', 'plan_sha256', 'board_link', 'preflight', 'text'], 'PLAN_CHAT_FIELDS');
  need(packet.schema === 'team-qa/plan-chat/v1' && packet.run_id === roster.run_id && packet.round === roster.round && packet.roster_hash === roster.roster_hash && packet.plan_sha256 === sha256File(planPath), 'PLAN_CHAT_BINDING');
  for (const ref of [packet.board_link, packet.preflight]) {
    rejectUnknownFields(ref, ['path', 'sha256'], 'PLAN_CHAT_REFERENCE_FIELDS');
    need(existsSync(resolve(runDir, ref.path)) && sha256File(resolve(runDir, ref.path)) === ref.sha256, 'PLAN_CHAT_STALE');
  }
  const boardLink = verifyBoardLink({ runDir, roster, file: resolve(runDir, packet.board_link.path),
    ...(verifyDelivery ? { verifyDelivery } : {}), ...(comparePage ? { comparePage } : {}), ...(compareNotion ? { compareNotion } : {}) });
  const preflight = assertToolPreflight({ runDir, roster, stage: 'plan', requirements: plan.preflight, file: resolve(runDir, packet.preflight.path) });
  const input = { roster, plan, planHash: packet.plan_sha256, boardLink, preflight };
  need(packet.text === planChat(input), 'PLAN_CHAT_PAYLOAD_DRIFT');
  return { packet, input };
}

export async function preparePlanPresentation({ runDir, roster, plan, planPath, verifyDelivery, comparePage, compareNotion }) {
  const boardLink = verifyBoardLink({ runDir, roster,
    ...(verifyDelivery ? { verifyDelivery } : {}), ...(comparePage ? { comparePage } : {}), ...(compareNotion ? { compareNotion } : {}) });
  const preflight = assertToolPreflight({ runDir, roster, stage: 'plan', requirements: plan.preflight });
  const planHash = sha256File(planPath), boardFile = join(runDir, 'board-link.json'), preflightFile = join(runDir, 'preflight.json');
  const folder = join(runDir, 'plan-presentations', `${planHash}-${sha256File(boardFile)}-${sha256File(preflightFile)}`);
  const refs = {};
  for (const [key, source] of [['board_link', boardFile], ['preflight', preflightFile]]) {
    const dest = join(folder, `${key}.json`), bytes = readFileSync(source, 'utf8');
    if (!existsSync(dest)) await writeConfirmed(dest, bytes, 'teamqa.plan-chat.snapshot');
    need(sha256File(dest) === sha256File(source), 'PLAN_CHAT_SNAPSHOT_DRIFT');
    refs[key] = { path: dest, sha256: sha256File(dest) };
  }
  const packet = { schema: 'team-qa/plan-chat/v1', run_id: roster.run_id, round: roster.round, roster_hash: roster.roster_hash, plan_sha256: planHash, ...refs, text: planChat({ roster, plan, planHash, boardLink, preflight }) };
  const file = join(runDir, 'plan-chat.json');
  if (existsSync(file)) await writeConfirmed(join(runDir, 'archive', `plan-chat-${sha256File(file)}.json`), readFileSync(file, 'utf8'), 'teamqa.plan-chat.archive');
  await writeConfirmed(file, stableJson(packet), 'teamqa.plan-chat.prepare');
  loadPlanPresentation({ runDir, roster, plan, planPath,
    ...(verifyDelivery ? { verifyDelivery } : {}), ...(comparePage ? { comparePage } : {}), ...(compareNotion ? { compareNotion } : {}) });
  return packet;
}
