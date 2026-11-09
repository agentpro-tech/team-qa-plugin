// Playwright stand-ins for Dragon behind QA GUI's R1e interfaces (tests only; QA GUI drives Dragon, HR1).
import { createHash } from 'node:crypto';
import { GEOMETRY_PROBE_BODY, normalizeDomSnapshot, probeExpression } from '../../scripts/lib/width-sweep.mjs';
import { EXPLORE_OBSERVE_BODY, UNMATCHED_CSS_BODY } from '../../scripts/lib/frontier-explorer.mjs';

const SNAPSHOT_STYLES = ['visibility', 'opacity', 'display'];

// The width sweep reader: resize, read the geometry, and the paint-ordered snapshot through CDP DOMSnapshot.
export async function playwrightGeometryReader({ browser, url, height = 800 }) {
  const context = await browser.newContext({ viewport: { width: 1280, height } });
  const page = await context.newPage();
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  const captured = [];
  const measure = async (target, width) => {
    await target.setViewportSize({ width, height });
    return target.evaluate(probeExpression(GEOMETRY_PROBE_BODY));
  };
  return {
    captured,
    measure: (width) => measure(page, width),
    async snapshot(width) {
      await page.setViewportSize({ width, height });
      return normalizeDomSnapshot(await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: SNAPSHOT_STYLES, includePaintOrder: true, includeDOMRects: true }), SNAPSHOT_STYLES);
    },
    async capture(width) {
      captured.push(width);
      await page.setViewportSize({ width, height });
      const png = await page.screenshot();
      return { width, sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length };
    },
    // A matrix row under its own emulation (profile, DPR, touch), verified by what the page reads back.
    async measureRow(row) {
      const mobile = row.profile === 'mobile';
      const rowContext = await browser.newContext({ viewport: { width: row.w, height: row.h }, deviceScaleFactor: row.dpr, isMobile: mobile, hasTouch: mobile });
      try {
        const rowPage = await rowContext.newPage();
        await rowPage.goto(url);
        const emulation = await rowPage.evaluate(() => ({ width: document.documentElement.clientWidth, dpr: window.devicePixelRatio, touch: navigator.maxTouchPoints > 0 }));
        const value = await rowPage.evaluate(probeExpression(GEOMETRY_PROBE_BODY));
        return { verified: emulation.width === row.w && emulation.dpr === row.dpr && emulation.touch === mobile, emulation,
          failures: value.failures.map((failure) => `${failure.rule}|${failure.selector}`) };
      } finally { await rowContext.close(); }
    },
    close: () => context.close(),
  };
}

// The overlay driver: real mouse, keyboard and wheel input; reads evaluate the same page-side body Dragon runs.
export async function playwrightOverlayDriver({ browser, url, width = 1280, height = 800 }) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(url);
  return {
    click: (selector) => page.click(selector),
    clickAt: (x, y) => page.mouse.click(x, y),
    press: (key) => page.keyboard.press(key),
    read: (body) => page.evaluate(probeExpression(body)),
    async scrollAttempt() {
      await page.mouse.move(width / 2, height / 2);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(50);
      return { attempted: true };
    },
    reload: () => page.reload(),
    close: () => context.close(),
  };
}

// The explorer's driver: the same observe and CSS reads Dragon runs, real clicks by the observed selector.
export async function playwrightExploreDriver({ browser, url, width = 1280, height = 800 }) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const observe = () => page.evaluate(probeExpression(EXPLORE_OBSERVE_BODY));
  return {
    async start() { await page.goto('about:blank'); await page.goto(url); return observe(); },
    observe,
    async act(candidate) {
      try { await page.click(candidate.selector, { timeout: 2000 }); await page.waitForTimeout(30); return {}; }
      catch (error) { return { blocked: 'OBSCURED', detail: String(error?.message ?? error).split('\n')[0] }; }
    },
    unmatchedCssRules: () => page.evaluate(probeExpression(UNMATCHED_CSS_BODY)),
    close: () => context.close(),
  };
}
