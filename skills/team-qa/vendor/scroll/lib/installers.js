// SCROLL — extension installers (v1.4): `scroll mcp add` · `scroll skill add` · `scroll plugin add`.
//
// These are the package-manager sugar for an agent: they WIRE capabilities declaratively, they do
// not ship implementations. MCP-first — tool implementations come from the MCP server; a skill is a
// SKILL.md folder; a plugin is an agent-pack bundle. All they do is edit files (.mcp.json, skills/,
// agents/) the runtime already reads. Zero-dep (the `unzip` CLI is used only for a .plugin ZIP;
// an unpacked plugin directory needs nothing).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseFrontmatter } from './scroll.js';

const NAME_RE = /^[a-z][a-z0-9-]*$/;
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function vaultRefs(env) {
  if (!env) return [];
  return Object.values(env).map(String).filter((v) => /^\$\{vault:.+\}$/.test(v)).map((v) => v.replace(/^\$\{vault:(.+)\}$/, '$1'));
}

// ── scroll mcp add <name> ─────────────────────────────────────────────────────
// Declare an MCP server / connector in .mcp.json (repo-level, or agent-level with opts.agent).
// Credentials are referenced as ${vault:KEY} (resolved at load, never written into the file).
// Per-tool risk/grounding (v1.4 §21) lives under server.tools.
export function mcpAdd(name, opts = {}, cwd = process.cwd()) {
  if (!NAME_RE.test(name || '')) throw new Error(`mcp name "${name}" must match ${NAME_RE}`);
  const file = opts.agent ? path.join(cwd, 'agents', opts.agent, '.mcp.json') : path.join(cwd, '.mcp.json');
  if (opts.agent && !fs.existsSync(path.join(cwd, 'agents', opts.agent))) throw new Error(`agent not found: agents/${opts.agent}/`);
  const json = readJson(file) || { mcpServers: {} };
  json.mcpServers = json.mcpServers || {};
  const existed = !!json.mcpServers[name];

  let server;
  if (opts.url) server = { type: opts.transport || 'http', url: opts.url };
  else server = { command: opts.command || name, args: Array.isArray(opts.args) ? opts.args : [] };
  if (opts.env && Object.keys(opts.env).length) server.env = opts.env;
  if (opts.tools && Object.keys(opts.tools).length) server.tools = opts.tools;

  // merge: keep existing fields (e.g. previously-added tools/env) unless this call overrides them
  json.mcpServers[name] = { ...(json.mcpServers[name] || {}), ...server };
  writeJson(file, json);
  return { file: path.relative(cwd, file) || file, name, existed, server: json.mcpServers[name], vaultRefs: vaultRefs(server.env) };
}

// ── scroll skill add <ref|--new name> ─────────────────────────────────────────
// A skill is a SKILL.md folder. Install it onto the repo search path (skills/<name>/), optionally
// attach it to an agent (IDENTITY.skills). --new scaffolds a stub.
export function skillAdd(ref, opts = {}, cwd = process.cwd()) {
  const skillsDir = path.join(cwd, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  if (opts.new) {
    const name = ref;
    if (!NAME_RE.test(name || '')) throw new Error(`skill name "${name}" must match ${NAME_RE}`);
    const dest = path.join(skillsDir, name);
    if (fs.existsSync(dest)) throw new Error(`skills/${name}/ already exists`);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), skillStub(name));
    return { name, dir: path.relative(cwd, dest) || dest, scaffolded: true, attachedToAgent: opts.agent ? attachSkillToAgent(cwd, opts.agent, name) : null };
  }

  const srcDir = path.resolve(cwd, ref || '');
  const skillMd = path.join(srcDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) throw new Error(`no SKILL.md in "${ref}" — a skill is a folder containing SKILL.md`);
  const { frontmatter } = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
  if (!frontmatter || !frontmatter.name || !frontmatter.description) throw new Error('SKILL.md frontmatter must declare name + description (+ triggers)');
  const name = frontmatter.name;
  if (!NAME_RE.test(name)) throw new Error(`SKILL.md name "${name}" must match ${NAME_RE}`);
  const dest = path.join(skillsDir, name);
  if (fs.existsSync(dest) && !opts.force) throw new Error(`skills/${name}/ already exists (use --force to overwrite)`);
  fs.cpSync(srcDir, dest, { recursive: true });
  return { name, dir: path.relative(cwd, dest) || dest, scaffolded: false, attachedToAgent: opts.agent ? attachSkillToAgent(cwd, opts.agent, name) : null };
}

// Ensure an agent's IDENTITY frontmatter references the skill (inline `skills: [a, b]`).
export function attachSkillToAgent(cwd, agent, skillName) {
  const idp = path.join(cwd, 'agents', agent, 'IDENTITY.md');
  if (!fs.existsSync(idp)) throw new Error(`agent not found: agents/${agent}/IDENTITY.md`);
  const raw = fs.readFileSync(idp, 'utf8');
  const m = raw.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!m) throw new Error(`agents/${agent}/IDENTITY.md has no frontmatter`);
  let fm = m[2];
  const existing = fm.match(/^skills:\s*\[([^\]]*)\]\s*$/m);
  if (existing) {
    const items = existing[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (!items.includes(skillName)) items.push(skillName);
    fm = fm.replace(/^skills:\s*\[[^\]]*\]\s*$/m, `skills: [${items.join(', ')}]`);
  } else {
    fm = `${fm}\nskills: [${skillName}]`;
  }
  fs.writeFileSync(idp, raw.replace(/^---\n[\s\S]*?\n---/, `---\n${fm}\n---`));
  return agent;
}

function skillStub(name) {
  return `---\nname: ${name}\ndescription: What this skill does and when to use it. CHANGE ME.\ntriggers: [${name}, "use ${name}"]\n---\n\n# ${name}\n\nDescribe the playbook here. The index (name + description) is cached; this body loads on trigger.\n`;
}

// ── scroll plugin add <ref> ───────────────────────────────────────────────────
// A plugin is an "agent-pack": agents/ + skills/ + .mcp.json (+ manifest). Unpack a directory or a
// .plugin/.zip and merge it into the repo. Existing items are skipped unless --force.
export function pluginAdd(ref, opts = {}, cwd = process.cwd()) {
  let srcDir = path.resolve(cwd, ref || '');
  if (!fs.existsSync(srcDir)) throw new Error(`plugin not found: ${ref}`);
  let tmp = null;
  if (fs.statSync(srcDir).isFile()) {
    if (!/\.(plugin|zip)$/.test(srcDir)) throw new Error('a plugin file must be a .plugin or .zip (or pass an unpacked directory)');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-plugin-'));
    const r = spawnSync('unzip', ['-q', '-o', srcDir, '-d', tmp], { encoding: 'utf8' });
    if (r.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('unzip failed (install the `unzip` CLI, or pass an unpacked plugin directory): ' + (r.stderr || '')); }
    srcDir = pluginRoot(tmp);
  }

  const manifest = readJson(path.join(srcDir, 'manifest.json')) || readJson(path.join(srcDir, 'plugin.json')) || {};
  const installed = { agents: [], skills: [], mcpServers: [] };

  const copyTree = (subdir, listKey) => {
    const base = path.join(srcDir, subdir);
    if (!fs.existsSync(base)) return;
    for (const n of fs.readdirSync(base)) {
      const s = path.join(base, n);
      if (!fs.statSync(s).isDirectory()) continue;
      const d = path.join(cwd, subdir, n);
      if (fs.existsSync(d) && !opts.force) { installed[listKey].push(`${n} (skipped: exists)`); continue; }
      fs.cpSync(s, d, { recursive: true });
      installed[listKey].push(n);
    }
  };
  copyTree('agents', 'agents');
  copyTree('skills', 'skills');

  const pmcp = readJson(path.join(srcDir, '.mcp.json'));
  if (pmcp && pmcp.mcpServers) {
    const dest = path.join(cwd, '.mcp.json');
    const cur = readJson(dest) || { mcpServers: {} };
    cur.mcpServers = cur.mcpServers || {};
    for (const [k, v] of Object.entries(pmcp.mcpServers)) {
      if (cur.mcpServers[k] && !opts.force) { installed.mcpServers.push(`${k} (skipped: exists)`); continue; }
      cur.mcpServers[k] = v; installed.mcpServers.push(k);
    }
    writeJson(dest, cur);
  }

  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  return { name: manifest.name || path.basename(String(ref)).replace(/\.(plugin|zip)$/, ''), installed, manifest };
}

// If a zip unpacked to a single wrapper folder (and no manifest/agents at top), descend into it.
function pluginRoot(dir) {
  const top = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  const hasContent = ['manifest.json', 'plugin.json', 'agents', 'skills', '.mcp.json'].some((n) => fs.existsSync(path.join(dir, n)));
  if (!hasContent && top.length === 1 && fs.statSync(path.join(dir, top[0])).isDirectory()) return path.join(dir, top[0]);
  return dir;
}
