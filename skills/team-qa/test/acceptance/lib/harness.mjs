import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const ACCEPTANCE_ROOT = join(REPO_ROOT, 'test', 'acceptance');
export const FIXTURES_ROOT = join(ACCEPTANCE_ROOT, 'fixtures');
export const PRODUCT_ENTRY = join(REPO_ROOT, 'scripts', 'teamqa.mjs');
export const CONTROL_ENTRY = join(ACCEPTANCE_ROOT, 'support', 'control-cli.mjs');
export const MIRROR_DOUBLE = join(ACCEPTANCE_ROOT, 'support', 'mirror-double.mjs');

export function defineCase(meta, run) {
  for (const key of ['id', 'group', 'requirement', 'expected', 'base', 'provenance']) {
    assert.ok(meta[key], `case metadata missing ${key}`);
  }
  if (meta.provenance === 'synthetic') {
    assert.ok(meta.justification, `${meta.id}: synthetic fixture needs justification`);
  }
  if (meta.provenance === 'product-path') {
    assert.ok(meta.setup, `${meta.id}: product-path fixture needs setup`);
  }
  assert.ok(['red', 'green'].includes(meta.base), `${meta.id}: invalid base status`);
  return Object.freeze({ ...meta, run });
}

export function withTemp(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), `teamqa-${name}-`));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function stageFixture(name, destination) {
  const source = join(FIXTURES_ROOT, name);
  assert.ok(existsSync(source), `fixture missing: ${name}`);
  cpSync(source, destination, { recursive: true });
  return destination;
}

export function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

export function writeJson(path, value) {
  return writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function runCli(cwd, args, options = {}) {
  const entry = options.entry ?? PRODUCT_ENTRY;
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    env: { ...process.env, ...options.env },
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    combined: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error ? String(result.error.message ?? result.error) : '',
  };
}

export function expectRun(result, expected) {
  assert.equal(result.signal, null, `unexpected signal ${result.signal}\n${result.combined}`);
  assert.equal(
    result.status,
    expected.exit,
    `expected exit ${expected.exit}, got ${result.status}\n${result.combined}${result.error}`,
  );
  for (const text of expected.includes ?? []) {
    assert.ok(result.combined.includes(text), `missing output ${JSON.stringify(text)}\n${result.combined}`);
  }
  for (const text of expected.excludes ?? []) {
    assert.ok(!result.combined.includes(text), `unexpected output ${JSON.stringify(text)}\n${result.combined}`);
  }
  return result;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function extractJsonBlock(path, start, end) {
  const text = readFileSync(path, 'utf8');
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  assert.ok(startAt >= 0, `missing marker ${start}`);
  assert.ok(endAt > startAt, `missing marker ${end}`);
  return JSON.parse(text.slice(startAt + start.length, endAt).trim());
}

export function signPlan(cwd, runId, planPath, version = 1) {
  return writeJson(join(cwd, 'control', 'approvals', runId, `plan-v${version}.json`), {
    signed_by: 'owner',
    ts: '2026-08-05T00:00:00.000Z',
    plan_sha256: sha256File(planPath),
  });
}

export function mirrorRoles(mode) {
  const node = process.execPath;
  const notionProbe = mode === 'fallback' ? 'probe-fail' : 'probe-pass';
  const notionReadback = mode === 'mismatch' ? 'readback-mismatch' : 'readback';
  return {
    roles: [],
    mirror: {
      notion: {
        probe: [node, MIRROR_DOUBLE, notionProbe],
        publish: [node, MIRROR_DOUBLE, 'publish'],
        readback: [node, MIRROR_DOUBLE, notionReadback],
      },
      doc_colab: {
        publish: [node, MIRROR_DOUBLE, 'publish'],
        readback: [node, MIRROR_DOUBLE, 'readback'],
      },
    },
    skills: {},
  };
}

export function hashAcceptanceTree() {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(ACCEPTANCE_ROOT, path);
      if (
        rel === 'evidence'
        || rel.startsWith('evidence/')
        || rel === 'PHASE-A-RED-PROOF.md'
        || rel === 'PHASE-A-WORKLOG.md'
      ) continue;
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(ACCEPTANCE_ROOT);
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(relative(ACCEPTANCE_ROOT, path)).update('\\0').update(readFileSync(path)).update('\\0');
  }
  return { sha256: hash.digest('hex'), files: files.length };
}

export function absolute(path) {
  return resolve(path);
}
