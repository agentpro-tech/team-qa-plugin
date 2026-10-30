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

window.__uiSanity = function (stateLabel) {
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
  function push(sev, rule, el, detail) {
    var key = rule + '|' + sel(el);
    if (seen[key] || issues.length >= MAX_ISSUES) return;
    seen[key] = 1;
    issues.push({ sev: sev, rule: rule, sel: sel(el), detail: detail, text: (el && el.textContent || '').trim().slice(0, 60) });
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
  return {
    v: 'ui-sanity/2.0',
    state: stateLabel || 'unlabeled',
    viewport: { w: vw, h: vh },
    scanned: n,
    verdict: high ? 'FAIL' : 'PASS',
    counts: { high: high, warn: issues.length - high },
    issues: issues
  };
};
