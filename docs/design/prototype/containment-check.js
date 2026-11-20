/*
  Kelvin Agent Crew — layout containment check (REVIEW TOOL, not product UI).

  Reports, for the window it runs in:
    1. whether the page scrolls sideways;
    2. elements that extend past the right edge of the window;
    3. elements whose content is wider than their own box (spilling out of it, or silently clipped).
  Anything inside a deliberate local scroller (overflow-x: auto | scroll, such as the year grid or a wide table) is expected to
  be wider, so it is listed separately instead of flagged. Text that ends in an ellipsis on purpose is ignored.

  It measures; it does not resize anything. Resize the window to 390px or 320px wide first, then run it on each screen and in
  each scenario. It was written for the D4 repair pass and has NOT been executed by its author (no browser was available);
  treat its first run as a test of the tool as well as of the layout.
*/
(function () {
  'use strict';

  var SKIP = '.proto, .sr-only, .skip-link, #toast-root, #live, #drawer-root .scrim';

  function label(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += '.' + cls.join('.');
    var txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 28);
    return s + (txt ? ' "' + txt + '"' : '');
  }

  function nearestLocalScroller(el, stop) {
    for (var p = el.parentElement; p && p !== stop; p = p.parentElement) {
      var ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return p;
    }
    return null;
  }

  function list(items, max) {
    var out = items.slice(0, max).map(function (x) { return '  - ' + x; }).join('\n');
    return out + (items.length > max ? '\n  … and ' + (items.length - max) + ' more' : '');
  }

  function run(ctx) {
    try {
      var root = document.documentElement;
      var vw = root.clientWidth;
      var app = document.getElementById('app');
      var lines = [];
      lines.push('Window ' + window.innerWidth + '×' + window.innerHeight + ' · layout width ' + vw + 'px · ' +
        ((ctx && ctx.route) || '?') + ' · scenario ' + ((ctx && ctx.scenario) || '?'));

      var over = root.scrollWidth - vw;
      lines.push(over > 1 ? 'FAIL: the page scrolls sideways by ' + over + 'px.' : 'OK: the page does not scroll sideways.');

      var beyond = [], spill = [], local = [];
      var all = app.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.closest(SKIP)) continue;
        if (typeof SVGElement !== 'undefined' && el instanceof SVGElement && el.ownerSVGElement) continue; // inside an <svg>
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        var cs = getComputedStyle(el);
        if (cs.visibility === 'hidden') continue;

        var sc = nearestLocalScroller(el, app);
        if (sc) {
          if (local.indexOf(sc) < 0 && sc.scrollWidth > sc.clientWidth + 1) local.push(sc);
          continue;
        }
        var scrolls = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
        if (scrolls && el.scrollWidth > el.clientWidth + 1) {
          if (local.indexOf(el) < 0) local.push(el);
        } else if (!scrolls && cs.textOverflow !== 'ellipsis' && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) &&
          !(typeof SVGElement !== 'undefined' && el instanceof SVGElement) &&
          el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
          spill.push(label(el) + ' (content ' + el.scrollWidth + 'px in a ' + el.clientWidth + 'px box)');
        }
        if (cs.position !== 'fixed' && r.right > vw + 1) beyond.push(label(el) + ' (right edge at ' + Math.round(r.right) + 'px)');
      }

      lines.push(beyond.length
        ? 'FAIL: ' + beyond.length + ' element(s) extend past the window:\n' + list(beyond, 8)
        : 'OK: nothing extends past the window.');
      lines.push(spill.length
        ? 'CHECK: ' + spill.length + ' element(s) have content wider than their box (spilling out or clipped):\n' + list(spill, 8)
        : 'OK: no content spills out of its box.');
      lines.push(local.length
        ? 'Local sideways scrollers (expected to be wider; confirm each shows an edge cue): ' + local.map(label).join('; ')
        : 'No local sideways scrollers at this width.');
      return lines.join('\n');
    } catch (err) {
      return 'The containment check could not run: ' + (err && err.message ? err.message : err);
    }
  }

  window.ContainmentCheck = { run: run };
})();
