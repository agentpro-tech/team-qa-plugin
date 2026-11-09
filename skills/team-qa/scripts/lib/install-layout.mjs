// Where Team QA and its sibling skills are installed (public v1.15, BA "Team QA as a Claude Code plugin", C1 and C2).
// Team QA is installed one of two ways: by the suite's install.sh into ~/.agents/skills, or as the Claude Code plugin
// team-qa@agentpro, whose skills sit in <plugin>/skills. Either way QA GUI and QA Code are installed next to Team QA,
// from the same signed suite. An installed Team QA (one that holds SOURCE.json) therefore looks for them next to its
// own folder and nowhere else, so one run never mixes two installs. A source checkout (no SOURCE.json) keeps the old
// default, ~/.agents/skills/<skill>. The environment variables TEAMQA_QA_GUI_ROOT and TEAMQA_QA_CODE_ROOT still win.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const TEAMQA_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const PLUGIN_NAME = 'team-qa';
export const MARKETPLACE_NAME = 'agentpro';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const RELEASES_REPO = 'agentpro-tech/team-qa-releases';
const ENV_KEYS = { 'qa-gui': 'TEAMQA_QA_GUI_ROOT', 'qa-code': 'TEAMQA_QA_CODE_ROOT' };

const realOr = (path, realpath = realpathSync) => { try { return realpath(path); } catch { return resolve(path); } };

// An installed Team QA carries the SOURCE.json its installer wrote; a git checkout does not.
export function isInstalledRoot(root = TEAMQA_ROOT, { exists = existsSync } = {}) {
  return exists(join(root, 'SOURCE.json'));
}

export function siblingSkillRoot(skill, { root = TEAMQA_ROOT, env = process.env, home = homedir(), exists = existsSync, realpath = realpathSync } = {}) {
  const key = ENV_KEYS[skill];
  if (key && env[key]) return env[key];
  if (isInstalledRoot(root, { exists })) return join(dirname(realOr(root, realpath)), skill);
  return join(home, '.agents', 'skills', skill);
}

// The plugin a Team QA root belongs to: <plugin>/skills/team-qa with <plugin>/.claude-plugin/plugin.json naming
// team-qa. Null for any other layout.
export function pluginInfo(root = TEAMQA_ROOT, { exists = existsSync, readText = path => readFileSync(path, 'utf8'), realpath = realpathSync } = {}) {
  const real = realOr(root, realpath);
  if (basename(dirname(real)) !== 'skills') return null;
  const pluginRoot = dirname(dirname(real)), manifest = join(pluginRoot, '.claude-plugin', 'plugin.json');
  if (!exists(manifest)) return null;
  let doc;
  try { doc = JSON.parse(readText(manifest)); } catch { return null; }
  if (doc?.name !== PLUGIN_NAME) return null;
  return { root: pluginRoot, manifest, version: typeof doc.version === 'string' ? doc.version : null, id: PLUGIN_ID };
}

// How this Team QA is installed: the Claude Code plugin, a suite install (SOURCE.json), or a source checkout.
export function installMode(root = TEAMQA_ROOT, deps = {}) {
  const plugin = pluginInfo(root, deps);
  if (plugin) return { mode: 'plugin', root, plugin };
  return { mode: isInstalledRoot(root, deps) ? 'skills' : 'source', root };
}

// The continuation registry of the plugin's hooks (C4): one fixed folder, kept across plugin updates.
export const pluginRegistryDir = (home = homedir()) => join(home, '.agentpro', 'teamqa', 'continuation');

// The signed Dragon runtime attached to a Team QA release (C5). The asset name is fixed; its version is inside it.
export const runtimeReleaseUrl = version => `https://github.com/${RELEASES_REPO}/releases/download/team-qa-${version}/dragon-runtime.dbrc`;

// Claude Code's own settings files that could still hold a hook staged by `continuation stage-hooks`.
export function claudeSettingsFiles({ env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  const config = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, '.claude');
  return [join(config, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
}

// roles.json names the child skills at the default suite install (~/.agents/skills/<skill>/...). An installed Team QA
// uses the children installed next to it (siblingSkillRoot), so a role path under that default follows the same root;
// an environment root wins. A source checkout without an environment root keeps the paths as written.
export function anchorChildSkillPaths(skills, { root = TEAMQA_ROOT, env = process.env, exists = existsSync, realpath = realpathSync } = {}) {
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return skills;
  const out = structuredClone(skills);
  const installed = isInstalledRoot(root, { exists });
  for (const name of Object.keys(ENV_KEYS)) {
    const entry = out[name];
    if (!entry || typeof entry !== 'object') continue;
    if (!installed && !env[ENV_KEYS[name]]) continue;
    const prefix = `~/.agents/skills/${name}/`;
    const base = siblingSkillRoot(name, { root, env, exists, realpath });
    const fix = value => typeof value === 'string' && value.startsWith(prefix) ? join(base, value.slice(prefix.length)) : value;
    for (const key of ['verdict_schema', 'receipt_schema']) if (key in entry) entry[key] = fix(entry[key]);
    if (entry.commands && typeof entry.commands === 'object') {
      for (const [command, argv] of Object.entries(entry.commands)) if (Array.isArray(argv)) entry.commands[command] = argv.map(fix);
    }
  }
  return out;
}
