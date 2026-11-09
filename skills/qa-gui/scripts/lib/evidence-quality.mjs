// Correct and light evidence (upgrade R1f). Runtime dependencies: Node built-ins only.
//
// A board that declares `evidencePolicy: {version: 1}` gets two machine checks on top of the byte checks it already
// had (file exists, valid PNG / mp4 over 50 KB, SHA-256 matches):
//   - every screenshot that backs a state is not blank, is bound to its state receipt (tab, URL, build, DOM hash and
//     the capture's own bytes), has the receipt viewport's shape, holds the named target rect, and is at most 1,280 px
//     wide (the `fit` below);
//   - every behavioral recording segment points at a recording manifest (qa-gui/recording-manifest/v1) whose frames
//     cover the action times, change after the action, are not one repeated image, and were all saved.
// A failed check is an issue with a stable code and a fix hint; the gate makes the case UNGRADED (it cannot PASS).
// The checks, the fit and the manifest builder are pure functions here; the gate and the CLI (scripts/qa-gui.mjs) and
// Team QA's `web collect` all use the same code. Contract: references/state-receipt-v1.md ("Evidence policy v1").
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { decodePng } from '../visual-diff.mjs';

export const EVIDENCE_POLICY_VERSION = 1;
export const RECORDING_MANIFEST_SCHEMA = 'qa-gui/recording-manifest/v1';
export const MAX_EVIDENCE_WIDTH = 1280;
// Blank: one flat colour over this share of the unmasked pixels, or a luminance standard deviation below this floor.
export const BLANK_DOMINANT_SHARE = 0.9995;
export const BLANK_MIN_LUMA_STDDEV = 1;
// Video windows, in recording milliseconds: every action needs a frame this close; some frame must change this soon
// after an action; the action window [first action - AROUND, last action + CHANGE] must not be one repeated image.
export const ACTION_AROUND_MS = 1000;
export const ACTION_CHANGE_MS = 3000;

export const EVIDENCE_CODES = Object.freeze({
  EVIDENCE_IMAGE_INVALID: 're-capture',
  EVIDENCE_IMAGE_BLANK: 're-capture',
  EVIDENCE_IMAGE_BINDING: 're-capture',
  EVIDENCE_IMAGE_TARGET_OUTSIDE: 're-capture',
  EVIDENCE_IMAGE_TARGET_MISSING: 're-capture',
  EVIDENCE_IMAGE_TOO_WIDE: 're-capture',
  EVIDENCE_IMAGE_FIT: 're-capture',
  EVIDENCE_VIDEO_MANIFEST: 're-record',
  EVIDENCE_VIDEO_FRAME_COUNT: 're-record',
  EVIDENCE_VIDEO_NO_ACTION_COVERAGE: 're-record',
  EVIDENCE_VIDEO_NO_CHANGE: 're-record',
  EVIDENCE_VIDEO_STALE: 're-record',
});

const SHA256 = /^[0-9a-f]{64}$/;
const FRAME_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function evidencePolicyOn(data) {
  return isObject(data?.evidencePolicy) && data.evidencePolicy.version === EVIDENCE_POLICY_VERSION;
}

// One issue line: `<CODE>:<scope>:<detail> fix=<hint>`. The scope names the case and the state or segment.
export function evidenceIssue(code, scope, detail) {
  if (!Object.hasOwn(EVIDENCE_CODES, code)) throw new Error(`unknown evidence code ${code}`);
  return { code, hint: EVIDENCE_CODES[code], message: `${code}:${scope}:${detail} fix=${EVIDENCE_CODES[code]}` };
}

export function parseViewport(value) {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(String(value ?? ''));
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

// ── fit: box-filter downscale to at most maxWidth, exact integer arithmetic (deterministic) ─────────────────────────
// For each output column/row, the source span [i*s, (i+1)*s) is weighted by its exact overlap, in 1/65536 units that
// sum to 65536. An output pixel whose whole span is mask black stays exactly (0,0,0). Mask rects (CSS px of the
// capture's viewport) are painted black again after the scale, rounded outward, so a box keeps its black edges.
function spanWeights(from, to) {
  const scale = from / to;
  const out = [];
  for (let i = 0; i < to; i += 1) {
    const start = i * scale, end = (i + 1) * scale;
    const first = Math.floor(start), last = Math.min(from - 1, Math.ceil(end) - 1);
    const taps = [];
    let total = 0;
    for (let j = first; j <= last; j += 1) {
      const overlap = Math.min(end, j + 1) - Math.max(start, j);
      if (overlap <= 0) continue;
      const weight = Math.round((overlap / scale) * 65536);
      taps.push([j, weight]); total += weight;
    }
    taps[taps.length - 1][1] += 65536 - total;
    out.push(taps);
  }
  return out;
}

export function fitRgba(image, { maxWidth = MAX_EVIDENCE_WIDTH } = {}) {
  const { width, height, data } = image;
  if (!Number.isInteger(maxWidth) || maxWidth < 1) throw new Error('maxWidth must be a positive integer');
  if (width <= maxWidth) return { width, height, data: Buffer.from(data) };
  const outW = maxWidth, outH = Math.max(1, Math.round((height * outW) / width));
  const cols = spanWeights(width, outW), rows = spanWeights(height, outH);
  const mid = new Uint32Array(outW * height * 4);
  for (let y = 0; y < height; y += 1) {
    const src = y * width * 4, dst = y * outW * 4;
    for (let x = 0; x < outW; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [j, w] of cols[x]) { const p = src + j * 4; r += data[p] * w; g += data[p + 1] * w; b += data[p + 2] * w; a += data[p + 3] * w; }
      const q = dst + x * 4; mid[q] = r; mid[q + 1] = g; mid[q + 2] = b; mid[q + 3] = a;
    }
  }
  const out = Buffer.alloc(outW * outH * 4);
  const SCALE = 65536 * 65536;
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [j, w] of rows[y]) { const p = (j * outW + x) * 4; r += mid[p] * w; g += mid[p + 1] * w; b += mid[p + 2] * w; a += mid[p + 3] * w; }
      const q = (y * outW + x) * 4;
      out[q] = Math.round(r / SCALE); out[q + 1] = Math.round(g / SCALE); out[q + 2] = Math.round(b / SCALE); out[q + 3] = Math.round(a / SCALE);
    }
  }
  return { width: outW, height: outH, data: out };
}

// Mask rects in image pixels: Dragon reports `maskedRects` as {x,y,w,h} in CSS px of the viewport; the image holds
// that viewport at `width / cssWidth` image px per CSS px. Rounded outward and grown by `grow` px, clamped.
export function maskRectsInImage(rects, { width, height }, cssWidth, grow = 0) {
  if (!Array.isArray(rects) || !(cssWidth > 0)) return [];
  const scale = width / cssWidth;
  return rects.filter((rect) => isObject(rect) && [rect.x, rect.y, rect.w, rect.h].every(finite) && rect.w > 0 && rect.h > 0).map((rect) => ({
    x1: Math.max(0, Math.floor(rect.x * scale) - grow), y1: Math.max(0, Math.floor(rect.y * scale) - grow),
    x2: Math.min(width, Math.ceil((rect.x + rect.w) * scale) + grow), y2: Math.min(height, Math.ceil((rect.y + rect.h) * scale) + grow),
  })).filter((rect) => rect.x2 > rect.x1 && rect.y2 > rect.y1);
}

function paintBlack(image, rects) {
  for (const rect of rects) {
    for (let y = rect.y1; y < rect.y2; y += 1) {
      for (let x = rect.x1; x < rect.x2; x += 1) {
        const q = (y * image.width + x) * 4;
        image.data[q] = 0; image.data[q + 1] = 0; image.data[q + 2] = 0;
      }
    }
  }
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      return c >>> 0;
    });
  }
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); name.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}

// PNG: 8-bit RGB when every pixel is opaque (else RGBA), per-row adaptive filter (least sum of absolute values among
// None/Sub/Up/Average/Paeth), deflate level 9. Same input, same Node zlib: same bytes.
export function encodeEvidencePng({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height * 4) throw new Error('invalid RGBA image');
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const channels = opaque ? 3 : 4, stride = width * channels;
  const rowsRaw = Buffer.alloc(stride * height);
  for (let i = 0, p = 0; i < width * height; i += 1) {
    const q = i * 4;
    rowsRaw[p++] = data[q]; rowsRaw[p++] = data[q + 1]; rowsRaw[p++] = data[q + 2];
    if (!opaque) rowsRaw[p++] = data[q + 3];
  }
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride, prev = y ? row - stride : -1;
    let best = null, bestFilter = 0, bestScore = Infinity;
    for (let filter = 0; filter < 5; filter += 1) {
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const value = rowsRaw[row + x];
        const left = x >= channels ? rowsRaw[row + x - channels] : 0;
        const up = prev >= 0 ? rowsRaw[prev + x] : 0;
        const upperLeft = prev >= 0 && x >= channels ? rowsRaw[prev + x - channels] : 0;
        let predicted = 0;
        if (filter === 1) predicted = left;
        else if (filter === 2) predicted = up;
        else if (filter === 3) predicted = (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - upperLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upperLeft);
          predicted = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upperLeft);
        }
        const out = (value - predicted) & 0xff;
        candidate[x] = out;
        score += out < 128 ? out : 256 - out;
        if (score >= bestScore) break;
      }
      if (score < bestScore) { bestScore = score; bestFilter = filter; best = Buffer.from(candidate); }
    }
    raw[y * (stride + 1)] = bestFilter;
    best.copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// The fit of one capture: the evidence PNG and the record the state receipt stores as `screenshot.fit`.
// `masks` = Dragon `maskedRects` (CSS px) with `cssWidth` = the capture viewport's CSS width.
export function fitPng(buffer, { maxWidth = MAX_EVIDENCE_WIDTH, masks = null, cssWidth = null } = {}) {
  const source = decodePng(buffer);
  const image = fitRgba(source, { maxWidth });
  if (masks && cssWidth) paintBlack(image, maskRectsInImage(masks, image, cssWidth));
  const png = encodeEvidencePng(image);
  return {
    png,
    sha256: sha256(png),
    fit: { fromSha256: sha256(buffer), fromWidth: source.width, fromHeight: source.height, width: image.width, height: image.height },
  };
}

// ── image checks ───────────────────────────────────────────────────────────────────────────────────────────────────
// Blank = one flat colour or near-zero luminance variance over the pixels outside the capture's mask boxes.
export function blankStats(image, maskRects = []) {
  const { width, height, data } = image;
  const counts = new Map();
  let n = 0, sum = 0, sumSq = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let masked = false;
      for (const rect of maskRects) if (x >= rect.x1 && x < rect.x2 && y >= rect.y1 && y < rect.y2) { masked = true; break; }
      if (masked) continue;
      const q = (y * width + x) * 4;
      const key = (data[q] << 16) | (data[q + 1] << 8) | data[q + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const luma = 0.299 * data[q] + 0.587 * data[q + 1] + 0.114 * data[q + 2];
      n += 1; sum += luma; sumSq += luma * luma;
    }
  }
  if (n === 0) return { pixels: 0, dominantShare: 1, lumaStddev: 0, blank: true };
  let dominant = 0;
  for (const count of counts.values()) if (count > dominant) dominant = count;
  const mean = sum / n;
  const lumaStddev = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const dominantShare = dominant / n;
  return { pixels: n, dominantShare, lumaStddev, blank: dominantShare >= BLANK_DOMINANT_SHARE || lumaStddev < BLANK_MIN_LUMA_STDDEV };
}

// The checks of one settled state's screenshot. `png` is the evidence file's bytes, `receipt` its state receipt.
export function stateImageIssues({ png, receipt, caseId, state }) {
  const scope = `${caseId}:${state}`;
  const out = [];
  const add = (code, detail) => out.push(evidenceIssue(code, scope, detail));
  let image;
  try { image = decodePng(png); }
  catch (error) { add('EVIDENCE_IMAGE_INVALID', `not a readable PNG (${error.message})`); return out; }
  const shot = isObject(receipt?.screenshot) ? receipt.screenshot : {};
  const pngSha = sha256(png);
  const viewport = parseViewport(receipt?.viewport);
  const capture = shot.capture;

  if (image.width > MAX_EVIDENCE_WIDTH) add('EVIDENCE_IMAGE_TOO_WIDE', `${image.width}px wide, at most ${MAX_EVIDENCE_WIDTH}; run qa-gui evidence fit`);
  const fit = shot.fit;
  if (fit !== undefined) {
    if (!isObject(fit) || !SHA256.test(fit.fromSha256 || '') || ![fit.fromWidth, fit.fromHeight, fit.width, fit.height].every((v) => Number.isInteger(v) && v > 0)) {
      add('EVIDENCE_IMAGE_FIT', 'screenshot.fit needs {fromSha256,fromWidth,fromHeight,width,height}');
    } else {
      if (fit.width !== image.width || fit.height !== image.height) add('EVIDENCE_IMAGE_FIT', `fit says ${fit.width}x${fit.height}, the PNG is ${image.width}x${image.height}`);
      if (fit.width > fit.fromWidth || Math.abs(fit.height - Math.round((fit.fromHeight * fit.width) / fit.fromWidth)) > 1) add('EVIDENCE_IMAGE_FIT', `${fit.fromWidth}x${fit.fromHeight} does not scale to ${fit.width}x${fit.height}`);
    }
  }
  // The capture's own bytes: the fit's source, or (no fit) the evidence file itself.
  if (!isObject(capture)) add('EVIDENCE_IMAGE_BINDING', 'screenshot.capture (the Dragon capture result) is missing');
  else {
    const expectedSource = isObject(fit) ? fit.fromSha256 : pngSha;
    if (capture.sha256 !== expectedSource) add('EVIDENCE_IMAGE_BINDING', isObject(fit) ? 'capture.sha256 is not the fit source (fit.fromSha256)' : 'capture.sha256 is not this PNG and no fit names it');
    if (String(capture.tabId ?? '') === '' || String(capture.tabId) !== String(receipt?.dragon?.tabId ?? '')) add('EVIDENCE_IMAGE_BINDING', `captured on tab ${capture.tabId ?? 'missing'}, the receipt is tab ${receipt?.dragon?.tabId ?? 'missing'}`);
    if (typeof capture.url !== 'string' || capture.url !== receipt?.url) add('EVIDENCE_IMAGE_BINDING', 'capture.url is not the receipt url');
    if (typeof capture.build !== 'string' || !capture.build || capture.build !== receipt?.build) add('EVIDENCE_IMAGE_BINDING', `capture.build ${capture.build ?? 'missing'} is not the receipt build ${receipt?.build ?? 'missing'}`);
    if (!SHA256.test(capture.domHash || '') || capture.domHash !== receipt?.domHash) add('EVIDENCE_IMAGE_BINDING', 'capture.domHash is not the receipt domHash');
    if (capture.viewport !== undefined && capture.viewport !== receipt?.viewport) add('EVIDENCE_IMAGE_BINDING', `captured at viewport ${capture.viewport}, the receipt says ${receipt?.viewport}`);
  }
  if (!viewport) add('EVIDENCE_IMAGE_BINDING', `receipt viewport ${receipt?.viewport ?? 'missing'} is not WxH`);
  else {
    // The PNG holds the CSS viewport at some image-px-per-CSS-px scale (device scale factor, then the fit).
    const scale = image.width / viewport.width;
    const expectedHeight = viewport.height * scale;
    if (!(scale > 0 && scale <= 4) || Math.abs(image.height - expectedHeight) > Math.max(2, expectedHeight * 0.01)) {
      add('EVIDENCE_IMAGE_BINDING', `${image.width}x${image.height} is not the shape of viewport ${receipt.viewport}`);
    }
  }
  const maskRects = viewport && isObject(capture) ? maskRectsInImage(capture.maskedRects, image, viewport.width, 1) : [];
  const stats = blankStats(image, maskRects);
  if (stats.blank) add('EVIDENCE_IMAGE_BLANK', `flat frame (dominant colour ${(stats.dominantShare * 100).toFixed(2)}% of ${stats.pixels} unmasked px, luma stddev ${stats.lumaStddev.toFixed(2)})`);
  // A state that asserts something about the function must say which element it is about, so its frame can be checked
  // to hold it (R1f); without one the state cannot back a verdict.
  const asserts = Array.isArray(receipt?.function?.assertions) && receipt.function.assertions.length > 0;
  if (receipt?.target === undefined && asserts) add('EVIDENCE_IMAGE_TARGET_MISSING', 'the state has function assertions and names no target {selector, rect}');
  if (receipt?.target !== undefined) {
    const target = receipt.target, rect = target?.rect;
    if (!isObject(target) || typeof target.selector !== 'string' || !target.selector || !isObject(rect)
      || ![rect.x, rect.y, rect.width, rect.height].every(finite) || rect.width <= 0 || rect.height <= 0) {
      add('EVIDENCE_IMAGE_TARGET_OUTSIDE', 'target needs {selector, rect:{x,y,width,height}} in CSS px');
    } else if (viewport && (rect.x < -1 || rect.y < -1 || rect.x + rect.width > viewport.width + 1 || rect.y + rect.height > viewport.height + 1)) {
      add('EVIDENCE_IMAGE_TARGET_OUTSIDE', `${target.selector} at ${rect.x},${rect.y} ${rect.width}x${rect.height} is outside the ${receipt.viewport} frame`);
    }
  }
  return out;
}

// ── recording manifest ─────────────────────────────────────────────────────────────────────────────────────────────
function jpegSize(bytes) {
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

function receiptList(receipts) {
  const out = [];
  const visit = (value) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isObject(value)) return;
    if (finite(value.ts) && (typeof value.actionId === 'string' || typeof value.action?.method === 'string')) out.push(value);
  };
  visit(receipts);
  return out;
}

// Action times, on the recording clock (ms from start). The recording's own input events come first: the extension
// stamps them `Date.now() - startedAt` on the same clock as the frames. Without any (navigation, insertText, an
// extension that sends none), the case's Dragon action receipts: `ts` (epoch ms) minus the manifest's `startedAt`
// (the bridge's clock, read just before the extension starts, so a receipt reads up to that start latency late).
export function recordingActions({ events, startedAt, receipts = [] }) {
  const fromEvents = (Array.isArray(events) ? events : [])
    .filter((event) => isObject(event) && finite(event.t) && (event.kind === 'down' || event.kind === 'key'))
    .map((event) => ({ t: event.t, kind: event.kind === 'down' ? 'click' : 'key', source: 'recording-event' }));
  if (fromEvents.length) return { actionSource: 'recording-events', actions: fromEvents };
  const fromReceipts = receiptList(receipts)
    .map((receipt) => ({ t: receipt.ts - startedAt, kind: receipt.action?.method ?? 'action', source: 'dragon-receipt', ...(typeof receipt.actionId === 'string' ? { actionId: receipt.actionId } : {}) }))
    .filter((action) => action.t >= 0)
    .sort((a, b) => a.t - b.t);
  return fromReceipts.length ? { actionSource: 'dragon-receipts', actions: fromReceipts } : { actionSource: 'none', actions: [] };
}

// Builds the manifest from a Dragon recording dir (events.json + f-NNNNNN.jpg). `video` is the assembled mp4 bytes.
export function buildRecordingManifest({ dir, video = null, receipts = [], readFile = readFileSync }) {
  let meta;
  try { meta = JSON.parse(readFile(join(dir, 'events.json'), 'utf8')); }
  catch (error) { throw new Error(`RECORDING_EVENTS_UNREADABLE: ${error.message}`); }
  if (!isObject(meta) || typeof meta.id !== 'string' || !finite(meta.startedAt) || !Array.isArray(meta.frames)) throw new Error('RECORDING_EVENTS_INVALID: events.json needs id, startedAt and frames[]');
  let frameBytes = 0, frameSize = null;
  const frames = meta.frames.map((frame, index) => {
    if (!isObject(frame) || !finite(frame.t) || typeof frame.file !== 'string' || !FRAME_FILE.test(frame.file)) throw new Error(`RECORDING_FRAME_INVALID: frames[${index}]`);
    let bytes;
    try { bytes = readFile(join(dir, frame.file)); }
    catch { throw new Error(`RECORDING_FRAME_MISSING: ${frame.file}`); }
    frameBytes += bytes.length;
    if (!frameSize) frameSize = jpegSize(bytes);
    return { t: frame.t, file: frame.file, sha256: sha256(bytes), bytes: bytes.length };
  });
  const { actionSource, actions } = recordingActions({ events: meta.events, startedAt: meta.startedAt, receipts });
  return {
    schema: RECORDING_MANIFEST_SCHEMA,
    id: meta.id,
    startedAt: meta.startedAt,
    durationMs: finite(meta.durationMs) ? meta.durationMs : (frames.at(-1)?.t ?? 0),
    viewport: meta.viewport ?? null,
    result: meta.result ?? null,
    frameSize,
    frameBytes,
    frames,
    events: Array.isArray(meta.events) ? meta.events : [],
    actionSource,
    actions,
    delivery: isObject(meta.delivery) ? meta.delivery : null,
    ...(video ? { video: { sha256: sha256(video), bytes: video.length } } : {}),
  };
}

// The checks of one behavioral recording segment against its manifest. `videoSha256` = the segment mp4's SHA-256.
export function recordingSegmentIssues({ manifest, segment, videoSha256, caseId, index = 0 }) {
  const scope = `${caseId}:segment-${index}`;
  const out = [];
  const add = (code, detail) => out.push(evidenceIssue(code, scope, detail));
  if (!isObject(manifest) || manifest.schema !== RECORDING_MANIFEST_SCHEMA || typeof manifest.id !== 'string' || !finite(manifest.startedAt)
    || !Array.isArray(manifest.frames) || !Array.isArray(manifest.actions)) {
    add('EVIDENCE_VIDEO_MANIFEST', `not a ${RECORDING_MANIFEST_SCHEMA} (id, startedAt, frames[], actions[])`);
    return out;
  }
  for (const [i, frame] of manifest.frames.entries()) {
    if (!isObject(frame) || !finite(frame.t) || !SHA256.test(frame.sha256 || '') || (i > 0 && frame.t < manifest.frames[i - 1].t)) {
      add('EVIDENCE_VIDEO_MANIFEST', `frames[${i}] needs t (not decreasing) and sha256`); return out;
    }
  }
  if (manifest.actions.some((action) => !isObject(action) || !finite(action.t))) { add('EVIDENCE_VIDEO_MANIFEST', 'every action needs a time t'); return out; }
  if (!isObject(manifest.video) || !SHA256.test(manifest.video.sha256 || '')) add('EVIDENCE_VIDEO_MANIFEST', 'video.sha256 (the assembled mp4) is missing; build with --video');
  else if (manifest.video.sha256 !== videoSha256) add('EVIDENCE_VIDEO_MANIFEST', `the manifest is of another video than ${segment?.file}`);

  const delivery = manifest.delivery;
  const count = manifest.frames.length;
  if (count === 0 || !isObject(delivery) || delivery.extensionFrames !== delivery.persistedFrames || delivery.persistedFrames !== count) {
    add('EVIDENCE_VIDEO_FRAME_COUNT', `sent ${delivery?.extensionFrames ?? 'unknown'}, saved ${delivery?.persistedFrames ?? 'unknown'}, listed ${count}`);
  }

  const start = finite(segment?.startMs) ? segment.startMs : 0;
  const end = finite(segment?.endMs) ? segment.endMs : Infinity;
  const frames = manifest.frames.filter((frame) => frame.t >= start && frame.t <= end);
  const actions = manifest.actions.map((action) => action.t).filter((t) => t >= start && t <= end).sort((a, b) => a - b);
  if (actions.length === 0) {
    add('EVIDENCE_VIDEO_NO_ACTION_COVERAGE', `no action time inside ${start}-${end} ms (action source ${manifest.actionSource ?? 'unknown'})`);
    return out;
  }
  const first = actions[0], last = actions.at(-1);
  const before = frames.filter((frame) => frame.t < first);
  const after = frames.filter((frame) => frame.t > last);
  if (before.length === 0) add('EVIDENCE_VIDEO_NO_ACTION_COVERAGE', `no frame before the first action at ${first} ms`);
  for (const t of actions) {
    if (!frames.some((frame) => Math.abs(frame.t - t) <= ACTION_AROUND_MS)) add('EVIDENCE_VIDEO_NO_ACTION_COVERAGE', `no frame within ${ACTION_AROUND_MS} ms of the action at ${t} ms`);
  }
  if (after.length === 0) add('EVIDENCE_VIDEO_NO_ACTION_COVERAGE', `no frame after the last action at ${last} ms`);
  if (before.length && after.length) {
    const shownBefore = before.at(-1).sha256, shownAfter = after.at(-1).sha256;
    const changeAfterAction = frames.some((frame, i) => i > 0 && frame.sha256 !== frames[i - 1].sha256
      && actions.some((t) => frame.t > t && frame.t <= t + ACTION_CHANGE_MS));
    if (shownBefore === shownAfter) add('EVIDENCE_VIDEO_NO_CHANGE', `the frame after the last action is the frame before the first action`);
    else if (!changeAfterAction) add('EVIDENCE_VIDEO_NO_CHANGE', `no frame changes within ${ACTION_CHANGE_MS} ms after any action`);
  }
  const window = frames.filter((frame) => frame.t >= first - ACTION_AROUND_MS && frame.t <= last + ACTION_CHANGE_MS);
  if (window.length >= 2) {
    const repeats = window.filter((frame, i) => i > 0 && frame.sha256 === window[i - 1].sha256).length;
    if (repeats === window.length - 1) add('EVIDENCE_VIDEO_STALE', `all ${window.length} frames from ${first - ACTION_AROUND_MS} to ${last + ACTION_CHANGE_MS} ms are one repeated image`);
  }
  return out;
}
