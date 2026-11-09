#!/usr/bin/env node
// Deterministic PNG pixel diff for qa-gui Phase 5. Runtime dependencies: Node built-ins only.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FAIL_PERCENT = 0.5;
const MASK_MAX_PERCENT = 40;
const MAJOR_PERCENT = 5;

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      return c >>> 0;
    });
  }
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG file");
  let offset = 8, width, height, bitDepth, colorType, interlace, palette, transparency;
  const idat = [];
  let sawIend = false;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    if (offset + 12 + length > buf.length) throw new Error("truncated PNG chunk");
    const typeBuf = buf.subarray(offset + 4, offset + 8);
    const type = typeBuf.toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buf.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([typeBuf, data])) !== expectedCrc) throw new Error(`invalid PNG CRC (${type})`);
    if (type === "IHDR") {
      if (length !== 13) throw new Error("invalid PNG IHDR");
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
      if (!width || !height) throw new Error("invalid PNG dimensions");
      if (data[10] !== 0 || data[11] !== 0) throw new Error("unsupported PNG compression/filter method");
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") transparency = Buffer.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") { sawIend = true; break; }
    offset += 12 + length;
  }
  if (!sawIend || width == null || !idat.length) throw new Error("incomplete PNG");
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}; expected 8`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  if (colorType === 3 && (!palette || palette.length % 3)) throw new Error("indexed PNG has no valid palette");
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("unexpected PNG scanline size");
  const pixels = Buffer.alloc(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src++];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y ? pixels[row - stride + x] : 0;
      const upperLeft = y && x >= channels ? pixels[row - stride + x - channels] : 0;
      let decoded;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
      else if (filter === 4) decoded = value + paeth(left, up, upperLeft);
      else throw new Error(`unsupported PNG filter ${filter}`);
      pixels[row + x] = decoded & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const q = i * 4;
    if (colorType === 0) rgba[q] = rgba[q + 1] = rgba[q + 2] = pixels[p];
    else if (colorType === 2 || colorType === 6) { rgba[q] = pixels[p]; rgba[q + 1] = pixels[p + 1]; rgba[q + 2] = pixels[p + 2]; }
    else if (colorType === 3) {
      const pi = pixels[p] * 3;
      if (pi + 2 >= palette.length) throw new Error("PNG palette index out of range");
      rgba[q] = palette[pi]; rgba[q + 1] = palette[pi + 1]; rgba[q + 2] = palette[pi + 2];
    } else if (colorType === 4) rgba[q] = rgba[q + 1] = rgba[q + 2] = pixels[p];
    rgba[q + 3] = colorType === 4 ? pixels[p + 1] : colorType === 6 ? pixels[p + 3] : colorType === 3 ? (transparency?.[pixels[p]] ?? 255) : 255;
  }
  return { width, height, data: rgba };
}

export function encodePng({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height * 4) throw new Error("invalid RGBA image");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA, non-interlaced
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (width * 4 + 1);
    raw[dst] = 0;
    data.copy(raw, dst + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND")]);
}

function rectanglesForState(mask, state) {
  if (mask == null) return [];
  if (Array.isArray(mask)) return mask.filter((r) => !r?.state || r.state === state);
  if (typeof mask !== "object") throw new Error("baseline mask must be an object or array");
  const value = mask[state] ?? mask.states?.[state] ?? [];
  if (!Array.isArray(value)) throw new Error(`baseline mask for state "${state}" must be an array`);
  return value;
}

function normalizeRectangles(mask, state, width, height) {
  return rectanglesForState(mask, state).map((r, index) => {
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 0 || r.height < 0) throw new Error(`invalid mask rectangle ${index} for state "${state}"`);
    const x1 = Math.max(0, Math.floor(r.x)), y1 = Math.max(0, Math.floor(r.y));
    const x2 = Math.min(width, Math.ceil(r.x + r.width)), y2 = Math.min(height, Math.ceil(r.y + r.height));
    return { x1, y1, x2, y2 };
  });
}

export function comparePngBuffers(baselineBuffer, actualBuffer, { state = "", mask = null } = {}) {
  const baseline = decodePng(baselineBuffer), actual = decodePng(actualBuffer);
  // A baseline and a round screenshot are compared only at the same size: under evidence policy v1 both go through
  // the same `qa-gui evidence fit --max-width 1280` (box filter), so a full-size baseline must be fitted, never scaled here.
  if (baseline.width !== actual.width || baseline.height !== actual.height) throw new Error(`PNG dimensions differ: ${baseline.width}x${baseline.height} vs ${actual.width}x${actual.height}; fit both with node scripts/qa-gui.mjs evidence fit --max-width 1280 before comparing`);
  const { width, height } = baseline;
  const rectangles = normalizeRectangles(mask, state, width, height);
  const diffData = Buffer.alloc(width * height * 4);
  let changedPixels = 0, maskedPixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const masked = rectangles.some((r) => x >= r.x1 && x < r.x2 && y >= r.y1 && y < r.y2);
    if (masked) {
      maskedPixels++;
      diffData[i] = 70; diffData[i + 1] = 130; diffData[i + 2] = 180; diffData[i + 3] = 90;
      continue;
    }
    const changed = baseline.data[i] !== actual.data[i] || baseline.data[i + 1] !== actual.data[i + 1] || baseline.data[i + 2] !== actual.data[i + 2] || baseline.data[i + 3] !== actual.data[i + 3];
    if (changed) {
      changedPixels++;
      diffData[i] = 255; diffData[i + 1] = 25; diffData[i + 2] = 70; diffData[i + 3] = 255;
    } else {
      const gray = Math.round(actual.data[i] * 0.299 + actual.data[i + 1] * 0.587 + actual.data[i + 2] * 0.114);
      diffData[i] = diffData[i + 1] = diffData[i + 2] = Math.round(235 + gray * 0.08);
      diffData[i + 3] = 255;
    }
  }
  const comparedPixels = width * height - maskedPixels;
  const diffPercent = comparedPixels ? Number(((changedPixels / comparedPixels) * 100).toFixed(6)) : 0;
  const maskedPercent = Number(((maskedPixels / (width * height)) * 100).toFixed(6));
  if (maskedPercent > MASK_MAX_PERCENT) throw new Error(`baseline mask covers ${maskedPercent}% of state "${state}" (limit ${MASK_MAX_PERCENT}%): a mask this large disables the comparison instead of narrowing it. Shrink the mask, or waive the state explicitly in untested.`);
  const verdict = diffPercent > FAIL_PERCENT ? "FAIL" : "PASS";
  return {
    verdict,
    severity: verdict === "FAIL" ? (diffPercent > MAJOR_PERCENT ? "major" : "minor") : null,
    diffPercent,
    changedPixels,
    comparedPixels,
    maskedPixels,
    maskedPercent,
    width,
    height,
    diffPng: encodePng({ width, height, data: diffData })
  };
}

export function comparePngFiles(baselinePath, actualPath, { state = "", maskPath, diffPath } = {}) {
  const mask = maskPath ? JSON.parse(readFileSync(maskPath, "utf8")) : null;
  const result = comparePngBuffers(readFileSync(baselinePath), readFileSync(actualPath), { state, mask });
  if (diffPath) writeFileSync(diffPath, result.diffPng);
  return result;
}

function usage(message) {
  if (message) process.stderr.write(`visual-diff: ${message}\n`);
  process.stderr.write("usage: node scripts/visual-diff.mjs <baseline.png> <actual.png> --state <state> [--mask baseline-mask.json] [--diff output.png]\n");
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2), positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--state" || arg === "--mask" || arg === "--diff") {
      if (i + 1 >= args.length) usage(`${arg} requires a value`);
      options[arg.slice(2)] = args[++i];
    } else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 2 || !options.state) usage("baseline, actual, and --state are required");
  try {
    const result = comparePngFiles(positional[0], positional[1], { state: options.state, maskPath: options.mask, diffPath: options.diff });
    const { diffPng, ...json } = result;
    process.stdout.write(JSON.stringify({ ...json, state: options.state, diff: options.diff || null }) + "\n");
    process.exit(result.verdict === "FAIL" ? 1 : 0);
  } catch (error) {
    process.stderr.write(`visual-diff: ${error.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) main();
