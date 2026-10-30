import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => fs.readFileSync(path.join(root, 'scripts', name), 'utf8');

test('A5 local candidate package is explicit, locally proven, and compat-root only', () => {
  const build = source('build-package.sh');
  const install = source('install-package.sh');
  const verify = source('verify-install.sh');
  assert.match(build, /--local-candidate\)/);
  assert.match(build, /TRUTH_COMMAND="prove-local"/);
  assert.match(build, /local-candidate/);
  assert.match(install, /--allow-local-candidate\)/);
  assert.match(install, /LOCAL_CANDIDATE_REQUIRES_EXPLICIT_COMPAT_ROOT/);
  assert.match(install, /verify-envelope.*allow-local-candidate/);
  assert.match(verify, /allow-local-candidate/);
});
