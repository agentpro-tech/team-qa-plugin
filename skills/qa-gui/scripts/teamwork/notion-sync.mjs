import { TEAMWORK_PRIORITIES, TEAMWORK_STATUSES, applyChanges, validateCanonical } from './canonical.mjs';

const STATUS_LABELS = Object.freeze({
  vi: Object.freeze({
    TODO: 'Chưa làm', DOING: 'Đang làm', PASS: 'Đạt', FAIL: 'Hỏng', BLOCKED: 'Bị chặn',
    ASSIGNED: 'Đã giao', FIXING: 'Đang sửa', RETEST: 'Chờ retest', VERIFIED: 'Đã xác nhận',
    CLOSED: 'Đóng', REOPENED: 'Mở lại', REJECTED: 'Từ chối', DEFERRED: 'Hoãn',
  }),
  en: Object.freeze(Object.fromEntries(TEAMWORK_STATUSES.map((status) => [status, status]))),
});

function clone(value) {
  return structuredClone(value);
}

function labels(language) {
  return STATUS_LABELS[language] || STATUS_LABELS.en;
}

function machineStatus(value, language) {
  if (TEAMWORK_STATUSES.includes(value)) return value;
  const entry = Object.entries(labels(language)).find(([, label]) => label === value);
  return entry?.[0] || null;
}

function machineLineForCase(entry) {
  return `STATUS ${entry.status}\nFUNCTION ${entry.functionVerdict}\nUI ${entry.uiVerdict}\nRULE ${entry.machine.rule}\nSELECTOR ${entry.machine.selector}`;
}

function notionSourcePages(data, options) {
  const value = options.notionSourcePages || {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('notionSourcePages must be an object keyed by canonical source id');
  const known = new Set((data.sourceItems || []).map((entry) => entry.id));
  for (const [sourceRef, pageId] of Object.entries(value)) {
    if (!known.has(sourceRef)) throw new Error(`notionSourcePages: unknown canonical source ${sourceRef}`);
    if (typeof pageId !== 'string' || pageId.trim().length === 0) throw new Error(`notionSourcePages.${sourceRef}: page id is required`);
  }
  return value;
}

function sourceProjection(data, entry, options) {
  if (data.schemaVersion !== 6) return {};
  const sourceById = new Map(data.sourceItems.map((item) => [item.id, item]));
  const pages = notionSourcePages(data, options);
  const relation = [];
  const external = [];
  const systems = [];
  for (const sourceRef of entry.sourceRefs) {
    const source = sourceById.get(sourceRef);
    if (!systems.includes(source.sourceSystem)) systems.push(source.sourceSystem);
    if (Object.hasOwn(pages, sourceRef)) {
      relation.push({ sourceRef, pageId: pages[sourceRef] });
      continue;
    }
    external.push({
      sourceRef,
      kind: source.kind,
      sourceSystem: source.sourceSystem,
      externalKey: source.externalKey,
      title: source.title,
      url: source.url || null,
      origin: source.origin,
      ...(source.origin === 'qa-derived' ? { qaDerivedReason: source.qaDerivedReason } : {}),
    });
  }
  return {
    sourceIssue: { property: 'Source Issue', relation, external },
    issueGroup: { derived: true, label: systems.join(' · '), sourceSystems: systems },
  };
}

function baseRow(data, entry, entity, language) {
  return {
    externalId: entry.id,
    entity,
    database: entity === 'case' ? 'Cases' : 'Defects',
    title: entry.title,
    status: { machine: entry.status, label: labels(language)[entry.status] },
    priority: entry.priority,
    assignee: entry.assignee,
    related: entity === 'defect' ? entry.caseId : null,
    comments: clone(entry.comments),
    history: clone(entry.history),
    evidence: clone(entity === 'defect' ? entry.fixEvidence : entry.evidence),
    canonicalRev: data.rev,
    language,
  };
}

export function mapCanonicalRows(data, options = {}) {
  const validation = validateCanonical(data);
  if (!validation.ok) throw new Error(`canonical gate failed before Notion mapping\n${validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join('\n')}`);
  const language = options.language || data.language;
  const caseRows = data.cases.map((entry) => ({
    ...baseRow(data, entry, 'case', language),
    ...sourceProjection(data, entry, options),
    functionVerdict: entry.functionVerdict,
    uiVerdict: entry.uiVerdict,
    conclusion: clone(entry.humanSummary),
    ...(entry.work ? { work: clone(entry.work) } : {}),
    machineLine: machineLineForCase(entry),
    currentRound: data.currentRound,
    rounds: clone(entry.results),
    metadata: { app: data.app, envDb: data.envDb, viewport: data.viewport, deepCheck: data.deepCheck },
  }));
  const defectRows = data.defects.map((entry) => ({
    ...baseRow(data, entry, 'defect', language),
    createdBy: entry.createdBy,
    repro: entry.repro,
    expected: entry.expected,
    actual: entry.actual,
    ...(entry.handoff ? { handoff: clone(entry.handoff) } : {}),
    rejectionReason: entry.rejectionReason,
    machineLine: `STATUS ${entry.status}\nCASE ${entry.caseId}`,
  }));
  return [...caseRows, ...defectRows];
}

function comparable(row) {
  const sorted = {};
  for (const key of Object.keys(row).sort()) sorted[key] = row[key];
  return sorted;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function compareNotionRows(data, rows, options = {}) {
  const expected = mapCanonicalRows(data, options);
  const actualById = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.externalId, row]));
  let matchedFields = 0;
  let totalFields = 0;
  const mismatches = [];
  for (const expectedRow of expected) {
    const actual = actualById.get(expectedRow.externalId);
    if (!actual) {
      totalFields += Object.keys(expectedRow).length;
      mismatches.push({ externalId: expectedRow.externalId, field: '<row>', reason: 'missing row' });
      continue;
    }
    for (const [field, value] of Object.entries(comparable(expectedRow))) {
      totalFields += 1;
      if (JSON.stringify(stable(actual[field])) === JSON.stringify(stable(value))) matchedFields += 1;
      else mismatches.push({ externalId: expectedRow.externalId, field, expected: value, actual: actual[field] });
    }
  }
  for (const row of actualById.values()) if (!expected.some((entry) => entry.externalId === row.externalId)) mismatches.push({ externalId: row.externalId, field: '<row>', reason: 'unexpected row' });
  return { matchPercent: totalFields === 0 ? 100 : Number(((matchedFields / totalFields) * 100).toFixed(2)), matchedFields, totalFields, mismatches };
}

export function applyNotionPull(data, rows, options = {}) {
  const initial = validateCanonical(data);
  if (!initial.ok) return { ok: false, errors: initial.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  if (!Array.isArray(rows)) return { ok: false, errors: ['Notion pull: rows must be an array'] };
  const language = options.language || data.language;
  const nextRows = [];
  const errors = [];
  for (const row of rows) {
    const entity = row?.entity;
    const collection = entity === 'case' ? data.cases : entity === 'defect' ? data.defects : null;
    const target = collection?.find((entry) => entry.id === row?.externalId);
    if (!target) { errors.push(`${row?.externalId || '<missing>'}: unknown Notion row`); continue; }
    const actor = row.editedBy;
    const when = row.editedAt;
    if (typeof actor !== 'string' || actor.length === 0 || typeof when !== 'string' || Number.isNaN(Date.parse(when))) { errors.push(`${row.externalId}: editedBy and editedAt are required`); continue; }
    const changes = [];
    if (Object.hasOwn(row, 'status')) {
      const status = machineStatus(row.status?.machine || row.status, language);
      if (!status) errors.push(`${row.externalId}: unknown status ${JSON.stringify(row.status)}`);
      else changes.push({ entity, id: row.externalId, field: 'status', from: target.status, to: status, rejectionReason: row.rejectionReason });
    }
    if (Object.hasOwn(row, 'priority')) {
      if (!TEAMWORK_PRIORITIES.includes(row.priority)) errors.push(`${row.externalId}: unknown priority ${JSON.stringify(row.priority)}`);
      else changes.push({ entity, id: row.externalId, field: 'priority', from: target.priority, to: row.priority });
    }
    if (Object.hasOwn(row, 'assignee')) changes.push({ entity, id: row.externalId, field: 'assignee', from: target.assignee, to: row.assignee });
    nextRows.push({ row, actor, when, changes });
  }
  if (errors.length > 0) return { ok: false, errors };

  let next = clone(data);
  let appliedChanges = 0;
  let appliedComments = 0;
  for (const entry of nextRows) {
    const changed = applyChanges(next, entry.changes, {
      actor: entry.actor,
      now: entry.when,
      source: 'notion',
      qaActors: options.qaActors || [],
      incrementRev: false,
    });
    if (!changed.ok) return { ok: false, errors: changed.errors };
    next = changed.data;
    appliedChanges += changed.applied;
    if (typeof entry.row.comment === 'string' && entry.row.comment.trim().length > 0) {
      const collection = entry.row.entity === 'case' ? next.cases : next.defects;
      const target = collection.find((item) => item.id === entry.row.externalId);
      const id = entry.row.commentId || `notion-${entry.row.externalId}-${entry.when}`;
      if (!target.comments.some((comment) => comment.id === id)) {
        target.comments.push({ id, author: entry.actor, text: entry.row.comment.trim(), when: entry.when, source: 'notion' });
        appliedComments += 1;
      }
    }
  }
  if (appliedChanges > 0 || appliedComments > 0) next.rev += 1;
  const final = validateCanonical(next);
  if (!final.ok) return { ok: false, errors: final.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  return { ok: true, data: next, applied: { changes: appliedChanges, comments: appliedComments } };
}

export async function syncCanonicalToNotion(data, transport, options = {}) {
  const before = JSON.stringify(data);
  let desired;
  try { desired = mapCanonicalRows(data, options); }
  catch (cause) { return { ok: false, errors: [cause.message] }; }
  if (!transport || typeof transport.listRows !== 'function' || typeof transport.upsertRow !== 'function') return { ok: false, errors: ['Notion transport requires listRows and upsertRow'] };
  let existing;
  try { existing = await transport.listRows(); }
  catch (cause) { return { ok: false, errors: [`Notion list failed: ${cause.message}`] }; }
  const existingById = new Map((Array.isArray(existing) ? existing : []).map((row) => [row.externalId, row]));
  let synced = 0;
  let skipped = 0;
  for (const row of desired) {
    const current = existingById.get(row.externalId);
    if (current && JSON.stringify(stable(current)) === JSON.stringify(stable(row))) { skipped += 1; continue; }
    try {
      await transport.upsertRow(clone(row), { existing: current || null });
      synced += 1;
      existingById.set(row.externalId, row);
    } catch (cause) {
      return { ok: false, errors: [`Notion sync failed at ${row.externalId}: ${cause.message}`], pendingExternalId: row.externalId, synced, skipped, canonicalUnchanged: JSON.stringify(data) === before };
    }
  }
  let finalRows;
  try { finalRows = await transport.listRows(); }
  catch { finalRows = [...existingById.values()]; }
  const comparison = compareNotionRows(data, finalRows, options);
  if (comparison.matchPercent !== 100) return { ok: false, errors: ['Notion comparison is not 100%'], comparison, synced, skipped, canonicalUnchanged: JSON.stringify(data) === before };
  return { ok: true, comparison, synced, skipped, canonicalUnchanged: JSON.stringify(data) === before };
}

export const notionFieldMap = Object.freeze({
  status: 'Status select plus Machine status',
  priority: 'Priority select',
  assignee: 'Assignee select',
  functionVerdict: 'Function verdict',
  uiVerdict: 'UI verdict',
  conclusion: 'Conclusion and page sections',
  machineLine: 'Code block',
  evidence: 'Files',
  rounds: 'Rounds page section',
  history: 'History page section and Notion page history',
  related: 'Related property',
  comments: 'Notion comments',
  sourceIssue: 'Source Issue relation with stable external key/URL fallback',
  issueGroup: 'Issue Group derived from sourceSystem; never canonical data',
});
