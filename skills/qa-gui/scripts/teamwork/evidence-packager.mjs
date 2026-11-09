#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { renderNativeBoard } from './native-renderer.mjs';
import { validateCanonical } from './canonical.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function bytes(asset) {
  if (asset.bytes instanceof Uint8Array) return Buffer.from(asset.bytes);
  if (Buffer.isBuffer(asset.bytes)) return asset.bytes;
  throw new Error(`asset ${asset.path || '<missing>'}: bytes must be Uint8Array`);
}

// What the board shows and links for an asset is a path inside the package (relative to the board's folder), never
// an absolute machine path such as /Users/<name>/... (M12): an absolute path inside baseDir becomes relative to it,
// any other absolute path its file name.
export function packagePath(path, baseDir = null) {
  const text = String(path ?? '');
  if (!isAbsolute(text)) return text.split(sep).join('/');
  if (baseDir) {
    const inside = relative(resolve(baseDir), text);
    if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return inside.split(sep).join('/');
  }
  return basename(text);
}

function dataUrl(asset) {
  return `data:${asset.mime};base64,${bytes(asset).toString('base64')}`;
}

// An asset's caption is its label (the path when it has none); a link goes to its path.
const label = (asset) => asset.label ?? asset.path;
function galleryHtml(images, videos, inlineVideos, maxBytes, language) {
  const imageHtml = images.map((asset) => `<figure><img src="${dataUrl(asset)}" alt="${escapeHtml(label(asset))}"><figcaption>${escapeHtml(label(asset))}</figcaption></figure>`).join('');
  const videoHtml = videos.map((asset) => inlineVideos
    ? `<figure><video controls preload="metadata" src="${dataUrl(asset)}"></video><figcaption>${escapeHtml(label(asset))}</figcaption></figure>`
    : `<a class="linked-video" href="${escapeHtml(asset.path)}">${escapeHtml(asset.path)}</a>`).join('');
  const note = inlineVideos || videos.length === 0 ? '' : language === 'vi'
    ? `<p class="package-note">File vượt 25MB nên video được giữ bằng đường dẫn; ảnh vẫn nhúng trong board.</p>`
    : `<p class="package-note">The file would exceed 25 MB, so videos remain linked; images stay inline.</p>`;
  return `<section id="packaged-evidence" aria-label="Packaged evidence"><style>#packaged-evidence{width:min(1120px,calc(100% - 32px));margin:30px auto 120px;padding:22px;background:#fff;border:1px solid #e5e8ef;border-radius:14px}#packaged-evidence h2{font:650 17px/1.3 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033}.evidence-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.evidence-gallery figure{margin:0}.evidence-gallery img,.evidence-gallery video{display:block;width:100%;max-height:320px;object-fit:contain;border-radius:9px;background:#f2f4f7}.evidence-gallery figcaption,.linked-video,.package-note{font:12px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#667085;margin-top:5px}.linked-video{display:block;color:#2563eb}</style><h2>Evidence package</h2><div class="evidence-gallery">${imageHtml}${videoHtml}</div>${note}<meta name="qa-package-max-bytes" content="${maxBytes}"></section>`;
}

export function packageSelfContained(data, assets = [], options = {}) {
  const validation = validateCanonical(data);
  if (!validation.ok) return { ok: false, errors: validation.errors.map((entry) => `${entry.path}: ${entry.message}`) };
  if (!Array.isArray(assets)) return { ok: false, errors: ['assets: expected array'] };
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  try {
    assets = assets.map((asset) => asset && typeof asset === 'object'
      ? { ...asset, path: packagePath(asset.path, options.baseDir), ...(asset.label === undefined ? {} : { label: packagePath(asset.label, options.baseDir) }) } : asset);
    const base = renderNativeBoard(data);
    const images = assets.filter((asset) => typeof asset?.mime === 'string' && asset.mime.startsWith('image/'));
    const videos = assets.filter((asset) => typeof asset?.mime === 'string' && asset.mime.startsWith('video/'));
    const others = assets.filter((asset) => !images.includes(asset) && !videos.includes(asset));
    for (const asset of [...images, ...videos]) bytes(asset);
    const allInlineGallery = galleryHtml(images, videos, true, maxBytes, data.language);
    const allInlineBytes = Buffer.byteLength(base) + Buffer.byteLength(allInlineGallery);
    const inlineVideos = allInlineBytes <= maxBytes;
    let gallery = galleryHtml(images, videos, inlineVideos, maxBytes, data.language);
    if (others.length > 0) gallery = gallery.replace('</div>', `${others.map((asset) => `<a class="linked-video" href="${escapeHtml(asset.path)}">${escapeHtml(asset.path)}</a>`).join('')}</div>`);
    const html = base.replace('</body>', `${gallery}</body>`);
    return {
      ok: true,
      html,
      inlineVideos: inlineVideos ? videos.map((asset) => asset.path) : [],
      linkedVideos: inlineVideos ? [] : videos.map((asset) => asset.path),
      linkedFiles: [...(inlineVideos ? [] : videos), ...others].map((asset) => asset.path),
      sizeBytes: Buffer.byteLength(html),
      maxBytes,
    };
  } catch (cause) {
    return { ok: false, errors: [cause.message] };
  }
}

function mimeFor(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.mp4') return 'video/mp4';
  if (extension === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

function cli() {
  const args = process.argv.slice(2);
  const input = args.find((argument) => !argument.startsWith('--'));
  const outIndex = args.indexOf('--out');
  const output = outIndex >= 0 ? args[outIndex + 1] : null;
  const assetPaths = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === '--asset' && args[index + 1]) assetPaths.push(args[index + 1]);
  if (!input || !output) {
    process.stderr.write('usage: node scripts/teamwork/evidence-packager.mjs <canonical.json> --asset <file>... --out <board.html>\n');
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(input, 'utf8'));
  // Paths in the board are relative to its folder. A file outside that folder is shown by its name; when it ends up
  // linked (a video over the size limit, another file) it is copied into <board>-evidence/ next to the board.
  const outDir = dirname(resolve(output)), evidenceDir = `${basename(output, extname(output))}-evidence`;
  const assets = assetPaths.map((given, index) => {
    const source = resolve(given), inside = relative(outDir, source);
    const within = inside && !inside.startsWith('..') && !isAbsolute(inside);
    return { path: within ? inside.split(sep).join('/') : `${evidenceDir}/${index + 1}-${basename(source)}`, label: within ? inside.split(sep).join('/') : basename(source),
      source, within, mime: mimeFor(given), bytes: readFileSync(given) };
  });
  const result = packageSelfContained(data, assets, { baseDir: outDir });
  if (!result.ok) {
    process.stderr.write(`${result.errors.join('\n')}\n`);
    process.exit(1);
  }
  for (const asset of assets) {
    if (asset.within || !result.linkedFiles.includes(asset.path)) continue;
    mkdirSync(dirname(join(outDir, asset.path)), { recursive: true });
    copyFileSync(asset.source, join(outDir, asset.path));
  }
  writeFileSync(output, result.html);
  process.stdout.write(`Self-contained QA board: ${output} (${result.sizeBytes} bytes)\n`);
  if (result.linkedVideos.length > 0) process.stdout.write(`Linked videos: ${result.linkedVideos.join(', ')}\n`);
}

if (isDirectExecution(import.meta.url)) cli();
