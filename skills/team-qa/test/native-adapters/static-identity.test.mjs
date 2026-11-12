import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/lib/core.mjs';
import * as preflight from '../../scripts/lib/tool-preflight.mjs';

// Static HTML identity: a page that loads no script by src and no Next.js assets is its own build. The id is the sha256
// of the whole HTML, the same from the whole read (getPageHtml) and from the parts read (getPageIdentity).
const failCode = (fn, code) => assert.throws(fn, e => e.code === code);
const pageUrl = 'https://static.example/';
const staticHtml = (extra = '') => `<html lang='en'><head><meta charset='UTF-8'><title>Static</title>`
  + `<link rel='stylesheet' href='/site.css'><link rel='preconnect' href='https://fonts.example'>` + extra
  + `<style>body{margin:0}</style></head><body><main>Hello</main></body></html>`;

function identityRead(html) {
  const parts = preflight.passiveHtmlParts(html), hash = sha256(html);
  return { v: 1, html_sha256: hash, html_length: html.length, html_bytes: Buffer.byteLength(html, 'utf8'), complete: true, truncated: false,
    scripts: parts.scripts, tags: parts.tags, omitted: 0, evidence: { kind: 'dom', contentHash: 'sha256:' + hash }, telemetry: {} };
}

test('a static page is its own build: the id is the sha256 of the whole HTML', () => {
  const html = staticHtml();
  const v = preflight.parsePassiveDeployedHtml(html, { preview_url: pageUrl });
  const manifest = { kind: 'static-html-assets/v1', html_sha256: sha256(html), urls: ['https://static.example/site.css'] };
  assert.deepEqual(v, { preview_url: pageUrl, frontend_build: { kind: 'static-html', id: 'sha256-' + sha256(html) }, asset_manifest_sha256: sha256(JSON.stringify(manifest)) });
  assert.deepEqual(preflight.parsePassiveIdentityRead(identityRead(html), { preview_url: pageUrl }), v, 'the parts read gives the identity of the whole read');
  const changed = preflight.parsePassiveDeployedHtml(staticHtml(`<meta name='x' content='1'>`), { preview_url: pageUrl });
  assert.notEqual(changed.frontend_build.id, v.frontend_build.id, 'any change to the HTML is another build');
  const inline = preflight.parsePassiveDeployedHtml(staticHtml(`<script>window.x=1</script>`), { preview_url: pageUrl });
  assert.equal(inline.frontend_build.kind, 'static-html', 'an inline script loads no code from elsewhere');
  const injected = preflight.parsePassiveDeployedHtml(staticHtml(`<script src='chrome-extension://abcdefghijklmnop/record.js'></script>`), { preview_url: pageUrl });
  assert.equal(injected.frontend_build.kind, 'static-html', 'a script a browser extension injects is not the page code');
});

test('a page that loads a script by src or carries Next.js assets is not static and fails closed', () => {
  failCode(() => preflight.parsePassiveDeployedHtml(staticHtml(`<script src='/app.js'></script>`), { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_NEXT_DATA');
  failCode(() => preflight.parsePassiveDeployedHtml(staticHtml(`<script src='https://cdn.example/a.js'></script>`), { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_NEXT_DATA');
  failCode(() => preflight.parsePassiveDeployedHtml(staticHtml(`<link rel='preload' href='/_next/static/chunks/main.js'>`), { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_NEXT_DATA');
  failCode(() => preflight.parsePassiveIdentityRead({ ...identityRead(staticHtml()), html_sha256: 'x' }, { preview_url: pageUrl }), 'PREFLIGHT_DRAGON_IDENTITY_SHAPE');
});
