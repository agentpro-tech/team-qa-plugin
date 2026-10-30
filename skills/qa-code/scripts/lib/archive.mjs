import {existsSync, mkdirSync, renameSync, realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {homedir, tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

export function archiveOwnedPath(value) {
  if (!existsSync(value)) return null;
  const requested=resolve(value);
  const scratch=realpathSync(process.env.QA_CODE_SCRATCH_ROOT || tmpdir());
  const realParent=realpathSync(dirname(requested));
  const candidate=join(realParent,basename(requested));
  const rel=relative(scratch,realParent);
  if ((rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)) || !relative(scratch,candidate).split(sep)[0].startsWith('qa-code-')) throw new Error(`archive ownership denied: ${candidate}`);
  const root=resolve(process.env.QA_CODE_ARCHIVE_ROOT || join(homedir(),'.qa-code','archive'));
  if (root===candidate || root.startsWith(candidate+sep)) throw new Error('archive destination must be outside scratch item');
  mkdirSync(root,{recursive:true});
  const destination=join(root,basename(candidate)+'-'+randomUUID());
  renameSync(candidate,destination);
  return destination;
}
