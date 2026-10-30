#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('local package install can isolate compatibility links from the official runtime', () => {
  const install = fs.readFileSync(path.join(root, 'scripts/install-package.sh'), 'utf8');
  const verify = fs.readFileSync(path.join(root, 'scripts/verify-install.sh'), 'utf8');

  assert.match(install, /--compat-root\) COMPAT_ROOT=/);
  assert.match(install, /"\$COMPAT_ROOT\/\.claude\/skills"/);
  assert.match(install, /"\$COMPAT_ROOT\/\.codex\/skills"/);
  assert.match(install, /verify-install\.sh" "\$DEST" "\$COMPAT_ROOT"/);
  assert.match(verify, /COMPAT_ROOT="\$\{2:-\$HOME\}"/);
  assert.match(verify, /"\$COMPAT_ROOT\/\.claude\/skills\/team-qa"/);
});
