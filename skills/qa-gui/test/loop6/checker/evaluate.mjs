import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CHECKER_DIR = dirname(new URL(import.meta.url).pathname);
export const ROOT = resolve(CHECKER_DIR, '../../..');
export const CORPUS_DIR = resolve(ROOT, 'test/loop6/corpus');
export const PRODUCT_PATH = resolve(ROOT, 'scripts/loop6/index.mjs');

const EXPORTS = {
  'V6.1': ['buildAppMap', (c) => [c.observations]],
  'V6.2': ['generateProperties', (c) => [c.appMap, c.baRequirements, c.envPin]],
  'V6.3': ['recallMemory', (c) => [c.appIdentity, c.appMapHash, c.records, c.nextRound]],
  'V6.4': ['diagnoseFailure', (c) => [c.evidence]],
  'V6.5': ['baToPlan', (c) => [c.markdown]],
  'V6.6': ['replayIntent', (c) => [c.savedSteps, c.redesignedControls]],
  'V6.7': ['evaluateRegressionJob', (c) => [c.job, c.runResult]],
  'V6.8': ['planFormProbes', (c) => [c.fields]],
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const finiteRate = (n, d, empty = 0) => d === 0 ? empty : n / d;
const jsonEqual = (a, b) => {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};
const isJsonCompatible = (value) => {
  try { return value !== undefined && JSON.parse(JSON.stringify(value)) !== undefined; } catch { return false; }
};

export async function validateCorpus() {
  const manifestPath = resolve(CORPUS_DIR, 'CORPUS-MANIFEST.json');
  const raw = await readFile(manifestPath);
  const manifest = JSON.parse(raw);
  if (manifest.manifestVersion !== 1 || manifest.status !== 'FROZEN') throw new Error('corpus manifest is not frozen v1');
  if (!Array.isArray(manifest.files) || manifest.files.length !== 8) throw new Error('corpus manifest must contain eight files');
  const seen = new Set();
  const corpora = new Map();
  let hard = 0;
  let ordinary = 0;
  for (const entry of manifest.files) {
    if (!entry || typeof entry.file !== 'string' || seen.has(entry.feature)) throw new Error('invalid or duplicate corpus manifest entry');
    seen.add(entry.feature);
    const fileRaw = await readFile(resolve(CORPUS_DIR, entry.file));
    if (sha256(fileRaw) !== entry.sha256) throw new Error(`corpus hash mismatch: ${entry.file}`);
    const corpus = JSON.parse(fileRaw);
    if (corpus.feature !== entry.feature || corpus.version !== 1 || corpus.frozen !== true) throw new Error(`invalid frozen corpus header: ${entry.file}`);
    if (corpus.sourceBaSha256 !== manifest.sourceBaSha256) throw new Error(`BA hash mismatch in ${entry.file}`);
    if (corpus.hard.length !== entry.hard || corpus.ordinary.length !== entry.ordinary) throw new Error(`corpus count mismatch: ${entry.file}`);
    const [, args] = EXPORTS[entry.feature];
    const deterministicInputs = new Map();
    for (const testCase of [...corpus.hard, ...corpus.ordinary]) {
      const input = JSON.stringify(args(testCase));
      const expected = oracle(entry.feature, testCase);
      const prior = deterministicInputs.get(input);
      if (prior && !jsonEqual(prior.expected, expected)) {
        throw new Error(`non-deterministic corpus input: ${entry.feature} ${prior.id} conflicts with ${testCase.id}`);
      }
      deterministicInputs.set(input, { id: testCase.id, expected });
    }
    hard += corpus.hard.length;
    ordinary += corpus.ordinary.length;
    corpora.set(entry.feature, corpus);
  }
  if (hard !== manifest.totals?.hard || ordinary !== manifest.totals?.ordinary) throw new Error('manifest total mismatch');
  return { manifest, corpora };
}

async function loadProduct() {
  try { await access(PRODUCT_PATH, constants.R_OK); } catch { return { exists: false, module: null }; }
  try {
    return { exists: true, module: await import(`${pathToFileURL(PRODUCT_PATH).href}?checker=${Date.now()}`) };
  } catch (error) {
    return { exists: true, module: null, importError: String(error?.message || error) };
  }
}

function oracle(feature, c) {
  switch (feature) {
    case 'V6.1': return c.expectedGraph;
    case 'V6.2': return { verdict: c.expectedVerdict, properties: c.expectedProperties, ungradedReason: c.ungradedReason ?? null };
    case 'V6.3': return c.expected;
    case 'V6.4': return { label: c.expectedLabel, action: c.expectedAction };
    case 'V6.5': return { cases: c.expectedCases, coverage: c.expectedCoverage };
    case 'V6.6': return {
      verdict: c.expectedVerdict,
      targets: c.expectedTargets,
      haltAtStep: c.haltAtStep ?? null,
      reason: c.reason ?? null,
      ungradedReason: c.ungradedReason ?? null,
    };
    case 'V6.7': return c.expectedReport;
    case 'V6.8': return { probes: c.expectedProbes, untested: c.expectedUntested ?? [] };
    default: throw new Error(`unknown feature ${feature}`);
  }
}

function actualProjection(feature, value) {
  if (feature === 'V6.4') return { label: value?.label, action: value?.action };
  return value;
}

function isFalsePositive(feature, expected, actual, matched) {
  if (matched) return false;
  if (feature === 'V6.2') {
    const expectedItems = expected.properties ?? [];
    const actualItems = Array.isArray(actual?.properties) ? actual.properties : [];
    return actualItems.some((item) => !expectedItems.some((wanted) => jsonEqual(item, wanted)));
  }
  if (feature === 'V6.8') {
    const actualItems = Array.isArray(actual?.probes) ? actual.probes : [];
    return actualItems.some((item) => !(expected.probes ?? []).some((wanted) => jsonEqual(item, wanted)));
  }
  return actual !== undefined && actual !== null;
}

export async function evaluate() {
  const { manifest, corpora } = await validateCorpus();
  const product = await loadProduct();
  const features = {};
  let totalMatched = 0;
  let totalCases = 0;
  let totalOrdinaryFp = 0;
  let totalOrdinary = 0;
  let realBugMatched = 0;
  let realBugTotal = 0;

  for (const entry of manifest.files) {
    const feature = entry.feature;
    const corpus = corpora.get(feature);
    const [exportName, args] = EXPORTS[feature];
    const fn = product.module?.[exportName];
    const rows = [];
    for (const kind of ['hard', 'ordinary']) {
      for (const c of corpus[kind]) {
        let actual;
        let error = null;
        if (typeof fn === 'function') {
          try { actual = await fn(...args(c)); } catch (caught) { error = String(caught?.message || caught); }
        }
        const expected = oracle(feature, c);
        const projected = actualProjection(feature, actual);
        let matched = typeof fn === 'function' && error === null && jsonEqual(projected, expected);
        if (feature === 'V6.4' && matched) {
          matched = typeof actual?.reason === 'string' && actual.reason.length > 0
            && isJsonCompatible(actual?.evidence)
            && !(c.mustNeverRetry && actual.action === 'retry');
        }
        const falsePositive = kind === 'ordinary' && isFalsePositive(feature, expected, projected, matched);
        const expectedProductVerdict = c.expectedVerdict ?? c.expected?.verdict ?? c.expectedCoverage?.verdict ?? c.expectedReport?.verdict ?? null;
        rows.push({ id: c.id, kind, graded: true, expectedProductVerdict, expected, actual: projected, matched, falsePositive, error });
        totalCases += 1;
        if (matched) totalMatched += 1;
        if (kind === 'ordinary') {
          totalOrdinary += 1;
          if (falsePositive) totalOrdinaryFp += 1;
        }
        if (feature === 'V6.4' && c.expectedLabel === 'real-bug') {
          realBugTotal += 1;
          if (matched) realBugMatched += 1;
        }
      }
    }
    const matched = rows.filter((r) => r.matched).length;
    const falsePositives = rows.filter((r) => r.falsePositive).length;
    features[feature] = {
      exportName,
      exportAvailable: typeof fn === 'function',
      graded: rows.length,
      ungraded: 0,
      matched,
      missed: rows.length - matched,
      ordinary: corpus.ordinary.length,
      falsePositives,
      recall: finiteRate(matched, rows.length),
      falsePositiveRate: product.exists ? finiteRate(falsePositives, corpus.ordinary.length) : 1,
      rows,
    };
    if (feature === 'V6.4') {
      features[feature].realBugTotal = rows.filter((row) => row.expected.label === 'real-bug').length;
      features[feature].realBugMatched = rows.filter((row) => row.expected.label === 'real-bug' && row.matched).length;
      features[feature].realBugRecall = product.exists
        ? finiteRate(features[feature].realBugMatched, features[feature].realBugTotal)
        : 0;
    }
  }

  return {
    productExists: product.exists,
    productImportable: product.module !== null,
    importError: product.importError ?? null,
    manifestValid: true,
    features,
    overallRecall: product.exists ? finiteRate(totalMatched, totalCases) : 0,
    falsePositiveRate: product.exists ? finiteRate(totalOrdinaryFp, totalOrdinary) : 1,
    realBugRecall: product.exists ? finiteRate(realBugMatched, realBugTotal) : 0,
  };
}
