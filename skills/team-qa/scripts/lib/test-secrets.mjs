// Test-account secrets (public v1, S6). A run is given the passwords of its test accounts (an accounts file the
// executor reads). Those values may sit in the worker's prompts and logs inside the run folder, but never in what
// people read or share: the board, the report, the RTM, the plan or the receipt. This module finds the values from
// the run's own inputs and scans the run's outputs for them. A finding names the file and how many values it holds,
// never the value itself.
// 1.15.1: keys in snake, kebab, camel and env form and the Vietnamese labels are read, quoted values may hold spaces,
// a value under a password key needs 4 characters (a bare value after an e-mail still needs 6), JSON numbers count,
// .env and creds files are sources, a symlinked source is followed to a regular file, and outputs of any size are
// scanned in chunks.
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// A bare value after an e-mail needs 6 characters; a value under an explicit password key needs 4.
const MIN_LENGTH = 6;
const MIN_KEYED_LENGTH = 4;
// A source file larger than this is not an accounts file. Outputs of any size are scanned, CHUNK_BYTES at a time.
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
// Folders where the inputs a run hands its workers live (roster --inputs copies them under dispatch/<role>/<id>/inputs).
const INPUT_DIRS = new Set(['inputs', 'exec-inputs', 'executor-inputs']);
// Worker-internal folders of a run: prompts, transcripts and copied inputs may hold a test password by design.
const INTERNAL_DIRS = new Set(['dispatch', 'prompts', ...INPUT_DIRS]);
// A file whose name says it holds credentials, wherever it is in the inputs or at the top of the workspace: accounts,
// credentials or creds, logins, secrets, passwords, users, an .env file, and the Vietnamese "tai khoan" (account) and
// "mat khau" (password) as file names are written, without diacritics.
const CREDENTIAL_NAME = /(^|[._-])(accounts?|credentials?|creds?|logins?|secrets?|passwords?|users?|env|tai[._-]?khoan|mat[._-]?khau)([._-]|$)/i;
// Program source is not an accounts file, whatever its name says (vite-env.d.ts, users.ts).
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kt|swift|php|cs|rs|c|h|cc|cpp|sh)$/i;
// The words of a key that name a secret. "mk" and "mat khau" are the Vietnamese abbreviation and label for password.
const SECRET_WORDS = new Set(['password', 'passwd', 'pass', 'pwd', 'passcode', 'passphrase', 'secret', 'pin', 'otp', 'token', 'mk', 'matkhau']);
// What stands in for a value without being one: null, true, a mask, a template or an environment reference.
const PLACEHOLDER = /^(?:null|none|nil|undefined|true|false|empty|n\/?a|todo|tbd|tba|string|number|required|optional|hidden|redacted|masked|secret|password|\*+|x+|\.+|-+|_+|#+|\?+|<[^>]*>|\[[^\]]*\]|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\{\{[^}]*\}\}|%[^%]+%)$/i;
// A "key: value" or "key = value" pair anywhere on a line; the key is one or two words (Admin password, mat khau).
const PAIR = /(?<![\p{L}\p{N}_.-])([\p{L}\p{N}][\p{L}\p{N}_.-]*(?: [\p{L}\p{N}][\p{L}\p{N}_.-]*)?)["']?[ \t]*[:=][ \t]*/gu;
const EMAIL_VALUE = /[^\s/:,;|]+@[^\s/:,;|]+\s*(?:\/|:|,|;|\||\s)\s*(\S+)\s*$/;

// The words of a key: snake_case, kebab-case, camelCase and dotted keys split, diacritics dropped (so the
// Vietnamese label matches however it is typed).
function keyWords(key) {
  return String(key).normalize('NFD').replace(/\p{M}/gu, '').replace(/\u0111/g, 'd').replace(/\u0110/g, 'D')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
export function isSecretKey(key) {
  const words = keyWords(key);
  return words.some((word) => SECRET_WORDS.has(word) || /^[a-z]*(?:password|passwd|pwd)$/.test(word)) || ` ${words.join(' ')} `.includes(' mat khau ');
}

// A value as written: a quoted value keeps its spaces; a bare one loses surrounding quotes and a trailing , or ;.
function add(set, value, min, { exact = false } = {}) {
  let v = String(value ?? '').trim();
  if (!exact) v = v.replace(/^["'`]+|["'`,;]+$/g, '');
  if (v.length >= min && (exact || !/\s/.test(v)) && !PLACEHOLDER.test(v)) set.add(v);
}

// The value after a key on a line: a quoted value up to its closing quote, a <template> or [template] as a whole
// (a placeholder), otherwise the run of non-space characters.
function valueAt(line, at) {
  const quote = line[at], close = { '<': '>', '[': ']' }[quote];
  if (close && line.indexOf(close, at) > at) return { value: line.slice(at, line.indexOf(close, at) + 1), end: line.indexOf(close, at) + 1, exact: true };
  if (quote === '"' || quote === "'" || quote === '`') {
    let value = '';
    for (let i = at + 1; i < line.length; i += 1) {
      if (line[i] === quote) return { value, end: i + 1, exact: true };
      if (line[i] === '\\' && quote === '"' && i + 1 < line.length) i += 1;
      value += line[i];
    }
  }
  const bare = /^\S+/.exec(line.slice(at));
  return bare ? { value: bare[0], end: at + bare[0].length, exact: false } : null;
}

// The secret values in an accounts or credentials file: "role: user@example.com / secret", "password: secret",
// "ADMIN_PASSWORD=secret", "export DB_PASS=\"two words\"", "user@example.com:secret", "user,secret" after an e-mail,
// or JSON with password-like keys (string or number values).
export function secretsFromText(text) {
  const out = new Set();
  const raw = String(text);
  try {
    const walk = (value, key = '') => {
      if (Array.isArray(value)) value.forEach((v) => walk(v, key));
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k);
      else if ((typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) && isSecretKey(key)) add(out, String(value), MIN_KEYED_LENGTH, { exact: true });
    };
    walk(JSON.parse(raw));
    return [...out];
  } catch { /* not JSON */ }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    let keyed = false;
    PAIR.lastIndex = 0;
    for (let m; (m = PAIR.exec(t));) {
      if (!isSecretKey(m[1])) continue;
      const found = valueAt(t, m.index + m[0].length);
      if (!found) continue;
      keyed = true;
      add(out, found.value, MIN_KEYED_LENGTH, { exact: found.exact });
      PAIR.lastIndex = Math.max(PAIR.lastIndex, found.end);
    }
    if (keyed) continue;
    const m = t.match(EMAIL_VALUE);
    if (m) add(out, m[1], MIN_LENGTH);
  }
  return [...out];
}

// The regular file a path names, following a symlink; null for a directory, a dangling link or anything else.
function regularFile(path) {
  try { const st = statSync(path); return st.isFile() ? st : null; } catch { return null; }
}

function files(dir, { skip = new Set(), depth = 0, follow = false, maxBytes = MAX_SOURCE_BYTES } = {}) {
  const out = [];
  if (!existsSync(dir) || depth > 12) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    let st = lstatSync(path);
    if (st.isSymbolicLink()) { if (!follow || !(st = regularFile(path))) continue; }
    if (st.isDirectory()) { if (!skip.has(name)) out.push(...files(path, { skip, depth: depth + 1, follow, maxBytes })); }
    else if (st.isFile() && st.size <= maxBytes) out.push(path);
  }
  return out;
}

const inputFiles = (dir, depth = 0) => {
  const out = [];
  if (!existsSync(dir) || depth > 12) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    if (INPUT_DIRS.has(name)) out.push(...files(path, { follow: true }));
    else out.push(...inputFiles(path, depth + 1));
  }
  return out;
};

const credentialNamed = (path) => CREDENTIAL_NAME.test(basename(path)) && !CODE_FILE.test(basename(path));

// The values a run must not show: from credential-named files in its input folders and at the top of the
// workspace, and from TEAMQA_TEST_SECRETS_FILE when the user keeps them elsewhere. `inputs` counts every file in the
// input folders, so a caller can tell a run that had nothing to hide from one whose credentials were not read.
export function collectRunSecrets(runDir, { workspace = join(runDir, '..', '..'), env = process.env } = {}) {
  const inputs = inputFiles(runDir);
  const sources = inputs.filter(credentialNamed);
  if (existsSync(workspace)) for (const name of readdirSync(workspace).sort()) {
    const path = join(workspace, name);
    if (credentialNamed(path) && regularFile(path)?.size <= MAX_SOURCE_BYTES) sources.push(path);
  }
  if (env.TEAMQA_TEST_SECRETS_FILE && existsSync(env.TEAMQA_TEST_SECRETS_FILE)) sources.push(env.TEAMQA_TEST_SECRETS_FILE);
  const secrets = new Set();
  for (const path of sources) { try { for (const s of secretsFromText(readFileSync(path, 'utf8'))) secrets.add(s); } catch { /* unreadable */ } }
  return { secrets: [...secrets], sources: sources.length, inputs: inputs.length };
}

// The forms a value takes in an output: as typed, JSON-escaped, URL-encoded (%20 and form + for a space) and
// HTML-escaped. A value shorter than 6 characters counts only as a whole word (not inside xabcdx).
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const forms = (secret) => [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), encodeURIComponent(secret).replace(/%20/g, '+'),
  secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')])];
function matcher(secret) {
  const all = forms(secret).sort((a, b) => b.length - a.length);
  const alternation = all.map(escapeRegExp).join('|');
  const source = secret.length < MIN_LENGTH ? `(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])` : `(?:${alternation})`;
  return { secret, re: new RegExp(source, 'gu'), longest: all[0].length };
}
const matchers = (secrets) => [...secrets].sort((a, b) => b.length - a.length).map(matcher);

// The values present in one text. `final` false: a hit that touches the end of the text waits for the next chunk,
// where its right edge is known.
function present(text, list, found, final = true) {
  for (const m of list) {
    if (found.has(m.secret)) continue;
    m.re.lastIndex = 0;
    for (let hit; (hit = m.re.exec(text));) {
      if (final || hit.index + hit[0].length < text.length) { found.add(m.secret); break; }
    }
  }
  return found;
}

// The values in a file of any size, read in chunks that overlap by the longest form, decoded across chunk edges.
function fileValues(path, list, chunkBytes = CHUNK_BYTES) {
  const found = new Set(), overlap = Math.max(...list.map((m) => m.longest)) + 1;
  const fd = openSync(path, 'r'), buffer = Buffer.alloc(chunkBytes), decoder = new StringDecoder('utf8');
  let carry = '';
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, chunkBytes, null), final = count === 0;
      const text = carry + (final ? decoder.end() : decoder.write(buffer.subarray(0, count)));
      present(text, list, found, final);
      if (final || found.size === list.length) break;
      carry = text.slice(-overlap);
    }
  } finally { closeSync(fd); }
  return found.size;
}

// How many of the values a text holds, in any of their forms (report build checks its text before writing it).
export function countSecretsInText(text, secrets) {
  return secrets.length ? present(String(text), matchers(secrets), new Set()).size : 0;
}

// Every file of the run outside its worker-internal folders that holds one of the values; files of any size.
export function scanRunOutputs(runDir, secrets, { chunkBytes = CHUNK_BYTES } = {}) {
  const findings = [];
  if (!secrets.length) return findings;
  const list = matchers(secrets);
  for (const path of files(runDir, { skip: INTERNAL_DIRS, maxBytes: Infinity })) {
    const values = fileValues(path, list, chunkBytes);
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

// Replaces every value with a mask (the diagnostic bundle, S7): the same forms and whole-word rule as the scan.
export function maskSecrets(text, secrets) {
  let out = String(text);
  for (const m of matchers(secrets)) out = out.replace(m.re, '[test-secret]');
  return out;
}
