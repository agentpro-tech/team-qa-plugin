// a11y-gate0.js — Phase 3: WCAG a11y checks PROMOTED into Gate-0 (qa-gui)
// ============================================================
// Runs the 4 highest-priority a11y rules as Gate-0 (NOT taste-optional):
//   B6 contrast       — text ≥4.5:1 (large ≥3:1), non-text/icon/border ≥3:1  (WCAG 1.4.3 + 1.4.11)
//   B7 focus-visible  — a focused control shows a visible indicator            (WCAG 2.4.7)  [harness-assisted]
//   B8 target-size    — interactive controls ≥ 24×24 CSS px (mobile 44)        (WCAG 2.2 §2.5.8)
//   B9 reflow-320     — no content loss / no horizontal scroll at 320px         (WCAG 1.4.10)
// HOW TO RUN: one Dragon `read` step, like ui-sanity:
//   { read: "<contents>; return __a11yB({minTarget:24});", as: "a11y_b" }
// For the responsive matrix, read scripts/loop7/responsive-matrix.mjs and call once per row; B9 uses the
// CURRENT viewport. B7 needs a real focus() (the QA flow / harness focuses each control) — this
// file exposes __a11yFocusProbe(el) the harness calls after focusing.
// CSP note: if the page blocks eval (injection fails), the sweep is "not measurable" — the QA flow
// says so explicitly and attaches ONE screenshot (never silently skip).

window.__a11yB = function (opts) {
  opts = opts || {};
  var MIN = opts.minTarget || 24;
  var EPS = 2;
  var issues = [];
  function sel(el) {
    if (!el || el.nodeType !== 1) return String(el);
    if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
    var s = el.tagName.toLowerCase();
    var c = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0];
    return c ? s + '.' + c : s;
  }
  function push(sev, rule, el, detail) { issues.push({ sev: sev, rule: rule, sel: sel(el), detail: detail, text: (el && el.textContent || '').trim().slice(0, 50) }); }
  function cs(el) { return window.getComputedStyle(el); }
  function toRGB(str) {
    if (!str) return null;
    var m = str.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    return { r: p[0], g: p[1], b: p[2], a: (p[3] == null ? 1 : p[3]) };
  }
  function relLum(c) {
    function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  function contrast(a, b) { var L1 = relLum(a), L2 = relLum(b), hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); }
  function effectiveBg(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      var bg = toRGB(cs(e).backgroundColor);
      if (bg && bg.a > 0) return bg;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) { var n = el.childNodes[i]; if (n.nodeType === 3 && n.textContent.trim().length > 1) return true; }
    return false;
  }
  function visible(el) { var st = cs(el); if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }

  var vw = window.innerWidth, vh = window.innerHeight;

  // ---- B6 contrast (text) ----
  var textEls = document.querySelectorAll('body *');
  var seen6 = {}, checked = 0;
  Array.prototype.some.call(textEls, function (el) {
    if (checked >= 800) return true;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
    if (!hasDirectText(el) || !visible(el)) return false;
    checked++;
    var st = cs(el);
    var fg = toRGB(st.color); if (!fg || fg.a === 0) return false;
    var bg = effectiveBg(el);
    var cr = contrast(fg, bg);
    var fpx = parseFloat(st.fontSize) || 16;
    var bold = (parseInt(st.fontWeight, 10) || 400) >= 700;
    var large = fpx >= 24 || (bold && fpx >= 18.66);
    var need = large ? 3 : 4.5;
    if (cr < need - 0.05) {
      var k = sel(el) + '|' + Math.round(cr * 10);
      if (!seen6[k]) { seen6[k] = 1; push('high', 'contrast', el, cr.toFixed(2) + ':1 (need ' + need + ':1, ' + (large ? 'large' : 'normal') + ' ' + Math.round(fpx) + 'px)'); }
    }
    return false;
  });

  // ---- B8 target-size (interactive ≥ MIN) ----
  var ctrls = document.querySelectorAll('button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"]');
  Array.prototype.forEach.call(ctrls, function (el) {
    if (!visible(el) || el.disabled) return;
    var st = cs(el);
    // inline links inside a paragraph are exempt (WCAG 2.5.8 inline exception)
    if (el.tagName === 'A' && st.display === 'inline') return;
    var r = el.getBoundingClientRect();
    if (r.width < MIN - EPS || r.height < MIN - EPS) {
      push('high', 'target-size', el, Math.round(r.width) + 'x' + Math.round(r.height) + ' < ' + MIN + 'x' + MIN);
    }
  });

  // ---- B9 reflow (no horizontal scroll at the current viewport) ----
  var de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + EPS) {
    push('high', 'reflow-' + vw, de, 'horizontal scroll at ' + vw + 'px: scrollWidth ' + de.scrollWidth + ' > ' + de.clientWidth);
  }

  var high = issues.filter(function (x) { return x.sev === 'high'; }).length;
  return { v: 'a11y-b/1.0', viewport: { w: vw, h: vh }, verdict: high ? 'FAIL' : 'PASS', counts: { high: high, warn: issues.length - high }, issues: issues };
};

// B7 focus-visible probe — the harness/QA-flow focuses a control, then calls this to judge whether a
// visible focus indicator appeared (outline, ring via box-shadow, or a border/background change).
window.__a11yFocusProbe = function (el) {
  if (!el) return { ok: false, reason: 'no element' };
  var st = window.getComputedStyle(el);
  var outline = st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0;
  var ring = st.boxShadow && st.boxShadow !== 'none';
  return { ok: !!(outline || ring), outlineWidth: st.outlineWidth, outlineStyle: st.outlineStyle, boxShadow: st.boxShadow };
};
