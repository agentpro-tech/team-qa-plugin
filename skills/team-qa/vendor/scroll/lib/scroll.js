// SCROLL — filesystem-native agent framework CLI (v0.6 — + scroll audit: convention scan + hash-bound compliance report)
// One module, no engine. Reads agent folders, validates, transpiles. ~spec v1.2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Minimal YAML-subset parser (zero-dep). Covers SCROLL frontmatter:
//    scalars, quoted strings, inline [..] / {..}, block maps + block sequences (indent-based).
//    Frontmatter is simple by design; full YAML is intentionally out of scope.
function stripComment(line) {
  let q = null, out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { out += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; out += ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out;
}
function splitTopLevel(s) {
  const parts = []; let depth = 0, q = null, cur = '';
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
function yScalar(v) {
  v = v.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")) return v.slice(1, -1);
  if (v[0] === '[' && v.at(-1) === ']') return splitTopLevel(v.slice(1, -1)).map(yScalar).filter((x) => x !== '');
  if (v[0] === '{' && v.at(-1) === '}') {
    const o = {};
    for (const pair of splitTopLevel(v.slice(1, -1))) {
      const ci = pair.indexOf(':'); if (ci < 0) continue;
      o[pair.slice(0, ci).trim()] = yScalar(pair.slice(ci + 1));
    }
    return o;
  }
  return v;
}
export function parseYaml(src) {
  const lines = String(src).split('\n').map(stripComment).filter((l) => l.trim() !== '');
  let idx = 0;
  const indentOf = (s) => s.match(/^ */)[0].length;
  function block(min) {
    let map = null, arr = null;
    while (idx < lines.length) {
      const line = lines[idx];
      const ind = indentOf(line);
      if (ind < min) break;
      if (ind > min) { idx++; continue; }
      const content = line.slice(ind);
      if (content.startsWith('- ')) {
        arr = arr || [];
        arr.push(yScalar(content.slice(2)));
        idx++;
      } else {
        const ci = content.indexOf(':');
        if (ci < 0) { idx++; continue; }
        const key = content.slice(0, ci).trim();
        const val = content.slice(ci + 1).trim();
        idx++;
        map = map || {};
        if (val === '') {
          const nextInd = idx < lines.length ? indentOf(lines[idx]) : min;
          map[key] = (idx < lines.length && nextInd > min) ? block(nextInd) : null;
        } else {
          map[key] = yScalar(val);
        }
      }
    }
    return arr !== null ? arr : (map || {});
  }
  return block(0);
}
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'agent');
const RUNTIMES = ['cowork', 'codex', 'gemini', 'claude-subagent', 'voice', 'a2a'];
const CAP_RE = /^(fs|web|shell|mcp|vision|voice|dispatch)\.[a-z_]+$/;

// ── ANSI helpers ──
const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// ── Frontmatter ──
export function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: raw };
  let fm;
  try { fm = parseYaml(m[1]) || {}; }
  catch (e) { throw new Error(`frontmatter YAML invalid: ${e.message}`); }
  return { frontmatter: fm, body: m[2].trim() };
}

// ── Load an agent folder → structured object ──
export function loadAgent(name, cwd = process.cwd()) {
  const dir = path.join(cwd, 'agents', name);
  if (!fs.existsSync(dir)) throw new Error(`agent not found: agents/${name}/`);
  const read = (f) => { const p = path.join(dir, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
  const identityRaw = read('IDENTITY.md');
  if (identityRaw == null) throw new Error(`agents/${name}/IDENTITY.md missing`);
  const { frontmatter, body } = parseFrontmatter(identityRaw);
  const evalsDir = path.join(dir, 'evals');
  const evals = fs.existsSync(evalsDir)
    ? fs.readdirSync(evalsDir).filter((f) => f.endsWith('.md') && f !== 'rubric.md')
    : [];
  return {
    name, dir, frontmatter, identityBody: body,
    soul: read('SOUL.md'), tools: read('TOOLS.md'), hardRules: read('hard-rules.md'),
    evals,
  };
}

// ── CHECK: validate against spec → { errors, warnings, level } ──
export function checkAgent(name, cwd = process.cwd()) {
  const errors = [], warnings = [];
  let agent;
  try { agent = loadAgent(name, cwd); }
  catch (e) { return { errors: [e.message], warnings: [], level: null }; }
  const fm = agent.frontmatter;

  if (!fm || typeof fm !== 'object') {
    errors.push('IDENTITY.md has no valid frontmatter');
  } else {
    // required fields
    const req = ['name', 'title', 'version', 'runtimes', 'model', 'capabilities'];
    for (const k of req) if (fm[k] === undefined) errors.push(`IDENTITY: missing required field "${k}"`);
    // name
    if (fm.name && !/^[a-z][a-z0-9-]*$/.test(fm.name)) errors.push(`IDENTITY: name "${fm.name}" must match ^[a-z][a-z0-9-]*$`);
    if (fm.name && fm.name !== name) errors.push(`IDENTITY: name "${fm.name}" must equal folder name "${name}"`);
    // version
    if (fm.version && !/^\d+\.\d+\.\d+$/.test(String(fm.version))) errors.push(`IDENTITY: version "${fm.version}" must be semver`);
    // runtimes
    if (fm.runtimes !== undefined) {
      if (!Array.isArray(fm.runtimes) || fm.runtimes.length === 0) errors.push('IDENTITY: runtimes must be a non-empty array');
      else for (const r of fm.runtimes) if (!RUNTIMES.includes(r)) warnings.push(`IDENTITY: unknown runtime "${r}"`);
    }
    // model
    if (fm.model !== undefined && (typeof fm.model !== 'object' || !fm.model.primary)) errors.push('IDENTITY: model.primary is required');
    // capabilities
    if (fm.capabilities !== undefined) {
      if (!Array.isArray(fm.capabilities)) errors.push('IDENTITY: capabilities must be an array');
      else for (const cap of fm.capabilities) if (!CAP_RE.test(cap)) warnings.push(`IDENTITY: capability "${cap}" not in reserved namespace`);
    }
    // dispatch
    if (fm.dispatch && fm.dispatch.authority && !['none', 'low', 'medium', 'high'].includes(fm.dispatch.authority))
      errors.push(`IDENTITY: dispatch.authority "${fm.dispatch.authority}" invalid`);
    // soft recommendations
    if (fm.pronoun === undefined) warnings.push('IDENTITY: pronoun not set (recommended)');
    if (fm.language === undefined) warnings.push('IDENTITY: language not set (recommended)');
  }

  // SOUL.md
  if (!agent.soul || !agent.soul.trim()) errors.push('SOUL.md missing or empty');

  // TOOLS capabilities ⊆ IDENTITY capabilities
  if (agent.tools && fm && Array.isArray(fm.capabilities)) {
    const declared = new Set(fm.capabilities);
    const used = [...agent.tools.matchAll(/^([a-z]+\.[a-z_]+):/gm)].map((x) => x[1]);
    for (const u of used) if (!declared.has(u)) errors.push(`TOOLS: capability "${u}" not declared in IDENTITY.capabilities`);
  }

  // hard_rules reference resolves
  if (fm && fm.hard_rules) {
    const hp = path.join(agent.dir, fm.hard_rules);
    if (!fs.existsSync(hp)) warnings.push(`IDENTITY: hard_rules path "${fm.hard_rules}" not found`);
  }

  // ── conformance level ──
  let level = null;
  if (errors.length === 0) {
    level = 'L0';
    const hasRules = (fm && fm.hard_rules) || agent.hardRules;
    if (agent.evals.length >= 3 && hasRules) level = 'L1';
    if (level === 'L1' && fs.existsSync(path.join(cwd, 'WORK.md'))) {
      // L2 requires WORK.md to satisfy the 4-part contract — checked by checkWork()
      const w = checkWork(cwd);
      if (w.errors.length === 0 && w.tasks > 0) level = 'L2'; else warnings.push(...w.errors);
    }
  }
  return { errors, warnings, level };
}

// ── CHECK WORK.md (4-part contract + single controller) ──
export function checkWork(cwd = process.cwd()) {
  const p = path.join(cwd, 'WORK.md');
  if (!fs.existsSync(p)) return { errors: [], tasks: 0, owners: [] };
  const raw = fs.readFileSync(p, 'utf8');
  // tasks are fenced yaml blocks ```task ... ``` OR a yaml list under "## tasks"
  const blocks = [...raw.matchAll(/```task\n([\s\S]*?)```/g)].map((m) => m[1]);
  const errors = [], owners = new Set();
  let tasks = 0;
  for (const b of blocks) {
    let t; try { t = parseYaml(b); } catch { errors.push('WORK: a task block has invalid YAML'); continue; }
    if (!t) continue;
    tasks++;
    for (const f of ['id', 'title', 'status', 'owner', 'objective', 'output_format', 'boundaries'])
      if (t[f] === undefined) errors.push(`WORK: task "${t.id || '?'}" missing "${f}"`);
    if (t.owner) owners.add(t.owner);
    if (t.status && !['todo', 'doing', 'done', 'blocked'].includes(t.status))
      errors.push(`WORK: task "${t.id}" invalid status "${t.status}"`);
  }
  return { errors, tasks, owners: [...owners] };
}

// ── BUILD: transpile source → runtime renderings (deterministic) ──
export function buildAgent(name, cwd = process.cwd()) {
  const a = loadAgent(name, cwd);
  const fm = a.frontmatter || {};
  const outDir = path.join(a.dir, '.build');
  const targets = Array.isArray(fm.runtimes) ? fm.runtimes : [];
  const written = [];
  const MARK = '<!-- GENERATED by scroll build — do not edit. Source: ../../ -->';

  const ensure = (d) => fs.mkdirSync(d, { recursive: true });

  // Cowork YourRole.md
  if (targets.includes('cowork')) {
    const d = path.join(outDir, 'cowork'); ensure(d);
    const out = [
      MARK, '',
      `# ${fm.title || name} — ${name}`, '',
      fm.pronoun ? `*Pronoun: ${fm.pronoun} · Language: ${fm.language || 'n/a'}*\n` : '',
      '## Identity', a.identityBody || '', '',
      '## Soul', a.soul || '', '',
      a.tools ? '## Tools\n' + a.tools : '',
      a.hardRules ? '\n## Hard rules\n' + a.hardRules : '',
    ].join('\n');
    const f = path.join(d, 'YourRole.md'); fs.writeFileSync(f, out); written.push(rel(cwd, f));
  }

  // Claude subagent (.md + frontmatter)
  if (targets.includes('claude-subagent')) {
    const d = path.join(outDir, 'claude-subagent'); ensure(d);
    const desc = (fm.title || name).replace(/\n/g, ' ');
    const sub = [
      '---',
      `name: ${name}`,
      `description: ${desc}`,
      `model: ${(fm.model && fm.model.primary) || 'inherit'}`,
      '---', '',
      a.soul || '', '',
      a.identityBody || '',
    ].join('\n');
    const f = path.join(d, `${name}.md`); fs.writeFileSync(f, sub); written.push(rel(cwd, f));
  }

  // A2A Agent Card (static JSON)
  if (targets.includes('a2a')) {
    const d = path.join(outDir, 'a2a'); ensure(d);
    const card = {
      schemaVersion: '1.0', name, title: fm.title || name, version: fm.version || '0.0.0',
      capabilities: fm.capabilities || [], model: (fm.model && fm.model.primary) || null,
    };
    const f = path.join(d, `${name}.agent-card.json`);
    fs.writeFileSync(f, JSON.stringify(card, null, 2) + '\n'); written.push(rel(cwd, f));
  }

  // Generic prompt for codex/gemini/voice
  for (const rt of ['codex', 'gemini', 'voice']) {
    if (!targets.includes(rt)) continue;
    const d = path.join(outDir, rt); ensure(d);
    const out = [MARK, '', a.soul || '', '', a.identityBody || '', a.tools ? '\n' + a.tools : ''].join('\n');
    const f = path.join(d, `${name}.prompt.md`); fs.writeFileSync(f, out); written.push(rel(cwd, f));
  }

  return { written, targets };
}

// ── REGISTRY: scan agents/ → rows ──
export function scanRegistry(cwd = process.cwd()) {
  const base = path.join(cwd, 'agents');
  if (!fs.existsSync(base)) return [];
  const rows = [];
  for (const name of fs.readdirSync(base)) {
    const idp = path.join(base, name, 'IDENTITY.md');
    if (!fs.existsSync(idp)) continue;
    try {
      const { frontmatter: fm } = parseFrontmatter(fs.readFileSync(idp, 'utf8'));
      rows.push({
        name, title: fm?.title || '', version: fm?.version || '',
        runtimes: (fm?.runtimes || []).join(','), model: fm?.model?.primary || '',
        caps: (fm?.capabilities || []).length,
      });
    } catch { rows.push({ name, title: c.red('(invalid IDENTITY)'), version: '', runtimes: '', model: '', caps: 0 }); }
  }
  return rows;
}

// ── COST: rough single-vs-multi estimate (language-aware) ──
// Non-English text costs more tokens per character (Vietnamese ≈ 1.8× English). Estimating as if
// English badly underestimates real spend for non-English markets — a local insight competitors miss.
export const LANG_MULT = { en: 1, vi: 1.8, ja: 1.6, zh: 1.7, ko: 1.6, th: 1.6, ar: 1.5, ru: 1.4 };
export function langMultiplier(language) {
  if (!language) return 1;
  const base = String(language).toLowerCase().split('-')[0];
  return LANG_MULT[base] || 1.5; // unknown but non-English → conservative 1.5
}
export function estimateCost(taskText, nAgents = 2, { language } = {}) {
  const mult = langMultiplier(language);
  const taskTokens = Math.ceil(((taskText || '').length / 4) * mult) || 500;
  const SYS = 1500;            // per-agent system prompt
  const single = SYS + taskTokens * 3;
  const multi = nAgents * (SYS + taskTokens * 2) + SYS /* coordinator */ + nAgents * 400 /* overhead */;
  return { single, multi, language: language || null, langMultiplier: mult, preferSingle: single < multi * 0.7, savingPct: Math.round((1 - single / multi) * 100) };
}

// ── NEW: scaffold from template ──
export function scaffold(name, cwd = process.cwd()) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`name "${name}" must match ^[a-z][a-z0-9-]*$`);
  const dest = path.join(cwd, 'agents', name);
  if (fs.existsSync(dest)) throw new Error(`agents/${name}/ already exists`);
  fs.cpSync(TEMPLATE_DIR, dest, { recursive: true });
  // patch IDENTITY name + title
  const idp = path.join(dest, 'IDENTITY.md');
  let id = fs.readFileSync(idp, 'utf8');
  id = id.replace(/^name: researcher.*$/m, `name: ${name}`)
         .replace(/^title: Research Synthesizer.*$/m, `title: ${name}`);
  fs.writeFileSync(idp, id);
  return rel(cwd, dest);
}

function rel(cwd, p) { return path.relative(cwd, p) || p; }

// tiny flag parser: --key value | --flag (boolean) | positional → _[]
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// "K=v,K2=${vault:X}" → { K: 'v', K2: '${vault:X}' }
function parseKv(s) {
  if (typeof s !== 'string') return undefined;
  const o = {};
  for (const pair of s.split(',')) { const i = pair.indexOf('='); if (i < 0) continue; o[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
  return Object.keys(o).length ? o : undefined;
}
// "issue_invoice:financial:code|amount,lookup:read_only" → { issue_invoice:{risk,ground:[...]}, lookup:{risk} }
function parseTools(s) {
  if (typeof s !== 'string') return undefined;
  const o = {};
  for (const t of s.split(',')) {
    const [name, tier, ground] = t.split(':');
    if (!name || !name.trim()) continue;
    o[name.trim()] = { ...(tier ? { risk: tier.trim() } : {}), ...(ground ? { ground: ground.split('|').map((x) => x.trim()).filter(Boolean) } : {}) };
  }
  return Object.keys(o).length ? o : undefined;
}

// ── CLI dispatch ──
const HELP = `${c.bold('scroll')} — build AI agents as folders, not code

${c.bold('Usage:')} scroll <command> [args]

  ${c.cyan('new')} <name>       scaffold a compliant agent folder
  ${c.cyan('check')} <name>     validate structure against the spec (L0/L1/L2)
  ${c.cyan('audit')} [name]     deeper compliance check — conventions + hash-bound report (run in CI; --verify)
  ${c.cyan('build')} <name>     render one source → every runtime
  ${c.cyan('registry')}         scan agents/ → a config table
  ${c.cyan('cost')} "<task>"    estimate single vs multi-agent token cost
  ${c.cyan('eval')} <name>      run gold cases N times → machine checks + consistency (real)
  ${c.cyan('run')} --work <f>   drive the inner loop: one harnessed multi-agent run (or: run <agent> --task "...")
  ${c.cyan('loop')} <LOOP.md>   drive the OUTER loop: schedule + find work + stop conditions (loop engineering)
  ${c.cyan('mcp')} add <name>   wire an MCP server / connector into .mcp.json
  ${c.cyan('skill')} add <ref>  add a skill to the search path
  ${c.cyan('plugin')} add <ref> install a plugin bundle (agents + skills + mcp)
  ${c.cyan('help')}             this message
`;

export async function run(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'new': {
      const name = rest[0]; if (!name) throw new Error('usage: scroll new <name>');
      const where = scaffold(name);
      console.log(`${c.green('✔')} created ${c.bold(where)}`);
      console.log(c.dim(`  edit SOUL.md (the persona) and IDENTITY.md (the frontmatter), then:`));
      console.log(c.dim(`  scroll check ${name} && scroll build ${name}`));
      break;
    }
    case 'check': {
      const name = rest[0]; if (!name) throw new Error('usage: scroll check <name>');
      const { errors, warnings, level } = checkAgent(name);
      for (const w of warnings) console.log(`${c.yellow('⚠')} ${w}`);
      for (const e of errors) console.log(`${c.red('✖')} ${e}`);
      if (errors.length === 0) console.log(`${c.green('✔')} ${name} valid — conformance ${c.bold(level)}`);
      else { console.log(`${c.red('✖')} ${name} has ${errors.length} error(s)`); process.exitCode = 1; }
      break;
    }
    case 'build': {
      const name = rest[0]; if (!name) throw new Error('usage: scroll build <name>');
      const chk = checkAgent(name);
      if (chk.errors.length) { chk.errors.forEach((e) => console.log(`${c.red('✖')} ${e}`)); throw new Error(`refusing to build invalid agent (run: scroll check ${name})`); }
      const { written, targets } = buildAgent(name);
      console.log(`${c.green('✔')} built ${c.bold(name)} → ${targets.join(', ')}`);
      written.forEach((f) => console.log(c.dim(`  ${f}`)));
      break;
    }
    case 'registry': {
      const rows = scanRegistry();
      if (!rows.length) { console.log(c.dim('no agents found under agents/')); break; }
      const pad = (s, n) => String(s).padEnd(n);
      console.log(c.bold(`${pad('NAME', 16)}${pad('VERSION', 10)}${pad('MODEL', 22)}${pad('RUNTIMES', 24)}CAPS`));
      for (const r of rows) console.log(`${pad(r.name, 16)}${pad(r.version, 10)}${pad(r.model, 22)}${pad(r.runtimes, 24)}${r.caps}`);
      console.log(c.dim(`\n${rows.length} agent(s). This table is derived from files — it is the registry.`));
      break;
    }
    case 'cost': {
      const a = parseArgs(rest);
      const task = a._.join(' '); if (!task) throw new Error('usage: scroll cost "<task>" [--language vi]');
      const lang = typeof a.language === 'string' ? a.language : (typeof a.lang === 'string' ? a.lang : undefined);
      const e = estimateCost(task, 2, { language: lang });
      console.log(`single-agent ~${e.single.toLocaleString()} tok · multi-agent ~${e.multi.toLocaleString()} tok${e.langMultiplier !== 1 ? ` · lang ${lang} ×${e.langMultiplier}` : ''}`);
      console.log(e.preferSingle ? `${c.green('→ prefer single')} (saves ~${e.savingPct}%)` : `${c.yellow('→ multi-agent justified')} (parallel/read-heavy)`);
      break;
    }
    case 'audit': {
      const a = parseArgs(rest);
      const { auditRepo, verifyAgainstRecord } = await import('./audit.js');
      const report = auditRepo(process.cwd(), { name: a._[0] });
      if (a.verify) {
        const v = verifyAgainstRecord(process.cwd(), report);
        console.log(v.ok ? `${c.green('✔')} ${v.reason}` : `${c.red('✖')} ${v.reason}`);
        if (!v.ok) process.exitCode = 1;
        break;
      }
      if (a.json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const ag of report.agents) {
          const mark = ag.errors.length ? c.red('✖') : c.green('✔');
          console.log(`${mark} ${c.bold(ag.name)} — ${ag.level || c.red('invalid')} · ${ag.evalCount} eval(s)`);
          ag.errors.forEach((e) => console.log(`    ${c.red('error')} ${e}`));
          ag.warnings.forEach((w) => console.log(`    ${c.yellow('warn')}  ${w}`));
        }
        if (report.conventions.length) {
          console.log(c.bold('\nconventions:'));
          for (const v of report.conventions) console.log(`  ${v.severity === 'error' ? c.red('error') : c.yellow('warn ')} ${c.cyan(v.rule)} — ${v.file}${v.line ? ':' + v.line : ''} — ${v.msg}`);
        }
        const verdict = report.verdict === 'pass' ? c.green('PASS') : c.red('FAIL');
        console.log(`\n${verdict} — ${report.errorCount} error(s), ${report.warnCount} warning(s)`);
        console.log(c.dim("  compliance = passing this in CI, not an agent's self-claim. Record: .scroll/audit.json"));
      }
      if (!a['no-write']) {
        fs.mkdirSync(path.join(process.cwd(), '.scroll'), { recursive: true });
        fs.writeFileSync(path.join(process.cwd(), '.scroll', 'audit.json'), JSON.stringify(report, null, 2) + '\n');
      }
      if (report.verdict !== 'pass') process.exitCode = 1;
      break;
    }
    case 'eval': {
      const a = parseArgs(rest);
      const name = a._[0]; if (!name) throw new Error('usage: scroll eval <name> [--n N] [--provider mock|claude|codex|openai|...] [--model M]');
      const { runEvals } = await import('./eval.js');
      const rep = await runEvals(name, {
        cwd: process.cwd(), n: a.n ? Number(a.n) : undefined,
        provider: typeof a.provider === 'string' ? a.provider : 'auto',
        model: typeof a.model === 'string' ? a.model : undefined,
        judge: !!a.judge,
        judgeProvider: typeof a['judge-provider'] === 'string' ? a['judge-provider'] : undefined,
        judgeModel: typeof a['judge-model'] === 'string' ? a['judge-model'] : undefined,
      });
      if (a.json) { console.log(JSON.stringify(rep, null, 2)); if (!rep.ok) process.exitCode = 1; break; }
      if (rep.error) { console.log(`${c.red('✖')} ${name}: ${rep.error}`); process.exitCode = 1; break; }
      for (const cs of rep.cases) {
        // §30 — provenance is printed beside every verdict: a green case built on a hand-made
        // precondition proves nothing about the path that should have made it.
        const prov = cs.fixture && cs.fixture.provenance
          ? c.dim(` [${cs.fixture.provenance}]`)
          : c.yellow(' [provenance?]');
        if (cs.skipped) { console.log(`${c.yellow('·')} ${cs.id}${prov} — ${c.yellow('ungraded')}: ${cs.reason}`); continue; }
        // §29 — verdict is ternary. `ungraded` gets a neutral marker, never a check-mark.
        const mark = cs.verdict === 'pass' ? c.green('✔') : cs.verdict === 'ungraded' ? c.yellow('·') : c.red('✖');
        const jd = cs.judge ? ` · judge ${cs.judge.ok ? cs.judge.average + '/' + cs.judge.min + (cs.judge.pass ? '✔' : '✖') : 'ERR ' + (cs.judge.error || '')}` : '';
        console.log(`${mark} ${c.bold(cs.id)}${prov} — ${cs.verdict === 'ungraded' ? c.yellow('ungraded (checker did not run)') : `${cs.passCount}/${cs.runs} runs pass (consistency ${cs.consistency} ≥ ${cs.threshold})`} · ${cs.checks} check(s)${jd}`);
        if (cs.verdict === 'fail') { const f = cs.perRun.find((r) => !r.allPass); if (f && f.fails.length) console.log(c.dim(`    failed: ${f.fails.join(', ')}${f.err ? ' · ' + f.err : ''}`)); }
        if (cs.fixture && cs.fixture.issues && cs.fixture.issues.length) console.log(c.yellow(`    fixture: ${cs.fixture.issues.join('; ')}`));
      }
      const verdict = rep.ok ? c.green('PASS') : c.red('FAIL');
      const ung = rep.ungraded ? c.yellow(` · ${rep.ungraded} ungraded (not counted as pass)`) : '';
      console.log(`\n${verdict} — ${rep.passed}/${rep.gradable} graded case(s)${ung} · provider ${rep.provider} (${rep.model}) · record .scroll/eval/${name}.json`);
      if (!rep.ok) process.exitCode = 1;
      break;
    }
    case 'run': {
      const a = parseArgs(rest);
      const positional = a._[0];
      const opts = {
        cwd: process.cwd(),
        workFile: a.work || (positional && positional.endsWith('.md') ? positional : undefined),
        task: typeof a.task === 'string' ? a.task : undefined,
        agent: a.agent || (positional && !positional.endsWith('.md') ? positional : undefined),
        providerName: a.provider || 'auto',
        model: typeof a.model === 'string' ? a.model : undefined,
        eventsPath: typeof a.events === 'string' ? a.events : undefined,
        outPath: typeof a.out === 'string' ? a.out : undefined,
        runDir: typeof a['run-dir'] === 'string' ? a['run-dir'] : undefined,
        json: !!a.json,
        verbose: !a.json,
        autoApprove: !!a['auto-approve'],
        risk: typeof a.risk === 'string' ? a.risk : undefined,
        resumeSelftest: !!a['resume-selftest'],
        noLean: !!a['no-lean'],
        maxTokens: a['max-tokens'] ? Number(a['max-tokens']) : undefined,
        intermediateMaxTokens: a['intermediate-max-tokens'] ? Number(a['intermediate-max-tokens']) : undefined,
        blackboardCap: a['blackboard-cap'] ? Number(a['blackboard-cap']) : undefined,
        subModel: typeof a['sub-model'] === 'string' ? a['sub-model'] : undefined,
        route: a['no-route'] ? false : undefined,
        compactPrefix: !!a['compact-prefix'],
        language: typeof a.language === 'string' ? a.language : (typeof a.lang === 'string' ? a.lang : undefined),
        resume: !!a.resume,
        worktree: !!a.worktree,
        tool: typeof a.tool === 'string' ? a.tool : undefined,
        caps: {},
      };
      const capMap = { 'max-iterations': 'maxIterations', 'max-input-tokens': 'maxInputTokens', 'max-wall-clock-ms': 'maxWallClockMs', 'max-usd': 'maxUsd' };
      for (const k of Object.keys(capMap)) if (a[k] != null && a[k] !== true) opts.caps[capMap[k]] = Number(a[k]);
      if (!opts.workFile && !opts.task) throw new Error('usage: scroll run --work <WORK.md>  |  scroll run <agent> --task "<text>"');
      const { runWork } = await import('./runtime.js');
      const res = await runWork(opts);
      if (!a.json) {
        const m = res.metrics;
        const mark = res.status === 'completed' ? c.green('✔') : c.yellow('●');
        console.log(`${mark} scroll run ${c.bold(res.status)} — ${m.tasksCompleted}/${m.tasksTotal} task(s) · ${res.decision}/${res.spawnedAgents} agent(s)`);
        console.log(c.dim(`  tokens ${m.billableTokenEquivalent} (cache ${m.cacheHitPct}%) · $${m.costUsd} · ${m.durationMs}ms · verify ${res.verification.passed ? c.green('PASS') : c.red('FAIL')}`));
        console.log(c.dim(`  events: ${rel(process.cwd(), res.eventsPath)}  ·  output: ${rel(process.cwd(), res.outPath)}`));
      }
      if (res.verification && res.verification.passed === false) process.exitCode = 1;
      break;
    }
    case 'loop': {
      const a = parseArgs(rest);
      const file = a._[0] || (typeof a.work === 'string' ? a.work : 'LOOP.md');
      const { runLoop } = await import('./loop.js');
      const { runWork } = await import('./runtime.js');
      const summary = await runLoop(file, {
        cwd: process.cwd(),
        once: !!a.once,
        dryRun: !!a['dry-run'],
        maxRuns: a['max-runs'] != null && a['max-runs'] !== true ? Number(a['max-runs']) : undefined,
        providerName: a.provider || 'auto',
        model: typeof a.model === 'string' ? a.model : undefined,
        sleepMs: a['sleep-ms'] != null && a['sleep-ms'] !== true ? Number(a['sleep-ms']) : undefined,
        verbose: !a.json,
        runWork,
      });
      if (a.json) { console.log(JSON.stringify(summary, null, 2)); break; }
      console.log(`${c.green('✔')} loop ${c.bold(summary.id)} — ${summary.iterations} iteration(s)${summary.stopped ? ` · stopped: ${summary.stopped}` : ''}`);
      for (const r of summary.runs) console.log(c.dim(`  iter ${r.iteration}: ${r.dryRun ? 'dry-run' : r.status + (r.verify != null ? ' · verify ' + (r.verify ? 'PASS' : 'FAIL') : '')}${r.digest ? ' · ' + r.digest : ''}`));
      console.log(c.dim(`  loop events: ${rel(process.cwd(), summary.eventsPath)}`));
      break;
    }
    case 'mcp': {
      const a = parseArgs(rest);
      if (a._[0] !== 'add') { console.log('usage: scroll mcp add <name> [--command "cmd" | --url URL] [--args "a b"] [--env "K=${vault:K}"] [--tool "name:tier[:g1|g2]"] [--agent <agent>]'); break; }
      const name = a._[1]; if (!name) throw new Error('usage: scroll mcp add <name> [--command cmd | --url URL] [--env "K=${vault:K}"] [--tool "name:tier"] [--agent <agent>]');
      const { mcpAdd } = await import('./installers.js');
      const res = mcpAdd(name, {
        command: typeof a.command === 'string' ? a.command : undefined,
        args: typeof a.args === 'string' ? a.args.split(/\s+/).filter(Boolean) : undefined,
        url: typeof a.url === 'string' ? a.url : undefined,
        transport: typeof a.transport === 'string' ? a.transport : undefined,
        env: parseKv(a.env), tools: parseTools(a.tool),
        agent: typeof a.agent === 'string' ? a.agent : undefined,
      });
      console.log(`${c.green('✔')} mcp ${res.existed ? 'updated' : 'added'} ${c.bold(name)} → ${res.file}`);
      if (res.vaultRefs.length) console.log(c.dim(`  credentials via vault: ${res.vaultRefs.join(', ')} (resolved at load — never written to the file)`));
      if (res.server.tools) console.log(c.dim(`  tools: ${Object.entries(res.server.tools).map(([k, v]) => `${k}=${v.risk || 'read_only'}`).join(', ')}`));
      break;
    }
    case 'skill': {
      const a = parseArgs(rest);
      if (a._[0] !== 'add') { console.log('usage: scroll skill add <path-to-skill-folder> [--agent <agent>]  |  scroll skill add --new <name> [--agent <agent>]'); break; }
      const isNew = a.new !== undefined;
      const ref = isNew ? (typeof a.new === 'string' ? a.new : a._[1]) : a._[1];
      if (!ref) throw new Error('usage: scroll skill add <path> [--agent <a>]  |  scroll skill add --new <name> [--agent <a>]');
      const { skillAdd } = await import('./installers.js');
      const res = skillAdd(ref, { new: isNew, force: !!a.force, agent: typeof a.agent === 'string' ? a.agent : undefined });
      console.log(`${c.green('✔')} skill ${res.scaffolded ? 'scaffolded' : 'added'} ${c.bold(res.name)} → ${res.dir}`);
      if (res.attachedToAgent) console.log(c.dim(`  referenced by agent ${res.attachedToAgent} (IDENTITY.skills)`));
      break;
    }
    case 'plugin': {
      const a = parseArgs(rest);
      if (a._[0] !== 'add') { console.log('usage: scroll plugin add <path-to-.plugin|dir> [--force]'); break; }
      const ref = a._[1]; if (!ref) throw new Error('usage: scroll plugin add <path-to-.plugin|dir> [--force]');
      const { pluginAdd } = await import('./installers.js');
      const res = pluginAdd(ref, { force: !!a.force });
      console.log(`${c.green('✔')} plugin ${c.bold(res.name)} installed`);
      console.log(c.dim(`  agents: ${res.installed.agents.join(', ') || 'none'} · skills: ${res.installed.skills.join(', ') || 'none'} · mcp: ${res.installed.mcpServers.join(', ') || 'none'}`));
      break;
    }
    case 'help': case undefined: case '--help': case '-h':
      console.log(HELP); break;
    default:
      throw new Error(`unknown command "${cmd}" — try: scroll help`);
  }
}
