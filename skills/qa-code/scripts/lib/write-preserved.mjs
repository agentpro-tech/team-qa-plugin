import {existsSync,mkdirSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
export function archiveExistingFile(path) {
  if(!existsSync(path))return null;
  const dir=join(dirname(path),'archive');mkdirSync(dir,{recursive:true});
  const dest=join(dir,basename(path)+'-'+randomUUID());renameSync(path,dest);return dest;
}
export function writePreserved(path,data,options) {
  archiveExistingFile(path);return writeFileSync(path,data,options);
}
