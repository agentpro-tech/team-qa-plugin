import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { approveRoster, selectRoster } from '../../scripts/lib/roster.mjs';
import { createCurrentTeamQaReceipt, verifyCurrentTeamQaReceipt } from '../../scripts/lib/current-run-receipt.mjs';
import { CONTRACT_SHA256, seal, verifyTeamQaReceipt } from '../../scripts/lib/release-truth.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const fixture=join(root,'test/roster-dynamic');
const catalogPath=join(fixture,'catalog-openai-v1.json');
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
const hashFile=path=>createHash('sha256').update(readFileSync(path)).digest('hex');

test('a re-sealed legacy receipt passes its legacy verifier but cannot certify current receipt/v2',()=>{
  const legacy=seal({schema:'team-qa/receipt/v1',contract_sha256:CONTRACT_SHA256,task_base:'a'.repeat(40),exact_final_sha:'b'.repeat(40),requirements_hash:'c'.repeat(64),release_verdict:'UNGRADED',artifacts:{}});
  assert.equal(verifyTeamQaReceipt(legacy,join(tmpdir(),'unused-legacy-receipt.json')),legacy);
  assert.throws(()=>verifyCurrentTeamQaReceipt(legacy,join(tmpdir(),'unused-current-receipt.json')),error=>error?.code==='RECEIPT_CURRENT_CONTRACT_REQUIRED');
});

test('current receipt creation fails closed when the approved run has no phase document',async()=>{
  const runDir=mkdtempSync(join(tmpdir(),'roster-current-receipt-'));
  const catalog=readJson(catalogPath),request=readJson(join(fixture,'request-default.json'));
  request.run_id=runDir.split('/').at(-1);
  const roster=selectRoster({catalog,request,catalogPath});
  const rosterFile=join(runDir,'roster.json');writeFileSync(rosterFile,`${JSON.stringify(roster,null,2)}\n`);
  const userEvent={schema:'team-qa/roster-user-event/v1',id:'event-current-receipt',actor:'user',text:'I approve this fixture roster for the test.',run_id:roster.run_id,round:roster.round,roster_hash:hashFile(rosterFile),source:{}};
  await approveRoster({runDir,file:rosterFile,userEvent});
  assert.throws(()=>createCurrentTeamQaReceipt({runDir,runUuid:'fixture-run',binding:{task_base:'a'.repeat(40),source_revision:'fixture',exact_final_sha:'b'.repeat(40),requirements_hash:'c'.repeat(64),contract_sha256:CONTRACT_SHA256}}),error=>error?.code==='RUN_CONTRACT_MISSING');
});
