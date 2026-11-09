// A write that a reader can catch half done: every string write under `dir` is split in two, and `observe` runs
// between the halves, as a second process reading the file at that moment would. Returns the function that undoes it.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

export function splitWrites(dir, observe) {
  const original = fs.writeFileSync;
  fs.writeFileSync = (path, data, options) => {
    if (typeof path === 'string' && path.startsWith(dir) && typeof data === 'string' && data.length > 1) {
      const half = Math.floor(data.length / 2);
      original(path, data.slice(0, half), options);
      observe(path);
      return original(path, data.slice(half), { encoding: 'utf8', flag: 'a' });
    }
    return original(path, data, options);
  };
  syncBuiltinESMExports();
  return () => { fs.writeFileSync = original; syncBuiltinESMExports(); };
}
