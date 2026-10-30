#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

import {
  GUI_RECEIPT_V1,
  GUI_RECEIPT_V2,
  GUI_RECEIPT_WEB_V1,
  verifyGuiWebReceiptBindings,
  validateGuiReceipt,
  verifyGuiReceiptBindings,
} from './lib/release-receipt-v2.mjs';
import { readGuiWebContext, webBindingAfterAttestation } from './lib/release-truth-v2.mjs';
import { verifyTeamQaGuiAttestation } from './lib/teamqa-attestation.mjs';

function usage(message = '') {
  process.stderr.write(`Usage: node scripts/receipt-verify.mjs --receipt <file> [--repo <git> --requirements <REQUIREMENTS.json> --evidence-root <run-root> | --web-binding <run/binding.json> --run-dir <run> --plan <tracked-plan.json> --requirements <REQUIREMENTS.json> --evidence-root <run-root>] [--json <out>]\n${message ? `${message}\n` : ''}`);
}

function parse(argv) {
  const options = {};
  const allowed = new Set(['--receipt', '--repo', '--requirements', '--evidence-root', '--json', '--web-binding', '--plan', '--run-dir']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined) throw new Error(`invalid flag or missing value: ${flag || '(empty)'}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (Object.hasOwn(options, key)) throw new Error(`duplicate flag: ${flag}`);
    options[key] = value;
  }
  if (!options.receipt) throw new Error('missing --receipt');
  const bindings = ['repo', 'requirements', 'evidenceRoot'].filter((key) => Object.hasOwn(options, key));
  if (bindings.length !== 0 && bindings.length !== 3 && !options.webBinding) throw new Error('v2 requires all of --repo, --requirements and --evidence-root');
  return options;
}

function main() {
  let options;
  try { options = parse(process.argv.slice(2)); }
  catch (error) { usage(error.message); return 2; }
  let receipt;
  try { receipt = JSON.parse(readFileSync(options.receipt, 'utf8')); }
  catch (error) {
    process.stderr.write(`RECEIPT_JSON:${error.message}\n`);
    return 20;
  }

  let errors;
  if (receipt.schema === GUI_RECEIPT_WEB_V1) {
    if (!options.webBinding || !options.requirements || !options.plan || !options.runDir || !options.evidenceRoot || options.repo) {
      errors = [...validateGuiReceipt(receipt), 'WEB_BINDINGS_REQUIRED'];
    } else {
      try {
        verifyTeamQaGuiAttestation({
          attestationPath: receipt.teamqa_provenance?.attestation_path,
          runtimeRoot: receipt.teamqa_provenance?.runtime_root,
          runUuid: receipt.run_uuid, requirementsHash: receipt.requirements_hash,
          targetBindingSha256: receipt.target_binding_sha256, caseId: receipt.teamqa_provenance?.case_id ?? null,
        });
        const context = readGuiWebContext({
          bindingPath: options.webBinding, requirementsPath: options.requirements,
          planPath: options.plan, runDir: options.runDir, verifyWebBinding: webBindingAfterAttestation,
        });
        errors = verifyGuiWebReceiptBindings(receipt, { context, evidenceRoot: options.evidenceRoot });
      } catch (error) { errors = [...validateGuiReceipt(receipt), error.message]; }
    }
  } else if (receipt.schema === GUI_RECEIPT_V2) {
    if (!options.repo || !options.requirements || !options.evidenceRoot) {
      errors = [...validateGuiReceipt(receipt), 'V2_BINDINGS_REQUIRED'];
    } else {
      errors = verifyGuiReceiptBindings(receipt, {
        repo: options.repo,
        requirements: options.requirements,
        evidenceRoot: options.evidenceRoot,
      });
    }
  } else {
    errors = validateGuiReceipt(receipt);
  }
  const result = {
    schema: 'qa-gui/receipt-verification/v1',
    ok: errors.length === 0,
    errors,
    capabilities: receipt.schema === GUI_RECEIPT_V1
      ? ['CAPABILITY_MISSING:release-truth-v2']
      : [],
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.json) writeFileSync(options.json, text);
  else process.stdout.write(text);
  return errors.length === 0 ? 0 : 1;
}

process.exitCode = main();
