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
// UX rules (R1c, references/ux-rules.md), in the same sweep and the same report:
//   U4 error-not-tied-to-field — a field error message not referenced by the field, or far from it  (WCAG 3.3.1)
//   U5 status-not-announced    — a visible toast/status message outside every live region          (WCAG 4.1.3)
//   U6 focus-obscured          — all five points of the focused element are painted over            (WCAG 2.4.11)
// Each returns PASS / FAIL / UNGRADED in report.ux.rules (UNGRADED when its condition is absent: no field in
// error, no status message, nothing focused). Level and thresholds are settings:
//   __a11yB({minTarget:24, ux:{levels:{U6:'warn'}, thresholds:{U4:{maxGapPx:120}}, require:['U5']}})
// A block-level FAIL fails the sweep; a warn-level FAIL is listed only; a rule listed in `require` that is
// UNGRADED makes the sweep UNGRADED instead of PASS.

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
  function push(sev, rule, el, detail, id) {
    var issue = { sev: sev, rule: rule, sel: sel(el), detail: detail, text: (el && el.textContent || '').trim().slice(0, 50) };
    if (id) issue.id = id;
    issues.push(issue);
  }
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

  // ---- UX rules U4 / U5 / U6 (R1c) ----
  // Defaults mirror UX_RULES in scripts/lib/ux-rules.mjs (a test keeps them equal).
  var UXD = { U4: { level: 'warn', t: { adjacentPx: 24, maxGapPx: 120 } }, U5: { level: 'warn', t: {} }, U6: { level: 'block', t: { coveredPoints: 5 } } };
  var UXN = { U4: 'error-not-tied-to-field', U5: 'status-not-announced', U6: 'focus-obscured' };
  var uxOpt = opts.ux || {};
  var uxRules = {};
  function uxCfg(id) {
    var d = UXD[id], out = { level: d.level, t: {}, bad: false }, k;
    for (k in d.t) out.t[k] = d.t[k];
    var lv = uxOpt.levels && uxOpt.levels[id];
    if (lv != null) { if (lv === 'block' || lv === 'warn') out.level = lv; else out.bad = true; }
    var th = uxOpt.thresholds && uxOpt.thresholds[id];
    if (th != null) {
      if (typeof th !== 'object') out.bad = true;
      else for (k in th) {
        if (!Object.prototype.hasOwnProperty.call(d.t, k) || typeof th[k] !== typeof d.t[k] || (typeof th[k] === 'number' && !(th[k] >= 0))
          || (k === 'coveredPoints' && !(th[k] >= 1 && th[k] <= 5))) out.bad = true;
        else out.t[k] = th[k];
      }
    }
    return out;
  }
  function uxDone(id, cfg, verdict, reason, measured) {
    var r = { id: id, rule: UXN[id], verdict: verdict, level: cfg.level, source: 'dom', thresholds: cfg.t };
    if (reason) r.reason = reason;
    if (measured) for (var k in measured) r[k] = measured[k];
    uxRules[id] = r;
    return r;
  }
  function uxFail(id, cfg, el, detail) { push(cfg.level === 'block' ? 'high' : 'warn', UXN[id], el, detail, id); }
  function textOf(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function tokens(el) {
    var c = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    return (c + ' ' + (el.id || '')).trim().split(/\s+/).filter(Boolean);
  }
  function anyToken(el, re) { var t = tokens(el); for (var i = 0; i < t.length; i++) if (re.test(t[i])) return true; return false; }
  function innermost(list) { return list.filter(function (c) { return !list.some(function (o) { return o !== c && c.contains(o); }); }); }
  function gapPx(a, b) {
    var A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
    var dx = Math.max(0, B.left - A.right, A.left - B.right), dy = Math.max(0, B.top - A.bottom, A.top - B.bottom);
    return Math.round(Math.sqrt(dx * dx + dy * dy));
  }
  // The part of el inside the viewport and inside every clipping ancestor (null when under 2x2 px).
  function visiblePart(el) {
    var r = el.getBoundingClientRect();
    var l = Math.max(r.left, 0), t = Math.max(r.top, 0), rt = Math.min(r.right, vw), b = Math.min(r.bottom, vh);
    var fixed = cs(el).position === 'fixed';
    for (var a = el.parentElement; a && !fixed && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      var st = cs(a);
      if (st.overflowX !== 'visible' || st.overflowY !== 'visible') {
        var ar = a.getBoundingClientRect();
        l = Math.max(l, ar.left); t = Math.max(t, ar.top); rt = Math.min(rt, ar.right); b = Math.min(b, ar.bottom);
      }
      if (st.position === 'fixed') fixed = true;
    }
    return (rt - l >= 2 && b - t >= 2) ? { l: l, t: t, r: rt, b: b } : null;
  }
  // Centre, then the 20%/80% corners: the same five points as Dragon paintSnapshot.
  function fivePoints(p) {
    var w = p.r - p.l, h = p.b - p.t, fx = [0.5, 0.2, 0.8, 0.2, 0.8], fy = [0.5, 0.2, 0.2, 0.8, 0.8], out = [];
    for (var i = 0; i < 5; i++) out.push({ x: p.l + w * fx[i], y: p.t + h * fy[i] });
    return out;
  }
  var REPLACED = /^(img|video|canvas|iframe|embed|object|svg|picture)$/i;
  function opacityChain(e) { var o = 1; for (; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(cs(e).opacity); return o; }
  function paintsBox(e) {
    var st = cs(e);
    if (st.visibility !== 'visible' || opacityChain(e) <= 0.01) return false;
    var bg = toRGB(st.backgroundColor);
    if (bg && bg.a > 0.05) return true;
    if (st.backgroundImage && st.backgroundImage !== 'none') return true;
    return REPLACED.test(e.tagName);
  }
  function relatedTo(el, h) {
    if (h === el || el.contains(h) || h.contains(el)) return true;
    var lab = h.closest && h.closest('label');
    return !!(lab && ((lab.htmlFor && lab.htmlFor === el.id) || lab.contains(el)));
  }
  // The topmost element that paints something at (x, y) above el, or null when el is the first one reached.
  function paintCover(el, x, y) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      if (relatedTo(el, stack[i])) return null;
      if (paintsBox(stack[i])) return stack[i];
    }
    return null;
  }

  // U6 focus not fully obscured
  (function () {
    var cfg = uxCfg('U6');
    if (cfg.bad) return uxDone('U6', cfg, 'UNGRADED', 'SETTINGS_INVALID');
    var ae = document.activeElement;
    if (!ae || ae === document.body || ae === document.documentElement) return uxDone('U6', cfg, 'UNGRADED', 'NO_FOCUS');
    if (/^(iframe|frame)$/i.test(ae.tagName)) return uxDone('U6', cfg, 'UNGRADED', 'FOCUS_IN_FRAME');
    if (!visible(ae)) return uxDone('U6', cfg, 'UNGRADED', 'FOCUS_NOT_VISIBLE');
    var part = visiblePart(ae);
    if (!part) return uxDone('U6', cfg, 'UNGRADED', 'FOCUS_NOT_IN_VIEW');
    var pts = fivePoints(part), n = 0, by = null;
    for (var i = 0; i < pts.length; i++) { var c = paintCover(ae, pts[i].x, pts[i].y); if (c) { n++; by = by || c; } }
    var measured = { target: sel(ae), coveredPoints: n, points: pts.length };
    if (n >= cfg.t.coveredPoints) {
      uxFail('U6', cfg, ae, 'focused element hidden: ' + n + '/' + pts.length + ' points covered by ' + sel(by));
      return uxDone('U6', cfg, 'FAIL', null, measured);
    }
    return uxDone('U6', cfg, 'PASS', null, measured);
  })();

  // U5 status message readable: a visible toast/status message must sit in a live region (or have focus).
  (function () {
    var cfg = uxCfg('U5');
    if (cfg.bad) return uxDone('U5', cfg, 'UNGRADED', 'SETTINGS_INVALID');
    var LIVE = '[role="status"],[role="alert"],[role="log"],[role="marquee"],[role="timer"],[aria-live],output';
    var TOAST = /(^|[-_])(toast|snackbar)([-_]|$)/i;
    var NOTE = /^(alert|notification|notice|flash|message|msg)([-_](success|error|danger|info|warning|ok|done|saved))?$/i;
    var CONTROL = /^(button|a|input|select|textarea)$/i;
    var cands = [];
    var nodes = document.querySelectorAll('body *');
    for (var i = 0; i < nodes.length && i < 4000; i++) {
      var el = nodes[i];
      if (CONTROL.test(el.tagName)) continue;
      var floating = /^(fixed|absolute|sticky)$/.test(cs(el).position);
      var like = el.matches(LIVE) || anyToken(el, TOAST) || el.hasAttribute('data-sonner-toast') || el.hasAttribute('data-toast')
        || (floating && anyToken(el, NOTE));
      if (!like || !visible(el)) continue;
      var tx = textOf(el);
      if (tx.length < 2 || tx.length > 300) continue;
      cands.push(el);
    }
    cands = innermost(cands);
    if (!cands.length) return uxDone('U5', cfg, 'UNGRADED', 'NO_STATUS_MESSAGE');
    var failed = 0;
    cands.forEach(function (c) {
      var why = null, e;
      for (e = c; e && e.nodeType === 1; e = e.parentElement) if (e.getAttribute('aria-hidden') === 'true') { why = 'inside aria-hidden ' + sel(e); break; }
      if (!why && !(document.activeElement && c.contains(document.activeElement))) {
        why = 'no role=status/alert/log and no aria-live on the message or an ancestor';
        for (e = c; e && e.nodeType === 1; e = e.parentElement) {
          var live = (e.getAttribute('aria-live') || '').toLowerCase();
          if (live === 'off') { why = 'aria-live="off" on ' + sel(e); break; }
          if (live === 'polite' || live === 'assertive' || /^(status|alert|log|marquee|timer)$/i.test(e.getAttribute('role') || '') || e.tagName === 'OUTPUT') { why = null; break; }
        }
      }
      if (why) { failed++; uxFail('U5', cfg, c, why); }
    });
    return uxDone('U5', cfg, failed ? 'FAIL' : 'PASS', null, { checked: cands.length, failed: failed });
  })();

  // U4 error tied to its field: referenced by aria-describedby / aria-errormessage (or inside its label), and near it.
  (function () {
    var cfg = uxCfg('U4');
    if (cfg.bad) return uxDone('U4', cfg, 'UNGRADED', 'SETTINGS_INVALID');
    var FIELD = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),select,textarea,[role="textbox"],[role="combobox"],[role="spinbutton"],[contenteditable="true"]';
    var ERR = /(^|[-_])(error|errors|invalid|danger)([-_]|$)/i;
    var all = Array.prototype.slice.call(document.querySelectorAll(FIELD));
    var fields = all.filter(function (f) { return visible(f); });
    var msgs = [];
    var nodes = document.querySelectorAll('body *');
    for (var i = 0; i < nodes.length && i < 4000; i++) {
      var el = nodes[i];
      if (el.matches(FIELD) || /^(button|a|label|form|fieldset)$/i.test(el.tagName) || el.querySelector(FIELD)) continue;
      if (!(anyToken(el, ERR) || (el.getAttribute('role') || '').toLowerCase() === 'alert')) continue;
      if (!visible(el)) continue;
      var tx = textOf(el);
      if (tx.length >= 2 && tx.length <= 200) msgs.push(el);
    }
    msgs = innermost(msgs);
    function inError(f) {
      if ((f.getAttribute('aria-invalid') || '').toLowerCase() === 'true' || anyToken(f, ERR)) return true;
      var p = f.parentElement;
      return !!(p && p !== document.body && anyToken(p, ERR) && p.querySelectorAll(FIELD).length === 1);
    }
    function refs(f) {
      var ids = [], out = [];
      for (var e = f; e && e.nodeType === 1; e = e.parentElement) {
        if (e === f || /^fieldset$/i.test(e.tagName) || /^(group|radiogroup)$/i.test(e.getAttribute('role') || '')) {
          ids = ids.concat(((e.getAttribute('aria-describedby') || '') + ' ' + (e.getAttribute('aria-errormessage') || '')).trim().split(/\s+/));
        }
      }
      ids.forEach(function (id) { var r = id && document.getElementById(id); if (r) out.push(r); });
      if (f.labels) for (var j = 0; j < f.labels.length; j++) out.push(f.labels[j]);
      return out;
    }
    function linked(f, m) { return refs(f).some(function (r) { return r === m || r.contains(m) || m.contains(r); }); }
    function nearest(list, el, gate) {
      var best = null;
      list.forEach(function (x) { if (gate && !gate(x)) return; var g = gapPx(x, el); if (!best || g < best.gap) best = { el: x, gap: g }; });
      return best;
    }
    var pairs = [];
    function paired(key, v) { return pairs.some(function (p) { return p[key] === v; }); }
    all.forEach(function (f) { msgs.forEach(function (m) { if (linked(f, m)) pairs.push({ f: f, m: m, linked: true }); }); });
    msgs.forEach(function (m) {
      if (paired('m', m)) return;
      var mr = m.getBoundingClientRect();
      var best = nearest(fields, m, function (f) { return mr.top >= f.getBoundingClientRect().top - EPS; });
      if (best && best.gap <= cfg.t.adjacentPx) pairs.push({ f: best.el, m: m, linked: false });
    });
    var orphans = 0;
    fields.filter(inError).forEach(function (f) {
      if (paired('f', f)) return;
      var best = nearest(msgs, f);
      if (best) pairs.push({ f: f, m: best.el, linked: false }); else orphans++;
    });
    if (!pairs.length) return uxDone('U4', cfg, 'UNGRADED', orphans ? 'NO_ERROR_MESSAGE' : 'NO_FIELD_ERROR');
    var failed = 0;
    pairs.forEach(function (p) {
      var g = gapPx(p.f, p.m), why = null;
      if (!p.linked) why = 'error "' + textOf(p.m).slice(0, 60) + '" (' + sel(p.m) + ', ' + g + 'px away) is not referenced by aria-describedby/aria-errormessage of the field';
      else if (g > cfg.t.maxGapPx) why = 'error "' + textOf(p.m).slice(0, 60) + '" (' + sel(p.m) + ') is ' + g + 'px far from the field (max ' + cfg.t.maxGapPx + 'px)';
      if (why) { failed++; uxFail('U4', cfg, p.f, why); }
    });
    return uxDone('U4', cfg, failed ? 'FAIL' : 'PASS', null, { checked: pairs.length, failed: failed });
  })();

  var required = (uxOpt.require || []).some(function (id) { return uxRules[id] && uxRules[id].verdict === 'UNGRADED'; });
  var blockFail = Object.keys(uxRules).some(function (id) { return uxRules[id].verdict === 'FAIL' && uxRules[id].level === 'block'; });
  var high = issues.filter(function (x) { return x.sev === 'high'; }).length;
  return {
    v: 'a11y-b/1.0', viewport: { w: vw, h: vh },
    verdict: (high || blockFail) ? 'FAIL' : (required ? 'UNGRADED' : 'PASS'),
    counts: { high: high, warn: issues.length - high }, issues: issues,
    ux: { v: 'ux-rules/1', rules: uxRules }
  };
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
