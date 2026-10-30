import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectRoster,approveRoster} from '../../scripts/lib/roster.mjs';
import {sha256File} from '../../scripts/lib/core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('fixture human events cannot authorize a real or arbitrary provider executable',async()=>{
  const path=join(root,'test/roster-dynamic/catalog-openai-v1.json');
  const catalog=JSON.parse(readFileSync(path));catalog.harnesses[0].bin='/bin/echo';
  const request=JSON.parse(readFileSync(join(root,'test/roster-dynamic/request-default.json')));
  const dir=mkdtempSync(join(tmpdir(),'tq-fixture-real-bin-rejection-')),file=join(dir,'roster.json');
  writeFileSync(file,JSON.stringify(selectRoster({catalog,request,catalogPath:path})));
  const userEvent={schema:'team-qa/roster-user-event/v1',actor:'user',id:'fictional-user',text:'I approve this fixture roster',run_id:request.run_id,round:request.round,roster_hash:sha256File(file)};
  await assert.rejects(approveRoster({runDir:dir,file,userEvent}),/FIXTURE_HARNESS_NOT_TEST_STUB/);
});
