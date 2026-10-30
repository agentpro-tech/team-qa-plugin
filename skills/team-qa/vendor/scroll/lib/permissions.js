// SCROLL — permission layer (v1.4). Risk-tiered, enforced at the action boundary.
//
// Why this exists (the thesis): a model is sycophantic and can be prompt-injected, so it
// cannot be trusted to "stop before a dangerous action" on its own. SCROLL makes the gate
// DETERMINISTIC and puts it in code, in front of the action — never in the prompt.
//
// Five tiers, lowest → highest consequence:
//   read_only · reversible_write · external_comm · financial · destructive
// A matrix maps each tier to a policy: auto | auto-log | soft-hold | must-approve.
// financial + destructive additionally require a grounding check (see grounding.js).
//
// Risk is DATA, not prose: it is declared in .mcp.json (per tool) or IDENTITY.security
// (per capability namespace), and resolved here — never read from a markdown body, because
// a label a model reads is just another prompt it can be talked out of.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './scroll.js';

export const TIERS = ['read_only', 'reversible_write', 'external_comm', 'financial', 'destructive'];
export const TIER_RANK = Object.fromEntries(TIERS.map((t, i) => [t, i]));

// Default permission matrix (overridable per agent via IDENTITY.security.approval / scroll.config).
export const DEFAULT_MATRIX = {
  read_only: 'auto',
  reversible_write: 'auto-log',
  external_comm: 'soft-hold',
  financial: 'must-approve',
  destructive: 'must-approve',
};

const GROUND_TIERS = new Set(['financial', 'destructive']);

// Back-compat: the v1.3 runtime used a binary task risk of `irreversible` (and `reversible`).
const LEGACY_TIER = { irreversible: 'destructive', reversible: 'reversible_write' };

export function normalizeTier(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (TIER_RANK[s] !== undefined) return s;
  if (LEGACY_TIER[s]) return LEGACY_TIER[s];
  return null; // unknown label → caller treats as the fail-safe tier
}

// Resolve a tool/capability name → a tier.
// Order (highest precedence first): explicit .mcp.json per-tool → IDENTITY exact → IDENTITY
// namespace glob (e.g. `mcp.*`, `fs.*`) → fallback `destructive` (deny-by-default / fail-safe).
export function resolveTier(name, { mcpTools = {}, riskDefaults = {} } = {}) {
  if (!name) return { tier: 'destructive', via: 'fallback' };
  const fromMcp = mcpTools[name] && normalizeTier(mcpTools[name].risk);
  if (fromMcp) return { tier: fromMcp, via: 'mcp' };
  const exact = riskDefaults[name] && normalizeTier(riskDefaults[name]);
  if (exact) return { tier: exact, via: 'identity' };
  // namespace glob: `fs.write` matches a `fs.*` default; `issue_invoice` won't.
  const root = String(name).split('.')[0];
  for (const key of Object.keys(riskDefaults)) {
    if (key.endsWith('.*') && key.slice(0, -2) === root) {
      const t = normalizeTier(riskDefaults[key]);
      if (t) return { tier: t, via: 'identity-glob' };
    }
  }
  return { tier: 'destructive', via: 'fallback' };
}

export function policyForTier(tier, overrides = {}) {
  const matrix = { ...DEFAULT_MATRIX, ...(overrides || {}) };
  return matrix[tier] || 'must-approve';
}

export function needsGrounding(tier) {
  return GROUND_TIERS.has(tier);
}

// The single deterministic decision. Returns one of: allow | await | deny.
//   - must-approve + not approved        → await   (block until an approval file exists)
//   - grounding required + not grounded  → deny    (a fabricated id/amount never executes)
//   - everything else                    → allow   (soft-hold/auto-log still execute, just logged)
export function evaluateAction({ tier, policy, approved = false, groundingRequired = false, grounded = null }) {
  if (groundingRequired && grounded === false) {
    return { decision: 'deny', reason: 'grounding failed — a critical parameter could not be traced to a real source' };
  }
  if (policy === 'must-approve' && !approved) {
    return { decision: 'await', reason: 'must-approve: blocked until an approval file is present' };
  }
  const held = policy === 'soft-hold';
  return { decision: 'allow', reason: held ? 'soft-hold: executed and logged' : 'within policy', held };
}

// Load per-tool risk from a repo-level or agent-level `.mcp.json`.
// Shape: { mcpServers: { <srv>: { tools: { <tool>: { risk, ground:[...] } } } } }
export function loadMcpRisk(cwd = process.cwd(), agentDir = null) {
  const tools = {};
  const files = [path.join(cwd, '.mcp.json')];
  if (agentDir) files.push(path.join(agentDir, '.mcp.json'));
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const servers = j.mcpServers || {};
    for (const srv of Object.values(servers)) {
      for (const [toolName, meta] of Object.entries(srv.tools || {})) {
        tools[toolName] = { risk: meta.risk || null, ground: Array.isArray(meta.ground) ? meta.ground : [] };
      }
    }
  }
  return tools;
}

// Read IDENTITY.security from an agent folder (risk_defaults + approval overrides).
export function loadAgentSecurity(agentDir) {
  try {
    const raw = fs.readFileSync(path.join(agentDir, 'IDENTITY.md'), 'utf8');
    const { frontmatter } = parseFrontmatter(raw);
    const sec = (frontmatter && frontmatter.security) || {};
    return {
      riskDefaults: sec.risk_defaults || {},
      approvalOverrides: sec.approval || {},
    };
  } catch { return { riskDefaults: {}, approvalOverrides: {} }; }
}
