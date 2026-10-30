import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const corpusDir = path.join(repoRoot, 'test/loop8/corpus');
const rendererUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/loop8/annotation-renderer.mjs'),
).href;

test('V8.2 renders the approved annotation byte-for-byte and never overwrites', async () => {
  const renderer = await import(rendererUrl).catch(() => null);
  assert.equal(
    typeof renderer?.renderAnnotations,
    'function',
    'V8.2 requires scripts/loop8/annotation-renderer.mjs to export renderAnnotations',
  );

  const outputDir = await mkdtemp(path.join(tmpdir(), 'loop8-v82-'));
  const outputPath = path.join(outputDir, 'phone-320.annotated.png');
  const renderOptions = {
    inputPath: path.join(corpusDir, 'phone-320.png'),
    findingsPath: path.join(corpusDir, 'phone-320.findings.json'),
    fontDirectory: path.join(corpusDir, 'fonts/noto-sans'),
    outputPath,
  };

  await renderer.renderAnnotations(renderOptions);
  assert.deepEqual(
    await readFile(outputPath),
    await readFile(path.join(corpusDir, 'phone-320.annotated.png')),
    'renderer output must match the approved golden PNG byte-for-byte',
  );

  const sentinel = Buffer.from('do-not-overwrite');
  await writeFile(outputPath, sentinel);
  await assert.rejects(
    renderer.renderAnnotations(renderOptions),
    /exist|overwrite/i,
    'renderer must refuse an output path that already exists',
  );
  assert.deepEqual(await readFile(outputPath), sentinel);
});
