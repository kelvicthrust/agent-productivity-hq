/*
  Style guide renderer (D4; colour, type and shape values unchanged from D2). Reads token values from tokens.css at runtime, so the
  swatches and specimens shown always match what the prototype uses.
*/
(function () {
  'use strict';
  var U = window.UI;
  var css = getComputedStyle(document.documentElement);
  function v(name) { return css.getPropertyValue(name).trim(); }
  function $(id) { return document.getElementById(id); }

  function rgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function lum(hex) {
    var c = rgb(hex).map(function (x) { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function ratio(a, b) { var la = lum(a), lb = lum(b); var hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); }
  function fmt(r) { return r.toFixed(2) + ':1'; }
  function grade(r) { return r >= 4.5 ? 'text OK' : r >= 3 ? 'graphics/UI only' : 'decorative only'; }

  // ---- swatches ----
  var GROUPS = [
    ['Warm neutrals', [
      ['canvas', 'Page background (cream)', 'bg'], ['surface', 'Cards, inputs, drawer', 'bg'], ['surface-sunken', 'Tracks, group rows, unavailable fill, Unlinked badge, zero cells', 'bg'],
      ['border', 'Decorative dividers (never the only control edge)', 'fg'], ['border-strong', 'Axis baselines, coverage rail', 'fg'], ['control-border', 'Input and secondary-button edges', 'fg']]],
    ['Text', [['text', 'Primary text, Evidence badge fill, toast', 'fg'], ['text-muted', 'Secondary text, scope lines, captions', 'fg']]],
    ['Action', [['action', 'Grape: primary buttons, links, focus ring', 'fg'], ['action-hover', 'Primary hover', 'fg'], ['on-action', 'Text on action/danger', 'bg'], ['selection-surface', 'Active nav, selected bucket, text selection', 'bg']]],
    ['Data series (marks only)', [['series-delivery', 'Berry: merged PRs', 'fg'], ['series-codex', 'Teal: Codex (square buddy, solid bars)', 'fg'], ['series-claude', 'Terracotta: Claude Code (round buddy, hatched bars)', 'fg'], ['series-neutral', 'Unknown / other', 'fg'], ['coverage-hatch', 'Unavailable-history hatch', 'fg'], ['delivery-surface', 'Merged PRs KPI tint', 'bg']]],
    ['Year grid ramp', [['heat-1', '1 merge', 'bg'], ['heat-2', '2 merges', 'bg'], ['heat-3', '3 merges', 'fg'], ['heat-4', '4+ merges', 'fg']]],
    ['Illustration accent', [['sunshine', 'Sparkles and antenna tips only; never text or data', 'bg']]],
    ['Feedback', [['success', 'Healthy source/connection (never praise for a metric)', 'fg'], ['success-surface', 'Success tint', 'bg'], ['warning', 'Partial, stale, needs attention', 'fg'], ['warning-surface', 'Warning banner/notice', 'bg'], ['danger', 'Failed, denied, validation, destructive', 'fg'], ['danger-surface', 'Danger tint, confirm panel', 'bg']]]
  ];
  var white = v('--color-surface'), canvas = v('--color-canvas'), ink = v('--color-text');
  var html = '';
  GROUPS.forEach(function (g) {
    html += '<h3 class="sg-h3">' + U.esc(g[0]) + '</h3><div class="sg-grid">';
    g[1].forEach(function (t) {
      var val = v('--color-' + t[0]).toUpperCase();
      var line;
      if (t[2] === 'fg') { var r1 = ratio(val, white), r2 = ratio(val, canvas); line = 'on surface ' + fmt(r1) + ' · on canvas ' + fmt(r2) + ' · ' + grade(Math.min(r1, r2)); }
      else { var r3 = ratio(ink, val); line = 'text on it ' + fmt(r3) + ' · ' + grade(r3); }
      html += '<div class="sw"><div class="sw-chip" style="background:' + val + ';color:' + ink + '">' + (t[2] === 'bg' ? 'Aa' : '') + '</div><div class="sw-body"><b>' + U.esc(t[0]) + '</b><code>--color-' + t[0] + ' · ' + val + '</code><span class="caption">' + U.esc(t[1]) + '</span><span class="sw-ratio">' + line + '</span></div></div>';
    });
    html += '</div>';
  });
  $('swatches').innerHTML = html;

  var PAIRS = [
    ['text', 'surface', 'Body text'], ['text', 'canvas', 'Body text on page'], ['text-muted', 'surface', 'Secondary text'], ['text-muted', 'canvas', 'Secondary text on page'],
    ['text-muted', 'surface-sunken', 'Unlinked badge, group rows'], ['text-muted', 'delivery-surface', 'Meta text in Merged PRs KPI'], ['action', 'surface', 'Links'], ['action', 'canvas', 'Links on page'],
    ['on-action', 'action', 'Primary button label'], ['on-action', 'danger', 'Danger button label'], ['surface', 'text', 'Evidence badge, toast'], ['toast-link', 'text', 'Undo link in toast'],
    ['warning', 'warning-surface', 'Warning text in banners'], ['danger', 'danger-surface', 'Errors on tint'], ['success', 'success-surface', 'Success on tint'],
    ['action', 'selection-surface', 'Active nav icon'], ['control-border', 'surface', 'Control edge (≥ 3:1)'], ['series-delivery', 'canvas', 'Berry bar on page: graphics only'], ['series-claude', 'canvas', 'Claude mark on page: graphics only']
  ];
  $('pairings').querySelector('tbody').innerHTML = PAIRS.map(function (p) {
    var a = v('--color-' + p[0]), b = v('--color-' + p[1]), r = ratio(a, b);
    return '<tr><td><span class="sw-dot" style="background:' + a + '"></span> ' + p[0] + '</td><td><span class="sw-dot" style="background:' + b + '"></span> ' + p[1] + '</td><td>' + U.esc(p[2]) + '</td><td>' + fmt(r) + ' · ' + grade(r) + '</td></tr>';
  }).join('');

  // ---- typography ----
  var TYPES = [
    ['metric', '24 merged PRs', 'KPI values; rounded display stack, tabular'], ['title-page', 'Morning, Kelvin', 'Page H1; rounded display stack'], ['title-section', 'A year of merges', 'Card and section titles; rounded display stack'],
    ['body', 'Here’s what merged and where your agents spent their tokens.', 'Prose and text cells; system sans'], ['label', 'Group by · Provider · usage only', 'Controls, labels, headers'],
    ['data', '1,204,881 · 38.1M · 12.3K', 'Numeric cells, readouts (tnum)'], ['caption', 'This machine · All repos · All providers', 'Scope lines, footnotes, badges, axes'],
    ['mono', 'thread 7f3a…2c91 · ~/.codex/sessions', 'Session IDs, discovered paths only']
  ];
  $('type-specimens').innerHTML = TYPES.map(function (t) {
    return '<div class="type-row"><code>' + t[0] + '</code><div style="font:var(--type-' + t[0] + ');' + (t[0] === 'metric' ? 'letter-spacing:var(--tracking-metric)' : '') + '">' + U.esc(t[1]) + '</div><span class="caption">' + U.esc(v('--type-' + t[0]).replace(/var\(--font-(sans|mono|display)\)/, '$1')) + ' · ' + U.esc(t[2]) + '</span></div>';
  }).join('') + '<p class="caption">Display: <code>' + U.esc(v('--font-display')) + '</code><br>Sans: <code>' + U.esc(v('--font-sans')) + '</code><br>Mono: <code>' + U.esc(v('--font-mono')) + '</code></p>';

  // ---- spacing ----
  $('spacing').innerHTML = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'].map(function (k) {
    var px = v('--space-' + k);
    return '<div class="space-row"><code>' + k + '</code><span>' + px + '</span><div class="space-bar" style="width:' + px + '"></div></div>';
  }).join('') + '<p class="caption">Typical use: 4 between icon and label, 8 inside groups, 12 between rows, 16 card padding and grid gap, 24 page gutter, 32/48 setup spacing.</p>';

  // ---- buddies ----
  function fig(inner, cap) { return '<figure style="margin:0;display:flex;flex-direction:column;align-items:center;gap:6px">' + inner + '<figcaption class="caption">' + cap + '</figcaption></figure>'; }
  $('buddy-specimens').innerHTML =
    fig(U.buddy('codex', { size: 40 }), 'Codex · root') + fig(U.buddy('claude', { size: 40 }), 'Claude Code · root') +
    fig(U.buddy('codex', { size: 24 }), 'Codex · child') + fig(U.buddy('claude', { size: 24 }), 'Claude Code · child') +
    fig(U.buddy('unknown', { size: 40 }), 'Unknown relationship') + fig(U.buddy('codex', { size: 40, mood: 'sleep' }), 'Not found / idle') +
    fig(U.buddy('claude', { size: 40, mood: 'dizzy' }), 'Recovery only') + fig(U.crewRow(['codex', 'claude', 'claude', 'codex', 'claude', 'codex', 'claude', 'codex', 'claude', 'codex', 'claude'], 9), 'Crew row (9 + more)');
  $('crew-specimens').innerHTML =
    fig(U.crewArt('awake'), 'awake · first run found') + fig(U.crewArt('search'), 'search · discovery, empty') +
    fig(U.crewArt('sleep'), 'sleep · true zero day') + fig(U.crewArt('dizzy'), 'dizzy · recovery (reserved)');

  // ---- labels ----
  $('status-specimens').innerHTML = [['ok', 'Found'], ['partial', 'Partial'], ['failed', 'Refresh failed'], ['notfound', 'Not found'], ['denied', 'Access denied'], ['needspassword', 'Needs a password'], ['notrunning', 'Not running'], ['stale', 'Reconnect needed'], ['checking', 'Looking…'], ['existing', 'Using your existing sign-in']]
    .map(function (s) { return U.statusTag(s[0], s[1]); }).join('');
  $('paseo-pw-tag').innerHTML = U.statusTag('needspassword', 'Needs a password');
  $('paseo-nr-tag').innerHTML = U.statusTag('notrunning', 'Not running');
  $('prov-specimens').innerHTML = U.provTag('codex') + U.provTag('claude') + '<span class="chip">Rolling 30 days</span><span class="chip chip-warn">Partial</span>';
  $('link-specimens').innerHTML = ['evidence', 'owner', 'suggested', 'unlinked', 'rejected'].map(function (k) { return U.linkBadge(k); }).join('');

  // ---- KPIs ----
  $('kpi-specimens').innerHTML =
    '<div class="kpi kpi-wide kpi-primary"><div class="kpi-label">Merged PRs</div><p class="scope">All repos · Authored by you</p><div class="kpi-value">24</div><div class="kpi-meta">Last week: 19</div></div>' +
    '<div class="kpi"><div class="kpi-label">Linked PRs</div><p class="scope">Evidence or owner-confirmed</p><div class="kpi-value">14<small>of 24</small></div><div class="kpi-meta">4 with suggestions only</div></div>' +
    '<div class="kpi kpi-wide kpi-tokens"><div class="kpi-label">Recorded local tokens</div><p class="scope">This machine · All repos · All providers</p><div class="kpi-split"><div>' + U.provTag('codex') + '<div class="kpi-value">81.4M</div></div><div>' + U.provTag('claude') + '<div class="kpi-unavail">History unavailable</div></div></div><div class="kpi-meta">Provider totals aren’t combined.</div></div>' +
    '<div class="kpi"><div class="kpi-label">Root sessions</div><p class="scope">Active in period</p><div class="kpi-value">96</div>' + U.crewRow(['codex', 'claude', 'claude', 'codex', 'claude', 'claude', 'codex', 'claude', 'codex', 'claude'], 9) + '<div class="kpi-meta">7 with unknown relationship</div></div>' +
    '<div class="kpi"><div class="kpi-label">Child agents</div><p class="scope">Known parent, active in period</p><div class="kpi-value">131</div>' + U.crewRow(['claude', 'codex', 'claude', 'claude', 'codex', 'codex', 'claude', 'codex', 'claude', 'claude'], 9) + '<div class="kpi-meta">Paseo 112 · native 19</div></div>';

  // ---- feedback ----
  $('feedback-specimens').innerHTML =
    '<div class="notice">' + U.icon('info') + '<span>Local usage history on this machine starts: Claude Code from Mar 14, 2026. Earlier dates show as unavailable, not zero.</span></div>' +
    '<div class="notice notice-warn">' + U.icon('alert') + '<span>Reporting window differs from your selected period. It isn’t used in trends.</span></div>' +
    '<div class="banner" role="status">' + U.icon('clock') + '<div class="banner-body"><strong>Showing cached data.</strong><p>Codex refresh failed today, 9:40 AM; last success Nov 3, 6:12 PM. Codex usage since then isn’t collected yet; everything already imported is still shown.</p></div><div class="actions"><a class="btn btn-secondary btn-sm" href="index.html#/sources">View source</a><button class="btn btn-primary btn-sm" type="button">' + U.icon('refresh') + 'Retry</button></div></div>' +
    '<div class="sg-row"><div class="toast"><span>Link confirmed and labeled Owner-confirmed.</span><button class="btn btn-ghost btn-sm" type="button">Undo</button></div></div>';

  $('quiet-specimens').innerHTML =
    '<div class="quiet">' + U.crewArt('sleep') + '<p><strong>A quiet one.</strong>No recorded agent activity and no merges in this period. Every source was collecting, so this is a true zero, not missing data.</p></div>' +
    '<div class="empty">' + U.crewArt('search') + '<h3>No tracked repositories</h3><p>Add the GitHub repositories you want to follow. Merged PRs, and their links to agent sessions, appear once a repo is tracked. Local usage is still shown without them.</p><a class="btn btn-primary btn-sm" href="index.html#/sources">Add repositories</a></div>' +
    '<div class="kpis"><div class="kpi kpi-wide" aria-hidden="true"><div class="skeleton sk-line"></div><div class="skeleton sk-value"></div><div class="skeleton sk-line" style="width:80%"></div></div></div>' +
    '<p class="sg-label">Illustrations appear only on rare or empty moments, and always next to text that names the state and the next step. Errors lead with the problem and the recovery; the dizzy buddy is reserved and is not used on loss-of-data messages.</p>';

  // ---- account card ----
  $('acct-specimens').innerHTML =
    '<div class="acct"><div class="acct-head"><span class="prov">' + U.provMark('codex') + '<b>ChatGPT</b><span class="caption">· Codex plan</span></span>' + U.statusTag('existing', 'Using your existing Codex sign-in') + '</div>' +
    '<div class="acct-value">52.4M<small>tokens</small></div><div class="acct-chips"><span class="chip">' + U.icon('calendar') + 'Oct 5 – Nov 3, 2026 · Rolling 30 days</span><span class="chip">Account-wide · may include other devices and surfaces</span></div>' +
    '<p class="acct-compare">This machine recorded <b>40.0M</b> Codex tokens in the same window. Shown separately, not added together.</p></div>' +
    '<div class="acct"><div class="acct-head"><span class="prov">' + U.provMark('claude') + '<b>Claude</b><span class="caption">· Claude Code plan</span></span>' + U.statusTag('connected', 'Connected') + '</div>' +
    '<div class="acct-value">62%<small>of weekly usage limit used</small></div><p class="acct-compare">Subscription tokens unavailable: this account reports a usage percentage, not tokens.</p></div>' +
    '<p class="footnote">Illustrative values. Whether these account reports exist, and their units and windows, depends on Tech Spec feasibility.</p>';

  // ---- evidence ----
  // D4: an evidence item leads with the recorded session name (or relationship when no name was recorded); the ID is secondary.
  function sessRefSpec(ref) { return '<span class="sess-ref mono"><span class="sr-only">Session ID: </span>' + ref + '</span>'; }
  function ev(kind, name, prov, sub, ref, basis, actions) {
    return '<div class="ev ' + (kind === 'suggested' ? 'is-suggested' : '') + '"><div class="ev-main"><div class="ev-line">' + U.linkBadge(kind) + '<span class="sess-name">' + name + '</span>' + U.provTag(prov) + '</div><div class="ev-line caption"><span>' + sub + '</span><span>Started Nov 2, 9:14 AM</span><span>1.21M tokens recorded in this session</span>' + sessRefSpec(ref) + '</div><p class="ev-basis">Basis: ' + basis + '</p></div><div class="ev-actions">' + actions + '</div></div>';
  }
  $('ev-specimens').innerHTML = '<div class="ev-list">' +
    ev('evidence', 'planner', 'codex', 'Root session · Paseo · atlas-api · wt-1', 'thread 7f3a…2c91', 'PR reference recorded in session', '<button class="btn btn-ghost btn-sm" type="button">Mark incorrect</button>') +
    ev('owner', 'Root session', 'claude', 'No name recorded', 'session d2a7…551c', 'Confirmed by you', '<button class="btn btn-secondary btn-sm" type="button">Remove link</button>') +
    ev('suggested', 'tester-2', 'codex', 'Paseo child agent · atlas-api · wt-1', 'thread 9c04…e1f8', 'Same repo · active within 48 h before merge', '<button class="btn btn-secondary btn-sm" type="button">Dismiss</button><button class="btn btn-primary btn-sm" type="button">Confirm link</button>') +
    '</div><p class="footnote">A linked session is recorded evidence of involvement, not proof it produced the PR alone. Its tokens stay on the dates they were used. Illustrative sessions: a name is shown only where one was recorded.</p>';

  // ---- D4 narrow-width specimens ----
  // frame(): a dashed frame whose INNER width equals the width the component really gets at that screen (padding and border of
  // the frame are added to it), so container-driven layouts choose the same layout here as they do in the prototype.
  function frame(inner, caption, html) {
    var style = inner === 'full' ? 'flex:1 1 100%' : 'width:' + (inner + 18) + 'px';
    return '<div class="sg-frame" style="' + style + '"><span class="sg-cap">' + caption + '</span>' + html + '</div>';
  }

  function tokensCard(w) {
    return '<div class="kpi kpi-wide kpi-tokens" style="width:' + w + 'px"><div class="kpi-label">Recorded local tokens</div><p class="scope">This machine · All repos · All providers</p>' +
      '<div class="kpi-split"><div>' + U.provTag('codex') + '<div class="kpi-value">81.4M</div></div><div>' + U.provTag('claude') + '<div class="kpi-unavail">History unavailable</div></div></div><div class="kpi-meta">Provider totals aren’t combined.</div></div>';
  }
  $('ledger-specimens').innerHTML =
    frame(358, 'Phone, full row (358px): side by side', tokensCard(358)) +
    frame(288, 'Phone at 320px (288px): side by side', tokensCard(288)) +
    frame(241, 'Desktop card (241px): side by side', tokensCard(241)) +
    frame(213, 'Tablet card (213px): stacked', tokensCard(213));

  function catCard(p) {
    var rows = p === 'codex'
      ? [['Input', '1,204,881'], ['Cached input', '812,330', 'sub', 'included in input'], ['Output', '96,412'], ['Reasoning', '51,208', 'sub', 'included in output']]
      : [['Input (uncached)', '48,117'], ['Cache write', '312,904'], ['Cache read', '3,456,789,012'], ['Output', '120,331']];
    var total = p === 'codex' ? '1,301,293' : '3,457,270,364';
    return '<section class="card"><div class="card-head"><div><h2>' + U.provTag(p) + '</h2><p class="scope">This machine · All repos</p></div><span class="caption">214 sessions</span></div>' +
      '<table class="cat-table"><caption class="sr-only">' + U.PROVIDERS[p] + ' token categories (illustrative)</caption><tbody>' +
      rows.map(function (r) { return '<tr class="' + (r[2] || '') + '"><td><span class="cat-name">' + r[0] + '</span>' + (r[3] ? '<span class="cat-note">' + r[3] + '</span>' : '') + '</td><td class="r num">' + r[1] + '</td></tr>'; }).join('') +
      '<tr class="total"><td>Provider total</td><td class="r num">' + total + '</td></tr></tbody></table>' +
      '<p class="footnote">' + (p === 'codex' ? 'Total = input + output. Cached input and reasoning are subsets and aren’t added again.' : 'Total = uncached input + cache write + cache read + output (separate categories, none counted twice).') + ' Illustrative numbers.</p></section>';
  }
  $('cat-specimens').innerHTML =
    frame(358, 'Phone, Codex ledger (358px)', catCard('codex')) +
    frame(358, 'Phone, Claude Code ledger (358px): a 13-character number stays on one line', catCard('claude'));

  function covItem(cls, icon, name, text) {
    return '<span class="cov-item"><span class="' + cls + '">' + U.icon(icon) + '</span><span class="cov-text"><b>' + name + '</b> ' + text + '</span></span>';
  }
  function coverageHTML() {
    return '<div class="cov-host"><section class="coverage" aria-label="Source coverage (specimen)">' +
      '<div class="cov-group"><span class="cov-label">This machine</span><div class="cov-items">' + covItem('st-ok', 'check', 'Codex', 'since Feb 2, 2026') + covItem('st-ok', 'check', 'Claude Code', 'since Mar 14, 2026') + covItem('st-warn', 'alert', 'Paseo', 'partial · 3 unreadable') + '</div></div><span class="cov-sep" aria-hidden="true"></span>' +
      '<div class="cov-group"><span class="cov-label">Delivery</span><div class="cov-items">' + covItem('st-ok', 'check', 'GitHub', '4 repos tracked') + '</div></div><span class="cov-sep" aria-hidden="true"></span>' +
      '<div class="cov-group"><span class="cov-label">Account reports</span><div class="cov-items">' + covItem('st-ok', 'check', 'ChatGPT', 'tokens · rolling 30 days') + covItem('st-warn', 'clock', 'Claude', 'reconnect needed') + '</div></div>' +
      '<div class="cov-end"><span>Refreshed today, 9:42 AM</span><a href="index.html#/sources">Manage sources</a></div></section></div>';
  }
  $('coverage-specimens').innerHTML =
    frame('full', 'Wide: one-line capsule (container ≥ 900px)', coverageHTML()) +
    frame(358, 'Phone (358px): compact groups', coverageHTML()) +
    frame(260, 'Very narrow (260px): label above its sources', coverageHTML());

  // Session identity specimens: static rows built with the same classes as the prototype's Usage tree.
  function sessRowSpec(o) {
    var toggle = o.kids
      ? '<button type="button" class="row-toggle" aria-expanded="true" aria-label="Hide ' + o.kids + ' child agents of ' + o.name + ', ' + o.ref + '">' + U.icon('chevronRight') + '</button>'
      : '<span class="row-toggle" aria-hidden="true"></span>';
    return '<tr class="sess-row tree-l' + o.lvl + '"><td><div class="tree-cell">' + toggle + U.buddy(o.buddy, { size: o.lvl === 2 ? 18 : 13 }) +
      '<div class="sess-id"><span class="sess-name">' + o.name + '</span><span class="role-tag">' + o.sub + '</span>' + sessRefSpec(o.ref) +
      '<span class="sess-meta">' + o.provider + ' · ' + o.model + ' · Started ' + o.when + '</span></div></div></td>' +
      '<td class="hide-sm">' + o.provider + '</td><td class="hide-sm mono">' + o.model + '</td><td class="hide-sm">' + o.when + '</td><td class="r tok" data-label="Tokens">' + o.tokens + '</td>' +
      '<td class="plc" data-label="Linked PRs"><div class="pl-list">' + o.links + '</div></td></tr>';
  }
  // A linked PR as the Usage tree draws it: the number plus the same evidence badge Delivery uses.
  function plItem(num, kind) { return '<span class="pl-item"><button type="button" class="btn btn-ghost btn-sm">#' + num + '</button>' + U.linkBadge(kind) + '</span>'; }
  function identityTable() {
    var rows = [
      { lvl: 2, kids: 2, buddy: 'codex', name: 'planner', sub: 'Root session · Paseo · atlas-api · wt-1 · 2 children', ref: 'thread 7f3a…2c91', provider: 'Codex', model: 'gpt-5-codex', when: 'Nov 2, 9:14 AM', tokens: '1.2M', links: plItem(512, 'evidence') },
      { lvl: 3, buddy: 'claude', name: 'implementer-1', sub: 'Paseo child agent · atlas-api · wt-1', ref: 'session 41be…0d7a', provider: 'Claude Code', model: 'claude-sonnet-5-5', when: 'Nov 2, 9:31 AM', tokens: '640K', links: '<span class="pl-item">' + U.linkBadge('unlinked') + '</span>' },
      { lvl: 2, buddy: 'claude', name: 'Root session', sub: 'No name recorded', ref: 'session d2a7…551c', provider: 'Claude Code', model: 'claude-opus-5-5', when: 'Nov 3, 2:20 PM', tokens: '910K', links: plItem(513, 'owner') + plItem(514, 'suggested') },
      { lvl: 3, buddy: 'unknown', name: 'reviewer-3', sub: 'Unknown relationship · Paseo · atlas-api · wt-2', ref: 'session 88f1…3b2e', provider: 'Claude Code', model: 'claude-sonnet-5-5', when: 'Nov 3, 4:30 PM', tokens: '220K', links: '<span class="caption">Repo not tracked, so PRs not checked</span>' }
    ];
    return '<section class="card"><div class="table-wrap"><table class="table tree"><caption class="sr-only">Illustrative sessions: named, unnamed and unknown-relationship rows</caption><thead><tr><th>Session</th><th class="hide-sm">Provider</th><th class="hide-sm">Model</th><th class="hide-sm">Started</th><th class="r">Tokens</th><th>Linked PRs</th></tr></thead><tbody>' +
      rows.map(sessRowSpec).join('') + '</tbody></table></div></section>';
  }
  $('identity-specimens').innerHTML =
    frame('full', 'Desktop: all columns. Named Paseo root with its children, an unnamed root, and an unknown relationship that stays Unknown', identityTable()) +
    '<div class="sg-phone" style="display:contents">' + frame(358, 'Phone (≤ 639px): identity across the full width, then Tokens and Linked PRs on one line', identityTable()) + '</div>';

  // Local scroll cue: a table wider than its frame.
  $('scroll-specimen').innerHTML = '<div class="table-wrap" style="margin:0;padding:0"><table class="table"><caption class="sr-only">Illustrative wide table</caption><thead><tr><th>Repository</th><th class="r">Merged PRs</th><th class="r">Linked</th><th class="r">Codex tokens</th><th class="r">Claude Code tokens</th><th class="r">Root sessions</th></tr></thead><tbody>' +
    '<tr><td>kelvin/atlas-api</td><td class="r">9</td><td class="r">5</td><td class="r">41.2M</td><td class="r">212.9M</td><td class="r">14</td></tr>' +
    '<tr><td>kelvin/atlas-web</td><td class="r">6</td><td class="r">3</td><td class="r">12.8M</td><td class="r">96.4M</td><td class="r">9</td></tr></tbody></table></div>';

  // ---- chart specimen (illustrative buckets covering every state) ----
  var buckets = [
    { short: 'Mar 9', prs: 3, codex: 0, claude: 0, dcov: 'ok', ucov: 'unavailable' },
    { short: 'Mar 10', prs: 1, codex: 0, claude: 0, dcov: 'ok', ucov: 'unavailable' },
    { short: 'Mar 11', prs: 4, codex: 0, claude: 0, dcov: 'ok', ucov: 'unavailable' },
    { short: 'Mar 12', prs: 2, codex: 4.1e6, claude: 0, dcov: 'ok', ucov: 'partial' },
    { short: 'Mar 13', prs: 0, codex: 3.2e6, claude: 0, dcov: 'ok', ucov: 'partial' },
    { short: 'Mar 14', prs: 2, codex: 2.8e6, claude: 6.4e6, dcov: 'ok', ucov: 'ok' },
    { short: 'Mar 15', prs: 0, codex: 0, claude: 0, dcov: 'ok', ucov: 'ok' },
    { short: 'Mar 16', prs: 5, codex: 5.1e6, claude: 9.8e6, dcov: 'ok', ucov: 'ok' },
    { short: 'Mar 17', prs: 3, codex: 3.9e6, claude: 7.2e6, dcov: 'ok', ucov: 'ok' },
    { short: 'Mar 18', prs: 0, codex: 0, claude: 0, dcov: 'future', ucov: 'future' },
    { short: 'Mar 19', prs: 0, codex: 0, claude: 0, dcov: 'future', ucov: 'future' }
  ];
  $('chart-legend').innerHTML = [['delivery', 'Merged PRs'], ['codex', 'Codex tokens'], ['claude', 'Claude Code tokens'], ['unavailable', 'History unavailable'], ['zero', 'Zero, covered']]
    .map(function (x) { return '<span class="legend-item">' + U.swatch(x[0]) + x[1] + '</span>'; }).join('') +
    '<span class="legend-item">' + U.swatch('railok') + U.swatch('railpartial') + U.swatch('railnone') + 'Local coverage: complete, partial, none</span>';
  function drawSpec() {
    var host = $('chart-spec');
    host.innerHTML = U.alignedChart({ id: 'spec', width: host.clientWidth || 700, buckets: buckets, providers: ['codex', 'claude'], selected: 7, focus: null, label: 'Illustrative aligned chart specimen', unavailText: 'History unavailable' });
    var svg = host.querySelector('svg'); if (svg) svg.removeAttribute('tabindex'); // specimen only: not interactive
  }
  drawSpec();
  var t; window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(drawSpec, 120); });

  // ---- year grid specimen (illustrative deterministic counts) ----
  var counts = {}, seed = 7;
  function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
  for (var d = '2025-11-05'; d <= '2026-11-04'; d = U.addDays(d, 1)) {
    var w = U.dow(d), x = rnd();
    var n = (w === 0 || w === 6) ? (x < 0.75 ? 0 : 1) : (x < 0.25 ? 0 : x < 0.55 ? 1 : x < 0.8 ? 2 : x < 0.93 ? 3 : 5);
    if (n) counts[d] = n;
  }
  $('year-spec').innerHTML = U.yearGrid({ start: '2025-11-05', today: '2026-11-04', counts: counts, rangeStart: '2026-10-06', rangeEnd: '2026-11-04', label: 'Illustrative year of merges specimen' });

  // ---- motion replays (entrance classes are added once per replay) ----
  var stage = $('motion-stage');
  function replay(htmlStr) {
    stage.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.innerHTML = htmlStr;
    stage.appendChild(wrap.firstChild);
  }
  $('replay-pop').addEventListener('click', function () {
    replay('<div class="popover is-entering" role="presentation"><h3>Quick ranges</h3><div class="preset-list"><span class="chip">Last 30 days</span><span class="chip">Last 90 days</span></div></div>');
  });
  $('replay-toast').addEventListener('click', function () {
    replay('<div class="toast is-entering"><span>Codex refreshed · 23 new sessions imported.</span></div>');
  });
  $('replay-buddy').addEventListener('click', function () {
    replay('<div class="sg-row">' + U.buddy('codex', { size: 40, cls: 'pop is-entering' }) + U.buddy('claude', { size: 40, cls: 'pop is-entering' }) + '</div>');
  });
})();
