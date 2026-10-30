import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const QA_RUN = join(ROOT, 'scripts', 'qa-run.sh');
export const GATE0 = join(ROOT, 'scripts', 'gate0.sh');
export const VALIDATOR = join(ROOT, 'scripts', 'verdict-validate.mjs');
export const RECEIPT_VERIFY = join(ROOT, 'scripts', 'receipt-verify.mjs');

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

export function git(repo, args) {
  const result = run('git', args, { cwd: repo });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function seal(value) {
  const withoutIntegrity = structuredClone(value);
  delete withoutIntegrity.integrity;
  return {
    ...withoutIntegrity,
    integrity: createHash('sha256').update(canonicalJson(withoutIntegrity)).digest('hex'),
  };
}

export function makeRepo(root, options = {}) {
  const repo = join(root, options.name || 'repo');
  mkdirSync(join(repo, '.teamcode'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'qa@example.invalid']);
  git(repo, ['config', 'user.name', 'QA']);
  if (!options.omitCoderVendorSpec) {
    writeFileSync(join(repo, '.teamcode', 'spec.md'), `coder_vendor: ${options.coderVendor || 'openai'}\n`);
  }
  writeFileSync(join(repo, 'src', 'app.js'), 'export const answer = 41;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'src', options.risky ? 'auth.js' : 'app.js'), options.risky
    ? 'export const authorize = (role) => role === "admin";\n'
    : 'export const answer = 42;\n');
  if (options.extraChangedFile) {
    const extra = join(repo, options.extraChangedFile);
    mkdirSync(dirname(extra), { recursive: true });
    writeFileSync(extra, 'release note\n');
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'final']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  return { repo, base, head };
}

export function gate0Receipt({ repo, base, head, runUuid = randomUUID(), overrides = {} }) {
  return seal({
    schema: 'qa-code/gate0/v1',
    status: 'pass',
    repo: realpathSync(repo),
    base,
    base_requested: base,
    commit: head,
    run_uuid: runUuid,
    created_at: new Date().toISOString(),
    layers: {},
    ...overrides,
  });
}

export function verdict({ head, verdict = 'PASS-STATIC', mode = 'static', engine = 'grok-4.5', sweep = null }) {
  return {
    schema: 'qa-code/verdict/v1',
    verdict,
    mode,
    engine,
    commit: head,
    findings: [],
    concerns: [],
    proposed_tests: [],
    sweep: sweep || {
      S1: 'PASS', S2: 'PASS', S3: 'PASS', S4: 'PASS', S5: 'PASS',
    },
  };
}

export function writeEngine(path, payload) {
  const source = typeof payload === 'string'
    ? payload
    : `process.stdout.write(${JSON.stringify(`${JSON.stringify(payload)}\n`)});\n`;
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return `node ${path}`;
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function qaArgs({ repo, base, gatePath, verdictPath, receiptPath, engineCmd, mode = 'static', engine = 'grok-4.5' }) {
  return [
    QA_RUN,
    '--repo', repo,
    '--mode', mode,
    '--gate0', gatePath,
    '--base', base,
    '--json', verdictPath,
    '--receipt', receiptPath,
    '--engine-cmd', engineCmd,
    '--engine', engine,
  ];
}
