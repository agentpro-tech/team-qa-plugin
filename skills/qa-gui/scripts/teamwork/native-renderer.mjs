import { readFileSync, writeFileSync } from 'node:fs';
import { pairFindingEvidence } from './board-gates.mjs';
import { TEAMWORK_PRIORITIES, TEAMWORK_STATUSES, applyChanges, validateCanonical } from './canonical.mjs';

const template = readFileSync(new URL('../../assets/qa-board-teamwork.html', import.meta.url), 'utf8');
const EDITABLE_FIELDS = new Set(['status', 'priority', 'assignee']);
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Visible and accessible copy for the finding-evidence block. The board already falls back to
// English for a language it has no chrome for; `original` and `annotated` stay in the machine
// `title`, next to the path, because they are the canonical role names of the data.
const EVIDENCE_TEXT = {
  vi: { annotated: 'Ảnh có chú thích', original: 'Ảnh gốc', full: 'ảnh đầy đủ' },
  en: { annotated: 'Annotated image', original: 'Original image', full: 'full-size image' },
};
const SOURCE_TEXT = {
  vi: { heading: 'Source Issue', qaReason: 'Lý do QA-derived' },
  en: { heading: 'Source Issue', qaReason: 'QA-derived reason' },
};

function clone(value) {
  return structuredClone(value);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function attribute(name, value) {
  return `${name}="${escapeHtml(value)}"`;
}

/** One evidence anchor: the role is machine-readable, the accessible name is human-readable. */
function evidenceLink(role, item, finding, text, body) {
  const path = String(item.path).trim();
  const attributes = [
    attribute('class', `evidence-${role}`),
    attribute('data-evidence-role', role),
    attribute('href', path),
    'target="_blank"',
    'rel="noopener"',
    attribute('aria-label', `${text[role]} — ${finding.id} — ${text.full}`),
    attribute('title', `${role} · ${path}`),
  ].join(' ');
  return `<a ${attributes}>${body}</a>`;
}

/**
 * The annotated capture is the picture of the defect, so it is the one that renders; the original
 * stays one accessible click away, because a reader who cannot check the annotation against the
 * untouched screen is being asked to trust it.
 */
function findingFigure(pair, text) {
  const { finding, original, annotated } = pair;
  const shot = `<img ${attribute('data-evidence-role', 'annotated')} ${attribute('src', String(annotated.path).trim())} ${attribute('alt', `${text.annotated} — ${finding.id}`)} loading="lazy">`;
  return `<figure class="finding-evidence" ${attribute('data-finding-id', finding.id)}>`
    + evidenceLink('annotated', annotated, finding, text, shot)
    + `<figcaption>${escapeHtml(finding.caption)} `
    + evidenceLink('original', original, finding, text, escapeHtml(text.original))
    + '</figcaption></figure>';
}

/**
 * Finding evidence for every defect, one inert `<template>` per defect id. The board's own script
 * owns the defect list and rewrites it on each render, so the markup is parked outside that list
 * and moved in — one renderer stays the single source of the evidence markup.
 */
function defectEvidenceHtml(data) {
  const text = EVIDENCE_TEXT[data.language] || EVIDENCE_TEXT.en;
  return (data.defects || []).map((defect) => {
    const pairs = pairFindingEvidence(defect).filter((pair) => pair.original && pair.annotated);
    if (pairs.length === 0) return '';
    return `<template ${attribute('data-defect-evidence', defect.id)}>${pairs.map((pair) => findingFigure(pair, text)).join('')}</template>`;
  }).join('');
}

function defectHandoffHtml(defect, language) {
  const handoff = defect.handoff;
  if (!handoff) return '';
  const vi = language === 'vi';
  const text = vi
    ? { heading: 'Yêu cầu bàn giao', problem: 'Vấn đề', request: 'Đề nghị', expected: 'Kết quả cần đạt' }
    : { heading: 'Developer handoff', problem: 'Problem', request: 'Request', expected: 'Expected outcome' };
  return '<div class="card work-progress defect-handoff"><h3>' + escapeHtml(text.heading) + ' · ' + escapeHtml(handoff.kind) + '</h3>'
    + '<p><b>' + escapeHtml(text.problem) + ':</b> ' + escapeHtml(handoff.problem) + '</p>'
    + '<p><b>' + escapeHtml(text.request) + ':</b> ' + escapeHtml(handoff.request) + '</p>'
    + '<p><b>' + escapeHtml(text.expected) + ':</b> ' + escapeHtml(handoff.expected) + '</p></div>';
}

function sourceItemHtml(item, text) {
  const key = `<code>${escapeHtml(item.externalKey)}</code>`;
  const label = `${key} — ${escapeHtml(item.title)}`;
  const linked = item.url
    ? `<a ${attribute('href', item.url)} target="_blank" rel="noopener">${label}</a>`
    : label;
  const reason = item.origin === 'qa-derived'
    ? `<div class="source-reason"><strong>${escapeHtml(text.qaReason)}:</strong> ${escapeHtml(item.qaDerivedReason)}</div>`
    : '';
  return `<li class="source-item" ${attribute('data-source-ref', item.id)}>`
    + `<div>${linked}</div><div class="section-note">${escapeHtml(item.sourceSystem)} · ${escapeHtml(item.kind)} · ${escapeHtml(item.origin)}</div>`
    + `${reason}</li>`;
}

function caseSourceTraceabilityHtml(data) {
  if (data.schemaVersion !== 6) return '';
  const text = SOURCE_TEXT[data.language] || SOURCE_TEXT.en;
  const sourceById = new Map(data.sourceItems.map((item) => [item.id, item]));
  return data.cases.map((entry) => {
    const items = entry.sourceRefs.map((sourceRef) => sourceById.get(sourceRef));
    return `<template ${attribute('data-case-sources', entry.id)}><div class="card source-issues" style="margin-top:14px">`
      + `<h3>${escapeHtml(text.heading)}</h3><ul>${items.map((item) => sourceItemHtml(item, text)).join('')}</ul></div></template>`;
  }).join('');
}

function safeInlineJson(data) {
  return JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

function error(message) {
  return { ok: false, errors: [message] };
}

function findEntity(data, type, id) {
  const collection = type === 'case' ? data.cases : type === 'defect' ? data.defects : null;
  return collection?.find((entry) => entry.id === id);
}

function validEdit(edit) {
  if (!edit || !EDITABLE_FIELDS.has(edit.field)) return false;
  if (edit.field === 'status') return TEAMWORK_STATUSES.includes(edit.to);
  if (edit.field === 'priority') return TEAMWORK_PRIORITIES.includes(edit.to);
  return typeof edit.to === 'string' && edit.to.trim().length > 0;
}

export function renderNativeBoard(data) {
  const validation = validateCanonical(data);
  if (!validation.ok) {
    const details = validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join('\n');
    throw new Error(`canonical gate failed before native render\n${details}`);
  }
  const evidence = defectEvidenceHtml(data);
  const defectHandoffs = data.defects.map((defect) => `<template ${attribute('data-defect-handoff', defect.id)}>${defectHandoffHtml(defect, data.language)}</template>`).join('');
  const sourceTraceability = caseSourceTraceabilityHtml(data);
  return template
    .replace('__LANG__', data.language)
    .replace('__CASE_SOURCE_TRACEABILITY__', () => sourceTraceability)
    .replace('__DEFECT_EVIDENCE__', () => evidence)
    .replace('__DEFECT_HANDOFFS__', () => defectHandoffs)
    .replace('__QA_DATA__', safeInlineJson(data));
}

export function applyNativePacket(data, packet, context = {}) {
  const validation = validateCanonical(data);
  if (!validation.ok) return { ok: false, errors: validation.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  if (!packet || !['doc-colab/v1', 'doc-colab/v2'].includes(packet.protocol || 'doc-colab/v1')) return error('native packet: unsupported protocol');
  const qaDelta = packet.qaDelta && typeof packet.qaDelta === 'object' ? packet.qaDelta : null;
  const baseRev = qaDelta?.baseRev ?? packet.stagedRev ?? packet.baseRev ?? packet.rev;
  if (baseRev !== data.rev) return { ok: false, conflict: true, errors: [`native packet: baseRev ${baseRev} does not match canonical rev ${data.rev}`] };
  const actor = context.actor;
  const when = context.now;
  if (typeof actor !== 'string' || actor.length === 0) return error('native packet: actor is required');
  if (typeof when !== 'string' || Number.isNaN(Date.parse(when))) return error('native packet: valid now timestamp is required');

  let next = clone(data);
  const edits = Array.isArray(qaDelta?.updates) ? qaDelta.updates
    : Array.isArray(packet.edits) ? packet.edits
      : Array.isArray(packet.staging?.edits) ? packet.staging.edits : [];
  const rawComments = Array.isArray(qaDelta?.comments) ? qaDelta.comments
    : Array.isArray(packet.comments) ? packet.comments
      : Array.isArray(packet.staging?.comments) ? packet.staging.comments : [];
  const comments = rawComments.map((comment) => ({
    ...comment,
    entityId: comment?.entityId ?? comment?.id,
    when: comment?.when ?? comment?.ts,
  }));
  const evidence = Array.isArray(qaDelta?.evidence) ? qaDelta.evidence
    : Array.isArray(packet.evidence) ? packet.evidence
      : Array.isArray(packet.staging?.evidence) ? packet.staging.evidence : [];
  const errors = [];

  for (const item of evidence) {
    const target = findEntity(next, 'defect', item?.entityId);
    if (!target) { errors.push(`native packet: evidence target ${item?.entityId || '<missing>'} not found`); continue; }
    const type = ['image', 'video', 'commit', 'log', 'link'].includes(item.type) ? item.type : null;
    if (!type || typeof item.path !== 'string' || item.path.trim().length === 0) { errors.push(`native packet: invalid evidence for ${item.entityId}`); continue; }
    const id = item.id || `native-${target.id}-evidence-${target.fixEvidence.length + 1}`;
    if (!target.fixEvidence.some((entry) => entry.id === id)) target.fixEvidence.push({ id, type, path: item.path.trim(), addedBy: actor, addedAt: item.addedAt || when });
  }

  if (errors.length === 0) {
    for (const edit of edits) if (!validEdit(edit)) errors.push(`native packet: invalid ${edit?.field || 'field'} for ${edit?.id || '<missing>'}`);
  }
  if (errors.length === 0) {
    const changed = applyChanges(next, edits, { actor, now: when, source: 'native', qaActors: context.qaActors || [], incrementRev: false });
    if (!changed.ok) errors.push(...changed.errors);
    else next = changed.data;
  }

  for (const comment of comments) {
    const target = findEntity(next, comment?.entity, comment?.entityId);
    if (!target) { errors.push(`native packet: comment target ${comment?.entityId || '<missing>'} not found`); continue; }
    if (typeof comment.text !== 'string' || comment.text.trim().length === 0) { errors.push(`native packet: empty comment for ${comment.entityId}`); continue; }
    target.comments.push({
      id: comment.id || `native-${target.id}-${target.comments.length + 1}`,
      author: actor,
      text: comment.text.trim(),
      when: comment.when || when,
      source: 'native',
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  if (edits.length > 0 || comments.length > 0 || evidence.length > 0) next.rev += 1;
  const hardened = validateCanonical(next);
  if (!hardened.ok) return { ok: false, errors: hardened.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  return { ok: true, data: next, applied: { edits: edits.length, comments: comments.length, evidence: evidence.length } };
}

function cli() {
  const input = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
  const outIndex = process.argv.indexOf('--out');
  const output = outIndex >= 0 ? process.argv[outIndex + 1] : null;
  if (!input || !output) {
    process.stderr.write('usage: node scripts/teamwork/native-renderer.mjs <canonical.json> --out <board.html>\n');
    process.exit(2);
  }
  try {
    const data = JSON.parse(readFileSync(input, 'utf8'));
    writeFileSync(output, renderNativeBoard(data));
    process.stdout.write(`Native QA board: ${output}\n`);
  } catch (cause) {
    process.stderr.write(`${cause.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) cli();
