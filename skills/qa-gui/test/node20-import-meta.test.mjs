import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// L2: import.meta.dirname and import.meta.filename exist from Node 20.11; on Node 20.0-20.10 they are undefined and
// a module that joins a path with them fails as it loads.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.(?:mjs|js|cjs)$/.test(name) ? [path] : [];
});

test('no shipped script uses import.meta.dirname or import.meta.filename (Node 20.11+ only)', () => {
  const users = files(join(root, 'scripts')).filter((path) => /import\.meta\.(?:dirname|filename)\b/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(users.map((path) => path.slice(root.length)), []);
});

test('the modules that used them load where import.meta.dirname is undefined, as on Node 20.10', () => {
  // A load hook that gives these modules the import.meta of Node 20.0-20.10.
  const hooks = "export async function load(url, context, next) { const r = await next(url, context); if (url.includes('/scripts/') && r.source != null) return { ...r, source: String(r.source).replaceAll('import.meta.dirname', 'undefined').replaceAll('import.meta.filename', 'undefined') }; return r; }";
  const register = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;
  for (const script of ['scripts/dragon-responsive-matrix-preflight.mjs', 'scripts/loop8/annotation-renderer.mjs']) {
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(register)}`, '--input-type=module', '-e',
      `await import(${JSON.stringify(pathToFileURL(join(root, script)).href)}); console.log('LOADED');`], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr.split('\n').find((line) => /Error/.test(line)) ?? result.stderr}`);
    assert.match(result.stdout, /LOADED/);
  }
});
