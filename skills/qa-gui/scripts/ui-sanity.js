// ui-sanity.js — Gate 0: deterministic UI-sanity sweep (qa-gui) — v2
// ============================================================
// WHAT: catches BASIC UI defects (not taste). v1 rules (A1-A6): clipped text,
//       occluded/cut popups & controls, page overflow, misaligned rows/columns,
//       zero-size interactive elements. v2 adds (A7-A11):
//         A7  broken-image           — img.complete && naturalWidth===0
//         A8  distorted-image        — render ratio vs natural ratio > 15%
//         A9  stacking-error         — open overlay rendered UNDER another element
//         A10 invisible-interactive  — control clickable but opacity:0
//         A11 unintended-text-overflow — text spills beyond its (non-clipping) parent
// HOW TO RUN: paste the whole IIFE below as ONE Dragon `read` step:
//   { read: "<contents of this file>; return __uiSanity('after-open-modal');", as: "ui_sanity" }
// COST: pure JS, no LLM, ~ms. Run at EVERY settled screen-state. verdict: FAIL if any `high`.
// FALSE-POSITIVE POLICY: conservative — intentional patterns (text-overflow:ellipsis,
// line-clamp, sr-only, elements behind an open modal backdrop, object-fit:cover/contain,
// pointer-events:none decoys) are NOT flagged.
// UX rule (R1c, references/ux-rules.md), in the same sweep and the same report:
//   U9 occluded-control-partial — a control with >= 2 of its five points (centre + 20%/80% corners)
//      hit-testing to an unrelated element; closes A3's centre-only blind spot.
// report.ux.rules.U9 is PASS / FAIL / UNGRADED (no control in view). Level and threshold are settings:
//   __uiSanity('label', {ux:{levels:{U9:'block'}, thresholds:{U9:{minCovered:2}}, require:['U9']}})
// `__uxObserve(opts)` (below) returns the observation the Node graders of U1/U2/U3/U8/U10 compare
// (scripts/lib/ux-rules.mjs); it measures only.

window.__uiSanity = function (stateLabel, opts) {
  opts = opts || {};
  var EPS = 2;                       // px tolerance
  var MAX_SCAN = 3000;               // element scan cap (perf)
  var MAX_ISSUES = 24;
  var DISTORT = 0.15;                // A8 threshold (Q1 default 15%)
  var vw = window.innerWidth, vh = window.innerHeight;
  var issues = [];
  var seen = {};

  function sel(el) {
    if (!el || el.nodeType !== 1) return String(el);
    if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
    var s = el.tagName.toLowerCase();
    var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0];
    if (cls) s += '.' + cls;
    var p = el.parentElement;
    if (p) {
      var sibs = Array.prototype.filter.call(p.children, function (c) { return c.tagName === el.tagName; });
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
      if (p.id) s = p.tagName.toLowerCase() + '#' + p.id + ' > ' + s;
      else if (p !== document.body && p.tagName !== 'HTML') s = p.tagName.toLowerCase() + ' > ' + s;
    }
    return s;
  }
  // The cap bounds the list, never the verdict: warnings stop at MAX_ISSUES, a high finding is always kept (up to
  // MAX_ISSUES of them more), so many warnings found first (U9 on a grid of controls) cannot push one out.
  function push(sev, rule, el, detail, id) {
    var key = rule + '|' + sel(el);
    if (seen[key]) return;
    if (sev === 'high' ? issues.length >= MAX_ISSUES * 2 : issues.length >= MAX_ISSUES) return;
    seen[key] = 1;
    var issue = { sev: sev, rule: rule, sel: sel(el), detail: detail, text: (el && el.textContent || '').trim().slice(0, 60) };
    if (id) issue.id = id;
    issues.push(issue);
  }
  function cs(el) { return window.getComputedStyle(el); }
  function visible(el, st) {
    st = st || cs(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  function isSrOnly(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.getAttribute && e.getAttribute('aria-hidden') === 'true') return true;
      var c = (typeof e.className === 'string' ? e.className : '');
      if (/sr-only|visually-hidden|screen-reader/i.test(c)) return true;
      var st = cs(e);
      if (st.clip === 'rect(0px, 0px, 0px, 0px)' || st.clipPath === 'inset(50%)') return true;
    }
    return false;
  }
  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.textContent.trim().length > 1) return true;
    }
    return false;
  }

  var overlaySel = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],[role="menubar"],dialog[open],[data-radix-popper-content-wrapper]';
  var overlays = Array.prototype.filter.call(document.querySelectorAll(overlaySel), function (o) { return visible(o); });
  var topOverlay = overlays.length ? overlays[overlays.length - 1] : null;

  // ---------- 1. OVERLAY CUT ----------
  overlays.forEach(function (o) {
    var r = o.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    var ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    var iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    var visRatio = (ix * iy) / (r.width * r.height);
    if (visRatio < 0.98) {
      push('high', 'overlay-cut-viewport', o, Math.round(visRatio * 100) + '% visible; rect=' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height) + ' viewport=' + vw + 'x' + vh);
    }
    for (var a = o.parentElement; a && a !== document.body; a = a.parentElement) {
      var ast = cs(a);
      if (/(hidden|clip|auto|scroll)/.test(ast.overflow + ast.overflowX + ast.overflowY)) {
        var ar = a.getBoundingClientRect();
        if (r.top < ar.top - EPS || r.bottom > ar.bottom + EPS || r.left < ar.left - EPS || r.right > ar.right + EPS) {
          if (ast.overflow.indexOf('visible') === -1 && (ast.overflowX === 'hidden' || ast.overflowY === 'hidden' || ast.overflow === 'hidden')) {
            push('high', 'overlay-cut-ancestor', o, 'escapes ' + sel(a) + ' which has overflow:hidden');
          }
        }
        break;
      }
    }
  });

  // ---------- A9. STACKING-ERROR (open overlay rendered UNDER another element) ----------
  overlays.forEach(function (o) {
    var r = o.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) return;
    var hit = document.elementFromPoint(cx, cy);
    if (hit && hit !== o && !o.contains(hit) && !hit.contains(o)) {
      push('high', 'stacking-error', o, 'overlay center covered by ' + sel(hit) + ' (rendered underneath / wrong z-order)');
    }
  });

  // ---------- 2. OCCLUSION ----------
  var occRoot = topOverlay || document.body;
  var interactives = occRoot.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[role="menuitem"],[role="option"],[role="tab"]');
  var occChecked = 0;
  Array.prototype.some.call(interactives, function (el) {
    if (occChecked >= 150) return true;
    var st = cs(el);
    if (!visible(el, st) || isSrOnly(el) || el.disabled) return false;
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) return false;
    occChecked++;
    var hit = document.elementFromPoint(cx, cy);
    if (!hit) return false;
    if (el === hit || el.contains(hit) || hit.contains(el)) return false;
    if (hit.tagName === 'LABEL' && (hit.htmlFor === el.id || hit.contains(el))) return false;
    push('high', 'occluded-control', el, 'center hit ' + sel(hit) + ' instead');
    return false;
  });

  // ---------- U9. OCCLUSION AT FIVE POINTS (R1c) ----------
  // Same controls and exclusions as A3, tested at the centre and the 20%/80% corners of the part in view.
  var U9D = { level: 'warn', t: { minCovered: 2 } };   // mirrors UX_RULES.U9 in scripts/lib/ux-rules.mjs
  var uxOpt = opts.ux || {};
  var uxRules = {};
  (function () {
    var cfg = { level: U9D.level, t: { minCovered: U9D.t.minCovered }, bad: false };
    var lv = uxOpt.levels && uxOpt.levels.U9;
    if (lv != null) { if (lv === 'block' || lv === 'warn') cfg.level = lv; else cfg.bad = true; }
    var th = uxOpt.thresholds && uxOpt.thresholds.U9;
    if (th != null) {
      if (typeof th !== 'object') cfg.bad = true;
      else for (var k in th) { if (k !== 'minCovered' || typeof th[k] !== 'number' || !(th[k] >= 1 && th[k] <= 5)) cfg.bad = true; else cfg.t[k] = th[k]; }
    }
    function done(verdict, reason, measured) {
      var r = { id: 'U9', rule: 'occluded-control-partial', verdict: verdict, level: cfg.level, source: 'dom', thresholds: cfg.t };
      if (reason) r.reason = reason;
      if (measured) for (var m in measured) r[m] = measured[m];
      uxRules.U9 = r;
    }
    if (cfg.bad) return done('UNGRADED', 'SETTINGS_INVALID');
    function part(el) {
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
      return (rt - l >= 4 && b - t >= 4) ? { l: l, t: t, r: rt, b: b } : null;
    }
    function within(a, b) { return a.left >= b.left - EPS && a.right <= b.right + EPS && a.top >= b.top - EPS && a.bottom <= b.bottom + EPS; }
    function cover(el, x, y) {
      var hit = document.elementFromPoint(x, y);
      if (!hit || el === hit || el.contains(hit) || hit.contains(el)) return null;
      var lab = hit.closest && hit.closest('label');
      if (lab && ((lab.htmlFor && lab.htmlFor === el.id) || lab.contains(el))) return null;
      // An adornment drawn inside the control's own box by its own wrapper (an icon in a field) is design.
      var p = el.parentElement;
      if (p && p !== document.body && p.contains(hit) && within(hit.getBoundingClientRect(), el.getBoundingClientRect())) return null;
      return hit;
    }
    var fx = [0.5, 0.2, 0.8, 0.2, 0.8], fy = [0.5, 0.2, 0.2, 0.8, 0.8];
    var checked = 0, failed = 0;
    Array.prototype.some.call(interactives, function (el) {
      if (checked >= 150) return true;
      var st = cs(el);
      if (!visible(el, st) || isSrOnly(el) || el.disabled || (el.tagName === 'INPUT' && el.type === 'hidden')) return false;
      var pr = part(el);
      if (!pr) return false;
      checked++;
      var n = 0, by = null;
      for (var i = 0; i < 5; i++) {
        var c = cover(el, pr.l + (pr.r - pr.l) * fx[i], pr.t + (pr.b - pr.t) * fy[i]);
        if (c) { n++; by = by || c; }
      }
      if (n >= cfg.t.minCovered) {
        failed++;
        push(cfg.level === 'block' ? 'high' : 'warn', 'occluded-control-partial', el, n + '/5 points covered by ' + sel(by), 'U9');
      }
      return false;
    });
    if (!checked) return done('UNGRADED', 'NO_CONTROLS_IN_VIEW');
    done(failed ? 'FAIL' : 'PASS', null, { checked: checked, failed: failed });
  })();

  // ---------- A10. INVISIBLE-INTERACTIVE (clickable but opacity:0) ----------
  var a10 = document.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[role="menuitem"],[role="tab"]');
  var a10n = 0;
  Array.prototype.some.call(a10, function (el) {
    if (a10n >= 200) return true;
    var st = cs(el);
    if (isSrOnly(el) || el.disabled) return false;
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    a10n++;
    // opacity:0 yet still in layout and hit-testable ⇒ an invisible click target
    if (parseFloat(st.opacity) === 0 && st.pointerEvents !== 'none') {
      push('high', 'invisible-interactive', el, 'opacity:0 but still clickable (' + Math.round(r.width) + 'x' + Math.round(r.height) + ')');
    }
    return false;
  });

  // ---------- A7/A8. IMAGES (broken / distorted) ----------
  var imgn = 0;
  Array.prototype.some.call(document.querySelectorAll('img'), function (img) {
    if (imgn >= 300) return true;
    imgn++;
    var st = cs(img);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    var src = img.getAttribute('src') || img.currentSrc || '';
    // A7 broken: finished loading but no pixels
    if (img.complete && img.naturalWidth === 0 && src) {
      push('high', 'broken-image', img, 'complete but naturalWidth=0 (failed to load): ' + src.slice(0, 60));
      return false;
    }
    // A8 distorted: only when object-fit stretches (fill / default), ratio off > threshold
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      var r = img.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) {
        var objf = st.objectFit || 'fill';
        if (objf === 'fill') {
          var natR = img.naturalWidth / img.naturalHeight;
          var renR = r.width / r.height;
          var dev = Math.abs(renR - natR) / natR;
          if (dev > DISTORT) {
            push('high', 'distorted-image', img, 'render ratio ' + renR.toFixed(2) + ' vs natural ' + natR.toFixed(2) + ' (' + Math.round(dev * 100) + '% off)');
          }
        }
      }
    }
    return false;
  });

  // ---------- 3..5 + A11 single scan: clip / overflow / zero-size / align / text-spill ----
  var all = document.querySelectorAll('body *');
  var offenders = [];
  var n = Math.min(all.length, MAX_SCAN);
  var groups = {};
  for (var i = 0; i < n; i++) {
    var el = all[i];
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    var st = cs(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      if (/^(BUTTON|A|INPUT|SELECT)$/.test(el.tagName) && !isSrOnly(el) && st.position !== 'absolute' && el.offsetParent !== null) {
        push('warn', 'zero-size-interactive', el, 'rendered 0x0');
      }
      continue;
    }

    if (hasDirectText(el)) {
      var ellipsis = st.textOverflow === 'ellipsis' || st.webkitLineClamp && st.webkitLineClamp !== 'none';
      var hidX = (st.overflowX === 'hidden' || st.overflowX === 'clip');
      var hidY = (st.overflowY === 'hidden' || st.overflowY === 'clip');
      if (hidX && !ellipsis && el.scrollWidth > el.clientWidth + EPS && el.clientWidth > 8) {
        push('high', 'text-clipped-x', el, el.scrollWidth + 'px content in ' + el.clientWidth + 'px box');
      }
      if (hidY && !ellipsis && el.scrollHeight > el.clientHeight + Math.max(EPS, 4) && el.clientHeight > 8) {
        var lh = parseFloat(st.lineHeight) || parseFloat(st.fontSize) * 1.3 || 16;
        if (el.scrollHeight - el.clientHeight > lh * 0.45) {
          push('high', 'text-clipped-y', el, el.scrollHeight + 'px content in ' + el.clientHeight + 'px box (lineHeight ' + Math.round(lh) + ')');
        }
      }
      // A11 unintended-text-overflow: text box spills beyond a NON-clipping parent
      var par = el.parentElement;
      if (par && par !== document.body && par.tagName !== 'HTML' && st.position !== 'absolute' && st.position !== 'fixed') {
        var pst = cs(par);
        var pClips = /(hidden|clip|auto|scroll)/.test(pst.overflow + pst.overflowX + pst.overflowY);
        var pr = par.getBoundingClientRect();
        if (!pClips && !ellipsis && el.clientWidth > 8 && (r.right > pr.right + EPS + 1 || r.left < pr.left - EPS - 1)) {
          push('high', 'unintended-text-overflow', el, 'text box escapes parent ' + sel(par) + ' (el right ' + Math.round(r.right) + ' vs parent right ' + Math.round(pr.right) + ')');
        }
      }
    }

    if (r.right > document.documentElement.clientWidth + EPS && r.width > 20 && r.width < vw * 1.5 && offenders.length < 5) {
      offenders.push(sel(el));
    }

    var p = el.parentElement;
    if (p && r.width > 4 && r.height > 4 && st.position !== 'absolute' && st.position !== 'fixed') {
      var fc = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0] || '';
      var gk = (p.__usid || (p.__usid = 'g' + i)) + '|' + el.tagName + '|' + fc;
      (groups[gk] || (groups[gk] = { parent: p, items: [] })).items.push({ el: el, r: r });
    }
  }

  var de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + EPS) {
    push('high', 'page-overflow-x', de, 'scrollWidth ' + de.scrollWidth + ' > clientWidth ' + de.clientWidth + (offenders.length ? '; offenders: ' + offenders.join(', ') : ''));
  }

  Object.keys(groups).forEach(function (k) {
    var g = groups[k].items;
    if (g.length < 3) return;
    var avgH = g.reduce(function (s, x) { return s + x.r.height; }, 0) / g.length;
    var avgW = g.reduce(function (s, x) { return s + x.r.width; }, 0) / g.length;
    var tops = g.map(function (x) { return x.r.top; });
    var lefts = g.map(function (x) { return x.r.left; });
    var topSpread = Math.max.apply(null, tops) - Math.min.apply(null, tops);
    var leftSpread = Math.max.apply(null, lefts) - Math.min.apply(null, lefts);
    var horizontal = topSpread < avgH && leftSpread > avgW * 0.5;
    var vertical = leftSpread < avgW && topSpread > avgH * 0.5;
    if (horizontal && topSpread > EPS + 1 && topSpread < avgH * 0.6) {
      var worst = g.reduce(function (a, b) { return Math.abs(b.r.top - tops[0]) > Math.abs(a.r.top - tops[0]) ? b : a; });
      push('warn', 'misaligned-row', worst.el, 'tops differ ' + Math.round(topSpread) + 'px across ' + g.length + ' siblings in ' + sel(groups[k].parent));
    }
    if (vertical && leftSpread > EPS + 1 && leftSpread < avgW * 0.6) {
      var worstL = g.reduce(function (a, b) { return Math.abs(b.r.left - lefts[0]) > Math.abs(a.r.left - lefts[0]) ? b : a; });
      push('warn', 'misaligned-column', worstL.el, 'lefts differ ' + Math.round(leftSpread) + 'px across ' + g.length + ' siblings in ' + sel(groups[k].parent));
    }
  });

  var high = issues.filter(function (x) { return x.sev === 'high'; }).length;
  var blockFail = Object.keys(uxRules).some(function (id) { return uxRules[id].verdict === 'FAIL' && uxRules[id].level === 'block'; });
  var required = (uxOpt.require || []).some(function (id) { return uxRules[id] && uxRules[id].verdict === 'UNGRADED'; });
  return {
    v: 'ui-sanity/2.0',
    state: stateLabel || 'unlabeled',
    viewport: { w: vw, h: vh },
    scanned: n,
    verdict: (high || blockFail) ? 'FAIL' : (required ? 'UNGRADED' : 'PASS'),
    counts: { high: high, warn: issues.length - high },
    issues: issues,
    ux: { v: 'ux-rules/1', rules: uxRules }
  };
};

// __uxObserve(opts) — one UX observation of the current state (R1c). Measures only; it never acts.
// The executor reads it around an action in the same `do` chain:
//   before the action, while a forced request is still pending (`during`), and after the result,
//   { read: "<contents of this file>; return __uxObserve({trigger:'#save'});", as: "ux_before" }
// and grades the observations with scripts/lib/ux-rules.mjs (gradeU1 / gradeU2 / gradeU3 / U8 context).
// Typed values never leave the page: a field is reported by key, type, filled, length and an 8-hex FNV-1a hash.
// opts.trigger (+ opts.nth): CSS selector of the control the action used (U2 reads its state).
window.__uxObserve = function (opts) {
  opts = opts || {};
  var vw = window.innerWidth, vh = window.innerHeight;
  function cs(el) { return window.getComputedStyle(el); }
  function sel(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
    var s = el.tagName.toLowerCase();
    var c = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0];
    return c ? s + '.' + c : s;
  }
  function shown(el, st) {
    st = st || cs(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function mix(h, s) { for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; }
  function hex(h) { return ('0000000' + (h >>> 0).toString(16)).slice(-8); }
  function fnv(s) { return hex(mix(0x811c9dc5, String(s))); }
  function textOf(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function directText(el) {
    var out = '';
    for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) out += el.childNodes[i].textContent;
    return out.replace(/\s+/g, ' ').trim();
  }
  function tokens(el) {
    var c = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    return (c + ' ' + (el.id || '')).trim().split(/\s+/).filter(Boolean);
  }
  function anyToken(el, re) { var t = tokens(el); for (var i = 0; i < t.length; i++) if (re.test(t[i])) return true; return false; }
  function list(selector, cap) {
    var out = [], nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length && out.length < (cap || 8); i++) if (shown(nodes[i])) out.push(nodes[i]);
    return out;
  }

  // Visible-content digest: what a user can see change. Document-wide and viewport-only.
  var STATE_ATTRS = ['disabled', 'aria-busy', 'aria-disabled', 'aria-expanded', 'aria-invalid', 'aria-pressed', 'aria-selected', 'aria-checked', 'hidden', 'open', 'src', 'role', 'style'];
  var hDoc = 0x811c9dc5, hView = 0x811c9dc5, counted = 0;
  var els = document.body ? document.body.getElementsByTagName('*') : [];
  for (var i = 0; i < els.length && i < 6000; i++) {
    var el = els[i];
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    var st = cs(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    counted++;
    var part = el.tagName + '|' + (typeof el.className === 'string' ? el.className : '') + '|' + directText(el) + '|' + (parseFloat(st.opacity) < 0.05 ? 'o0' : '');
    for (var a = 0; a < STATE_ATTRS.length; a++) { var v = el.getAttribute(STATE_ATTRS[a]); if (v != null) part += '|' + STATE_ATTRS[a] + '=' + v; }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      if (/^password$/i.test(el.type || '')) part += '|pw';
      else if (/^(checkbox|radio)$/i.test(el.type || '')) part += '|' + (el.checked ? 'on' : 'off');
      else part += '|v=' + fnv(el.value || '');
      part += el.disabled ? '|dis' : '';
    }
    hDoc = mix(hDoc, part + '\n');
    var r = el.getBoundingClientRect();
    if (r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh) hView = mix(hView, part + '\n');
  }

  // Form fields: never the value itself. Passwords, files and hidden inputs are left out.
  var SKIP = /^(hidden|submit|button|reset|image|password|file)$/i;
  function collect(controls) {
    var out = [];
    Array.prototype.forEach.call(controls, function (c, ci) {
      if (!/^(INPUT|SELECT|TEXTAREA)$/.test(c.tagName)) return;
      var type = String(c.type || c.tagName).toLowerCase();
      if (SKIP.test(type)) return;
      var key = c.id || c.getAttribute('name') || (c.tagName.toLowerCase() + ci);
      if (type === 'checkbox' || type === 'radio') {
        if (type === 'radio' && !c.id) key = (c.getAttribute('name') || 'radio') + ':' + c.value;
        out.push({ key: key, sel: sel(c), type: type, filled: !!c.checked, len: c.checked ? 1 : 0, hash: c.checked ? 'on' : 'off' });
      } else {
        var val = String(c.value || '');
        out.push({ key: key, sel: sel(c), type: type, filled: val.length > 0, len: val.length, hash: val.length ? fnv(val) : '' });
      }
    });
    return out;
  }
  var forms = [];
  Array.prototype.forEach.call(document.forms, function (f, fi) {
    forms.push({ key: f.id || f.getAttribute('name') || ('form' + fi), sel: sel(f), fields: collect(f.elements) });
  });
  var loose = Array.prototype.filter.call(document.querySelectorAll('input,select,textarea'), function (c) { return !c.form; });
  if (loose.length) forms.push({ key: '(no form)', sel: 'document', fields: collect(loose) });

  // Busy signals: in a given subtree (U2) and on the whole page (U1 context).
  var SPIN = /(^|[-_])(spin|spinner|loader|loading|busy|progress)([-_]|$)/i;
  var BUSY = '[role="progressbar"],progress,[aria-busy="true"]';
  function busyIn(root) {
    var nodes = root.querySelectorAll(BUSY + ',[class]');
    for (var n = 0; n < nodes.length && n < 2000; n++) {
      var e = nodes[n];
      if ((e.matches(BUSY) || anyToken(e, SPIN)) && shown(e)) return true;
    }
    if (document.getAnimations) {
      var an = document.getAnimations();
      for (var k = 0; k < an.length; k++) {
        var tgt = an[k].effect && an[k].effect.target, timing = an[k].effect && an[k].effect.getTiming && an[k].effect.getTiming();
        if (tgt && tgt.nodeType === 1 && root.contains(tgt) && an[k].playState === 'running' && timing && timing.iterations === Infinity) return true;
      }
    }
    return false;
  }
  var busy = {
    ariaBusy: list('[aria-busy="true"]').map(sel),
    progress: list('[role="progressbar"],progress').map(sel),
    spinners: list('[class]', 400).filter(function (e) { return anyToken(e, SPIN); }).slice(0, 8).map(sel)
  };

  var trigger = null;
  if (opts.trigger) {
    var te = document.querySelectorAll(opts.trigger)[opts.nth || 0];
    if (!te) trigger = { sel: opts.trigger, found: false };
    else {
      var tst = cs(te), tr = te.getBoundingClientRect();
      var cx = tr.left + tr.width / 2, cy = tr.top + tr.height / 2;
      var hit = (cx >= 0 && cy >= 0 && cx <= vw && cy <= vh) ? document.elementFromPoint(cx, cy) : null;
      var form = te.form || (te.closest && te.closest('form'));
      trigger = {
        sel: sel(te), found: true, text: (textOf(te) || String(te.value || '')).slice(0, 60),
        disabled: !!te.disabled || !!(te.matches && te.matches(':disabled')),
        ariaDisabled: (te.getAttribute('aria-disabled') || '') === 'true',
        inert: !!(te.closest && te.closest('[inert]')),
        pointerEventsNone: tst.pointerEvents === 'none',
        covered: !!(hit && hit !== te && !te.contains(hit) && !hit.contains(te)),
        coveredBy: hit && hit !== te && !te.contains(hit) && !hit.contains(te) ? sel(hit) : null,
        visible: shown(te, tst),
        ariaBusy: !!(te.closest && te.closest('[aria-busy="true"]')),
        spinner: busyIn(te),
        formBusy: !!form && ((form.getAttribute('aria-busy') || '') === 'true' || busyIn(form))
      };
    }
  }

  // U10 pre-screen: visible text with Vietnamese marks (letters with a mark above the cap height or a dot below),
  // its glyph ink measured with canvas metrics against the box that clips it. The verdict stays with vision; this
  // says where to look and what the machine measured. Inline boxes are listed but not measured.
  var VI = /[\u00c0-\u00c3\u00c8-\u00ca\u00cc\u00cd\u00d2-\u00d5\u00d9\u00da\u00dd\u0102\u0110\u0128\u0168\u01a0\u01af\u1ea0-\u1ef9]/;
  var tol = typeof opts.inkTolerancePx === 'number' ? opts.inkTolerancePx : 1;
  var diacritics = [];
  var ctx = null;
  try { ctx = document.createElement('canvas').getContext('2d'); } catch (e) { ctx = null; }
  for (var d = 0; d < els.length && d < 6000 && diacritics.length < 24; d++) {
    var de = els[d];
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|INPUT|SELECT|OPTION)$/.test(de.tagName)) continue;
    var dt = directText(de);
    if (!dt || !VI.test(dt)) continue;
    var dst = cs(de);
    if (!shown(de, dst)) continue;
    var dr = de.getBoundingClientRect();
    var cand = { sel: sel(de), text: dt.slice(0, 40), rect: { x: Math.round(dr.left), y: Math.round(dr.top), w: Math.round(dr.width), h: Math.round(dr.height) },
      fontPx: parseFloat(dst.fontSize) || null, lineHeightPx: null, clipBy: null, overflowTopPx: null, overflowBottomPx: null, clipped: null };
    if (dst.display !== 'inline' && ctx) {
      ctx.font = dst.fontStyle + ' ' + dst.fontWeight + ' ' + dst.fontSize + ' ' + dst.fontFamily;
      var m = ctx.measureText(dt.slice(0, 200));
      var fA = m.fontBoundingBoxAscent, fD = m.fontBoundingBoxDescent;
      var lineH = dst.lineHeight === 'normal' ? fA + fD : parseFloat(dst.lineHeight);
      var padT = parseFloat(dst.paddingTop) || 0, padB = parseFloat(dst.paddingBottom) || 0;
      var contentTop = dr.top + (parseFloat(dst.borderTopWidth) || 0) + padT;
      var lines = Math.max(1, Math.round((de.scrollHeight - padT - padB) / lineH));
      var baseFirst = contentTop + (lineH - (fA + fD)) / 2 + fA;
      var inkTop = baseFirst - m.actualBoundingBoxAscent, inkBottom = baseFirst + (lines - 1) * lineH + m.actualBoundingBoxDescent;
      // The clip box: this element's padding box when it clips, then every clipping ancestor's.
      var top = -Infinity, bottom = Infinity, by = null;
      for (var ce = de; ce && ce !== document.body && ce !== document.documentElement; ce = ce.parentElement) {
        var cst = ce === de ? dst : cs(ce);
        if (cst.overflowX !== 'visible' || cst.overflowY !== 'visible') {
          var cr = ce.getBoundingClientRect();
          var ct = cr.top + (parseFloat(cst.borderTopWidth) || 0), cb = cr.bottom - (parseFloat(cst.borderBottomWidth) || 0);
          if (ct > top) { top = ct; by = by || (ce === de ? 'self' : 'ancestor'); }
          if (cb < bottom) { bottom = cb; by = by || (ce === de ? 'self' : 'ancestor'); }
        }
        if (cst.position === 'fixed') break;
      }
      cand.lineHeightPx = Math.round(lineH * 10) / 10;
      if (by) {
        cand.clipBy = by;
        cand.overflowTopPx = Math.round((top - inkTop) * 10) / 10;
        cand.overflowBottomPx = Math.round((inkBottom - bottom) * 10) / 10;
        cand.clipped = cand.overflowTopPx > tol || cand.overflowBottomPx > tol;
      } else cand.clipped = false;
    }
    diacritics.push(cand);
  }

  var UNDO = /^(undo|restore|recover|ho\u00e0n t\u00e1c|kh\u00f4i ph\u1ee5c)\b/i;
  var ae = document.activeElement;
  return {
    v: 'ux-observe/1', t: Date.now(),
    url: window.location.origin + window.location.pathname + window.location.hash,
    viewport: { w: vw, h: vh },
    digest: { doc: hex(hDoc), view: hex(hView), elements: counted },
    forms: forms,
    trigger: trigger,
    busy: busy,
    dialogs: list('[role="dialog"],[role="alertdialog"],dialog[open]').map(sel),
    live: list('[role="status"],[role="alert"],[role="log"],[aria-live="polite"],[aria-live="assertive"],output', 12)
      .map(function (e) { return { sel: sel(e), text: textOf(e).slice(0, 80) }; })
      .filter(function (x) { return x.text.length > 0; }),
    undo: list('button,a[href],[role="button"]', 400)
      .filter(function (e) { var tx = textOf(e); return tx.length <= 30 && UNDO.test(tx); })
      .slice(0, 4).map(function (e) { return { sel: sel(e), text: textOf(e) }; }),
    focus: ae && ae !== document.body && ae !== document.documentElement ? sel(ae) : null,
    diacritics: diacritics
  };
};
