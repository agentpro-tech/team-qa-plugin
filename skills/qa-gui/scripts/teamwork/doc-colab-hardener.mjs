import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applyNativePacket } from './native-renderer.mjs';

function safePart(value, fallback) {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function evidenceBuffer(item) {
  const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=]+)$/.exec(String(item?.dataUrl || ''));
  if (match) {
    if (item.mime && match[1] !== item.mime) throw new Error(`evidence ${item.id || item.path}: MIME does not match dataUrl`);
    const bytes = Buffer.from(match[2], 'base64');
    if (Number.isFinite(item.size) && item.size !== bytes.length) throw new Error(`evidence ${item.id || item.path}: size does not match dataUrl`);
    return bytes;
  }
  const source = path.resolve(String(item?.path || ''));
  if (existsSync(source)) return readFileSync(source);
  if (['link', 'commit', 'log'].includes(item?.type)) return null;
  throw new Error(`evidence ${item?.id || item?.path || '<missing>'}: no readable file or dataUrl`);
}

function writeRecoverably(directory, item, bytes) {
  mkdirSync(directory, { recursive: true });
  const base = safePart(path.basename(String(item.path || 'evidence.bin')), 'evidence.bin');
  const id = safePart(item.id, 'native-evidence');
  let target = path.join(directory, `${id}-${base}`);
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (existing.equals(bytes)) return target;
    const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 10);
    target = path.join(directory, `${id}-${digest}-${base}`);
    if (existsSync(target) && !readFileSync(target).equals(bytes)) throw new Error(`evidence collision: ${target}`);
  }
  if (!existsSync(target)) writeFileSync(target, bytes, { flag: 'wx' });
  return target;
}

export function hardenDocColabPacket({ canonical, packet, evidenceDir, context, input, output }) {
  if (input && output && path.resolve(input) === path.resolve(output)) throw new Error('hardener refuses to overwrite the input canonical');
  const normalized = structuredClone(packet || {});
  const evidence = Array.isArray(normalized.qaDelta?.evidence) ? normalized.qaDelta.evidence
    : Array.isArray(normalized.staging?.evidence) ? normalized.staging.evidence
      : Array.isArray(normalized.evidence) ? normalized.evidence : [];
  const files = [];
  for (const item of evidence) {
    const bytes = evidenceBuffer(item);
    if (!bytes) continue;
    const target = writeRecoverably(path.resolve(evidenceDir), item, bytes);
    item.path = target;
    delete item.dataUrl;
    files.push(target);
  }
  const result = applyNativePacket(canonical, normalized, context);
  return { ...result, evidenceFiles: files, packet: normalized };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) args._.push(token);
    else args[token.slice(2)] = argv[++i];
  }
  return args;
}

function cli() {
  const args = parseArgs(process.argv.slice(2));
  const [input, packetFile] = args._;
  if (!input || !packetFile || !args.out || !args['evidence-dir'] || !args.actor || !args.now) {
    process.stderr.write('usage: node scripts/teamwork/doc-colab-hardener.mjs <canonical.json> <packet.json> --evidence-dir <dir> --out <next-canonical.json> --actor <name> --now <ISO> [--qa-actors <a,b>]\n');
    process.exit(2);
  }
  try {
    const canonical = JSON.parse(readFileSync(input, 'utf8'));
    const packet = JSON.parse(readFileSync(packetFile, 'utf8'));
    const result = hardenDocColabPacket({
      canonical,
      packet,
      evidenceDir: args['evidence-dir'],
      input,
      output: args.out,
      context: { actor: args.actor, now: args.now, qaActors: String(args['qa-actors'] || '').split(',').filter(Boolean) },
    });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    writeFileSync(path.resolve(args.out), `${JSON.stringify(result.data, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`DOC_COLAB_HARDEN_PASS rev=${result.data.rev} evidence=${result.evidenceFiles.length} out=${path.resolve(args.out)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) cli();
