#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const required = [
  'VERSION', 'package-files.json', 'package-manifest.json',
  'scripts/package-tool.mjs', 'scripts/build-package.sh', 'scripts/install-package.sh',
  'scripts/verify-install.sh', 'scripts/release-provenance-redproof.sh', '.github/workflows/ci.yml',
];
for (const relative of required) assert.equal(fs.existsSync(path.join(root, relative)), true, `missing ${relative}`);

const run = spawnSync(process.execPath, [path.join(root, 'scripts/package-tool.mjs'), 'verify', '--root', root, '--manifest', path.join(root, 'package-manifest.json')], { encoding: 'utf8' });
assert.equal(run.status, 0, `package manifest must verify\n${run.stdout}\n${run.stderr}`);

const build = fs.readFileSync(path.join(root, 'scripts/build-package.sh'), 'utf8');
const install = fs.readFileSync(path.join(root, 'scripts/install-package.sh'), 'utf8');
const verify = fs.readFileSync(path.join(root, 'scripts/verify-install.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const packageTool = fs.readFileSync(path.join(root, 'scripts/package-tool.mjs'), 'utf8');
const fixtureRunner = fs.readFileSync(path.join(root, 'fixtures/run_fixtures.sh'), 'utf8');
const fixtureRoles = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/data/roles-check.fixture.json'), 'utf8'));
assert.match(build, /TEAMCODE_RELEASE_TRUTH_GATE/, 'build must use canonical Team-code gate');
assert.match(build, /prove --repo "\$ROOT" --receipt/, 'build must prove live remote before packaging');
assert.match(build, /cp "\$TRUTH_GATE" "\$RELEASE\/release-truth-gate\.mjs"/, 'artifact must carry exact verifier');
assert.match(build, /cp "\$TRUTH_POLICY" "\$RELEASE\/release-policy\.mjs"/, 'artifact must carry verifier dependency');
assert.match(install, /verify-envelope --receipt/, 'installer must verify release truth before cutover');
assert.match(install, /cp "\$TRUTH_POLICY" "\$STAGE\/\$SKILL\/release-policy\.mjs"/, 'installer must carry verifier dependency into runtime');
assert.match(install, /mv "\$DEST" "\$PREVIOUS"/, 'installer must archive previous runtime');
assert.doesNotMatch(install, /rm\s+-rf/, 'installer must not hard-delete');
assert.match(verify, /release-truth\.json/, 'runtime verify must require release truth');
assert.match(verify, /release-policy\.mjs/, 'runtime verify must require verifier dependency');
assert.match(workflow, /git ls-remote origin refs\/heads\/main/, 'CI main must read live remote SHA');
assert.match(workflow, /grep -q 'a134d56e66d9e797bff49d6141eca6002bb6518d' vendor\/scroll\/VENDORED\.md\n\s+cp -R vendor\/scroll "\$RUNNER_TEMP\/scroll"/, 'CI must use the pinned SCROLL runtime that ships with Team QA');
assert.match(workflow, /TEAMQA_SCROLL_ROOT: \$\{\{ runner\.temp \}\}\/scroll/, 'CI acceptance must receive the pinned SCROLL root');
assert.match(workflow, /Run release truth contract v2 incident replay\n\s+env:\n\s+TEAMQA_SCROLL_ROOT: \$\{\{ runner\.temp \}\}\/scroll\n\s+run: node --test test\/release-truth-v2-session1\.test\.mjs/, 'CI incident replay must receive the pinned SCROLL root');
assert.match(workflow, /Prove release truth v2 mutations turn RED\n\s+env:\n\s+TEAMQA_SCROLL_ROOT: \$\{\{ runner\.temp \}\}\/scroll\n\s+run: node test\/release-truth-v2-session1-mutation\.mjs/, 'CI mutation replay must receive the pinned SCROLL root');
assert.match(workflow, /Run Release C escaped-defect compile acceptance\n\s+env:\n\s+TEAMQA_SCROLL_ROOT: \$\{\{ runner\.temp \}\}\/scroll\n\s+run: node --test test\/release-c-escaped-defect-compile\.acceptance\.mjs/, 'CI Release C acceptance must receive the pinned SCROLL root');
assert.match(workflow, /Prove Release C escaped-defect compile mutations turn RED\n\s+env:\n\s+TEAMQA_SCROLL_ROOT: \$\{\{ runner\.temp \}\}\/scroll\n\s+run: node --test test\/release-c-escaped-defect-compile\.mutation\.mjs/, 'CI Release C mutation must receive the pinned SCROLL root');
assert.match(packageTool, /'\.build'/, 'package manifest must exclude generated SCROLL builds');
assert.match(fixtureRunner, /TEAMQA_ROLES="\$RUN_DIR\/roles-check\.json"/, 'fixture roles check must not depend on installed user skills');
assert.equal(Array.isArray(fixtureRoles.roles) && fixtureRoles.roles.length, 6, 'fixture roles must cover all six Team QA roles');
assert.ok(fixtureRoles.skills?.['qa-gui']?.commands?.gate, 'fixture must expose a deterministic qa-gui canary');
assert.ok(fixtureRoles.skills?.['qa-code']?.commands?.gate0, 'fixture must expose a deterministic qa-code canary');

process.stdout.write('TEAM_QA_RELEASE_PROVENANCE_PASS package=1 build=1 install=1 runtime=1 ci=1\n');
