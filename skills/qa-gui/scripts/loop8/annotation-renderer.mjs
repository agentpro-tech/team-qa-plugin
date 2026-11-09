// annotation-renderer.mjs — V8.2 annotated-PNG renderer.
//
// Every mark on the board is derived from the findings the caller hands in: the marker rectangle
// comes from the finding's own measured bbox, the legend copy comes from its rule, severity,
// caption and selector, and the viewport line comes from the source PNG header. Nothing here reads
// the approved golden and nothing recognises the Wave 1 fixture — a different findings file draws a
// different picture. There is no image analysis anywhere: a box the detector did not measure is
// never drawn, because a guessed rectangle would point the reader at a defect nobody found.
//
// The numbers in LAYOUT are the board style the owner approved together with the golden. They are
// constants of the visual design, the same way a stylesheet is; the geometry they are applied to is
// not.

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Approved board style. Distances are device pixels of the source capture. */
const LAYOUT = Object.freeze({
  background: '#FFFFFF',
  // Marker drawn over the capture.
  markerStrokeWidth: 9,
  markerCornerRadius: 18,
  badgeRadius: 32,
  badgePointsize: 32,
  badgeStrokeWidth: 6,
  // Legend panel appended below the capture.
  panelBorder: '#D0D5DD',
  panelBorderWidth: 2,
  panelPaddingX: 64,
  legendBadgeRadius: 30,
  legendBadgePointsize: 30,
  titlePointsize: 30,
  captionPointsize: 25,
  metaPointsize: 21,
  captionColor: '#101828',
  metaColor: '#475467',
  lineStep: 43,
  // Vertical rhythm of one legend entry, measured from that entry's title line.
  entryTopOffset: 47,
  titleToCaption: 78,
  captionToMeta: 89,
  entryBottomGap: 117,
  badgeCenterBelowTitle: 33,
  titleGapAfterBadge: 18,
});

/** The approved phone capture is 960 device pixels wide (320 CSS px at DPR=3). */
const APPROVED_CAPTURE_WIDTH = 960;

const SCALABLE_LAYOUT_KEYS = Object.freeze([
  'markerStrokeWidth',
  'markerCornerRadius',
  'badgeRadius',
  'badgePointsize',
  'badgeStrokeWidth',
  'panelBorderWidth',
  'panelPaddingX',
  'legendBadgeRadius',
  'legendBadgePointsize',
  'titlePointsize',
  'captionPointsize',
  'metaPointsize',
  'lineStep',
  'entryTopOffset',
  'titleToCaption',
  'captionToMeta',
  'entryBottomGap',
  'badgeCenterBelowTitle',
  'titleGapAfterBadge',
]);

/** Keep the approved 960 px recipe exact, while scaling device-pixel typography on narrower PNGs. */
function layoutForCapture(capture) {
  const scale = Math.min(1, capture.width / APPROVED_CAPTURE_WIDTH);
  if (scale === 1) return LAYOUT;
  const layout = { ...LAYOUT };
  for (const key of SCALABLE_LAYOUT_KEYS) {
    layout[key] = Math.max(1, Math.round(LAYOUT[key] * scale));
  }
  return Object.freeze(layout);
}

/**
 * A badge digit sits inside its circle by a fixed fraction of the point size. ImageMagick places
 * `-annotate` text by the top-left of its glyph box under NorthWest gravity, so the label is offset
 * from the circle centre rather than centred by measurement.
 */
const GLYPH_OFFSET = Object.freeze({ x: 1 / 3, y: 0.7 });

/**
 * Only `high` has a palette an approved golden has actually signed off. Any other severity renders
 * in the neutral tone instead of a colour nobody reviewed — an unapproved style reads as plain,
 * never as a guess dressed up in red.
 */
const SEVERITY_PALETTE = Object.freeze({
  high: Object.freeze({ marker: '#D92D20', badge: '#D92D20', title: '#B42318' }),
  default: Object.freeze({ marker: '#475467', badge: '#475467', title: '#344054' }),
});

/** The `Nguồn:`/`Source:` label follows the caption's language; the rest of the line is data. */
const SOURCE_LABEL = Object.freeze({ vi: 'Nguồn', en: 'Source' });

/**
 * Captions wrap on a character column, not on measured pixel width: the approved golden breaks a
 * 633 px line while keeping a 670 px line whole, which no width-based wrap can produce.
 */
const CAPTION_COLUMNS = 56;

/** Where a drawn box came from. Only detector-measured geometry is ever drawn. */
const GEOMETRY_SOURCE = 'detector DOM';

const FONT_FILES = Object.freeze({ regular: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' });

/**
 * Where the board looks for its font pack when a caller does not name one. Wave 1 bundles exactly
 * one Noto Sans copy — under the frozen corpus, next to its OFL licence — and `assets/fonts` is
 * probed first so moving the pack to a product location later needs no code change. Fonts are the
 * board's typeface, not the fixture's answer: the geometry and the copy still come from the
 * findings.
 */
// From import.meta.url, which every Node 20 has (the dirname field of import.meta came in 20.11).
const HERE = fileURLToPath(new URL('.', import.meta.url));
const BUNDLED_FONT_DIRECTORIES = Object.freeze([
  path.resolve(HERE, '../../assets/fonts/noto-sans'),
  path.resolve(HERE, '../../test/loop8/corpus/fonts/noto-sans'),
]);

const SENTENCE_BOUNDARY = /(?<=[.!?。！？])\s+/;

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

/**
 * Width and height straight out of the PNG IHDR chunk. Reading the header keeps the renderer free
 * of an image-decoding dependency, and a file that is not a PNG fails loudly here rather than
 * producing a canvas sized from a guess.
 */
async function readPngSize(filePath) {
  const header = await readFile(filePath);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (header.length < 24 || !header.subarray(0, 8).equals(signature)) {
    throw new Error(`not a PNG file: ${filePath}`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** A bbox is drawable only when it is a finite, positive rectangle at a finite positive scale. */
function drawableBbox(bbox) {
  if (!isPlainRecord(bbox)) return null;
  const x = Number(bbox.x);
  const y = Number(bbox.y);
  const width = Number(bbox.width);
  const height = Number(bbox.height);
  const dpr = Number(bbox.dpr);
  if (![x, y, width, height, dpr].every(Number.isFinite)) return null;
  if (!(width > 0) || !(height > 0) || !(dpr > 0)) return null;
  return { x, y, width, height, dpr };
}

/**
 * The device-pixel box a CSS rectangle covers, clamped to the capture. Outward rounding on both
 * edges keeps every pixel the element actually touched inside the marker; rounding inward would
 * draw a box smaller than the defect it points at. A partially offscreen element keeps the part the
 * capture can show, and an element entirely outside the capture returns `null` so the board marks
 * nothing rather than drawing a box over unrelated pixels.
 */
function pixelBox(bbox, capture) {
  const left = clamp(Math.floor(bbox.x * bbox.dpr), 0, capture.width);
  const top = clamp(Math.floor(bbox.y * bbox.dpr), 0, capture.height);
  const right = clamp(Math.ceil((bbox.x + bbox.width) * bbox.dpr), 0, capture.width);
  const bottom = clamp(Math.ceil((bbox.y + bbox.height) * bbox.dpr), 0, capture.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/**
 * Greedy wrap at a character column, restarting at every sentence end so a recommendation never
 * shares a line with the problem it fixes. A single run longer than the column — scripts that do not
 * space their words — is hard-split rather than allowed to overflow the panel.
 */
function wrapCaption(caption) {
  const lines = [];
  for (const sentence of String(caption).trim().split(SENTENCE_BOUNDARY)) {
    if (!sentence) continue;
    let line = '';
    for (const word of sentence.split(/\s+/)) {
      if (!word) continue;
      let pending = word;
      while (!line && pending.length > CAPTION_COLUMNS) {
        lines.push(pending.slice(0, CAPTION_COLUMNS));
        pending = pending.slice(CAPTION_COLUMNS);
      }
      const candidate = line ? `${line} ${pending}` : pending;
      if (!line || candidate.length <= CAPTION_COLUMNS) {
        line = candidate;
        continue;
      }
      lines.push(line);
      line = pending;
    }
    if (line) lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
}

function severityPalette(severity) {
  const key = typeof severity === 'string' ? severity.toLowerCase() : '';
  return SEVERITY_PALETTE[key] ?? SEVERITY_PALETTE.default;
}

/** `HIGH · UNINTENDED-TEXT-OVERFLOW`, or whichever half of it the finding actually carries. */
function legendTitle(finding) {
  return [finding?.severity, finding?.rule]
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => part.trim().toUpperCase())
    .join(' · ');
}

/** Measured numbers are printed verbatim — a rounded readout would disagree with the findings file. */
function bboxLine(bbox) {
  const parts = [
    `x=${bbox.x}`,
    `y=${bbox.y}`,
    `w=${bbox.width}`,
    `h=${bbox.height}`,
    `DPR=${bbox.dpr}`,
  ];
  return `BBOX  ${parts.join(' · ')}`;
}

/** Where the rectangle came from, in the caption's language, so a reader can re-measure it. */
function provenanceLine(finding, bbox, capture) {
  const label = SOURCE_LABEL[finding?.language] ?? SOURCE_LABEL.en;
  const parts = [`${label}: ${GEOMETRY_SOURCE}`];
  parts.push(`viewport ${capture.width / bbox.dpr}×${capture.height / bbox.dpr} CSS px`);
  if (typeof finding?.selector === 'string' && finding.selector.trim()) {
    parts.push(`selector ${finding.selector.trim()}`);
  }
  return parts.join(' · ');
}

/**
 * Text lines under one legend title: the agent's own caption, wrapped, then the geometry readout.
 * The caption is never rewritten — clamping a box must not silently reword what the agent claimed.
 */
function legendBlock(finding, bbox, capture) {
  const caption = typeof finding?.caption === 'string' && finding.caption.trim()
    ? finding.caption
    : finding?.detail ?? '';
  return {
    title: legendTitle(finding),
    caption: wrapCaption(caption),
    meta: [bboxLine(bbox), provenanceLine(finding, bbox, capture)],
  };
}

function entryHeight(block, layout) {
  return (
    layout.titleToCaption +
    layout.lineStep * (block.caption.length - 1) +
    layout.captionToMeta +
    layout.lineStep * (block.meta.length - 1) +
    layout.entryBottomGap
  );
}

/**
 * Badge label placement: NorthWest gravity, so the offset is the glyph box's top-left corner.
 * `resetStroke` clears the outline left over from drawing the badge itself, so the digit is filled
 * white rather than traced.
 */
function badgeLabelArgs(font, pointsize, centerX, centerY, label, { resetStroke = false } = {}) {
  const x = centerX - Math.floor(pointsize * GLYPH_OFFSET.x);
  const y = centerY - Math.floor(pointsize * GLYPH_OFFSET.y);
  return [
    '-font', font, '-pointsize', String(pointsize), '-fill', LAYOUT.background,
    ...(resetStroke ? ['-stroke', 'none'] : []),
    '-gravity', 'NorthWest', '-annotate', `+${x}+${y}`, label,
  ];
}

function annotateArgs(font, pointsize, color, x, y, text) {
  return [
    '-font', font, '-pointsize', String(pointsize), '-fill', color,
    '-annotate', `+${x}+${y}`, text,
  ];
}

/**
 * Build the full ImageMagick argument vector. Keeping this pure makes the drawing plan inspectable
 * and comparable against the approved oracle without touching the filesystem.
 */
function buildRenderArgs({ inputPath, outputPath, fonts, capture, entries }) {
  const layout = layoutForCapture(capture);
  const panelTop = capture.height;
  const canvasHeight = panelTop + layout.entryTopOffset +
    entries.reduce((total, entry) => total + entryHeight(entry.block, layout), 0);
  const canvas = { width: capture.width, height: canvasHeight };

  const args = [
    '-size', `${canvas.width}x${canvas.height}`, `xc:${layout.background}`,
    inputPath, '-geometry', '+0+0', '-composite',
    '-fill', layout.background, '-stroke', layout.panelBorder,
    '-strokewidth', String(layout.panelBorderWidth),
    '-draw', `rectangle 0,${panelTop} ${canvas.width - 1},${canvas.height - 1}`,
  ];

  // Markers over the capture, in findings order, so badge N on the shot is entry N in the panel.
  for (const { index, palette, box } of entries) {
    // A finding whose box fell entirely outside the capture is still listed in the legend, but
    // nothing is drawn over the shot: there is no pixel on this image that it points at.
    if (!box) continue;
    // The visible stroke sits outside the projected box so it never covers the finding itself,
    // then stays on the board even when the element ran off the edge of the capture.
    const outset = layout.markerStrokeWidth;
    const ring = {
      left: clamp(box.left - outset, 0, canvas.width - 1),
      top: clamp(box.top - outset, 0, canvas.height - 1),
      right: clamp(box.right + outset, 0, canvas.width - 1),
      bottom: clamp(box.bottom + outset, 0, canvas.height - 1),
    };
    args.push(
      '-fill', 'none', '-stroke', palette.marker,
      '-strokewidth', String(layout.markerStrokeWidth),
      '-draw', `roundrectangle ${ring.left},${ring.top} ${ring.right},${ring.bottom} ${layout.markerCornerRadius},${layout.markerCornerRadius}`,
      '-fill', palette.badge, '-stroke', layout.background,
      '-strokewidth', String(layout.badgeStrokeWidth),
      '-draw', `circle ${ring.left},${ring.top} ${ring.left + layout.badgeRadius},${ring.top}`,
      ...badgeLabelArgs(
        fonts.bold, layout.badgePointsize, ring.left, ring.top, String(index),
        { resetStroke: true },
      ),
    );
  }

  // Legend entries in the appended white panel.
  let titleY = panelTop + layout.entryTopOffset;
  const textX = layout.panelPaddingX;
  const badgeCx = layout.panelPaddingX;
  const titleX = badgeCx + layout.legendBadgeRadius + layout.titleGapAfterBadge;
  for (const { index, palette, block } of entries) {
    const badgeCy = titleY + layout.badgeCenterBelowTitle;
    args.push(
      '-fill', palette.badge, '-stroke', 'none',
      '-draw', `circle ${badgeCx},${badgeCy} ${badgeCx + layout.legendBadgeRadius},${badgeCy}`,
      ...badgeLabelArgs(fonts.bold, layout.legendBadgePointsize, badgeCx, badgeCy, String(index)),
      ...annotateArgs(fonts.bold, layout.titlePointsize, palette.title, titleX, titleY, block.title),
    );

    let lineY = titleY + layout.titleToCaption;
    args.push(
      '-font', fonts.regular, '-pointsize', String(layout.captionPointsize),
      '-fill', layout.captionColor,
    );
    for (const line of block.caption) {
      args.push('-annotate', `+${textX}+${lineY}`, line);
      lineY += layout.lineStep;
    }

    lineY = lineY - layout.lineStep + layout.captionToMeta;
    args.push(
      '-font', fonts.regular, '-pointsize', String(layout.metaPointsize),
      '-fill', layout.metaColor,
    );
    for (const line of block.meta) {
      args.push('-annotate', `+${textX}+${lineY}`, line);
      lineY += layout.lineStep;
    }

    titleY += entryHeight(block, layout);
  }

  // Strip timestamps so the same findings always produce the same bytes.
  args.push('-strip', '-define', 'png:exclude-chunk=date,time', outputPath);
  return args;
}

async function assertReadable(filePath, what) {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`${what} not found: ${filePath}`);
  }
}

async function isReadable(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function fontPathsIn(directory) {
  return {
    regular: path.join(directory, FONT_FILES.regular),
    bold: path.join(directory, FONT_FILES.bold),
  };
}

/**
 * A named directory is used as given and fails loudly when it is incomplete — a caller that asks
 * for a specific typeface must not be silently rendered in a different one, because different glyph
 * widths would move every line of the legend.
 */
async function resolveFonts(fontDirectory) {
  if (typeof fontDirectory === 'string' && fontDirectory.trim()) {
    const fonts = fontPathsIn(fontDirectory);
    await assertReadable(fonts.regular, 'regular font');
    await assertReadable(fonts.bold, 'bold font');
    return fonts;
  }
  for (const candidate of BUNDLED_FONT_DIRECTORIES) {
    const fonts = fontPathsIn(candidate);
    if (await isReadable(fonts.regular) && await isReadable(fonts.bold)) return fonts;
  }
  throw new Error(
    `no bundled Noto Sans pack found; pass fontDirectory or install one of: ${BUNDLED_FONT_DIRECTORIES.join(', ')}`,
  );
}

async function loadFindings({ findings, findingsPath }) {
  if (Array.isArray(findings)) return findings;
  if (typeof findingsPath !== 'string' || !findingsPath.trim()) {
    throw new Error('renderAnnotatedPng requires findings or a findingsPath');
  }
  const parsed = JSON.parse(await readFile(findingsPath, 'utf8'));
  const loaded = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(loaded)) {
    throw new Error(`findings file must hold an array of findings: ${findingsPath}`);
  }
  return loaded;
}

/**
 * Render the annotated board for a capture and its findings.
 *
 * Deterministic: the same capture, findings and fonts always produce the same bytes. The input is
 * only ever read. The output path is never overwritten — an annotated board is evidence, and
 * silently replacing evidence would erase the record of what an earlier run actually saw.
 *
 * @param {{inputPath: string, findingsPath: string, fontDirectory: string, outputPath: string}} options
 * @returns {Promise<{outputPath: string, width: number, height: number, markers: number, entries: number}>}
 */
export async function renderAnnotations(options = {}) {
  const { inputPath, findingsPath, fontDirectory, outputPath } = options;
  for (const [key, value] of Object.entries({ inputPath, findingsPath, fontDirectory, outputPath })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`renderAnnotations requires a ${key}`);
    }
  }
  return renderAnnotatedPng({ inputPath, findingsPath, fontDirectory, outputPath });
}

/**
 * Same board, for callers that already hold their findings in memory — the QA pipeline normalizes
 * findings before it draws them, so making it round-trip through a file would only invite the file
 * and the pipeline to disagree.
 *
 * `findings` takes precedence over `findingsPath`; `fontDirectory` defaults to the bundled Noto
 * Sans pack.
 *
 * @param {{inputPath: string, findings?: unknown[], findingsPath?: string, fontDirectory?: string, outputPath: string}} options
 * @returns {Promise<{outputPath: string, width: number, height: number, markers: number, entries: number}>}
 */
export async function renderAnnotatedPng(options = {}) {
  const { inputPath, findings, findingsPath, fontDirectory, outputPath } = options;
  for (const [key, value] of Object.entries({ inputPath, outputPath })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`renderAnnotatedPng requires a ${key}`);
    }
  }

  // Checked before any work, so a refusal costs nothing and says why.
  if (await isReadable(outputPath)) {
    throw new Error(`refusing to overwrite an output that already exists: ${outputPath}`);
  }

  await assertReadable(inputPath, 'input capture');
  const fonts = await resolveFonts(fontDirectory);
  const loaded = await loadFindings({ findings, findingsPath });
  const capture = await readPngSize(inputPath);

  const entries = [];
  for (const finding of loaded) {
    if (!isPlainRecord(finding)) continue;
    const bbox = drawableBbox(finding.bbox);
    // A finding without a usable rectangle is not annotated at all: a board that invented a box
    // would point the reader at a place the detector never measured.
    if (!bbox) continue;
    entries.push({
      index: entries.length + 1,
      palette: severityPalette(finding.severity),
      box: pixelBox(bbox, capture),
      block: legendBlock(finding, bbox, capture),
    });
  }
  if (entries.length === 0) {
    throw new Error('no finding carries a drawable bbox, so there is nothing to annotate');
  }

  // Rendered to a scratch path first, then linked in with COPYFILE_EXCL, so a file that appears
  // between the check above and the write still wins over this render.
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'loop8-annotate-'));
  const scratchPath = path.join(scratchDir, 'annotated.png');
  const args = buildRenderArgs({ inputPath, outputPath: scratchPath, fonts, capture, entries });
  try {
    await execFileAsync('magick', args);
    await copyFile(scratchPath, outputPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code === 'ENOENT' && error?.syscall === 'spawn magick') {
      throw new Error('ImageMagick `magick` is required to render annotations');
    }
    if (error?.code === 'EEXIST') {
      throw new Error(`refusing to overwrite an output that already exists: ${outputPath}`);
    }
    throw error;
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }

  const size = await readPngSize(outputPath);
  return {
    outputPath,
    width: size.width,
    height: size.height,
    markers: entries.filter((entry) => entry.box).length,
    entries: entries.length,
  };
}
