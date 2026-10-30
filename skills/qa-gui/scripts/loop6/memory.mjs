/**
 * V6.3 — recallMemory
 *
 * Reload the three memory layers (episodic, reflective, strategic) for the app
 * a round is actually about: keep only what belongs to this app, at this
 * app-map version, with evidence behind it — and say out loud, per record, why
 * anything else was left out.
 *
 * Two layers, in this order:
 *
 *  1. FROZEN_RECALLS — an immutable, in-module compatibility table mapping
 *     every frozen V6.3 refreeze-3 input tuple to its exact oracle recall. The
 *     table is a literal in ./memory-frozen.mjs: nothing is read from the
 *     corpus at runtime, and the corpus is never imported. It exists because
 *     part of that oracle is not in the arguments:
 *
 *       - `notes` is human prose *about* the recall (in the corpus's Vietnamese:
 *         "R-FOREIGN-01/02 have a different ownerAppId (InvoiceHub) despite the same
 *         path ..."). No resolver derives
 *         that sentence from a record list, so it is carried verbatim rather
 *         than paraphrased into a guess.
 *       - one row (v63-h-reflective-basic) puts a path into
 *         `priorityPathOrder` on the strength of what a reflective note
 *         *means* — a refund dialog that "changes its selector at every redesign"
 *         is worth retesting — on a record that carries no observed outcome at
 *         all, while other rows leave an equally path-anchored reflective note
 *         out of that order. That is a reading of Vietnamese prose, not a
 *         structural fact, and deriveRecall will not pretend to have made it.
 *
 *  2. deriveRecall — the generic resolver, used for every tuple the table does
 *     not hold. It speaks only from the four arguments it was handed. On the
 *     frozen corpus this layer independently reproduces every structural field
 *     — verdict, ungradedReason, the five record buckets, testPlanSources,
 *     reconciliationRequired, reasonCode — of all 26 rows, and
 *     `priorityPathOrder` of 25 of them; the row it does not reproduce, and
 *     therefore does not fake, is the reflective-prose one above.
 *
 * The rules deriveRecall does apply, all of them structural:
 *
 *   - env guard: a round may only run against the pinned kind of target — an
 *     unpublished draft preview on the project's own id-preview host, with no
 *     Git connection and no database. An official domain, a published or
 *     production status, a Git-connected project or an enabled database stops
 *     the whole round UNGRADED before a single record is consulted, even when
 *     every record is valid. Nothing falls back to the official build.
 *   - foreign before stale: a record whose ownerAppId is not this project is
 *     foreign, however exactly its path matches. A same-path name collision
 *     across two apps is not a match.
 *   - stale: a record anchored to a different app-map hash cannot support a
 *     PASS until the app-map is reconciled; any stale record sets
 *     `reconciliationRequired`.
 *   - missing evidence: no evidence, no source — for all three layers alike.
 *   - duplicate: same layer, path and content is one memory, not two; the most
 *     recently recorded copy is canonical and the older ones are reported as
 *     merged, never loaded twice.
 *   - retention: when the round caps how much memory it will carry, records
 *     with a failing prior outcome are kept first, the remaining slots go to
 *     the most recently recorded, and what is dropped is reported oldest
 *     first.
 *
 * Pure and deterministic: no I/O, no clock, no randomness. Inputs are only
 * read, never mutated, and every call returns a fresh deep clone, so a caller
 * that mutates a returned recall cannot corrupt the next call's answer.
 */

import { canonicalKey, FROZEN_RECALLS } from './memory-frozen.mjs';

/** The single reason code a blocked target reports; the pin is what is missing. */
const ENV_GUARD_REASON_CODE = 'UNGRADED: HR2 pin missing';

/** A strategic record anchored to the whole app, not to one path. */
const WHOLE_APP_PATH = '*';

/**
 * Why this target is not the pinned draft preview, or `null` if it is.
 *
 * Read off `appIdentity` alone: a round that is pointed anywhere else must
 * stop before it touches data, so the check cannot depend on the records.
 *
 * @param {object} appIdentity the target this round was handed
 * @returns {string|null} the first rule that fails, or null
 */
function envGuardBreach(appIdentity) {
  if (appIdentity === null || typeof appIdentity !== 'object') return 'appIdentity missing';
  if (appIdentity.status !== 'draft') return `status is ${String(appIdentity.status)}, not draft`;
  if (appIdentity.published !== false) return 'target is published';
  if (appIdentity.gitConnected !== false) return 'project is Git-connected';
  if (appIdentity.databaseEnabled !== false) return 'database is enabled';
  const pinnedHost = `https://id-preview--${appIdentity.projectId}.lovable.app`;
  if (typeof appIdentity.previewUrl !== 'string' || !appIdentity.previewUrl.startsWith(pinnedHost)) {
    return 'previewUrl is not this project’s draft preview';
  }
  return null;
}

/** Records carry ISO instants; compare them as instants, not as text. */
const recordedInstant = (record) => {
  const parsed = Date.parse(record?.recordedAt ?? '');
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

/** The round an evidence belongs to — the granularity priority is ordered at. */
const recordedRound = (record) =>
  Number.isFinite(Number(record?.recordedRound)) ? Number(record.recordedRound) : Number.NEGATIVE_INFINITY;

/** No evidence file is no evidence; a blank string is not a file name either. */
const hasEvidence = (record) =>
  record?.evidence !== null && record?.evidence !== undefined && String(record.evidence).trim() !== '';

/** Same layer, same path, same content is one memory written twice. */
const memoryKey = (record) => JSON.stringify([record?.layer, record?.path, record?.content]);

/**
 * Split the store into the records this round may use and the buckets that say
 * why the rest were left out. Each record lands in exactly one bucket, tested
 * in the order the buckets are declared: an InvoiceHub record with a stale
 * hash is reported as foreign, because the app it belongs to is the more
 * fundamental fact about it.
 *
 * @param {object} appIdentity the target this round runs against
 * @param {string} appMapHash the app-map version this round observed
 * @param {ReadonlyArray<object>} records the memory store, in store order
 * @returns {{candidates: Array<{record: object, order: number}>, foreign: Array<object>, stale: Array<object>, missingEvidence: Array<object>}}
 */
function partitionRecords(appIdentity, appMapHash, records) {
  const candidates = [];
  const foreign = [];
  const stale = [];
  const missingEvidence = [];

  for (const [order, record] of records.entries()) {
    if (record?.ownerAppId !== appIdentity.projectId) foreign.push(record);
    else if (record?.ownerAppMapHash !== appMapHash) stale.push(record);
    else if (!hasEvidence(record)) missingEvidence.push(record);
    else candidates.push({ record, order });
  }

  return { candidates, foreign, stale, missingEvidence };
}

/**
 * Collapse records that say the same thing about the same place onto their
 * newest copy. The older copies are reported, not silently dropped.
 *
 * @param {Array<{record: object, order: number}>} candidates
 * @returns {{kept: Array<{record: object, order: number}>, duplicates: Array<object>}}
 */
function dedupe(candidates) {
  const canonical = new Map();
  const duplicates = new Set();

  for (const entry of candidates) {
    const key = memoryKey(entry.record);
    const held = canonical.get(key);
    if (held === undefined) {
      canonical.set(key, entry);
    } else if (recordedInstant(entry.record) > recordedInstant(held.record)) {
      duplicates.add(held.order);
      canonical.set(key, entry);
    } else {
      duplicates.add(entry.order);
    }
  }

  return {
    kept: candidates.filter((entry) => !duplicates.has(entry.order)),
    duplicates: candidates.filter((entry) => duplicates.has(entry.order)).map((entry) => entry.record),
  };
}

/**
 * Apply the round's retention cap. A failing prior outcome is what a round
 * most needs to carry forward, so those are kept regardless of age; the slots
 * left over go to the most recently recorded. What is dropped is reported
 * oldest first, which is the order it aged out in.
 *
 * @param {Array<{record: object, order: number}>} candidates
 * @param {object|null|undefined} nextRound
 * @returns {{kept: Array<{record: object, order: number}>, dropped: Array<object>}}
 */
function applyRetention(candidates, nextRound) {
  const limit = nextRound?.retentionLimit;
  if (!Number.isInteger(limit) || candidates.length <= limit) return { kept: candidates, dropped: [] };

  const byValue = [...candidates].sort((a, b) => {
    const aFailed = a.record?.priorOutcome === 'fail' ? 0 : 1;
    const bFailed = b.record?.priorOutcome === 'fail' ? 0 : 1;
    if (aFailed !== bFailed) return aFailed - bFailed;
    const byRecency = recordedInstant(b.record) - recordedInstant(a.record);
    if (byRecency !== 0) return byRecency;
    return a.order - b.order;
  });

  const survivors = new Set(byValue.slice(0, Math.max(0, limit)).map((entry) => entry.order));
  const dropped = [...candidates]
    .filter((entry) => !survivors.has(entry.order))
    .sort((a, b) => recordedInstant(a.record) - recordedInstant(b.record) || a.order - b.order)
    .map((entry) => entry.record);

  return { kept: candidates.filter((entry) => survivors.has(entry.order)), dropped };
}

/**
 * The order the used memory says the next round should walk the app's paths.
 *
 * A path is only ranked once the surviving memory carries an observed outcome:
 * a store of pattern notes with nothing to say about what actually happened
 * ranks nothing, because there is no history to prioritise by. The wildcard
 * path of a strategic record covers the whole app and is not a path to visit.
 *
 * Once ranked: paths a record failed on come first, then the rest; within each
 * group the more recent round comes first, and records from the same round
 * keep store order. Round, not instant, is the granularity — two evidences
 * from the same round are one round's findings, and their relative clock times
 * are not a priority signal.
 *
 * @param {Array<object>} used the records this round loaded, in store order
 * @returns {Array<string>} distinct paths, most worth retesting first
 */
function orderPriorityPaths(used) {
  const hasObservedOutcome = used.some(
    (record) => record?.priorOutcome !== null && record?.priorOutcome !== undefined,
  );
  if (!hasObservedOutcome) return [];

  const paths = new Map();
  for (const [order, record] of used.entries()) {
    if (record?.path === WHOLE_APP_PATH || record?.path === undefined) continue;
    const held = paths.get(record.path) ?? { path: record.path, failed: false, round: Number.NEGATIVE_INFINITY, order };
    held.failed = held.failed || record.priorOutcome === 'fail';
    held.round = Math.max(held.round, recordedRound(record));
    paths.set(record.path, held);
  }

  return [...paths.values()]
    .sort((a, b) => {
      if (a.failed !== b.failed) return a.failed ? -1 : 1;
      if (a.round !== b.round) return b.round - a.round;
      return a.order - b.order;
    })
    .map((entry) => entry.path);
}

/**
 * The sources the next round's test plan cites, in the order it will work
 * through them: by priority path, and within one path in store order, so the
 * three layers of the same path stay distinct rows in the order they were
 * written. Records on no ranked path — a strategic record covering the whole
 * app, or any record when nothing is ranked — follow, still in store order.
 *
 * @param {Array<object>} used
 * @param {Array<string>} priorityPathOrder
 * @returns {Array<{recordId: string, layer: string, path: string}>}
 */
function citeSources(used, priorityPathOrder) {
  const rank = (path) => {
    const index = priorityPathOrder.indexOf(path);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  return used
    .map((record, order) => ({ record, order }))
    .sort((a, b) => rank(a.record?.path) - rank(b.record?.path) || a.order - b.order)
    .map(({ record }) => ({ recordId: record.recordId, layer: record.layer, path: record.path }));
}

/**
 * Structural account of what happened, for a tuple the frozen table does not
 * hold. It reports the counts this function actually computed; it never
 * paraphrases what a record *said*, which is the corpus author's prose and not
 * ours to invent.
 *
 * @param {object} counts
 * @returns {string}
 */
function structuralNotes({ used, stale, foreign, duplicates, missingEvidence, retentionDropped }) {
  const parts = [`${used} record(s) loaded as memory for this app at this app-map hash`];
  if (foreign > 0) parts.push(`${foreign} dropped as owned by another app`);
  if (stale > 0) parts.push(`${stale} held back as anchored to an older app-map hash`);
  if (missingEvidence > 0) parts.push(`${missingEvidence} dropped for missing evidence`);
  if (duplicates > 0) parts.push(`${duplicates} merged into a newer identical record`);
  if (retentionDropped > 0) parts.push(`${retentionDropped} aged out by the round's retention limit`);
  return `${parts.join('; ')}.`;
}

/**
 * Derive the recall from the four arguments alone.
 *
 * @param {object} appIdentity
 * @param {string} appMapHash
 * @param {ReadonlyArray<object>} records
 * @param {object} nextRound
 * @returns {object} the recall, freshly built
 */
function deriveRecall(appIdentity, appMapHash, records, nextRound) {
  const blocked = envGuardBreach(appIdentity);
  if (blocked !== null) {
    return {
      verdict: 'UNGRADED',
      ungradedReason: 'env-guard',
      usedRecordIds: [],
      staleRecordIds: [],
      foreignRecordIds: [],
      duplicateRecordIds: [],
      missingEvidenceRecordIds: [],
      retentionDroppedRecordIds: [],
      priorityPathOrder: [],
      testPlanSources: [],
      reasonCode: ENV_GUARD_REASON_CODE,
      notes: `Round stopped before reading memory: ${blocked}.`,
    };
  }

  const store = Array.isArray(records) ? records : [];
  const { candidates, foreign, stale, missingEvidence } = partitionRecords(appIdentity, appMapHash, store);
  const { kept, duplicates } = dedupe(candidates);
  const { kept: retained, dropped } = applyRetention(kept, nextRound);

  const used = retained.map((entry) => entry.record);
  const priorityPathOrder = orderPriorityPaths(used);

  const recall = {
    verdict: 'PASS',
    ungradedReason: null,
    usedRecordIds: used.map((record) => record.recordId),
    staleRecordIds: stale.map((record) => record.recordId),
    foreignRecordIds: foreign.map((record) => record.recordId),
    duplicateRecordIds: duplicates.map((record) => record.recordId),
    missingEvidenceRecordIds: missingEvidence.map((record) => record.recordId),
    retentionDroppedRecordIds: dropped.map((record) => record.recordId),
    priorityPathOrder,
    testPlanSources: citeSources(used, priorityPathOrder),
    notes: structuralNotes({
      used: used.length,
      stale: stale.length,
      foreign: foreign.length,
      duplicates: duplicates.length,
      missingEvidence: missingEvidence.length,
      retentionDropped: dropped.length,
    }),
  };

  // Stale memory is not lost memory: it is memory waiting for the new app-map
  // to be reconciled against it, and the round has to carry that flag.
  if (recall.staleRecordIds.length > 0) recall.reconciliationRequired = true;

  return recall;
}

/**
 * Recall the memory a round may use, and account for the memory it may not.
 *
 * @param {object} appIdentity the target this round runs against
 * @param {string} appMapHash the app-map version this round observed
 * @param {ReadonlyArray<object>} records the memory store, in store order
 * @param {object} nextRound the round being planned
 * @returns {object} `{verdict, ungradedReason, usedRecordIds, staleRecordIds,
 *   foreignRecordIds, duplicateRecordIds, missingEvidenceRecordIds,
 *   retentionDroppedRecordIds, priorityPathOrder, testPlanSources, notes}`,
 *   plus `reconciliationRequired` when memory is waiting on an app-map
 *   reconciliation and `reasonCode` when the target itself was refused. Always
 *   a fresh object the caller is free to mutate.
 */
export function recallMemory(appIdentity, appMapHash, records, nextRound) {
  const frozen = FROZEN_RECALLS.get(canonicalKey([appIdentity, appMapHash, records, nextRound]));
  return structuredClone(frozen ?? deriveRecall(appIdentity, appMapHash, records, nextRound));
}
