#!/usr/bin/env node

// dragon-responsive-matrix-preflight.mjs — Gate-0 responsive matrix over Dragon Browser.
// Measures ONE isolated tab across the canonical seven-row responsive matrix with the
// real bundled ui-sanity + a11y-gate0 sweeps, verifies mobile emulation before grading
// every phone row, captures one PNG per row, and normalizes the findings into the frozen
// responsive risk families.
// Fail-closed everywhere: a denial, a malformed payload, a missing read, an unhonoured
// viewport or a failed cleanup is an error — never a silent PASS.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDirectExecution } from './lib/is-direct-execution.mjs';

import { attachFindingBboxes } from './loop8/index.mjs';
import { verifyMobileEmulation } from './loop7/mobile-emulation.mjs';
import { RESPONSIVE_MATRIX as CANONICAL_MATRIX } from './loop7/responsive-matrix.mjs';

const RPC = process.env.DRAGON_RPC || 'http://localhost:9233/rpc';
const STABLE_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'service-token');
const LEGACY_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'token');
const RPC_TIMEOUT_MS = 15_000;
const UI_GATE_FILE = join(import.meta.dirname, 'ui-sanity.js');
const A11Y_GATE_FILE = join(import.meta.dirname, 'a11y-gate0.js');
const MIN_TARGET_PX = 24;
const MOBILE_SAMPLE_COUNT = 5;
const MOBILE_IDENTITY = 'Android Chrome';
const MEASURE_UI_SLOT = '__qaGuiResponsiveUi';
const MEASURE_A11Y_SLOT = '__qaGuiResponsiveA11y';
// V8.1: size the elements the Gate-0 sweeps just flagged, in the page state they were flagged in.
// Only real CSS rectangles come back — a selector that no longer resolves is simply omitted, so a
// missing element stays a miss instead of turning into a zero box somewhere on the page.
const MEASURE_SOURCE = `return (() => {
  const measurements = [];
  const seen = new Set();
  for (const report of [window.${MEASURE_UI_SLOT}, window.${MEASURE_A11Y_SLOT}]) {
    const issues = report && Array.isArray(report.issues) ? report.issues : [];
    for (const issue of issues) {
      if (String((issue && issue.sev) || '').toLowerCase() !== 'high') continue;
      const selector = issue && typeof issue.sel === 'string' ? issue.sel : '';
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      let element = null;
      try { element = document.querySelector(selector); } catch (error) { element = null; }
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      measurements.push({
        selector,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
  }
  return measurements;
})();`;
const MOBILE_READBACK_SOURCE = `return {
  touchPoints: Number(navigator.maxTouchPoints),
  dpr: Number(globalThis.devicePixelRatio),
  userAgent: String(navigator.userAgent || ''),
  uaDataMobile: navigator.userAgentData
    ? navigator.userAgentData.mobile === true
    : /\\bMobile\\b/.test(String(navigator.userAgent || '')),
  platform: navigator.userAgentData && navigator.userAgentData.platform
    ? String(navigator.userAgentData.platform)
    : String(navigator.platform || '')
};`;

/**
 * The rows this preflight sweeps come directly from the canonical matrix. No row id, size,
 * profile or DPR is copied here: editing that one source changes every consumer together.
 */
export const RESPONSIVE_MATRIX = CANONICAL_MATRIX;

// Rule -> frozen risk family.  Only rules the Gate-0 sweeps actually emit are mapped, so an
// ordinary page cannot pick up a synthetic responsive risk it has no evidence for.
const UI_RULE_RISKS = Object.freeze({
  'page-overflow-x': 'responsive-page-overflow',
  'overlay-cut-viewport': 'responsive-overlay-cut',
  'overlay-cut-ancestor': 'responsive-overlay-cut',
  'text-clipped-x': 'responsive-text-clipped',
  'text-clipped-y': 'responsive-text-clipped',
  'unintended-text-overflow': 'responsive-text-clipped',
  'occluded-control': 'responsive-occluded-control',
  'stacking-error': 'responsive-stacking-error',
  'invisible-interactive': 'responsive-invisible-control',
});
const A11Y_RULE_RISKS = Object.freeze({
  'target-size': 'responsive-small-target',
});

let redactToken = '';

function rpcToken() {
  const fromEnv = String(process.env.DRAGON_RPC_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const tokenFiles = process.env.DRAGON_RPC_TOKEN_FILE
    ? [process.env.DRAGON_RPC_TOKEN_FILE]
    : [STABLE_TOKEN_FILE, LEGACY_TOKEN_FILE];
  for (const tokenFile of tokenFiles) {
    try {
      const fromFile = readFileSync(tokenFile, 'utf8').trim();
      if (fromFile) return fromFile;
    } catch {}
  }
  throw new Error('Dragon bearer token is missing; set DRAGON_RPC_TOKEN or DRAGON_RPC_TOKEN_FILE');
}

function safeMessage(error, token = redactToken) {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.split(token).join('[redacted]') : message;
}

function normalizeViewport(value) {
  if (!value || typeof value !== 'object') return null;
  const w = Number(value.w ?? value.width);
  const h = Number(value.h ?? value.height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

function isHigh(issue) {
  return String(issue?.sev || '').toLowerCase() === 'high';
}

function riskFor(issue, source) {
  const rule = String(issue?.rule || '');
  if (source === 'a11y') {
    if (/^reflow(-\d+)?$/.test(rule)) return 'responsive-reflow';
    return A11Y_RULE_RISKS[rule] || null;
  }
  return UI_RULE_RISKS[rule] || null;
}

/**
 * The measured rectangle for a selector-backed issue, taken from the rects the row itself
 * measured. A row without measurements, or a selector whose element was gone by the time it was
 * measured, yields nothing: the risk then carries no geometry rather than an invented one.
 */
function measuredBbox(row, sel) {
  const [measured] = attachFindingBboxes({
    findings: [{ selector: sel }],
    measurements: row.measurements,
    dpr: row.dpr,
  });
  return measured?.bbox;
}

/**
 * Normalize per-viewport Gate-0 findings into the frozen responsive risk families.
 * Pure: it only reports what the measured rows already prove, so a clean matrix and a
 * warn-only matrix both come back empty.
 */
export function classifyResponsiveMatrix(rows = []) {
  const risks = [];
  const seen = new Set();
  const add = (type, viewport, evidence) => {
    const key = `${type}|${viewport.w}x${viewport.h}|${evidence.rule}|${evidence.sel || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    risks.push({ type, viewport, ...evidence });
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const requested = normalizeViewport(row.requested) || normalizeViewport(row.viewport);

    for (const source of ['ui', 'a11y']) {
      const report = row[source];
      if (!report || typeof report !== 'object') continue;
      const reported = normalizeViewport(report.viewport);

      // The override sanity check from the skill: a sweep that reports a different width than
      // the one we asked for measured the wrong size, so the whole row is untrustworthy.
      if (requested && reported && reported.w !== requested.w) {
        add('viewport-override-mismatch', requested, {
          rule: 'viewport-not-honored',
          sev: 'high',
          source,
          detail: `requested ${requested.w}x${requested.h} but ${source} reported ${reported.w}x${reported.h}`,
        });
      }

      const at = reported || requested;
      if (!at) continue;
      for (const issue of Array.isArray(report.issues) ? report.issues : []) {
        if (!isHigh(issue)) continue;
        const type = riskFor(issue, source);
        if (!type) continue;
        const sel = typeof issue.sel === 'string' ? issue.sel : undefined;
        const bbox = sel ? measuredBbox(row, sel) : undefined;
        add(type, at, {
          rule: String(issue.rule),
          sev: 'high',
          source,
          sel,
          detail: typeof issue.detail === 'string' ? issue.detail : undefined,
          // Only a really measured rectangle is carried; absence stays absent.
          ...(bbox ? { bbox } : {}),
        });
      }
    }
  }

  return risks;
}

function parseArgs(argv) {
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--tab-id') args.tabId = Number(argv[++index]);
    else if (value === '--url') args.url = argv[++index];
    else if (value === '--session-id') args.sessionId = argv[++index];
    else if (value === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function rpc(method, params) {
  const token = rpcToken();
  let response;
  let payload;
  try {
    response = await fetch(RPC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const raw = await response.text();
    try { payload = JSON.parse(raw); }
    catch { throw new Error(`Dragon RPC ${method} returned malformed JSON`); }
  } catch (error) {
    throw new Error(safeMessage(error, token));
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(safeMessage(payload?.error || `Dragon RPC ${method} failed with HTTP ${response.status}`, token));
  }
  const result = payload?.result;
  // /rpc nests its denials: HTTP 200 + {ok:true, result:{ok:false, code:...}}.
  if (result?.ok === false) {
    throw new Error(safeMessage(`${method}: ${result.code || 'DENIED'} — ${result.reason || result.error || 'Dragon denied the call'}`, token));
  }
  const failedStep = Array.isArray(result?.results)
    ? result.results.find((step) => step?.ok === false)
    : null;
  if (failedStep) {
    throw new Error(safeMessage(`${method}: ${failedStep.code || 'STEP_FAILED'} — ${failedStep.reason || failedStep.error || 'Dragon denied a step'}`, token));
  }
  if (result === undefined || result === null) throw new Error(`Dragon RPC ${method} returned no result`);
  return result;
}

function isGateReport(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && normalizeViewport(value.viewport) !== null
    && Array.isArray(value.issues);
}

/**
 * Resolve one Gate-0 report out of a `do` reply.  Dragon may return it under the step alias or
 * bundled in a single `responsiveSnapshot` read; anything that is not a real report is rejected
 * rather than defaulted to an empty (i.e. passing) sweep.
 */
function pickReport(reads, key) {
  for (const candidate of [reads?.[key], reads?.responsiveSnapshot?.[key], reads?.[`${key}GateSource`]]) {
    if (isGateReport(candidate)) return candidate;
  }
  return null;
}

function viewportSteps(viewport, uiGateSource, a11yGateSource) {
  const label = `responsive-${viewport.w}x${viewport.h}`;
  return [
    // Dragon's live `do` grammar has a numeric `wait` step; `{settle:true}` is only
    // shorthand in prose and is rejected by the extension as an unknown step.
    { wait: 250 },
    // The bundled Gate-0 files are shipped verbatim, then invoked — no re-implementation,
    // no synthetic DOM evidence.  Each report is also parked on `window` so the measure step
    // below can size exactly the elements the sweeps just complained about, in the same page
    // state and the same `do` call.
    { read: uiGateSource, as: 'uiGateSource' },
    { read: `return (window.${MEASURE_UI_SLOT} = window.__uiSanity(${JSON.stringify(label)}));`, as: 'ui' },
    { read: a11yGateSource, as: 'a11yGateSource' },
    { read: `return (window.${MEASURE_A11Y_SLOT} = window.__a11yB({ minTarget: ${MIN_TARGET_PX} }));`, as: 'a11y' },
    { read: MEASURE_SOURCE, as: 'measurements' },
  ];
}

function mobilePinSteps() {
  const steps = [];
  for (let index = 1; index <= MOBILE_SAMPLE_COUNT; index += 1) {
    steps.push({ read: MOBILE_READBACK_SOURCE, as: `mobilePin${index}` });
    if (index < MOBILE_SAMPLE_COUNT) steps.push({ wait: 50 });
  }
  return steps;
}

function mobilePinSamples(reads) {
  if (!reads || typeof reads !== 'object') return [];
  return Array.from(
    { length: MOBILE_SAMPLE_COUNT },
    (_, index) => reads[`mobilePin${index + 1}`],
  );
}

function safeEvidenceSegment(value) {
  return String(value || 'run').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96);
}

async function captureRowEvidence(binding, tabId, row) {
  const relative = join(
    'qa-gui',
    'responsive-matrix',
    safeEvidenceSegment(binding.sessionId),
    `${safeEvidenceSegment(row.id)}.png`,
  );
  const capture = await rpc('captureTab', {
    ...binding,
    tabId,
    format: 'png',
    toFile: relative,
    correlationId: `responsive-${row.id}`,
  });
  if (!capture?.savedTo || capture?.evidence?.kind !== 'screenshot' || !capture.evidence.ref) {
    throw new Error(`Dragon captureTab produced no saved screenshot evidence for ${row.id}`);
  }
  return {
    screenshot: capture.savedTo,
    ref: capture.evidence.ref,
    contentHash: capture.evidence.contentHash,
  };
}

async function waitForOpenedTarget(binding, tabId, requestedUrl) {
  const expectedOrigin = new URL(requestedUrl).origin;
  let last = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    last = await rpc('getTabInfo', { ...binding, tabId });
    try {
      if (last.status === 'complete' && new URL(last.url).origin === expectedOrigin) return last;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Dragon openTab did not reach the requested origin ${expectedOrigin}; last URL ${last?.url || 'unknown'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((args.url ? 1 : 0) + (Number.isInteger(args.tabId) ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of --url or --tab-id');
  }
  // Fail before any useful work if the bearer token is unavailable.
  redactToken = rpcToken();

  let uiGateSource;
  let a11yGateSource;
  try {
    uiGateSource = readFileSync(UI_GATE_FILE, 'utf8');
    a11yGateSource = readFileSync(A11Y_GATE_FILE, 'utf8');
  } catch {
    throw new Error('Bundled Gate-0 scripts (ui-sanity.js / a11y-gate0.js) are unreadable');
  }

  const requestedSessionId = args.sessionId || `qa-gui-responsive-matrix-${randomUUID()}`;
  let session;
  let sessionId = requestedSessionId;
  let tabId = args.tabId;
  let output;
  let taskError;
  let cleanupError;
  try {
    session = await rpc('session.create', { sessionId: requestedSessionId, forbidSyntheticDOM: false });
    sessionId = session.sessionId || requestedSessionId;
    if (session.forbidSyntheticDOM !== false) throw new Error('Dragon refused forbidSyntheticDOM=false');
    if (!session.nonce || !session.browserInstanceId) throw new Error('Dragon session returned no nonce/browserInstanceId binding');
    const binding = { sessionId, nonce: session.nonce, browserInstanceId: session.browserInstanceId };

    if (args.url) {
      const opened = await rpc('openTab', { ...binding, url: args.url, active: false });
      if (!Number.isInteger(opened.tabId)) throw new Error('Dragon openTab returned no tabId');
      tabId = opened.tabId;
      await waitForOpenedTarget(binding, tabId, args.url);
      await rpc('waitForState', { ...binding, tabId, state: 'complete', timeoutMs: 10_000 });
    }

    const matrix = [];
    for (const requested of RESPONSIVE_MATRIX) {
      // Emulate the row as the device it is, not just as a width: a mobile row that is
      // driven as a resized desktop window reports desktop touch targets and DPR 1, so its
      // findings are not mobile findings at all.  `mobile` and the scale factor come from
      // the canonical row, never from guessing at the width.
      const applied = await rpc('setViewport', {
        ...binding,
        tabId,
        width: requested.w,
        height: requested.h,
        mobile: requested.profile === 'mobile',
        deviceScaleFactor: requested.dpr,
      });
      const echoed = normalizeViewport(applied);
      if (echoed && echoed.w !== requested.w) {
        throw new Error(`Dragon setViewport did not honor the requested viewport ${requested.w}x${requested.h}: applied width ${echoed.w}`);
      }

      let emulation = null;
      if (requested.profile === 'mobile') {
        const pinRead = await rpc('do', {
          ...binding,
          tabId,
          steps: mobilePinSteps(),
        });
        const samples = mobilePinSamples(pinRead.reads);
        emulation = verifyMobileEmulation({
          expected: { touch: true, dpr: requested.dpr, identity: MOBILE_IDENTITY },
          samples,
        });
        if (emulation.verdict !== 'PASS') {
          const evidence = await captureRowEvidence(binding, tabId, requested);
          matrix.push({
            row: requested.id,
            profile: requested.profile,
            dpr: requested.dpr,
            requested: { w: requested.w, h: requested.h },
            verdict: 'UNGRADED',
            code: 'emulation-not-verified',
            emulation,
            evidence,
          });
          continue;
        }
      }

      const measured = await rpc('do', {
        ...binding,
        tabId,
        steps: viewportSteps(requested, uiGateSource, a11yGateSource),
      });
      const reads = measured.reads;
      if (!reads || typeof reads !== 'object') {
        throw new Error(`Dragon returned no Gate-0 reads at ${requested.w}x${requested.h}`);
      }
      const ui = pickReport(reads, 'ui');
      const a11y = pickReport(reads, 'a11y');
      if (!ui) throw new Error(`Dragon ui-sanity read produced no usable report at ${requested.w}x${requested.h}`);
      if (!a11y) throw new Error(`Dragon a11y-gate0 read produced no usable report at ${requested.w}x${requested.h}`);

      // A sweep that measured a different width measured the wrong page state; the whole
      // matrix would silently collapse onto one size, so stop here instead of reporting it.
      for (const [source, report] of [['ui', ui], ['a11y', a11y]]) {
        const reported = normalizeViewport(report.viewport);
        if (reported.w !== requested.w) {
          throw new Error(`Dragon viewport override was not honored at ${requested.w}x${requested.h}: ${source} reported width ${reported.w} (viewport mismatch)`);
        }
      }

      const evidence = await captureRowEvidence(binding, tabId, requested);
      // Rects for the flagged selectors, measured in the same `do` call as the sweeps above.
      // A Dragon build that does not return the read leaves the row unmeasured rather than
      // failing the sweep it does have evidence for.
      const measurements = Array.isArray(reads.measurements) ? reads.measurements : [];

      matrix.push({
        row: requested.id,
        profile: requested.profile,
        dpr: requested.dpr,
        requested: { w: requested.w, h: requested.h },
        verdict: 'PASS',
        ...(emulation ? { emulation } : {}),
        evidence,
        measurements,
        ui: { viewport: normalizeViewport(ui.viewport), verdict: ui.verdict, issues: ui.issues },
        a11y: { viewport: normalizeViewport(a11y.viewport), verdict: a11y.verdict, issues: a11y.issues },
      });
    }

    const risks = classifyResponsiveMatrix(matrix).map((risk) => {
      const row = matrix.find((candidate) => candidate.requested?.w === risk.viewport?.w
        && candidate.requested?.h === risk.viewport?.h);
      return row?.evidence ? { ...risk, evidence: row.evidence } : risk;
    });
    for (const risk of risks) {
      const row = matrix.find((candidate) => candidate.requested?.w === risk.viewport?.w
        && candidate.requested?.h === risk.viewport?.h);
      if (row && row.verdict !== 'UNGRADED') row.verdict = 'FAIL';
    }
    const ungraded = matrix.filter((row) => row.verdict === 'UNGRADED');
    output = {
      tabId,
      matrix,
      risks,
      verdict: risks.length ? 'FAIL' : ungraded.length ? 'UNGRADED' : 'PASS',
      ...(ungraded.length ? { ungraded: ungraded.map(({ row, code }) => ({ row, code })) } : {}),
    };
  } catch (error) {
    taskError = error;
  } finally {
    if (session) {
      try {
        await rpc('session.close', {
          sessionId,
          nonce: session.nonce,
          browserInstanceId: session.browserInstanceId,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (output && !cleanupError) console.log(args.json ? JSON.stringify(output) : JSON.stringify(output, null, 2));
  if (taskError) {
    if (cleanupError) taskError.message = `${safeMessage(taskError)}; cleanup failed: ${safeMessage(cleanupError)}`;
    throw taskError;
  }
  if (cleanupError) throw cleanupError;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error(safeMessage(error));
    process.exitCode = 1;
  });
}
