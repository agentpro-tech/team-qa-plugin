// SCROLL v1.5 — LEDGER: the human-readable tracking table that spans runs.
// `local://` = CSV/MD (core, zero dependency). External schemes write ledger.jsonl
// into loopDir for an app-layer ADAPTER to push (the core embeds no third-party SDK).
import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_HEADER = ['ts', 'loop', 'iteration', 'task', 'status', 'tries', 'proof', 'digest'];

function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

// "local://runs/ledger.csv" → {scheme:'local', target:'runs/ledger.csv'}
export function parseLedger(spec) {
  if (!spec) return null;
  const m = String(spec).match(/^(\w+):\/\/(.*)$/);
  return m ? { scheme: m[1], target: m[2] } : { scheme: 'local', target: String(spec) };
}

// Append one ledger row. Always writes ledger.jsonl (audit + adapter). `local` also writes CSV/MD directly.
export function appendLedgerRow(ledgerSpec, cwd, loopDir, row) {
  const jsonlPath = path.join(loopDir, 'ledger.jsonl');
  fs.appendFileSync(jsonlPath, JSON.stringify(row) + '\n');
  const L = parseLedger(ledgerSpec);
  if (!L) return { jsonl: jsonlPath, external: false };
  if (L.scheme === 'local') {
    const p = path.resolve(cwd, L.target);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (/\.md$/.test(p)) {
      if (!fs.existsSync(p)) fs.writeFileSync(p, '| ' + LEDGER_HEADER.join(' | ') + ' |\n| ' + LEDGER_HEADER.map(() => '---').join(' | ') + ' |\n');
      fs.appendFileSync(p, '| ' + LEDGER_HEADER.map((h) => csvCell(row[h]).replace(/\|/g, '\\|')).join(' | ') + ' |\n');
    } else {
      if (!fs.existsSync(p)) fs.writeFileSync(p, LEDGER_HEADER.join(',') + '\n');
      fs.appendFileSync(p, LEDGER_HEADER.map((h) => csvCell(row[h])).join(',') + '\n');
    }
    return { local: p, external: false };
  }
  // External schemes: an app-layer adapter reads ledger.jsonl and pushes it (proof: upload → URL → file field).
  return { jsonl: jsonlPath, external: true, scheme: L.scheme, target: L.target };
}
