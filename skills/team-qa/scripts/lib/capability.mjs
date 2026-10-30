import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { canaryInputPath, pickCanaryCommand } from './child-canary.mjs';
import { expandPath, runAdapter } from './core.mjs';

// Required tool -> the runtime skill that carries that tool. Only tools present here are measured
// live; the other tools are still only checked against their static declaration, as before.
const LIVE_TOOL_SKILL = { dragon: 'qa-gui' };
const STATUS_URL_ENV = { dragon: 'TEAMQA_DRAGON_STATUS_URL' };
const DEFAULT_TIMEOUT_MS = 5_000;

function firstLine(value) {
  return String(value ?? '').split('\n')[0].slice(0, 200);
}

function isFileWith(path, mode) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function looksLikePath(part) {
  return part === '~' || part.startsWith('~/') || part.startsWith('./') || part.startsWith('../') || isAbsolute(part);
}

// The program must resolve on the machine that is running, not just have a name in
// the config: a path must exist and be executable, a bare name must be on
// the current PATH.
function resolveProgram(program, base) {
  if (looksLikePath(program) || program.includes('/')) {
    return isFileWith(expandPath(program, base), constants.X_OK);
  }
  const raw = process.env.PATH;
  if (!raw) return false;
  return raw.split(delimiter).some((dir) => dir && isFileWith(join(dir, program), constants.X_OK));
}

function timeoutMs() {
  const raw = Number(process.env.TEAMQA_DRAGON_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

// With a status URL, the capability is measured with that very endpoint: no 2xx within
// the time limit means not live.
async function probeStatusUrl(tool, url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs()) });
  } catch (error) {
    return { ok: false, detail: `${tool} status_url=${url} unreachable=${firstLine(error?.message ?? error)}` };
  }
  if (!response.ok) return { ok: false, detail: `${tool} status_url=${url} http_status=${response.status}` };
  return { ok: true, via: `status-url http_status=${response.status}` };
}

// Without a status URL, the capability counts as measurable only when the declared runtime
// of the skill that carries that tool can run right here.
function probeSkillRuntime(tool, skillName, config, base, repoRoot) {
  const skills = config.skills;
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
    return { ok: false, detail: `${tool} skills_config_missing` };
  }
  const skill = skills[skillName];
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
    return { ok: false, detail: `${tool} skill_undeclared=${skillName}` };
  }
  const commands = skill.commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
    return { ok: false, detail: `${tool} skill_commands_missing=${skillName}` };
  }
  const entries = Object.entries(commands);
  if (entries.length === 0) return { ok: false, detail: `${tool} skill_commands_empty=${skillName}` };
  for (const [name, command] of entries) {
    const label = `${skillName}.${name}`;
    if (!Array.isArray(command) || command.length === 0
      || command.some((part) => typeof part !== 'string' || part.length === 0)) {
      return { ok: false, detail: `${tool} command_invalid=${label}` };
    }
    const [program, ...args] = command;
    if (!resolveProgram(program, base)) {
      return { ok: false, detail: `${tool} program_unresolved=${program} command=${label}` };
    }
    for (const arg of args) {
      if (!looksLikePath(arg)) continue;
      if (!isFileWith(expandPath(arg, base), constants.R_OK)) {
        return { ok: false, detail: `${tool} entrypoint_unreadable=${arg} command=${label}` };
      }
    }
  }
  const picked = pickCanaryCommand(skill);
  if (!picked) return { ok: false, detail: `${tool} runtime_probe_undeclared=${skillName}` };
  const result = runAdapter([...picked.command, canaryInputPath(repoRoot)], {
    cwd: base,
    timeout: timeoutMs(),
    env: { TEAMQA_CHILD_CANARY: '1', TEAMQA_CAPABILITY_PROBE: '1' },
  });
  if (result.error || result.signal) {
    return { ok: false, detail: `${tool} runtime_unavailable=${firstLine(result.error || result.signal)}` };
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.status === 0) return { ok: false, detail: `${tool} runtime_accepted_bad_input=${picked.name}` };
  if (!output) return { ok: false, detail: `${tool} runtime_silent_exit=${result.status}` };
  return { ok: true, via: `runtime ${skillName}.${picked.name} rejected-canary exit=${result.status}` };
}

function liveToolsRequired(config) {
  const required = new Set();
  for (const role of config.roles) {
    if (!role?.tool_bound) continue;
    const tools = config.role_tools?.[role.role];
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) if (Object.hasOwn(LIVE_TOOL_SKILL, tool)) required.add(tool);
  }
  return [...required].sort();
}

// Returns notes when every required capability can be measured; returns code + detail when a tool
// cannot be verified. Not verifiable is ungraded, not pass.
export async function probeLiveCapabilities(config, base, repoRoot = base, options = {}) {
  const notes = [];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  for (const tool of liveToolsRequired(config)) {
    const statusUrl = process.env[STATUS_URL_ENV[tool]];
    const vias = [];
    if (statusUrl) {
      const status = await probeStatusUrl(tool, statusUrl, fetchImpl);
      if (!status.ok) return { ok: false, code: `${tool.toUpperCase()}_UNAVAILABLE`, detail: status.detail };
      vias.push(status.via);
    }
    const runtime = probeSkillRuntime(tool, LIVE_TOOL_SKILL[tool], config, base, repoRoot);
    if (!runtime.ok) return { ok: false, code: `${tool.toUpperCase()}_UNAVAILABLE`, detail: runtime.detail };
    vias.push(runtime.via);
    notes.push(`${tool}=live via=${vias.join('+')}`);
  }
  return { ok: true, notes };
}
