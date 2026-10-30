// Test-account secrets (public v1, S6). A run is given the passwords of its test accounts (an accounts file the
// executor reads). Those values may sit in the worker's prompts and logs inside the run folder, but never in what
// people read or share: the board, the report, the RTM, the plan or the receipt. This module finds the values from
// the run's own inputs and scans the run's outputs for them. A finding names the file and how many values it holds,
// never the value itself.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const MIN_LENGTH = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Folders where the inputs a run hands its workers live (roster --inputs copies them under dispatch/<role>/<id>/inputs).
const INPUT_DIRS = new Set(['inputs', 'exec-inputs', 'executor-inputs']);
// Worker-internal folders of a run: prompts, transcripts and copied inputs may hold a test password by design.
const INTERNAL_DIRS = new Set(['dispatch', 'prompts', ...INPUT_DIRS]);
// A file whose name says it holds credentials, wherever it is in the inputs or at the top of the workspace.
const CREDENTIAL_NAME = /(^|[._-])(accounts?|credentials?|logins?|secrets?|passwords?|users?)([._-]|$)/i;
const SECRET_KEY = /pass(word|wd)?|pwd|secret|pin|otp|token/i;

function add(set, value) {
  const v = String(value ?? '').trim().replace(/^["'`]+|["'`,;]+$/g, '');
  if (v.length >= MIN_LENGTH && !/\s/.test(v)) set.add(v);
}

// The secret values in an accounts or credentials file: "role: user@example.com / secret", "password: secret",
// "user@example.com:secret", "user,secret" after an e-mail, or JSON with password-like keys.
export function secretsFromText(text) {
  const out = new Set();
  const raw = String(text);
  try {
    const walk = (value, key = '') => {
      if (Array.isArray(value)) value.forEach((v) => walk(v, key));
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k);
      else if (typeof value === 'string' && SECRET_KEY.test(key)) add(out, value);
    };
    walk(JSON.parse(raw));
    return [...out];
  } catch { /* not JSON */ }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    let m = t.match(/\b(?:pass(?:word|wd)?|pwd|secret|pin|otp)\b\s*[:=]\s*(\S+)/i);
    if (m) { add(out, m[1]); continue; }
    m = t.match(/[^\s/:,;|]+@[^\s/:,;|]+\s*(?:\/|:|,|;|\||\s)\s*(\S+)\s*$/);
    if (m) add(out, m[1]);
  }
  return [...out];
}

function files(dir, { skip = new Set(), depth = 0 } = {}) {
  const out = [];
  if (!existsSync(dir) || depth > 12) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), st = lstatSync(path);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (!skip.has(name)) out.push(...files(path, { skip, depth: depth + 1 })); }
    else if (st.isFile() && st.size <= MAX_FILE_BYTES) out.push(path);
  }
  return out;
}

const inputFiles = (dir, depth = 0) => {
  const out = [];
  if (!existsSync(dir) || depth > 12) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    if (INPUT_DIRS.has(name)) out.push(...files(path));
    else out.push(...inputFiles(path, depth + 1));
  }
  return out;
};

// The values a run must not show: from credential-named files in its input folders and at the top of the
// workspace, and from TEAMQA_TEST_SECRETS_FILE when the user keeps them elsewhere.
export function collectRunSecrets(runDir, { workspace = join(runDir, '..', '..'), env = process.env } = {}) {
  const sources = inputFiles(runDir).filter((path) => CREDENTIAL_NAME.test(basename(path)));
  if (existsSync(workspace)) for (const name of readdirSync(workspace)) {
    const path = join(workspace, name);
    if (CREDENTIAL_NAME.test(name) && lstatSync(path).isFile()) sources.push(path);
  }
  if (env.TEAMQA_TEST_SECRETS_FILE && existsSync(env.TEAMQA_TEST_SECRETS_FILE)) sources.push(env.TEAMQA_TEST_SECRETS_FILE);
  const secrets = new Set();
  for (const path of sources) { try { for (const s of secretsFromText(readFileSync(path, 'utf8'))) secrets.add(s); } catch { /* unreadable */ } }
  return { secrets: [...secrets], sources: sources.length };
}

// The forms a value takes in an output: as typed, JSON-escaped, URL-encoded and HTML-escaped.
const forms = (secret) => [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
  secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')])];

// Every file of the run outside its worker-internal folders that holds one of the values.
export function scanRunOutputs(runDir, secrets) {
  const findings = [];
  if (!secrets.length) return findings;
  const needles = secrets.map(forms);
  for (const path of files(runDir, { skip: INTERNAL_DIRS })) {
    const text = readFileSync(path).toString('utf8');
    const values = needles.filter((list) => list.some((form) => text.includes(form))).length;
    if (values) findings.push({ file: relative(runDir, path), values });
  }
  return findings;
}

export function assertNoTestSecrets(runDir, options = {}) {
  const { secrets, sources } = collectRunSecrets(runDir, options);
  const findings = scanRunOutputs(runDir, secrets);
  if (findings.length) {
    const error = new Error(`TEST_SECRET_IN_OUTPUT ${findings.map((f) => `${f.file} (${f.values})`).join(', ')}`);
    error.code = 'TEST_SECRET_IN_OUTPUT'; error.findings = findings;
    throw error;
  }
  return { secrets: secrets.length, sources, findings };
}

// Replaces every value with a mask (the diagnostic bundle, S7).
export function maskSecrets(text, secrets) {
  let out = String(text);
  for (const secret of secrets) for (const form of forms(secret)) out = out.split(form).join('[test-secret]');
  return out;
}
