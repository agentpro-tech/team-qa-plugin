// Dragon bridge status endpoint read by the preflight, its live checks and the QA hook (eval compat 9).
// TEAMQA_DRAGON_STATUS_URL is already the endpoint the roles check probes (lib/capability.mjs); here it also
// moves the preflight status call to another loopback bridge, e.g. an isolated QA Dragon. Without it the endpoint
// stays http://127.0.0.1:9233/status. Only a plain-http loopback .../status URL is honoured; any other value
// falls back to the default rather than sending the probe somewhere else.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const DEFAULT_DRAGON_STATUS_URL = 'http://127.0.0.1:9233/status';
const LOOPBACK_STATUS = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/status$/;
const STATUS_ENV = 'TEAMQA_DRAGON_STATUS_URL';
const RUNTIME_ENV = 'TEAMQA_DRAGON_RUNTIME_DIR';
export const DRAGON_RUNTIME_FILES = ['server.js', 'mcp-server.mjs', 'package.json'];

export function dragonStatusUrl(env = process.env) {
  const raw = String(env?.[STATUS_ENV] ?? '').trim();
  return LOOPBACK_STATUS.test(raw) ? raw : DEFAULT_DRAGON_STATUS_URL;
}

export function dragonStatusCommand(env = process.env) {
  return `curl --fail --silent ${dragonStatusUrl(env)}`;
}

// The root may type the URL itself or the variable that holds it; both reach the same endpoint in the root's
// environment, and the readers still bind the returned status to the session's browserInstanceId.
export function isDragonStatusCommand(command, env = process.env) {
  if (command === dragonStatusCommand(env)) return true;
  if (dragonStatusUrl(env) === DEFAULT_DRAGON_STATUS_URL && !LOOPBACK_STATUS.test(String(env?.[STATUS_ENV] ?? '').trim())) return false;
  return [`curl --fail --silent $${STATUS_ENV}`, `curl --fail --silent "$${STATUS_ENV}"`, `curl --fail --silent \${${STATUS_ENV}}`,
    `curl --fail --silent "\${${STATUS_ENV}}"`].includes(command);
}

// The Dragon runtime the preflight pins and checks for version drift (eval compat 11). An isolated eval Dragon runs
// its own release, not ~/.dragon-browser/runtime/current, so a run on such a bridge names that release's directory in
// TEAMQA_DRAGON_RUNTIME_DIR; the pin then records the files that actually serve the run, and an update of the user's
// global Dragon cannot block it. The value is honoured only beside a loopback TEAMQA_DRAGON_STATUS_URL (the same
// isolated bridge) and only as an absolute directory holding server.js, mcp-server.mjs and package.json; anything
// else keeps the historical directory.
export function defaultDragonRuntimeDir() {
  return join(homedir(), '.dragon-browser/runtime/current');
}
export function dragonRuntimeDir(env = process.env) {
  const raw = String(env?.[RUNTIME_ENV] ?? '').trim();
  const lane = LOOPBACK_STATUS.test(String(env?.[STATUS_ENV] ?? '').trim());
  if (!lane || !raw || !isAbsolute(raw) || /[\0\n\r]/.test(raw)) return defaultDragonRuntimeDir();
  try { if (!statSync(raw).isDirectory()) return defaultDragonRuntimeDir(); } catch { return defaultDragonRuntimeDir(); }
  return DRAGON_RUNTIME_FILES.every(name => existsSync(join(raw, name))) ? raw : defaultDragonRuntimeDir();
}
