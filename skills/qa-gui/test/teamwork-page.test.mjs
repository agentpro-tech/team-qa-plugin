import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const cli = new URL('../scripts/teamwork/cli.mjs', import.meta.url).pathname;
const canonical = new URL('../scripts/teamwork/example-canonical.json', import.meta.url).pathname;
const run = args => spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'qa-page-')); const out=join(dir,'page.json');
 const result=run(['export-page','--file',canonical,'--out',out]);
 assert.equal(result.status,0,result.stderr);
 const page=JSON.parse(readFileSync(out));
 const snapshot={structuredContent:{content:{page_id:'page_test',title:page.title,blocks:page.initial_blocks.map((markdown,i)=>({id:`b${i}`,hash:'observed',kind:'markdown',markdown}))},metadata:{page_id:'page_test',url:'https://chatgpt.com/pages/page_test'}}};
 return {dir,out,page,snapshot};
}
function compare(f,snapshot,args=[]) {const file=join(f.dir,`snapshot-${Math.random()}.json`);writeFileSync(file,JSON.stringify(snapshot));return run(['compare-page','--file',canonical,'--snapshot',file,...args]);}
test('Page CLI projects canonical defects first, local evidence disclosed and references lower',()=>{
 const f=fixture();const text=f.page.initial_blocks.join('\n\n');
 assert.ok(text.indexOf('## Lỗi đang xử lý')<text.indexOf('## Tất cả ca kiểm thử'));
 for(const label of ['**Vị trí:**','**Các bước tái hiện:**','**Thực tế:**','**Mong đợi:**','cần tải lên']) assert.ok(text.includes(label),label);
 const source=JSON.parse(readFileSync(canonical));
 assert.ok(text.includes('**Người phụ trách:** '+source.defects[0].assignee));
 const intro=f.page.initial_blocks[0];
 for(const key of ['app','envDb','build','role','testProfile']) assert.ok(intro.includes(source[key]),key);
 for(const field of ['repro','actual','expected']) assert.ok(text.includes(source.defects[0][field]),field);
 assert.ok(text.includes('Function: UNGRADED'));assert.ok(text.includes('SRC-REQ-01'));
 assert.ok(text.indexOf('## Tham chiếu kỹ thuật')>text.indexOf('## Tất cả ca kiểm thử'));
 assert.match(f.page.canonical.sha256,/^[a-f0-9]{64}$/);
 const receipt=join(f.dir,'receipt.json');const r=compare(f,f.snapshot,['--out',receipt]);assert.equal(r.status,0,r.stderr);
 assert.equal(JSON.parse(readFileSync(receipt)).matchPercent,100);
 assert.match(JSON.parse(r.stdout).seal,/^[a-f0-9]{64}$/);
});
test('Page verifier rejects every changed or missing block, title, stale revision, partial read and exporter self-readback',()=>{
 const f=fixture();
 const mutations=[s=>s.content.title+=' edited',s=>s.content.blocks.pop(),s=>s.content.blocks[0].markdown+=' changed',s=>s.content.blocks.reverse(),s=>s.content.blocks.push({kind:'markdown',markdown:'extra'}),s=>s.content.blocks.find(b=>b.markdown.includes('canonical sha256')).markdown=s.content.blocks.find(b=>b.markdown.includes('canonical sha256')).markdown.replace('revision 0','revision 99'),s=>s.selection={whole_page_complete:false},s=>s.metadata.url='/local'];
 for(const mutate of mutations){const s=structuredClone(f.snapshot);mutate(s.structuredContent);assert.notEqual(compare(f,s).status,0);}
 assert.notEqual(compare(f,f.page).status,0);
});
test('Page evidence map requires verified exact known paths and rejects unsafe links',()=>{
 const f=fixture();const map=join(f.dir,'map.json');
 for(const entry of [{reference:'javascript:alert(1)',verified:true},{reference:'https://example.test/image',verified:false}]){
 writeFileSync(map,JSON.stringify({'evidence/replace-with-capture.png':entry}));assert.notEqual(run(['export-page','--file',canonical,'--out',join(f.dir,`bad-${Math.random()}.json`),'--evidence-map',map]).status,0);
 }
 writeFileSync(map,JSON.stringify({'evidence/replace-with-capture.png':{reference:'library-file:observed-file',verified:true}}));
 const out=join(f.dir,'mapped.json');const r=run(['export-page','--file',canonical,'--out',out,'--evidence-map',map]);assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(readFileSync(out)).initial_blocks.join('\n').includes('library-file:observed-file'));
});
test('Page comparison accepts native block splitting and rejects canonical changes with identical revision',()=>{
 const f=fixture();const split=structuredClone(f.snapshot);
 split.structuredContent.content.blocks=f.page.initial_blocks.flatMap((text,i)=>text.split('\n\n').map((markdown,j)=>({id:`${i}-${j}`,hash:'observed',kind:'markdown',markdown})));
 assert.equal(compare(f,split).status,0);
 const changed=join(f.dir,'canonical-changed.json');const data=JSON.parse(readFileSync(canonical));data.defects[0].actual='Hành vi lỗi khác đã được quan sát.';writeFileSync(changed,JSON.stringify(data,null,2));
 const snapshot=join(f.dir,'unchanged-page.json');writeFileSync(snapshot,JSON.stringify(f.snapshot));
 assert.notEqual(run(['compare-page','--file',changed,'--snapshot',snapshot]).status,0);
 assert.notEqual(run(['export-page','--file',canonical,'--out',f.out]).status,0);
});

test('Page groups RETEST and VERIFIED waiting for QA; only CLOSED and REJECTED resolved', async()=>{
 const {exportPage}=await import('../scripts/teamwork/page-exporter.mjs');
 const data=JSON.parse(readFileSync(canonical));
 data.defects=['TODO','RETEST','VERIFIED','CLOSED','REJECTED','DEFERRED'].map((status,index)=>({...structuredClone(data.defects[0]),id:`DF-${index}`,title:`Group fixture ${status}`,status}));
 const blocks=exportPage(data,'a'.repeat(64)).initial_blocks;
 const active=blocks.indexOf('## Lỗi đang xử lý');const waiting=blocks.indexOf('## Chờ QA kiểm tra lại');const resolved=blocks.indexOf('## Lỗi đã giải quyết');const scope=blocks.indexOf('## Phạm vi và kết quả vòng QA');const deferred=blocks.indexOf('## Lỗi hoãn xử lý');
 assert.ok(deferred>resolved && deferred<scope);
 assert.ok(blocks.slice(deferred,scope).join('\n').includes('Group fixture DEFERRED'));
 assert.ok(!blocks.slice(active,waiting).join('\n').includes('Group fixture DEFERRED'));
 assert.ok(blocks.slice(active,waiting).join('\n').includes('Group fixture TODO'));
 for(const status of ['RETEST','VERIFIED']) {assert.ok(blocks.slice(waiting,resolved).join('\n').includes(`Group fixture ${status}`));assert.ok(!blocks.slice(resolved,scope).join('\n').includes(`Group fixture ${status}`));}
 for(const status of ['CLOSED','REJECTED']) {assert.ok(blocks.slice(resolved,scope).join('\n').includes(`Group fixture ${status}`));assert.ok(!blocks.slice(waiting,resolved).join('\n').includes(`Group fixture ${status}`));}
});
test('observed Pages native list-item blocks compare with exact projected text; item mutations fail',async()=>{
 const {comparePage}=await import('../scripts/teamwork/page-exporter.mjs');
 const payload=JSON.parse(readFileSync(new URL('./fixtures/teamwork-page-observed/page-payload.json',import.meta.url)));
 const actual=JSON.parse(readFileSync(new URL('./fixtures/teamwork-page-observed/read-page.json',import.meta.url)));
 assert.equal(comparePage(payload,actual).ok,true);
 for(const mutate of [b=>b.markdown=b.markdown.replace('2.','4.'),b=>b.markdown+=' altered']) {
  const changed=structuredClone(actual);mutate(changed.structuredContent.content.blocks.find(b=>b.markdown==='2. Chọn chi nhánh A.'));assert.equal(comparePage(payload,changed).ok,false);
 }
});
test('Page prose escapes literal heading syntax; historical evidence accepts verified map and discloses local paths',async()=>{
 const {exportPage}=await import('../scripts/teamwork/page-exporter.mjs');
 const data=JSON.parse(readFileSync(canonical));data.defects[0].actual='# Tiêu đề chỉ là văn bản\n## Văn bản tiếp theo';
 data.cases[0].results=[{round:1,functionVerdict:'FAIL',uiVerdict:'UNGRADED',recordedAt:'2026-10-02T00:00:00Z',evidence:['evidence/historical.png']}];
 const local=exportPage(data,'a'.repeat(64)).initial_blocks.join('\n\n');
 assert.ok(local.includes('\\# Tiêu đề chỉ là văn bản\n\\#\\# Văn bản tiếp theo'));
 assert.ok(local.includes('evidence/historical.png — bằng chứng cục bộ chưa truy cập được trên Page; cần tải lên'));
 const mapped=exportPage(data,'a'.repeat(64),{'evidence/historical.png':{reference:'project-file:observed-history',verified:true}}).initial_blocks.join('\n\n');
 assert.ok(mapped.includes('[evidence/historical.png](project-file:observed-history)'));
});
