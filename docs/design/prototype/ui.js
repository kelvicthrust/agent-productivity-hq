/*
  Kelvin Agent Crew — shared presentation helpers for the prototype and style guide.
  Prototype code: illustrative presentation only. Not a production component library.
*/
(function () {
  'use strict';

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ---- dates (ISO yyyy-mm-dd strings, calendar dates in the report timezone) ----
  function parse(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function addDays(s, n) { var d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
  function diffDays(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function dow(s) { return parse(s).getUTCDay(); }
  function weekStart(s) { return addDays(s, -((dow(s) + 6) % 7)); } // Monday-start weeks
  function monthStart(s) { return s.slice(0, 8) + '01'; }
  function monthEnd(s) { var d = parse(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return iso(d); }
  function minDate(a, b) { return a < b ? a : b; }
  function maxDate(a, b) { return a > b ? a : b; }
  function fmtDay(s) { var d = parse(s); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  function fmtDayLong(s) { var d = parse(s); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); }
  function fmtDow(s) { return DOW[dow(s)]; }
  function fmtMonth(s) { var d = parse(s); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function fmtMonthShort(s) {
    var d = parse(s); var m = MONTHS[d.getUTCMonth()];
    return d.getUTCMonth() === 0 ? m + ' ’' + String(d.getUTCFullYear()).slice(2) : m;
  }
  function fmtRange(a, b) {
    if (a === b) return fmtDayLong(a);
    if (a.slice(0, 4) === b.slice(0, 4)) return fmtDay(a) + ' – ' + fmtDayLong(b);
    return fmtDayLong(a) + ' – ' + fmtDayLong(b);
  }
  function fmtTime(t) {
    var p = t.split(':'); var h = +p[0]; var ap = h >= 12 ? 'PM' : 'AM'; var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + p[1] + ' ' + ap;
  }

  // ---- numbers ----
  function trimNum(x) {
    var s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  function compact(n) {
    if (n == null || isNaN(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return trimNum(n / 1e9) + 'B';
    if (a >= 1e6) return trimNum(n / 1e6) + 'M';
    if (a >= 1e3) return trimNum(n / 1e3) + 'K';
    return String(Math.round(n));
  }
  function int(n) { return Math.round(n).toLocaleString('en-US'); }
  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- icons (16px, stroke = currentColor) ----
  var SW = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  var ICONS = {
    check: '<path d="M3.5 8.5l3 3 6-6.5" ' + SW + '/>',
    alert: '<path d="M8 2.5l6 10.5H2L8 2.5z" ' + SW + '/><path d="M8 6.5v3" ' + SW + '/><circle cx="8" cy="11.4" r=".85" fill="currentColor"/>',
    error: '<circle cx="8" cy="8" r="6" ' + SW + '/><path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" ' + SW + '/>',
    none: '<circle cx="8" cy="8" r="6" ' + SW + '/><path d="M5.3 8h5.4" ' + SW + '/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2" ' + SW + '/><path d="M5.5 7V5.2a2.5 2.5 0 015 0V7" ' + SW + '/>',
    clock: '<circle cx="8" cy="8" r="6" ' + SW + '/><path d="M8 4.8V8l2.2 1.4" ' + SW + '/>',
    refresh: '<path d="M13 8a5 5 0 11-1.6-3.7" ' + SW + '/><path d="M12.3 1.8v2.9H9.4" ' + SW + '/>',
    external: '<path d="M9.5 2.5h4v4M13.5 2.5l-6 6" ' + SW + '/><path d="M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3" ' + SW + '/>',
    chevronRight: '<path d="M6 3.5L10.5 8 6 12.5" ' + SW + '/>',
    chevronDown: '<path d="M3.5 6L8 10.5 12.5 6" ' + SW + '/>',
    plus: '<path d="M8 3v10M3 8h10" ' + SW + '/>',
    close: '<path d="M4 4l8 8M12 4l-8 8" ' + SW + '/>',
    info: '<circle cx="8" cy="8" r="6" ' + SW + '/><path d="M8 7.3v3.9" ' + SW + '/><circle cx="8" cy="4.9" r=".85" fill="currentColor"/>',
    overview: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" ' + SW + '/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" ' + SW + '/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" ' + SW + '/><rect x="9" y="9" width="4.5" height="4.5" rx="1" ' + SW + '/>',
    trends: '<path d="M2.5 12.5l3.5-4 3 2.5 4.5-6" ' + SW + '/>',
    merge: '<circle cx="4.5" cy="3.5" r="1.6" ' + SW + '/><circle cx="4.5" cy="12.5" r="1.6" ' + SW + '/><circle cx="11.5" cy="8.5" r="1.6" ' + SW + '/><path d="M4.5 5.1v5.8M4.5 5.6c0 2.3 2 2.9 5.4 2.9" ' + SW + '/>',
    layers: '<path d="M8 2.5l5.5 3L8 8.5 2.5 5.5 8 2.5z" ' + SW + '/><path d="M2.5 8.5L8 11.5l5.5-3" ' + SW + '/><path d="M2.5 11.2L8 14.2l5.5-3" ' + SW + '/>',
    plug: '<path d="M5.5 2.5v3M10.5 2.5v3" ' + SW + '/><path d="M3.5 5.5h9v2a4.5 4.5 0 01-9 0v-2z" ' + SW + '/><path d="M8 12v2" ' + SW + '/>',
    filter: '<path d="M2.5 3.5h11l-4.3 5v4l-2.4 1v-5l-4.3-5z" ' + SW + '/>',
    calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5" ' + SW + '/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" ' + SW + '/>',
    dotSolid: '<circle cx="8" cy="8" r="3.5" fill="currentColor"/>',
    dotDashed: '<circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 1.6"/>',
    dash: '<path d="M4.5 8h7" ' + SW + '/>',
    spinner: '<circle class="spin" cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="20 15" stroke-linecap="round"/>'
  };
  function icon(name, cls) {
    return '<svg class="icon ' + (cls || '') + '" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' + (ICONS[name] || '') + '</svg>';
  }

  // ---- status, provider, link basis ----
  var STATUS = {
    ok: ['check', 'st-ok'], connected: ['check', 'st-ok'], existing: ['check', 'st-ok'],
    partial: ['alert', 'st-warn'], warn: ['alert', 'st-warn'], reconnect: ['alert', 'st-warn'], stale: ['clock', 'st-warn'],
    failed: ['error', 'st-error'], error: ['error', 'st-error'], denied: ['lock', 'st-error'], inaccessible: ['lock', 'st-error'],
    // D8: Paseo's two states take the server's status names. A password is a locked door (same lock as Access denied); a daemon that
    // isn't running is nothing answering (same muted mark as Not found). Existing icons and tints; no new value.
    needspassword: ['lock', 'st-error'], notrunning: ['none', 'st-muted'],
    notfound: ['none', 'st-muted'], none: ['none', 'st-muted'], notconnected: ['none', 'st-muted'],
    checking: ['spinner', 'st-muted'], connecting: ['spinner', 'st-muted'], info: ['info', 'st-muted']
  };
  function statusTag(kind, text) {
    var s = STATUS[kind] || STATUS.info;
    return '<span class="status ' + s[1] + '">' + icon(s[0]) + '<span>' + esc(text) + '</span></span>';
  }

  var PROVIDERS = { codex: 'Codex', claude: 'Claude Code' };

  // Agent buddies: authored geometric characters. Shape still encodes provider:
  // Codex = rounded square with antenna, Claude Code = circle, unknown = dashed outline.
  function buddyInner(kind, mood) {
    var body, extra = '', eyes;
    if (kind === 'codex') {
      extra = '<path class="b-antenna" d="M10 5V2.8"/><circle class="b-antenna-tip" cx="10" cy="2.3" r="1.5"/>';
      body = '<rect class="b-codex" x="2.5" y="5" width="15" height="13" rx="4"/>';
    } else if (kind === 'claude') {
      body = '<circle class="b-claude" cx="10" cy="11.2" r="7.6"/>';
    } else {
      body = '<rect class="b-unknown" x="2.5" y="5" width="15" height="13" rx="6.5"/>';
    }
    var ey = 11.2, eyeCls = kind === 'unknown' ? 'b-eye-unknown' : 'b-eye';
    if (mood === 'sleep') eyes = '<path class="b-lid" d="M5.8 ' + ey + 'h2.8M11.4 ' + ey + 'h2.8"/>';
    else if (mood === 'dizzy') eyes = '<path class="b-lid" d="M6 10l2.2 2.2M8.2 10L6 12.2M11.8 10l2.2 2.2M14 10l-2.2 2.2"/>';
    else eyes = '<circle class="' + eyeCls + '" cx="7.3" cy="' + ey + '" r="1.45"/><circle class="' + eyeCls + '" cx="12.7" cy="' + ey + '" r="1.45"/>';
    return extra + body + eyes;
  }
  function buddy(kind, o) {
    o = o || {};
    var size = o.size || 14;
    return '<svg class="buddy ' + (o.cls || '') + '" width="' + size + '" height="' + size + '" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' + buddyInner(kind, o.mood || 'awake') + '</svg>';
  }
  // Small crew illustration for rare moments (first run, quiet day, recovery). Decorative.
  function crewArt(mood, cls) {
    var a = mood === 'sleep' ? 'sleep' : mood === 'dizzy' ? 'dizzy' : 'awake';
    var s = '<svg class="crew-art ' + (cls || '') + '" width="132" height="64" viewBox="0 0 132 64" aria-hidden="true" focusable="false">';
    s += '<ellipse class="shadow" cx="35" cy="59" rx="19" ry="3"/><ellipse class="shadow" cx="77" cy="59" rx="17" ry="3"/>';
    s += '<g transform="translate(14 16) scale(2.1)">' + buddyInner('codex', a) + '</g>';
    s += '<g transform="translate(58 22) scale(1.85)">' + buddyInner('claude', a === 'dizzy' ? 'awake' : a) + '</g>';
    if (mood === 'sleep') s += '<text class="z" x="100" y="26">z</text><text class="z" x="110" y="15">z</text>';
    else if (mood === 'search') s += '<ellipse class="shadow" cx="112" cy="59" rx="11" ry="2.5"/><g transform="translate(99 32) scale(1.3)">' + buddyInner('unknown', 'awake') + '</g><text class="z" x="108" y="26">?</text>';
    else if (mood === 'awake') s += '<path class="spark" d="M112 12l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><path class="spark" d="M101 30l1.2 3 3 1.2-3 1.2-1.2 3-1.2-3-3-1.2 3-1.2z"/>';
    return s + '</svg>';
  }
  function provMark(p) { return buddy(p, { size: 15 }); }
  function provTag(p) { return '<span class="prov">' + provMark(p) + '<span>' + PROVIDERS[p] + '</span></span>'; }
  // A small row of buddies, one per item up to max, for crew-count KPIs.
  function crewRow(list, max) {
    max = max || 10;
    var s = '<span class="crew-row" aria-hidden="true">';
    for (var i = 0; i < Math.min(list.length, max); i++) s += buddy(list[i], { size: 13 });
    if (list.length > max) s += '<span class="crew-more">+' + (list.length - max) + '</span>';
    return s + '</span>';
  }

  var LINKS = {
    evidence: { label: 'Evidence link', icon: 'dotSolid' },
    owner: { label: 'Owner-confirmed', icon: 'check' },
    suggested: { label: 'Suggested', icon: 'dotDashed' },
    unlinked: { label: 'Unlinked', icon: 'dash' },
    rejected: { label: 'Marked incorrect', icon: 'close' }
  };
  function linkBadge(kind) {
    var L = LINKS[kind];
    return '<span class="lbadge lb-' + kind + '">' + icon(L.icon) + esc(L.label) + '</span>';
  }

  // Legend swatches (share global SVG patterns #pat-claude and #pat-unavail defined in the page).
  function swatch(kind) {
    var inner = {
      delivery: '<rect class="s-delivery" x="0" y="0" width="14" height="10" rx="1"/>',
      codex: '<rect class="s-codex" x="0" y="0" width="14" height="10" rx="1"/>',
      claude: '<rect fill="url(#pat-claude)" x="0" y="0" width="14" height="10" rx="1"/>',
      unavailable: '<rect fill="url(#pat-unavail)" x="0" y="0" width="14" height="10"/>',
      zero: '<rect class="zero-tick" x="0" y="8" width="14" height="1.5"/>',
      railok: '<rect class="rail-ok" x="0" y="3" width="14" height="5"/>',
      railpartial: '<rect class="rail-partial" fill="url(#pat-unavail)" x="0" y="3" width="14" height="5"/>',
      railnone: '<rect class="rail-unavailable" x="0.5" y="3" width="13" height="5"/>'
    }[kind];
    return '<svg viewBox="0 0 14 10" aria-hidden="true">' + inner + '</svg>';
  }

  // ---- aligned delivery/usage chart ----
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var m = v / e;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e;
  }

  /*
    o = {
      id, width, label,
      buckets: [{ short, prs, codex, claude, dcov: 'ok'|'none'|'future', ucov: 'ok'|'partial'|'unavailable'|'future' }],
      providers: ['codex','claude'], selected: index|null, focus: index|null,
      unavailText: 'History unavailable before Mar 14, 2026'
    }
    Two panels share one x-axis; each panel has its own y-axis and unit (no shared numeric axis).
  */
  function alignedChart(o) {
    var B = o.buckets, n = B.length, provs = o.providers;
    // Minimum 240: at a 320px window the chart sits in a 256px card body, and a larger minimum would spill out of the card.
    var W = Math.max(240, Math.round(o.width || 720));
    var padL = W < 480 ? 40 : 52, padR = 6, plotW = W - padL - padR;
    var aTop = 26, aH = W < 480 ? 72 : 92, bTop = aTop + aH + 44, bH = W < 480 ? 104 : 132;
    var railY = bTop + bH + 8, railH = 6, labY = railY + railH + 16, H = labY + 6;
    var band = plotW / Math.max(n, 1);
    var bw = Math.max(1, Math.min(band * 0.68, 28));
    var maxP = 1, maxT = 1, i;
    for (i = 0; i < n; i++) {
      if (B[i].prs > maxP) maxP = B[i].prs;
      var tot = 0; for (var k = 0; k < provs.length; k++) tot += B[i][provs[k]] || 0;
      if (tot > maxT) maxT = tot;
    }
    maxP = niceMax(maxP); maxT = niceMax(maxT);

    var s = '<svg class="achart" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" tabindex="0" role="group" aria-roledescription="chart" ' +
      'aria-label="' + esc(o.label) + '" data-chart="' + esc(o.id) + '" data-fk="chart-' + esc(o.id) + '">';

    s += '<text class="ch-title" x="0" y="12">Merged PRs</text><text class="ch-unit" x="76" y="12">count</text>';
    s += '<text class="ch-title" x="0" y="' + (bTop - 14) + '">Recorded local tokens</text><text class="ch-unit" x="138" y="' + (bTop - 14) + '">tokens, this machine</text>';

    function grid(top, h, max, fmt, labelMid) {
      var out = '';
      out += '<line class="ch-grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + top + '" y2="' + top + '"/>';
      out += '<line class="ch-grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (top + h / 2) + '" y2="' + (top + h / 2) + '"/>';
      out += '<line class="ch-base" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (top + h) + '" y2="' + (top + h) + '"/>';
      out += '<text class="ch-y" x="' + (padL - 8) + '" y="' + (top + 4) + '" text-anchor="end">' + fmt(max) + '</text>';
      if (labelMid) out += '<text class="ch-y" x="' + (padL - 8) + '" y="' + (top + h / 2 + 4) + '" text-anchor="end">' + fmt(max / 2) + '</text>';
      out += '<text class="ch-y" x="' + (padL - 8) + '" y="' + (top + h + 4) + '" text-anchor="end">0</text>';
      return out;
    }
    s += grid(aTop, aH, maxP, function (v) { return String(v); }, maxP % 2 === 0);
    s += grid(bTop, bH, maxT, compact, true);

    for (i = 0; i < n; i++) {
      var b = B[i];
      var x0 = padL + i * band, bx = x0 + (band - bw) / 2;
      var cls = 'bk' + (i === o.selected ? ' is-sel' : '') + (i === o.focus ? ' is-focus' : '');
      s += '<g class="' + cls + '" data-i="' + i + '">';
      s += '<rect class="bk-band" x="' + x0 + '" y="' + (aTop - 6) + '" width="' + band + '" height="' + (railY + railH - aTop + 6) + '"/>';
      // delivery panel
      if (b.dcov === 'ok') {
        if (b.prs > 0) {
          var hp = b.prs / maxP * aH;
          s += '<rect class="s-delivery" x="' + bx + '" y="' + (aTop + aH - hp) + '" width="' + bw + '" height="' + hp + '" rx="' + (bw >= 6 ? 3 : 1) + '"/>';
        } else {
          s += '<rect class="zero-tick" x="' + bx + '" y="' + (aTop + aH - 1.5) + '" width="' + bw + '" height="1.5"/>';
        }
      }
      // usage panel
      if (b.ucov === 'unavailable') {
        s += '<rect fill="url(#pat-unavail)" x="' + x0 + '" y="' + bTop + '" width="' + band + '" height="' + bH + '"/>';
      } else if (b.ucov !== 'future') {
        var y = bTop + bH, total = 0;
        for (var p = 0; p < provs.length; p++) {
          var v = b[provs[p]] || 0; total += v;
          if (v > 0) {
            var hv = v / maxT * bH; y -= hv;
            s += provs[p] === 'codex'
              ? '<rect class="s-codex" x="' + bx + '" y="' + y + '" width="' + bw + '" height="' + hv + '"/>'
              : '<rect fill="url(#pat-claude)" x="' + bx + '" y="' + y + '" width="' + bw + '" height="' + hv + '"/>';
          }
        }
        if (total === 0) s += '<rect class="zero-tick" x="' + bx + '" y="' + (bTop + bH - 1.5) + '" width="' + bw + '" height="1.5"/>';
      }
      // coverage rail
      var rw = Math.max(band - 1, 0.5);
      if (b.ucov === 'ok') s += '<rect class="rail-ok" x="' + (x0 + 0.5) + '" y="' + railY + '" width="' + rw + '" height="' + railH + '"/>';
      else if (b.ucov === 'partial') s += '<rect class="rail-partial" fill="url(#pat-unavail)" x="' + (x0 + 0.5) + '" y="' + railY + '" width="' + rw + '" height="' + railH + '"/>';
      else if (b.ucov === 'unavailable') s += '<rect class="rail-unavailable" x="' + (x0 + 0.5) + '" y="' + railY + '" width="' + rw + '" height="' + railH + '"/>';
      s += '</g>';
    }

    // label long runs of unavailable history inside the usage panel
    var run = -1;
    for (i = 0; i <= n; i++) {
      var un = i < n && B[i].ucov === 'unavailable';
      if (un && run < 0) run = i;
      if (!un && run >= 0) {
        var rx = padL + run * band, rwid = (i - run) * band;
        var txt = o.unavailText || 'History unavailable';
        var tw = txt.length * 5.9 + 16;
        if (rwid >= tw + 8) {
          var cx = rx + rwid / 2, cy = bTop + bH / 2;
          s += '<rect class="ch-note-bg" x="' + (cx - tw / 2) + '" y="' + (cy - 11) + '" width="' + tw + '" height="20" rx="4"/>';
          s += '<text class="ch-note" x="' + cx + '" y="' + (cy + 3) + '" text-anchor="middle">' + esc(txt) + '</text>';
        }
        run = -1;
      }
    }

    // no delivery data at all (e.g. no tracked repos): say so inside the delivery panel
    if (o.noDeliveryText) {
      var nw = o.noDeliveryText.length * 5.9 + 16, ncx = padL + plotW / 2, ncy = aTop + aH / 2;
      s += '<rect class="ch-note-bg" x="' + (ncx - nw / 2) + '" y="' + (ncy - 11) + '" width="' + nw + '" height="20" rx="4"/>';
      s += '<text class="ch-note" x="' + ncx + '" y="' + (ncy + 3) + '" text-anchor="middle">' + esc(o.noDeliveryText) + '</text>';
    }

    // x labels
    var maxLabels = Math.max(3, Math.floor(plotW / 64));
    var step = Math.max(1, Math.ceil(n / maxLabels));
    for (i = 0; i < n; i++) {
      if (i % step !== 0) continue;
      s += '<text class="ch-x' + (B[i].ucov === 'future' && B[i].dcov === 'future' ? ' is-future' : '') + '" x="' + (padL + i * band + band / 2) + '" y="' + labY + '" text-anchor="middle">' + esc(B[i].short) + '</text>';
    }
    s += '</svg>';
    return s;
  }

  /*
    Year-of-merges grid: one cell per day, Monday-start weeks as columns.
    o = { start, today, counts: {date: n}, rangeStart, rangeEnd, label }
    Level 0 = covered zero; days before start / after today are not drawn.
  */
  function yearGrid(o) {
    var step = 14, cell = 11, padL = 30, padT = 18;
    var first = weekStart(o.start);
    var cols = Math.floor(diffDays(first, o.today) / 7) + 1;
    var W = padL + cols * step, H = padT + 7 * step;
    var s = '<svg class="ygrid" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label) + '">';
    ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach(function (t, r) {
      if (t) s += '<text x="0" y="' + (padT + r * step + 9) + '">' + t + '</text>';
    });
    var lastMonthCol = -9;
    for (var d = o.start; d <= o.today; d = addDays(d, 1)) {
      var col = Math.floor(diffDays(first, d) / 7), row = (dow(d) + 6) % 7;
      var x = padL + col * step, y = padT + row * step;
      if (d.slice(8) === '01' && col - lastMonthCol >= 3) {
        s += '<text x="' + x + '" y="11">' + MONTHS[+d.slice(5, 7) - 1] + '</text>';
        lastMonthCol = col;
      }
      var n = o.counts[d] || 0;
      var lvl = n === 0 ? 0 : n >= 4 ? 4 : n;
      var inR = o.rangeStart && d >= o.rangeStart && d <= o.rangeEnd;
      s += '<g class="ycell" data-day="' + d + '"><rect class="yc-' + lvl + (inR ? ' yc-in' : '') + '" x="' + x + '" y="' + y + '" width="' + cell + '" height="' + cell + '" rx="3">' +
        '<title>' + fmtDow(d) + ', ' + fmtDayLong(d) + ': ' + n + ' merged ' + (n === 1 ? 'PR' : 'PRs') + '</title></rect></g>';
    }
    return s + '</svg>';
  }

  window.UI = {
    MONTHS: MONTHS, parse: parse, iso: iso, addDays: addDays, diffDays: diffDays, dow: dow,
    weekStart: weekStart, monthStart: monthStart, monthEnd: monthEnd, minDate: minDate, maxDate: maxDate,
    fmtDay: fmtDay, fmtDayLong: fmtDayLong, fmtDow: fmtDow, fmtMonth: fmtMonth, fmtMonthShort: fmtMonthShort,
    fmtRange: fmtRange, fmtTime: fmtTime, compact: compact, int: int, plural: plural, esc: esc,
    icon: icon, statusTag: statusTag, PROVIDERS: PROVIDERS, provMark: provMark, provTag: provTag,
    buddy: buddy, crewArt: crewArt, crewRow: crewRow, yearGrid: yearGrid,
    LINKS: LINKS, linkBadge: linkBadge, swatch: swatch, alignedChart: alignedChart, niceMax: niceMax
  };
})();
