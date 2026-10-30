import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

// Third-party runners also clean generated cache files. Keep their API semantics,
// but preserve bytes and fail closed for any removal outside declared owned roots.
const root=process.env.QA_CODE_FS_ARCHIVE_ROOT;
if (!root) throw new Error('QA_CODE_FS_ARCHIVE_ROOT required for archive preload');
const configured=JSON.parse(process.env.QA_CODE_FS_ARCHIVE_ALLOWED_ROOTS || '[]');
if (!Array.isArray(configured)||!configured.length||configured.some(p=>typeof p!=='string'||!isAbsolute(p))) throw new Error('explicit archive removal roots required');
function canonicalParent(value) {
  let cursor=resolve(value),tail=[];
  while(!fs.existsSync(cursor)){const parent=dirname(cursor);if(parent===cursor)throw new Error('no canonical archive ancestor');tail.unshift(basename(cursor));cursor=parent;}
  return resolve(fs.realpathSync(cursor),...tail);
}
const allowed=configured.map(canonicalParent);
const generatedConfigs=JSON.parse(process.env.QA_CODE_FS_ARCHIVE_CONFIG_PATHS || '[]');
if(!Array.isArray(generatedConfigs)||generatedConfigs.some(p=>typeof p!=='string'||!isAbsolute(p)))throw new Error('invalid explicit generated config paths');
const configPaths=generatedConfigs.map(p=>join(canonicalParent(dirname(p)),basename(p)));
const archive=resolve(root);
fs.mkdirSync(archive,{recursive:true});
const rename=fs.renameSync.bind(fs);
function retain(value,options={}) {
  const requested=resolve(String(value));
  const candidate=join(canonicalParent(dirname(requested)),basename(requested));
  const generated=configPaths.some(p=>candidate.startsWith(p+'.timestamp-')&&/^\d+-[0-9a-f]+\.mjs$/.test(candidate.slice((p+'.timestamp-').length)));
  if(!generated&&!allowed.some(p=>{const r=relative(p,candidate);return r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r)})) throw new Error('archive removal denied: '+candidate);
  try{fs.lstatSync(candidate);}catch(error){if(error.code==='ENOENT'&&options.force)return;throw error;}
  const destination=join(archive,basename(candidate)+'-'+randomUUID());
  rename(candidate,destination);
  fs.appendFileSync(join(archive,'archive-operations.jsonl'),JSON.stringify({at:new Date().toISOString(),from:candidate,to:destination})+'\n',{mode:0o600});
}
for(const name of ['rmSync','rmdirSync','unlinkSync']) fs[name]=(value,options)=>retain(value,options);
for(const name of ['rm','rmdir','unlink']) {
  fs[name]=(value,options,callback)=>{
    if(typeof options==='function'){callback=options;options={};}
    if(typeof callback!=='function')throw new TypeError('callback required');
    try{retain(value,options);queueMicrotask(()=>callback(null));}catch(error){queueMicrotask(()=>callback(error));}
  };
  fs.promises[name]=async(value,options)=>retain(value,options);
}
syncBuiltinESMExports();
