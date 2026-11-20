/*
  Kelvin Agent Crew — clickable design prototype (static HTML/CSS/JS), revision D4 (responsive/usability repair on D3).
  Presentation and local UI state only: no network, storage, auth or real data.
  All records come from data.js (synthetic fixtures). See docs/design and DESIGN.md.
*/
(function () {
  'use strict';
  const U = window.UI, F = window.FIXTURE, esc = U.esc, icon = U.icon;
  const T = F.TODAY, ME = F.ME;
  const NOW = '9:52 AM'; // fixed fixture clock

  const ROUTES = [
    { id: 'overview', label: 'Overview', icon: 'overview' },
    { id: 'trends', label: 'Trends', icon: 'trends' },
    { id: 'delivery', label: 'Delivery', icon: 'merge' },
    { id: 'usage', label: 'Usage', icon: 'layers' }
  ];
  const SRC_ROUTE = { id: 'sources', label: 'Sources & repos', short: 'Sources', icon: 'plug' };
  const PAGE_NAMES = { overview: 'Overview', trends: 'Trends', delivery: 'Delivery', usage: 'Usage', sources: 'Sources & repos', setup: 'Setup' };
  const PERIOD_LABEL = { today: 'Today', week: 'This week', month: 'This month', '30d': 'Last 30 days', '90d': 'Last 90 days', '12m': 'Last 12 months', custom: 'Custom range' };
  const DEFAULT_GRAN = { today: 'day', week: 'day', month: 'day', '30d': 'day', '90d': 'week', '12m': 'month' };

  let W = null;
  const S = {
    scenario: 'typical', route: 'overview', f: null,
    openPop: null, customDraft: null, filtersOpen: false,
    charts: {}, trendSel: null, drawer: null, drawerTab: 'prs', returnFocus: null,
    prOpen: {}, linkFilter: 'all', prQuery: '', prCap: 50, addLinkFor: null, addLinkPick: '',
    treeOpen: {}, treeMore: {},
    repoInput: '', repoError: null, repoBusy: false, confirmRemove: null,
    busy: {}, retryFails: false, setup: null, protoOpen: false, loadingPhase: null, toasts: [], timers: [],
    focusNext: null, entering: {}
  };
  // Entrance classes are emitted for exactly one render, so re-renders never replay motion.
  function takeEnter(k) { if (S.entering[k]) { delete S.entering[k]; return true; } return false; }
  const GREETING = 'Morning, Kelvin'; // fixture: name from the GitHub connection, fixed 9:52 AM clock

  // ---------- utilities ----------
  function later(ms, fn) {
    const t = setTimeout(() => { S.timers = S.timers.filter(x => x !== t); fn(); }, ms);
    S.timers.push(t);
  }
  function text(html) { const d = document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' ').trim(); }
  function announce(t) { const l = document.getElementById('live'); l.textContent = ''; setTimeout(() => { l.textContent = t; }, 30); }
  function sum(xs) { return xs.reduce((a, s) => a + s.total, 0); }
  function uniq(xs) { return xs.filter((x, i) => xs.indexOf(x) === i); }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function prUrl(p) { return 'https://github.com/' + p.repo + '/pull/' + p.number; }
  function autoGran(a, b) { const n = U.diffDays(a, b) + 1; return n <= 45 ? 'day' : n <= 200 ? 'week' : 'month'; }

  function seg(act, options, current, label, extra, fkx) {
    return '<div class="seg" role="group" aria-label="' + esc(label) + '">' + options.map(o =>
      `<button type="button" class="seg-btn" data-act="${act}" data-val="${o[0]}" ${extra || ''} data-fk="${act}-${o[0]}${fkx ? '-' + fkx : ''}" aria-pressed="${o[0] === current}">${o[1]}</button>`
    ).join('') + '</div>';
  }
  function pageHead(title, sub, actions) {
    return `<div class="page-head"><div><h1 id="page-title" tabindex="-1" data-fk="page-title">${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
  }

  // ---------- filters & scope ----------
  function rangeFor(p) {
    switch (p) {
      case 'today': return [T, T];
      case 'week': { const s = U.weekStart(T); return [s, U.addDays(s, 6)]; }
      case 'month': return [U.monthStart(T), U.monthEnd(T)];
      case '30d': return [U.addDays(T, -29), T];
      case '90d': return [U.addDays(T, -89), T];
      case '12m': return [F.LOOKBACK_START, T];
    }
    return [S.f.start, S.f.end];
  }
  // Opens on the current Monday-start week (owner decision, Review r6). Days after "today" are
  // inside the period but not yet happened, so they render as upcoming, never as zero.
  function defaultFilters() { const s = U.weekStart(T); return { period: 'week', start: s, end: U.addDays(s, 6), gran: 'day', repos: [], provider: 'all', author: 'mine' }; }
  function resetSelections() { S.charts = {}; S.trendSel = null; S.drawer = null; }
  function setPeriod(p) {
    const r = rangeFor(p); S.f.period = p; S.f.start = r[0]; S.f.end = r[1]; S.f.gran = DEFAULT_GRAN[p] || S.f.gran; resetSelections();
  }

  const trackedIds = () => W.repos.filter(r => r.status === 'ok').map(r => r.id);
  const isTracked = id => W.repos.some(r => r.id === id && r.status === 'ok');
  const provs = () => S.f.provider === 'all' ? ['codex', 'claude'] : [S.f.provider];
  const repoOk = (repo, f) => !f.repos.length || (repo != null && f.repos.indexOf(repo) >= 0);
  function sessIn(f) {
    return W.sessions.filter(s => s.date >= f.start && s.date <= f.end && (f.provider === 'all' || s.provider === f.provider) && repoOk(s.repo, f));
  }
  function prsIn(f) {
    return W.prs.filter(p => p.date >= f.start && p.date <= f.end && isTracked(p.repo) && repoOk(p.repo, f) && (f.author === 'all' || p.author === ME));
  }
  function activeLinks(p) { return p.links.filter(l => !l.rejected && W.sessionById[l.sid]); }
  function prClass(p) {
    const ls = activeLinks(p);
    if (ls.some(l => l.cls === 'evidence')) return 'evidence';
    if (ls.some(l => l.cls === 'owner')) return 'owner';
    if (ls.some(l => l.cls === 'suggested')) return 'suggested';
    return 'unlinked';
  }
  const isLinked = p => { const c = prClass(p); return c === 'evidence' || c === 'owner'; };
  function repoScope() { const r = S.f.repos; return r.length ? (r.length === 1 ? r[0] : r.length + ' repos') : 'All repos'; }
  function scopeDelivery() { return esc(repoScope()) + ' · ' + (S.f.author === 'mine' ? 'Authored by you' : 'All authors'); }
  function scopeUsage() { return 'This machine · ' + esc(repoScope()) + ' · ' + (S.f.provider === 'all' ? 'All providers' : U.PROVIDERS[S.f.provider]); }

  // ---------- coverage ----------
  function provCov(p, a, b) {
    if (a > T) return 'future';
    const src = W.sources[p];
    if (!src || !src.oldest) return 'none';
    if (b < src.oldest) return 'unavailable';
    if (a < src.oldest) return 'partial';
    if (src.staleAfter && b > src.staleAfter) return 'stale';
    return 'ok';
  }
  function usageCov(a, b) {
    const ps = provs().map(p => provCov(p, a, b));
    if (ps.every(x => x === 'future')) return 'future';
    if (ps.every(x => x === 'unavailable' || x === 'none')) return 'unavailable';
    if (ps.some(x => x !== 'ok')) return 'partial';
    return 'ok';
  }
  function delivCov(a) { if (a > T) return 'future'; return trackedIds().length ? 'ok' : 'none'; }
  function unavailText() {
    const xs = provs().map(p => W.sources[p].oldest).filter(Boolean).sort();
    return xs.length ? 'History unavailable before ' + U.fmtDayLong(xs[0]) : 'No local records on this machine';
  }

  // ---------- buckets ----------
  function buildBuckets(f) {
    const out = [], idx = {};
    const add = (a, b, label, short) => {
      const i = out.length; out.push({ a, b, label, short, prs: 0, codex: 0, claude: 0 });
      for (let d = a; d <= b; d = U.addDays(d, 1)) idx[d] = i;
    };
    if (f.gran === 'day') {
      const n = U.diffDays(f.start, f.end) + 1;
      for (let d = f.start; d <= f.end; d = U.addDays(d, 1)) {
        add(d, d, U.fmtDow(d) + ', ' + U.fmtDayLong(d), n <= 7 ? U.fmtDow(d) + ' ' + U.parse(d).getUTCDate() : U.fmtDay(d));
      }
    } else if (f.gran === 'week') {
      for (let ws = U.weekStart(f.start); ws <= f.end; ws = U.addDays(ws, 7)) {
        const we = U.addDays(ws, 6), a = U.maxDate(ws, f.start), b = U.minDate(we, f.end);
        add(a, b, 'Week of ' + U.fmtDayLong(ws) + (a !== ws || b !== we ? ' (part in range)' : ''), U.fmtDay(ws));
      }
    } else {
      for (let ms = U.monthStart(f.start); ms <= f.end; ms = U.addDays(U.monthEnd(ms), 1)) {
        const me = U.monthEnd(ms), a = U.maxDate(ms, f.start), b = U.minDate(me, f.end);
        add(a, b, U.fmtMonth(ms) + (a !== ms || b !== me ? ' (part in range)' : ''), U.fmtMonthShort(ms));
      }
    }
    sessIn(f).forEach(s => { const i = idx[s.date]; if (i != null) out[i][s.provider] += s.total; });
    prsIn(f).forEach(p => { const i = idx[p.date]; if (i != null) out[i].prs++; });
    out.forEach(b => {
      b.cov = { codex: provCov('codex', b.a, b.b), claude: provCov('claude', b.a, b.b) };
      b.ucov = usageCov(b.a, b.b); b.dcov = delivCov(b.a);
    });
    return out;
  }
  function readout(b) {
    if (!b) return '';
    const parts = [`<span class="ro-label">${esc(b.label)}</span>`];
    if (b.dcov === 'future') { parts.push('<span class="ro-muted">Upcoming, no data yet</span>'); return parts.join(''); }
    parts.push(`<span>Merged PRs: <b>${b.dcov === 'none' ? 'no tracked repos' : b.prs}</b></span>`);
    provs().forEach(p => {
      const c = b.cov[p]; let v;
      if (c === 'unavailable') v = 'history unavailable';
      else if (c === 'none') v = 'no local records';
      else {
        v = b[p] === 0 ? '0 (no recorded activity)' : U.compact(b[p]) + ' tokens';
        if (c === 'partial') v += ' · partial coverage';
        if (c === 'stale') v += ' · not collected since failed refresh';
      }
      parts.push(`<span>${U.PROVIDERS[p]}: <b>${v}</b></span>`);
    });
    return parts.join('');
  }
  function covText(b) {
    return { ok: 'Complete', partial: 'Partial', unavailable: 'Unavailable', future: 'Upcoming' }[b.ucov] || '';
  }
  function cellTok(b, p) {
    const c = b.cov[p];
    if (c === 'future') return '—';
    if (c === 'unavailable') return 'Unavailable';
    if (c === 'none') return 'No records';
    return U.int(b[p]) + (c === 'partial' || c === 'stale' ? ' *' : '');
  }

  // ---------- charts ----------
  function legend(pv) {
    const items = [['delivery', 'Merged PRs']].concat(pv.map(p => [p, U.PROVIDERS[p] + ' tokens'])).concat([['unavailable', 'History unavailable'], ['zero', 'Zero, covered']]);
    return items.map(x => `<span class="legend-item">${U.swatch(x[0])}${esc(x[1])}</span>`).join('') +
      `<span class="legend-item">${U.swatch('railok')}${U.swatch('railpartial')}${U.swatch('railnone')}Local coverage: complete, partial, none</span>`;
  }
  function chartBlock(id, f, label) {
    const prev = S.charts[id] || { view: 'chart', sel: null, focus: null };
    const buckets = buildBuckets(f);
    const c = S.charts[id] = {
      view: prev.view, buckets, provs: provs(), label, unavailText: unavailText(),
      sel: prev.sel != null && prev.sel < buckets.length ? prev.sel : null,
      focus: prev.focus != null && prev.focus < buckets.length ? prev.focus : null
    };
    const head = `<div class="chart-head"><div class="legend">${legend(c.provs)}</div>${seg('chartview', [['chart', 'Chart'], ['table', 'Table']], c.view, 'Chart display', `data-chart="${id}"`, id)}</div>`;
    if (S.loadingPhase === 'loading' && id === 'ov') return head + '<div class="skeleton sk-chart" aria-hidden="true"></div><p class="sr-only" role="status">Loading chart</p>';
    if (S.loadingPhase === 'error' && id === 'ov' && c.view === 'chart') {
      return head + `<div class="chart-state" role="status">${U.statusTag('error', 'Couldn’t build this chart')}<p>The records are still available. Switch to Table to read the same values, or try again.</p><button type="button" class="btn btn-secondary" data-act="chart-retry" data-fk="chart-retry">${icon('refresh')}Try again</button></div>`;
    }
    if (c.view === 'table') return head + chartTable(id, c);
    const cur = c.focus != null ? buckets[c.focus] : c.sel != null ? buckets[c.sel] : null;
    return head +
      `<div class="readout" id="ro-${id}">${cur ? readout(cur) : '<span class="ro-muted">Hover a bucket, or focus the chart and use the arrow keys, to read its values.</span>'}</div>` +
      `<div class="chart-host" data-chart-host="${id}"></div>` +
      `<p class="chart-hint">Click a bucket or press Enter to see its records. Merged PRs and tokens have separate axes and are never compared on one scale.</p>`;
  }
  function chartTable(id, c) {
    const rows = c.buckets.map((b, i) =>
      `<tr><td class="lead" data-label="Period"><button type="button" class="btn btn-ghost btn-sm" data-act="bucket" data-chart="${id}" data-val="${i}" data-fk="bt-${id}-${i}">${esc(b.label)}</button></td>` +
      `<td class="r" data-label="Merged PRs">${b.dcov === 'future' ? '—' : b.dcov === 'none' ? 'n/a' : b.prs}</td>` +
      c.provs.map(p => `<td class="r" data-label="${U.PROVIDERS[p]} tokens">${cellTok(b, p)}</td>`).join('') +
      `<td data-label="Local coverage">${covText(b)}</td></tr>`).join('');
    return `<div class="table-wrap"><table class="table stack"><caption class="sr-only">${esc(c.label)}, as a table</caption><thead><tr><th>Period</th><th class="r">Merged PRs</th>${c.provs.map(p => `<th class="r">${U.PROVIDERS[p]} tokens</th>`).join('')}<th>Local coverage</th></tr></thead><tbody>${rows}</tbody></table></div><p class="footnote">* Partial: part of this period is before available history or not yet collected. Select a period to see its records.</p>`;
  }
  // The year grid is wider than a phone on purpose and scrolls locally. The whole page re-renders on every state change, which
  // would snap it back to the oldest weeks, so remember where the user left it; first time, show the newest weeks (the right end).
  function restoreHScroll() {
    document.querySelectorAll('.year-wrap').forEach(el => { el.scrollLeft = S.yearScroll != null ? S.yearScroll : el.scrollWidth; });
  }
  document.addEventListener('scroll', e => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('year-wrap')) S.yearScroll = t.scrollLeft;
  }, true);
  function drawCharts() {
    document.querySelectorAll('[data-chart-host]').forEach(host => {
      const id = host.getAttribute('data-chart-host'), c = S.charts[id];
      if (!c) return;
      const w = Math.max(240, Math.floor(host.clientWidth || 700));
      host.innerHTML = U.alignedChart({
        id, width: w, buckets: c.buckets, providers: c.provs, selected: c.sel, focus: c.focus,
        label: c.label + '. Use the left and right arrow keys to move between periods; press Enter to open records.',
        unavailText: c.unavailText, noDeliveryText: trackedIds().length ? null : 'No tracked repositories'
      });
    });
  }
  function setFocusBucket(id, i, say) {
    const c = S.charts[id]; if (!c) return;
    c.focus = i;
    document.querySelectorAll('.achart[data-chart="' + id + '"] .bk').forEach(g => g.classList.toggle('is-focus', +g.getAttribute('data-i') === i));
    const ro = document.getElementById('ro-' + id);
    if (ro) ro.innerHTML = readout(c.buckets[i]);
    if (say) announce(text(readout(c.buckets[i])));
  }
  function defaultBucket(c) {
    if (c.sel != null) return c.sel;
    for (let i = c.buckets.length - 1; i >= 0; i--) if (c.buckets[i].dcov !== 'future') return i;
    return 0;
  }
  function activateBucket(id, i) {
    const c = S.charts[id]; if (!c || !c.buckets[i]) return;
    c.sel = i; c.focus = i;
    if (id === 'ov') {
      if (!S.drawer) S.entering.drawer = true;
      S.drawer = { chart: id, i };
      S.drawerTab = c.buckets[i].prs > 0 ? 'prs' : 'sessions';
      S.returnFocus = c.view === 'table' ? 'bt-' + id + '-' + i : 'chart-' + id;
      S.focusNext = 'drawer-title';
    } else {
      S.trendSel = i;
    }
    render();
  }

  // ---------- shared fragments ----------
  function issues() {
    const list = [];
    Object.keys(W.sources).forEach(k => { if (W.sources[k].status !== 'ok') list.push(W.sources[k].name); });
    Object.keys(W.accounts).forEach(k => { if (W.accounts[k].status === 'reconnect') list.push(W.accounts[k].name + ' account'); });
    W.repos.forEach(r => { if (r.status !== 'ok') list.push(r.id); });
    return list;
  }
  function covIcon(st) {
    const m = { ok: ['check', 'st-ok'], partial: ['alert', 'st-warn'], failed: ['error', 'st-error'], stale: ['clock', 'st-warn'], notfound: ['none', 'st-muted'], notrunning: ['none', 'st-muted'], denied: ['lock', 'st-error'], needspassword: ['lock', 'st-error'] }[st] || ['info', 'st-muted'];
    return `<span class="${m[1]}">${icon(m[0])}</span>`;
  }
  // The strip carries state only (an icon and a few words per source). The one prose explanation of a failed refresh, with its
  // freshness, coverage limit and recovery action, lives in the banner; repeating it here, in notices and in cards read as noise.
  function lastRefreshText() { return W.refresh.failed ? W.sources.codex.lastSuccess : 'today, 9:42 AM'; }
  function covItem(status, name, text) {
    return `<span class="cov-item">${covIcon(status)}<span class="cov-text"><b>${esc(name)}</b> ${esc(text)}</span></span>`;
  }
  function coverageStrip() {
    const src = ['codex', 'claude', 'paseo'].map(k => {
      const s = W.sources[k]; let t;
      if (s.status === 'ok') t = 'since ' + U.fmtDayLong(s.oldest);
      else if (s.status === 'partial') t = 'partial · ' + s.unreadable + ' unreadable';
      else if (s.status === 'failed') t = 'refresh failed';
      else if (s.status === 'notfound') t = 'not found';
      else if (s.status === 'notrunning') t = 'not running';
      else if (s.status === 'needspassword') t = 'needs a password';
      else t = 'access denied';
      return covItem(s.status, s.name, t);
    }).join('');
    const ok = trackedIds().length, bad = W.repos.filter(r => r.status !== 'ok').length;
    const gh = covItem(ok ? (bad ? 'partial' : 'ok') : 'notfound', 'GitHub', ok + ' ' + U.plural(ok, 'repo') + ' tracked' + (bad ? ' · ' + bad + ' inaccessible' : ''));
    const acct = ['chatgpt', 'claude'].map(k => {
      const a = W.accounts[k];
      const t = a.status === 'reconnect' ? 'reconnect needed' : !a.report ? 'not connected' : a.report.unit === 'tokens' ? 'tokens · ' + a.report.window.toLowerCase() : '% of limit only';
      return covItem(a.status === 'reconnect' ? 'stale' : a.report ? 'ok' : 'notfound', a.name, t);
    }).join('');
    return `<div class="cov-host"><section class="coverage" aria-label="Source coverage">
      <div class="cov-group"><span class="cov-label">This machine</span><div class="cov-items">${src}</div></div><span class="cov-sep" aria-hidden="true"></span>
      <div class="cov-group"><span class="cov-label">Delivery</span><div class="cov-items">${gh}</div></div><span class="cov-sep" aria-hidden="true"></span>
      <div class="cov-group"><span class="cov-label">Account reports</span><div class="cov-items">${acct}</div></div>
      <div class="cov-end"><span>${W.refresh.failed ? 'Last successful refresh' : 'Refreshed'} ${esc(lastRefreshText())}</span><a href="#/sources">Manage sources</a></div></section></div>`;
  }
  function notice(kind, html) {
    return `<div class="notice ${kind === 'warn' ? 'notice-warn' : ''}">${icon(kind === 'warn' ? 'alert' : 'info')}<span>${html}</span></div>`;
  }
  function rangeNotices(opts) {
    const f = S.f, out = [];
    if (!provs().some(p => W.sources[p].oldest)) {
      out.push(notice('warn', 'No local agent records were found on this machine. Usage here comes from account reports only and can’t be split by repo, session or PR.'));
    } else {
      const parts = provs().filter(p => W.sources[p].oldest && f.start < W.sources[p].oldest).map(p => `${U.PROVIDERS[p]} from ${U.fmtDayLong(W.sources[p].oldest)}`);
      if (parts.length) out.push(notice('info', `Local usage history on this machine starts: ${esc(parts.join('; '))}. Earlier dates show as unavailable, not zero.`));
    }
    // A stale-collection notice used to sit here. It repeated the failed-refresh banner (shown on every screen while a refresh
    // is failing), so it was removed; the per-period readout and KPI keep their own short "not collected / cached" markers.
    if (f.repos.length) out.push(notice('info', 'Repo filter is on: sessions with an unknown or untracked repo are excluded. Account-reported usage stays account-wide.'));
    if (opts && opts.zeroCheck) {
      const ss = sessIn(f), ps = prsIn(f);
      const covered = provs().every(p => { const c = provCov(p, f.start, U.minDate(f.end, T)); return c === 'ok'; });
      if (!ss.length && !ps.length && covered && trackedIds().length) out.push(`<div class="quiet" role="status">${U.crewArt('sleep')}<p><strong>A quiet one.</strong>No recorded agent activity and no merges in this period. Every source was collecting, so this is a true zero, not missing data.</p></div>`);
    }
    return out.join('');
  }
  function emptyRepos() {
    return `<div class="empty">${U.crewArt('search')}<h3>No tracked repositories</h3><p>Add the GitHub repositories you want to follow. Merged PRs, and their links to agent sessions, appear once a repo is tracked. Local usage is still shown without them.</p><a class="btn btn-primary btn-sm" href="#/sources" data-fk="empty-add">${icon('plus')}Add repositories</a></div>`;
  }
  function prItem(p) {
    return `<li class="list-item"><div class="li-main"><a href="${prUrl(p)}" target="_blank" rel="noopener" class="truncate">${esc(p.title)}<span class="sr-only"> (opens GitHub)</span></a><span class="pr-meta">${esc(p.repo)} #${p.number} · ${U.fmtDay(p.date)}, ${U.fmtTime(p.time)}${p.author !== ME ? ' · by ' + esc(p.author) : ''}</span></div>${U.linkBadge(prClass(p))}</li>`;
  }
  function roleText(s) {
    return s.role === 'root' ? 'Root session' : s.role === 'child' ? (s.kind === 'native' ? 'Native subagent' : 'Paseo child agent') : 'Unknown relationship';
  }
  // Session identity: lead with the recorded agent name when one exists (only Paseo records carry one in this fixture). With no
  // recorded name, lead with the recorded relationship and say so; never make a name up. Relationship stays "Unknown" when unknown.
  function sessName(s) {
    return s.paseo && s.paseo.agent ? { text: s.paseo.agent, named: true } : { text: roleText(s), named: false };
  }
  function sessSub(s, extra) {
    const parts = [];
    if (sessName(s).named) {
      parts.push(roleText(s));
      if (s.role !== 'child') parts.push('Paseo'); // roleText already says "Paseo child agent" for children
      parts.push(s.paseo.workspace);
    } else parts.push('No name recorded');
    (extra || []).forEach(x => { if (x) parts.push(x); });
    return parts.join(' · ');
  }
  // The technical ID is secondary but always present, with a screen-reader prefix so it isn't read as a stray string.
  function sessRef(s) { return `<span class="sess-ref mono"><span class="sr-only">Session ID: </span>${esc(s.ref)}</span>`; }
  function sessItem(s) {
    const nm = sessName(s);
    return `<li class="list-item"><div class="li-main"><span class="ev-line"><span class="sess-name">${esc(nm.text)}</span>${U.provTag(s.provider)}</span><span class="pr-meta">${esc(sessSub(s, [s.repo ? s.repo : 'Unknown repo', 'Started ' + U.fmtDay(s.date) + ', ' + U.fmtTime(s.time)]))}</span>${sessRef(s)}</div><span class="num">${U.compact(s.total)}</span></li>`;
  }
  function bucketFilter(b) { return Object.assign({}, S.f, { start: b.a, end: U.minDate(b.b, T) }); }
  function prListBlock(b) {
    if (b.a > T) return '<p class="muted">This period hasn’t happened yet.</p>';
    if (b.dcov === 'none') return emptyRepos();
    const ps = prsIn(bucketFilter(b)).sort((x, y) => y.mergedAt.localeCompare(x.mergedAt));
    if (!ps.length) return `<p class="muted">No merged PRs in this period${S.f.author === 'mine' ? ' authored by you' : ''}. GitHub history for tracked repos covers these dates, so this is a true zero.</p>`;
    return `<ul class="list">${ps.slice(0, 30).map(prItem).join('')}</ul>${ps.length > 30 ? `<p class="footnote">Showing 30 of ${ps.length}. Open in Delivery for all.</p>` : ''}`;
  }
  function sessListBlock(b) {
    if (b.a > T) return '<p class="muted">This period hasn’t happened yet.</p>';
    const notes = provs().map(p => {
      const c = b.cov[p];
      if (c === 'unavailable') return notice('info', `${U.PROVIDERS[p]}: history unavailable for these dates on this machine.`);
      if (c === 'none') return notice('info', `${U.PROVIDERS[p]}: no local records on this machine.`);
      if (c === 'partial') return notice('info', `${U.PROVIDERS[p]}: only part of this period is covered.`);
      if (c === 'stale') return notice('warn', `${U.PROVIDERS[p]}: not collected after the failed refresh.`);
      return '';
    }).join('');
    const ss = sessIn(bucketFilter(b)).sort((x, y) => y.total - x.total);
    const anyCovered = provs().some(p => b.cov[p] === 'ok' || b.cov[p] === 'partial' || b.cov[p] === 'stale');
    if (!ss.length) return notes + (anyCovered ? '<p class="muted">No recorded sessions in this period. Covered sources had no activity, so this is a true zero.</p>' : '');
    return notes + `<ul class="list">${ss.slice(0, 25).map(sessItem).join('')}</ul>${ss.length > 25 ? `<p class="footnote">Showing the 25 largest of ${ss.length} sessions. Open in Usage for all.</p>` : ''}`;
  }

  // ---------- shell ----------
  function appbarActions() {
    if (S.route === 'setup') return `<span class="caption">Step ${S.setup.step} of 3</span>`;
    const n = issues().length;
    // On a phone only the icon and the count stay visible; the words remain for assistive technology (see .sb-w in app.css).
    const state = n
      ? `<span class="status st-warn">${icon('alert')}<span><span class="sb-n">${n}</span><span class="sb-w"> ${U.plural(n, 'source issue')}</span></span></span>`
      : `<span class="status st-ok">${icon('check')}<span class="sb-w">Sources OK</span></span>`;
    return `<a class="btn btn-secondary btn-sm" href="#/sources" data-fk="bar-sources">${state}</a>` +
      `<button type="button" class="btn btn-secondary btn-sm" data-act="refresh-all" data-fk="bar-refresh" ${S.busy.all ? 'aria-busy="true" disabled' : ''}>${icon(S.busy.all ? 'spinner' : 'refresh')}<span class="btn-label">${S.busy.all ? 'Refreshing…' : 'Refresh'}</span></button>`;
  }
  function nav() {
    const n = issues().length;
    // "Sources & repos" is too long for a phone tab; the short label is visual only and the full label stays the accessible name.
    const label = r => r.short
      ? `<span class="nav-label"><span class="nav-full">${esc(r.label)}</span><span class="nav-short" aria-hidden="true">${esc(r.short)}</span></span>`
      : `<span class="nav-label">${esc(r.label)}</span>`;
    const link = r => `<a class="nav-link" href="#/${r.id}" ${S.route === r.id ? 'aria-current="page"' : ''} data-fk="nav-${r.id}">${icon(r.icon)}${label(r)}${r.id === 'sources' && n ? `<span class="nav-badge"><span aria-hidden="true">${n}</span><span class="sr-only">, ${n} issues</span></span>` : ''}</a>`;
    return ROUTES.map(link).join('') + '<div class="nav-spacer"></div>' + link(SRC_ROUTE);
  }
  function banner() {
    if (!W.refresh.failed) return '';
    const s = W.sources.codex, busy = S.busy.codex;
    return `<div class="banner" role="status">${icon('clock')}<div class="banner-body"><strong>Showing cached data.</strong><p>Codex refresh failed ${esc(s.lastAttempt.replace('Failed ', ''))}; last success ${esc(s.lastSuccess)}. Codex usage since then isn’t collected yet; everything already imported is still shown.</p></div>` +
      `<div class="actions"><a class="btn btn-secondary btn-sm" href="#/sources" data-fk="banner-view">View source</a><button type="button" class="btn btn-primary btn-sm" data-act="retry-source" data-val="codex" data-fk="banner-retry" ${busy ? 'aria-busy="true" disabled' : ''}>${icon(busy ? 'spinner' : 'refresh')}${busy ? 'Retrying…' : 'Retry'}</button></div></div>`;
  }
  function filterbar() {
    const f = S.f;
    const isCustom = ['custom', '30d', '90d', '12m'].indexOf(f.period) >= 0;
    const repoLabel = repoScope();
    const summary = `<div class="fb-summary"><p class="fb-summary-text"><b>${esc(PERIOD_LABEL[f.period])}</b> · ${esc(repoLabel)} · ${f.provider === 'all' ? 'All providers' : U.PROVIDERS[f.provider]} · ${f.author === 'mine' ? 'My PRs' : 'All tracked PRs'}</p><button type="button" class="btn btn-secondary btn-sm" data-act="filters-open" data-fk="fb-open" aria-expanded="${S.filtersOpen}">${icon('filter')}Filters</button></div>`;
    const periodSeg = '<div class="seg" role="group" aria-label="Period">' +
      [['today', 'Today'], ['week', 'This week'], ['month', 'This month']].map(o => `<button type="button" class="seg-btn" data-act="period" data-val="${o[0]}" data-fk="period-${o[0]}" aria-pressed="${f.period === o[0]}">${o[1]}</button>`).join('') +
      `<button type="button" class="seg-btn" data-act="pop" data-val="custom" data-fk="period-custom" aria-pressed="${isCustom}" aria-expanded="${S.openPop === 'custom'}" aria-haspopup="dialog">${icon('calendar')}${isCustom ? esc(PERIOD_LABEL[f.period]) : 'Custom'}</button></div>`;
    return summary + `<div class="fb-controls" ${S.filtersOpen ? 'role="dialog" aria-modal="true" aria-label="Filters"' : ''}>
      <div class="fb-sheet-head"><h2>Filters</h2><button type="button" class="icon-btn" data-act="filters-close" aria-label="Close filters" data-fk="fb-close">${icon('close')}</button></div>
      <div class="fb-group"><span class="fb-label">Period</span>${periodSeg}${S.openPop === 'custom' ? customPopover() : ''}</div>
      <div class="fb-group"><span class="fb-range">${esc(U.fmtRange(f.start, f.end))}</span><span class="fb-tz">Times in ${esc(W.tz)} (this machine)</span></div>
      <div class="fb-break"></div>
      <div class="fb-group"><span class="fb-label">Group by</span>${seg('gran', [['day', 'Day'], ['week', 'Week'], ['month', 'Month']], f.gran, 'Group by')}</div>
      <div class="fb-group"><span class="fb-label">Repos <b>· usage &amp; delivery</b></span><button type="button" class="select-btn" data-act="pop" data-val="repos" data-fk="repos-btn" aria-expanded="${S.openPop === 'repos'}" aria-haspopup="dialog">${esc(repoLabel)}${icon('chevronDown')}</button>${S.openPop === 'repos' ? reposPopover() : ''}</div>
      <div class="fb-group"><span class="fb-label">Provider <b>· usage only</b></span>${seg('provider', [['all', 'All'], ['codex', 'Codex'], ['claude', 'Claude Code']], f.provider, 'Provider, applies to usage only')}</div>
      <div class="fb-group"><span class="fb-label">Author <b>· delivery only</b></span>${seg('author', [['mine', 'Mine'], ['all', 'All in tracked repos']], f.author, 'PR author, applies to delivery only')}</div>
      <div class="fb-sheet-foot"><button type="button" class="btn btn-secondary" data-act="filters-reset" data-fk="fb-reset">Reset</button><button type="button" class="btn btn-primary" data-act="filters-close" data-fk="fb-done">Show results</button></div>
    </div>`;
  }
  function customPopover() {
    const d = S.customDraft || { start: S.f.start, end: U.minDate(S.f.end, T) };
    return `<div class="popover${takeEnter('pop') ? ' is-entering' : ''}" role="dialog" aria-label="Custom range">
      <h3>Quick ranges</h3>
      <div class="preset-list">${[['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['12m', 'Last 12 months']].map(o => `<button type="button" class="btn btn-secondary btn-sm" data-act="period" data-val="${o[0]}" data-fk="preset-${o[0]}" aria-pressed="${S.f.period === o[0]}">${o[1]}</button>`).join('')}</div>
      <h3>Custom dates</h3>
      <div class="field-row"><div class="field"><label for="cr-start">From</label><input class="input" type="date" id="cr-start" data-input="cr-start" min="${F.LOOKBACK_START}" max="${T}" value="${d.start}" data-fk="cr-start"></div>
      <div class="field"><label for="cr-end">To</label><input class="input" type="date" id="cr-end" data-input="cr-end" min="${F.LOOKBACK_START}" max="${T}" value="${d.end}" data-fk="cr-end"></div></div>
      ${d.error ? `<p class="field-error" role="alert">${icon('error')}<span>${esc(d.error)}</span></p>` : ''}
      <p class="field-hint">Up to 12 months back, from ${U.fmtDayLong(F.LOOKBACK_START)}. Earlier data isn’t retained.</p>
      <div class="actions"><button type="button" class="btn btn-secondary btn-sm" data-act="pop-close" data-fk="cr-cancel">Cancel</button><button type="button" class="btn btn-primary btn-sm" data-act="custom-apply" data-fk="cr-apply">Apply</button></div>
    </div>`;
  }
  function reposPopover() {
    return `<div class="popover${takeEnter('pop') ? ' is-entering' : ''}" role="dialog" aria-label="Repository filter"><h3>Tracked repositories</h3>
      ${W.repos.length ? W.repos.map(r => `<label class="check-row ${r.status !== 'ok' ? 'is-disabled' : ''}"><input type="checkbox" data-act="repo-toggle" data-val="${esc(r.id)}" data-fk="rf-${esc(r.id)}" ${S.f.repos.indexOf(r.id) >= 0 ? 'checked' : ''} ${r.status !== 'ok' ? 'disabled' : ''}>${esc(r.id)}${r.status !== 'ok' ? ' <span class="caption">(inaccessible)</span>' : ''}</label>`).join('') : '<p class="muted">No tracked repositories yet.</p>'}
      <p class="field-hint">Applies to local usage and merged PRs. While a repo is selected, sessions with an unknown or untracked repo are excluded. Account-reported usage stays account-wide.</p>
      <div class="actions"><button type="button" class="btn btn-secondary btn-sm" data-act="repo-clear" data-fk="rf-clear">All repos</button><button type="button" class="btn btn-primary btn-sm" data-act="pop-close" data-fk="rf-done">Done</button></div></div>`;
  }

  // ---------- Overview ----------
  function prevRange(f) {
    const len = U.diffDays(f.start, f.end) + 1;
    const s = U.addDays(f.start, -len), e = U.addDays(f.start, -1);
    return { start: s, end: e, len, ok: s >= F.LOOKBACK_START };
  }
  function kpis(ps, ss) {
    const f = S.f, pr = prevRange(f), noRepos = !trackedIds().length;
    const prevLabel = f.period === 'today' ? 'Yesterday' : f.period === 'week' ? 'Last week' : 'Previous ' + pr.len + ' ' + U.plural(pr.len, 'day');
    const prevTxt = pr.ok ? prevLabel + ': ' + prsIn(Object.assign({}, f, { start: pr.start, end: pr.end })).length : prevLabel + ': outside the 12-month lookback';
    const linked = ps.filter(isLinked).length, sugg = ps.filter(p => prClass(p) === 'suggested').length;
    const roots = ss.filter(s => s.role === 'root').length, kids = ss.filter(s => s.role === 'child'), unk = ss.filter(s => s.role === 'unknown').length;
    const paseoKids = kids.filter(s => s.kind === 'paseo').length;
    const hasLocal = provs().some(p => W.sources[p].oldest);
    const tok = provs().map(p => {
      const cov = provCov(p, f.start, U.minDate(f.end, T));
      const v = sum(ss.filter(s => s.provider === p));
      const val = cov === 'none' ? '<div class="kpi-unavail">No local records</div>' : cov === 'unavailable' ? '<div class="kpi-unavail">History unavailable</div>' : `<div class="kpi-value">${U.compact(v)}</div>`;
      const meta = cov === 'partial' ? `<div class="kpi-meta">From ${U.fmtDay(W.sources[p].oldest)} only</div>` : cov === 'stale' ? '<div class="kpi-meta">Cached; recent days missing</div>' : '';
      return `<div>${U.provTag(p)}${val}${meta}</div>`;
    }).join('');
    return `
      <div class="kpi kpi-wide kpi-primary"><div class="kpi-label">Merged PRs</div><p class="scope">${scopeDelivery()}</p>${noRepos ? '<div class="kpi-unavail">No tracked repos</div><div class="kpi-meta"><a href="#/sources">Add repositories</a></div>' : `<div class="kpi-value">${ps.length}</div><div class="kpi-meta">${esc(prevTxt)}</div>`}</div>
      <div class="kpi"><div class="kpi-label">Linked PRs</div><p class="scope">Evidence or owner-confirmed</p>${noRepos ? '<div class="kpi-unavail">—</div>' : `<div class="kpi-value">${linked}<small>of ${ps.length}</small></div><div class="kpi-meta">${sugg} with suggestions only</div>`}</div>
      <div class="kpi kpi-wide kpi-tokens"><div class="kpi-label">Recorded local tokens</div><p class="scope">${scopeUsage()}</p><div class="kpi-split">${tok}</div><div class="kpi-meta">Provider totals aren’t combined.</div></div>
      <div class="kpi"><div class="kpi-label">Root sessions</div><p class="scope">Active in period</p>${hasLocal ? `<div class="kpi-value">${roots}</div>${U.crewRow(ss.filter(s => s.role === 'root').map(s => s.provider), 9)}<div class="kpi-meta">${unk} with unknown relationship</div>` : '<div class="kpi-unavail">No local records</div>'}</div>
      <div class="kpi"><div class="kpi-label">Child agents</div><p class="scope">Known parent, active in period</p>${hasLocal ? `<div class="kpi-value">${kids.length}</div>${U.crewRow(kids.map(s => s.provider), 9)}<div class="kpi-meta">Paseo ${paseoKids} · native ${kids.length - paseoKids}</div>` : '<div class="kpi-unavail">No local records</div>'}</div>`;
  }
  function skeletonKpis() {
    let s = '';
    ['kpi-wide kpi-primary', '', 'kpi-wide kpi-tokens', '', ''].forEach(c => { s += `<div class="kpi ${c}" aria-hidden="true"><div class="skeleton sk-line"></div><div class="skeleton sk-value"></div><div class="skeleton sk-line" style="width:80%"></div></div>`; });
    return s + '<p class="sr-only" role="status">Loading summary metrics</p>';
  }
  function acctCard(k) {
    const a = W.accounts[k], busy = S.busy['acct-' + k];
    const head = `<div class="acct-head"><span class="prov">${U.provMark(a.provider)}<b>${a.name}</b><span class="caption">· ${a.provider === 'codex' ? 'Codex' : 'Claude Code'} plan</span></span>${busy ? U.statusTag('connecting', 'Waiting for sign-in…') : U.statusTag(a.status, a.statusText)}</div>`;
    if (!a.report) {
      return `<div class="acct">${head}<p class="caption">No account report. Local usage from this machine is still shown.</p><div class="actions start"><button type="button" class="btn btn-secondary btn-sm" data-act="acct-connect" data-val="${k}" data-fk="acct-${k}" ${busy ? 'disabled' : ''}>Connect ${a.name}</button></div></div>`;
    }
    const r = a.report; let body;
    if (r.unit === 'tokens') {
      const local = sum(W.sessions.filter(s => s.provider === a.provider && s.date >= r.start && s.date <= r.end));
      const differs = r.start !== S.f.start || r.end !== U.minDate(S.f.end, T);
      body = `<div class="acct-value">${U.compact(r.total)}<small>tokens</small></div>
        <div class="acct-chips"><span class="chip">${icon('calendar')}${esc(U.fmtRange(r.start, r.end))} · ${esc(r.window)}</span><span class="chip">${esc(r.scope)}</span></div>
        <p class="acct-compare">This machine recorded <b>${local ? U.compact(local) : 'no'}</b> Codex tokens in the same window. Shown separately, not added together.</p>
        ${differs ? notice('warn', `Reporting window differs from your selected period (${esc(U.fmtRange(S.f.start, S.f.end))}). It isn’t used in trends.`) : ''}`;
    } else {
      body = `<div class="acct-value">${r.value}%<small>${esc(r.label)}</small></div>
        <div class="acct-chips"><span class="chip">${esc(r.resets)}</span><span class="chip">${esc(r.scope)}</span></div>
        <p class="acct-compare">Subscription tokens unavailable: this account reports a usage percentage, not tokens.</p>`;
    }
    const foot = r.stale
      ? `<p class="caption">Last report ${esc(r.refreshed)}, so these figures may be out of date.</p><div class="actions start"><button type="button" class="btn btn-primary btn-sm" data-act="acct-connect" data-val="${k}" data-fk="acct-${k}" ${busy ? 'disabled aria-busy="true"' : ''}>Reconnect ${a.name}</button></div>`
      : `<p class="caption">Updated ${esc(r.refreshed)}</p>`;
    return `<div class="acct">${head}${body}${foot}</div>`;
  }
  function accountCards() {
    const ks = ['chatgpt', 'claude'].filter(k => S.f.provider === 'all' || W.accounts[k].provider === S.f.provider);
    return ks.map(acctCard).join('') + '<p class="footnote">Account reports keep their own unit and window. They’re never added to local usage, split by repo or agent, or drawn into the trend.</p>';
  }
  function tokCell(ss, p) {
    const c = provCov(p, S.f.start, U.minDate(S.f.end, T));
    if (c === 'none') return 'No records';
    if (c === 'unavailable') return 'Unavailable';
    return U.compact(sum(ss.filter(s => s.provider === p)));
  }
  function repoTable(ps, ss) {
    const f = S.f, pv = provs();
    const shown = W.repos.filter(r => !f.repos.length || f.repos.indexOf(r.id) >= 0);
    const rows = shown.map(r => {
      if (r.status !== 'ok') {
        return `<tr><td class="lead" data-label="Repository">${esc(r.id)} ${U.statusTag('inaccessible', 'Inaccessible')} <a href="#/sources" class="caption">Fix</a></td><td class="r" data-label="Merged PRs">—</td><td class="r" data-label="Linked">—</td>${pv.map(p => `<td class="r" data-label="${U.PROVIDERS[p]} tokens">—</td>`).join('')}<td class="r" data-label="Root sessions">—</td></tr>`;
      }
      const rp = ps.filter(p => p.repo === r.id), rs = ss.filter(s => s.repo === r.id);
      return `<tr><td class="lead" data-label="Repository">${esc(r.id)}</td><td class="r" data-label="Merged PRs">${rp.length}</td><td class="r" data-label="Linked">${rp.filter(isLinked).length}</td>${pv.map(p => `<td class="r" data-label="${U.PROVIDERS[p]} tokens">${tokCell(rs, p)}</td>`).join('')}<td class="r" data-label="Root sessions">${rs.filter(s => s.role === 'root').length}</td></tr>`;
    });
    if (!f.repos.length) {
      [['Untracked repos', ss.filter(s => s.repo && !isTracked(s.repo))], ['Unknown repo', ss.filter(s => !s.repo)]].forEach(g => {
        if (!g[1].length) return;
        rows.push(`<tr class="row-sub"><td class="lead" data-label="Repository">${g[0]} <span class="caption">(usage only)</span></td><td class="r" data-label="Merged PRs">n/a</td><td class="r" data-label="Linked">n/a</td>${pv.map(p => `<td class="r" data-label="${U.PROVIDERS[p]} tokens">${tokCell(g[1], p)}</td>`).join('')}<td class="r" data-label="Root sessions">${g[1].filter(s => s.role === 'root').length}</td></tr>`);
      });
    }
    const none = !W.repos.length ? '<p class="footnote">No tracked repositories yet, so merged PRs aren’t available. Recorded usage is grouped by the repo each session recorded.</p>' : '';
    return none + `<div class="table-wrap"><table class="table stack"><caption class="sr-only">Merged PRs and recorded local tokens by repository</caption><thead><tr><th>Repository</th><th class="r">Merged PRs</th><th class="r">Linked</th>${pv.map(p => `<th class="r">${U.PROVIDERS[p]} tokens</th>`).join('')}<th class="r">Root sessions</th></tr></thead><tbody>${rows.join('') || `<tr><td colspan="${4 + pv.length}" class="muted">No recorded activity in this period.</td></tr>`}</tbody></table></div>`;
  }
  function recentList(ps) {
    if (!trackedIds().length) return emptyRepos();
    const top = ps.slice().sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, 6);
    if (!top.length) return `<div class="empty"><p>No merged PRs in this period${S.f.author === 'mine' ? ' authored by you' : ''}. Agent work that didn’t merge still appears in Usage.</p></div>`;
    return `<ul class="list">${top.map(prItem).join('')}</ul><div class="card-foot"><span class="footnote">${ps.length} merged in this period</span><a href="#/delivery">View all in Delivery</a></div>`;
  }
  function pageOverview() {
    const f = S.f, ps = prsIn(f), ss = sessIn(f), loading = S.loadingPhase === 'loading';
    return pageHead(GREETING, 'Here’s what merged and where your agents spent their tokens · ' + esc(PERIOD_LABEL[f.period]).toLowerCase() + ', ' + esc(U.fmtRange(f.start, f.end))) +
      coverageStrip() + rangeNotices({ zeroCheck: true }) +
      `<section class="kpis" aria-label="Summary metrics">${loading ? skeletonKpis() : kpis(ps, ss)}</section>
      <div class="grid">
        <section class="card span-8" aria-labelledby="ov-chart-t"><div class="card-head"><div><h2 id="ov-chart-t">Delivery and usage over time</h2><p class="scope">PRs: ${scopeDelivery()} · Tokens: ${scopeUsage()}</p></div></div>${chartBlock('ov', f, 'Merged PRs and recorded local tokens by ' + f.gran)}</section>
        <section class="card span-4" aria-labelledby="ov-acct-t"><div class="card-head"><div><h2 id="ov-acct-t">Account-reported usage</h2><p class="scope">Account-wide · own reporting window <span class="tag">Not filtered by repo</span></p></div></div>${accountCards()}</section>
        <section class="card span-7" aria-labelledby="ov-repo-t"><div class="card-head"><div><h2 id="ov-repo-t">By repository</h2><p class="scope">PRs: ${scopeDelivery()} · Tokens: ${scopeUsage()}</p></div></div>${repoTable(ps, ss)}</section>
        <section class="card span-5" aria-labelledby="ov-recent-t"><div class="card-head"><div><h2 id="ov-recent-t">Recently merged</h2><p class="scope">${scopeDelivery()}</p></div></div>${recentList(ps)}</section>
      </div>`;
  }

  // ---------- Trends ----------
  function modelBreakdown(ss) {
    return provs().map(p => {
      const rows = {};
      ss.filter(s => s.provider === p).forEach(s => { rows[s.model] = rows[s.model] || { t: 0, n: 0 }; rows[s.model].t += s.total; rows[s.model].n++; });
      const keys = Object.keys(rows).sort((a, b) => rows[b].t - rows[a].t);
      const tot = keys.reduce((a, k) => a + rows[k].t, 0);
      const cov = provCov(p, S.f.start, U.minDate(S.f.end, T));
      const body = cov === 'none' ? '<p class="muted">No local records on this machine.</p>' : cov === 'unavailable' ? '<p class="muted">History unavailable for this period.</p>' : !keys.length ? '<p class="muted">No recorded sessions in scope.</p>' :
        `<div class="model-bars">${keys.map(k => { const pct = tot ? Math.round(rows[k].t / tot * 100) : 0; return `<div class="model-row"><span class="mono truncate" title="${esc(k)}">${esc(k)}</span><div class="model-track" role="img" aria-label="${pct}% of ${U.PROVIDERS[p]} tokens"><div class="model-fill ${p}" style="width:${pct}%"></div></div><span class="r num">${U.compact(rows[k].t)} <span class="caption">${pct}%</span></span></div>`; }).join('')}</div>`;
      return `<div class="card-sub span-6"><h3>${U.provTag(p)}</h3>${body}</div>`;
    }).join('');
  }
  function pageTrends() {
    const f = S.f;
    const block = chartBlock('tr', f, 'Merged PRs and recorded local tokens by ' + f.gran);
    const c = S.charts.tr;
    const b = S.trendSel != null ? c.buckets[S.trendSel] : null;
    return pageHead('Trends', esc(PERIOD_LABEL[f.period]) + ' · ' + esc(U.fmtRange(f.start, f.end)) + ' · by ' + f.gran) + rangeNotices() +
      yearCard() +
      `<section class="card" aria-labelledby="tr-chart-t"><div class="card-head"><div><h2 id="tr-chart-t">Merged PRs and recorded local tokens</h2><p class="scope">PRs: ${scopeDelivery()} · Tokens: ${scopeUsage()}</p></div></div>${block}</section>
      <section class="card" aria-labelledby="tr-rec-t"><div class="card-head"><div><h2 id="tr-rec-t">${b ? 'Records in ' + esc(b.label) : 'Period records'}</h2><p class="scope">Current filters apply</p></div>${b ? `<div class="actions"><button type="button" class="btn btn-ghost btn-sm" data-act="trend-clear" data-fk="tr-clear">Clear selection</button><button type="button" class="btn btn-secondary btn-sm" data-act="drill" data-val="usage" data-a="${b.a}" data-b="${b.b}">Open in Usage</button><button type="button" class="btn btn-primary btn-sm" data-act="drill" data-val="delivery" data-a="${b.a}" data-b="${b.b}">Open in Delivery</button></div>` : ''}</div>
        ${b ? `<div class="grid"><div class="card-sub span-6"><h3>Merged PRs</h3>${prListBlock(b)}</div><div class="card-sub span-6"><h3>Sessions</h3>${sessListBlock(b)}</div></div>` : '<p class="muted">Select a period in the chart, or in its table view, to list the merged PRs and sessions inside it.</p>'}</section>
      <section class="card" aria-labelledby="tr-model-t"><div class="card-head"><div><h2 id="tr-model-t">Recorded tokens by model</h2><p class="scope">${scopeUsage()} · share within each provider; providers aren’t compared on one scale</p></div></div><div class="grid">${modelBreakdown(sessIn(f))}</div></section>`;
  }

  // Year of merges: delivery history covers the whole lookback for tracked repos, so every drawn
  // cell is a real count (0 included). The Period filter only outlines its days; repo/author apply.
  function yearCard() {
    if (!trackedIds().length) return '';
    const yf = Object.assign({}, S.f, { start: F.LOOKBACK_START, end: T });
    const counts = {};
    let total = 0;
    prsIn(yf).forEach(p => { counts[p.date] = (counts[p.date] || 0) + 1; total++; });
    const days = Object.keys(counts);
    let best = null;
    days.forEach(d => { if (!best || counts[d] > counts[best] || (counts[d] === counts[best] && d > best)) best = d; });
    const label = `Merged PRs per day for the last 12 months: ${total} in total across ${days.length} days.` + (best ? ` Busiest day ${U.fmtDayLong(best)} with ${counts[best]}.` : '') + ' Days in the selected period are outlined.';
    const legend = '<span class="year-legend" aria-hidden="true">Fewer <i style="background:var(--color-surface-sunken)"></i><i style="background:var(--color-heat-1)"></i><i style="background:var(--color-heat-2)"></i><i style="background:var(--color-heat-3)"></i><i style="background:var(--color-heat-4)"></i> More</span>';
    return `<section class="card" aria-labelledby="yr-t"><div class="card-head"><div><h2 id="yr-t">A year of merges</h2><p class="scope">${scopeDelivery()} · last 12 months · selected period outlined</p></div>${legend}</div>
      <div class="year-wrap">${U.yearGrid({ start: F.LOOKBACK_START, today: T, counts, rangeStart: f0(S.f.start), rangeEnd: U.minDate(S.f.end, T), label })}</div>
      <div class="year-facts"><span><b>${total}</b> merged PRs</span><span><b>${days.length}</b> days with a merge</span>${best ? `<span>Busiest day <b>${U.fmtDay(best)}</b> (${counts[best]})</span>` : ''}<span>Click a day to look at it below.</span><span class="year-hint">Scroll sideways to see the full year; it opens on the newest weeks.</span></div></section>`;
  }
  function f0(d) { return d < F.LOOKBACK_START ? F.LOOKBACK_START : d; }
  function openDay(d) {
    S.f.period = 'custom'; S.f.start = d; S.f.end = d; S.f.gran = 'day';
    const view = S.charts.tr ? S.charts.tr.view : 'chart';
    S.charts = { tr: { view, sel: 0, focus: null } };
    S.trendSel = 0; S.drawer = null;
    render();
    announce('Showing ' + U.fmtDayLong(d) + '.');
  }

  // ---------- Delivery ----------
  function candidates(p) {
    const lo = U.addDays(p.date, -3), have = p.links.map(l => l.sid);
    return W.sessions.filter(s => s.repo === p.repo && s.date >= lo && s.date <= p.date && have.indexOf(s.id) < 0)
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).slice(0, 30);
  }
  function evItem(p, l) {
    const s = W.sessionById[l.sid];
    const kind = l.rejected ? 'rejected' : l.cls;
    const d = `data-pr="${p.id}" data-sid="${l.sid}"`;
    let actions;
    if (l.rejected) actions = `<button type="button" class="btn btn-secondary btn-sm" data-act="link-restore" ${d} data-fk="lr-${p.id}-${l.sid}">Restore</button>`;
    else if (l.cls === 'suggested') actions = `<button type="button" class="btn btn-secondary btn-sm" data-act="link-dismiss" ${d} data-fk="ld-${p.id}-${l.sid}">Dismiss</button><button type="button" class="btn btn-primary btn-sm" data-act="link-confirm" ${d} data-fk="lc-${p.id}-${l.sid}">Confirm link</button>`;
    else if (l.cls === 'owner') actions = `<button type="button" class="btn btn-secondary btn-sm" data-act="link-remove" ${d} data-fk="lm-${p.id}-${l.sid}">Remove link</button>`;
    else actions = `<button type="button" class="btn btn-ghost btn-sm" data-act="link-reject" ${d} data-fk="lj-${p.id}-${l.sid}">Mark incorrect</button>`;
    const basis = l.rejected ? `Source claim kept: ${l.basis}. You marked it incorrect, so it isn’t counted as linked.` : l.basis;
    return `<div class="ev ${l.cls === 'suggested' && !l.rejected ? 'is-suggested' : ''} ${l.rejected ? 'is-rejected' : ''}"><div class="ev-main">
      <div class="ev-line">${U.linkBadge(kind)}<span class="sess-name">${esc(sessName(s).text)}</span>${U.provTag(s.provider)}</div>
      <div class="ev-line caption"><span>${esc(sessSub(s))}</span><span>Started ${U.fmtDay(s.date)}, ${U.fmtTime(s.time)}</span><span class="mono">${esc(s.model)}</span><span>${U.compact(s.total)} tokens recorded in this session</span>${sessRef(s)}</div>
      <p class="ev-basis">Basis: ${esc(basis)}</p></div><div class="ev-actions">${actions}</div></div>`;
  }
  function addLinkForm(p) {
    const cs = candidates(p);
    if (!cs.length) return `<p class="muted">No other local sessions in ${esc(p.repo)} in the 3 days before this merge.</p><div><button type="button" class="btn btn-secondary btn-sm" data-act="link-add-cancel" data-fk="lac-${p.id}">Close</button></div>`;
    return `<div class="add-link"><div class="field"><label for="al-${p.id}">Session in ${esc(p.repo)}, up to 3 days before the merge</label><select id="al-${p.id}" data-input="addlink" data-fk="als-${p.id}">${cs.map(s => `<option value="${s.id}" ${S.addLinkPick === s.id ? 'selected' : ''}>${esc(sessName(s).text)} · ${U.PROVIDERS[s.provider]} · started ${U.fmtDay(s.date)} ${U.fmtTime(s.time)} · ${esc(s.ref)}</option>`).join('')}</select></div>
      <div class="actions"><button type="button" class="btn btn-secondary btn-sm" data-act="link-add-cancel" data-fk="lac-${p.id}">Cancel</button><button type="button" class="btn btn-primary btn-sm" data-act="link-add" data-pr="${p.id}" data-fk="lad-${p.id}">Add link</button></div></div>
      <p class="field-hint">Your link is labeled Owner-confirmed and can be removed later. It doesn’t change what the source recorded.</p>`;
  }
  function prDetail(p) {
    const items = p.links.filter(l => W.sessionById[l.sid]).map(l => evItem(p, l)).join('');
    const cs = candidates(p);
    let none = '';
    if (!items) {
      none = p.author !== ME
        ? `<p class="muted">Authored by ${esc(p.author)}. No sessions from this machine are linked.</p>`
        : `<p class="muted">No session evidence found for this PR. ${cs.length ? 'You can link a session yourself.' : 'No local sessions were recorded in this repo in the 3 days before the merge.'}</p>`;
    }
    const add = S.addLinkFor === p.id ? addLinkForm(p) : (cs.length ? `<div><button type="button" class="btn btn-secondary btn-sm" data-act="link-add-open" data-val="${p.id}" data-fk="lao-${p.id}">${icon('plus')}Link a session</button></div>` : '');
    return `<div class="pr-evidence">${items ? `<div class="ev-list">${items}</div>` : ''}${none}${add}<p class="footnote">A linked session is recorded evidence of involvement, not proof it produced the PR alone. Its tokens stay on the dates they were used and aren’t assigned to this PR.</p></div>`;
  }
  function prRow(p) {
    const open = !!S.prOpen[p.id];
    const ls = activeLinks(p), conf = ls.filter(l => l.cls !== 'suggested'), sug = ls.filter(l => l.cls === 'suggested');
    const pv = uniq(conf.map(l => W.sessionById[l.sid].provider));
    const linkedCell = conf.length
      ? `<span class="prov-list">${pv.map(U.provTag).join('')}</span><div class="pr-meta">${conf.length} ${U.plural(conf.length, 'session')}${sug.length ? ' · +' + sug.length + ' suggested' : ''}</div>`
      : sug.length ? `<span class="pr-meta">${sug.length} suggested</span>` : '<span class="pr-meta">None</span>';
    return `<tr class="pr-row">
      <td class="lead" data-label="Pull request"><div class="pr-cell"><button type="button" class="row-toggle" data-act="pr-toggle" data-val="${p.id}" data-fk="prt-${p.id}" aria-expanded="${open}" ${open ? `aria-controls="prd-${p.id}"` : ''} aria-label="${open ? 'Hide' : 'Show'} link evidence for ${esc(p.title)}">${icon('chevronRight')}</button>
        <div class="pr-title"><a href="${prUrl(p)}" target="_blank" rel="noopener">${esc(p.title)} <span class="ext">${icon('external')}</span><span class="sr-only"> (opens GitHub)</span></a><div class="pr-meta">${esc(p.repo)} #${p.number}</div></div></div></td>
      <td data-label="Merged">${U.fmtDay(p.date)}, ${U.fmtTime(p.time)}</td>
      <td data-label="Author">${p.author === ME ? 'You' : esc(p.author)}</td>
      <td data-label="Merged by">${p.mergedBy === ME ? 'You' : esc(p.mergedBy)}</td>
      <td data-label="Linked sessions">${linkedCell}</td>
      <td data-label="Link basis">${U.linkBadge(prClass(p))}</td></tr>
      ${open ? `<tr class="pr-detail" id="prd-${p.id}"><td colspan="6">${prDetail(p)}</td></tr>` : ''}`;
  }
  function pageDelivery() {
    const f = S.f;
    const head = pageHead('Delivery', esc(PERIOD_LABEL[f.period]) + ' · ' + esc(U.fmtRange(f.start, f.end)) + ' · ' + scopeDelivery());
    if (!trackedIds().length) return head + emptyRepos();
    const all = prsIn(f).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    const counts = { all: all.length, evidence: 0, owner: 0, suggested: 0, unlinked: 0 };
    all.forEach(p => { counts[prClass(p)]++; });
    const q = S.prQuery.trim().toLowerCase();
    const list = all.filter(p => (S.linkFilter === 'all' || prClass(p) === S.linkFilter) && (!q || (p.title + ' ' + p.repo + ' #' + p.number).toLowerCase().indexOf(q) >= 0));
    if (S.focusNext && S.focusNext.indexOf('prt-') === 0) {
      const ix = list.findIndex(p => 'prt-' + p.id === S.focusNext);
      if (ix >= S.prCap) S.prCap = ix + 1;
    }
    const shown = list.slice(0, S.prCap);
    const chips = seg('linkfilter', [
      ['all', `All <span class="seg-count">${counts.all}</span>`], ['evidence', `Evidence <span class="seg-count">${counts.evidence}</span>`],
      ['owner', `Owner-confirmed <span class="seg-count">${counts.owner}</span>`], ['suggested', `Suggested only <span class="seg-count">${counts.suggested}</span>`],
      ['unlinked', `Unlinked <span class="seg-count">${counts.unlinked}</span>`]], S.linkFilter, 'Filter by link basis');
    const inacc = W.repos.filter(r => r.status !== 'ok');
    return head + (inacc.length ? notice('warn', `${esc(inacc.map(r => r.id).join(', '))} ${inacc.length === 1 ? 'is' : 'are'} inaccessible. ${inacc.length === 1 ? 'Its' : 'Their'} PRs are excluded until access is restored. <a href="#/sources">Fix in Sources &amp; repos</a>`) : '') +
      `<section class="card" aria-labelledby="dl-t"><div class="card-head"><div><h2 id="dl-t">Merged pull requests</h2><p class="scope">${scopeDelivery()} · counted on merge date · each PR counts once, however many sessions link to it</p></div></div>
      <div class="chart-head">${chips}<div class="field"><label class="sr-only" for="prq">Search pull requests</label><input class="input" id="prq" type="search" placeholder="Search title, repo or #" value="${esc(S.prQuery)}" data-input="prq" data-fk="prq"></div></div>
      ${shown.length ? `<div class="table-wrap"><table class="table stack pr-table"><caption class="sr-only">Merged pull requests with linked sessions and link basis</caption><thead><tr><th>Pull request</th><th>Merged</th><th>Author</th><th>Merged by</th><th>Linked sessions</th><th>Link basis</th></tr></thead><tbody>${shown.map(prRow).join('')}</tbody></table></div>` : `<div class="empty"><p>${all.length ? 'No PRs match these filters.' : `No merged PRs in this period${f.author === 'mine' ? ' authored by you' : ''}.`}</p></div>`}
      ${list.length > shown.length ? `<div><button type="button" class="btn btn-secondary btn-sm" data-act="pr-more" data-fk="pr-more">Show ${Math.min(50, list.length - shown.length)} more</button> <span class="caption">${list.length - shown.length} not shown</span></div>` : ''}
      </section>`;
  }

  // ---------- Usage ----------
  function linkMap() {
    const m = {};
    W.prs.forEach(p => {
      if (!isTracked(p.repo)) return;
      // Each entry keeps the link's own evidence class (evidence | owner | suggested) so the Usage tree can name it, as Delivery does.
      p.links.forEach(l => { if (l.rejected) return; (m[l.sid] = m[l.sid] || []).push({ p: p, cls: l.cls }); });
    });
    return m;
  }
  function catCard(p, ss) {
    const xs = ss.filter(s => s.provider === p), t = {};
    xs.forEach(s => Object.keys(s.tokens).forEach(k => { t[k] = (t[k] || 0) + s.tokens[k]; }));
    const cov = provCov(p, S.f.start, U.minDate(S.f.end, T));
    const rows = p === 'codex'
      ? [['Input', t.input], ['Cached input', t.cached, 'sub', 'included in input'], ['Output', t.output], ['Reasoning', t.reasoning, 'sub', 'included in output']]
      : [['Input (uncached)', t.input], ['Cache write', t.cacheWrite], ['Cache read', t.cacheRead], ['Output', t.output]];
    const body = cov === 'none' ? '<p class="muted">No local records on this machine.</p>' : cov === 'unavailable' ? '<p class="muted">History unavailable for this period.</p>' :
      `<table class="cat-table"><caption class="sr-only">${U.PROVIDERS[p]} token categories</caption><tbody>${rows.map(r => `<tr class="${r[2] || ''}"><td><span class="cat-name">${r[0]}</span>${r[3] ? `<span class="cat-note">${r[3]}</span>` : ''}</td><td class="r num">${U.int(r[1] || 0)}</td></tr>`).join('')}<tr class="total"><td>Provider total</td><td class="r num">${U.int(t.total || 0)}</td></tr></tbody></table>
      <p class="footnote">${p === 'codex' ? 'Total = input + output. Cached input and reasoning are subsets and aren’t added again.' : 'Total = uncached input + cache write + cache read + output (separate categories, none counted twice).'}${cov === 'partial' ? ' Covers ' + U.fmtDayLong(W.sources[p].oldest) + ' onward only.' : ''}</p>`;
    return `<section class="card span-6" aria-label="${U.PROVIDERS[p]} token categories"><div class="card-head"><div><h2>${U.provTag(p)}</h2><p class="scope">${scopeUsage()}</p></div><span class="caption">${xs.length} sessions</span></div>${body}</section>`;
  }
  function sessRow(s, level, nKids, open, lm, note) {
    const toggle = nKids
      ? `<button type="button" class="row-toggle" data-act="tree" data-val="${s.id}" data-fk="tt-${s.id}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} ${nKids} child ${U.plural(nKids, 'agent')} of ${esc(sessName(s).text)}, ${esc(s.ref)}">${icon('chevronRight')}</button>`
      : '<span class="row-toggle" aria-hidden="true"></span>';
    // Linked PRs: every link names its evidence level with the same badge vocabulary as Delivery (Evidence link, Owner-confirmed,
    // Suggested). A session with no link in a tracked repo says "Unlinked"; where PRs were never collected (repo not tracked, or no
    // repo recorded) it says so instead, because "Unlinked" would claim a check that could not happen.
    const e = lm[s.id];
    const order = { evidence: 0, owner: 1, suggested: 2 };
    const pl = e && e.length
      ? e.slice().sort((a, b) => order[a.cls] - order[b.cls]).map(x => `<span class="pl-item"><button type="button" class="btn btn-ghost btn-sm" data-act="goto-pr" data-val="${x.p.id}" data-fk="gp-${s.id}-${x.p.id}">#${x.p.number}</button>${U.linkBadge(x.cls)}</span>`).join('')
      : s.repo && isTracked(s.repo) ? `<span class="pl-item">${U.linkBadge('unlinked')}</span>`
      : `<span class="caption">${s.repo ? 'Repo not tracked, so PRs not checked' : 'No repo recorded, so PRs not checked'}</span>`;
    const mark = U.buddy(s.role === 'unknown' ? 'unknown' : s.provider, { size: s.role === 'root' ? 18 : 13 });
    const when = U.fmtDay(s.date) + ', ' + U.fmtTime(s.time);
    const sub = sessSub(s, [nKids ? nKids + ' ' + U.plural(nKids, 'child', 'children') : '', note]);
    // Columns: Session | Provider | Model | Active | Tokens | Linked PRs. On a phone Provider, Model and Active are hidden and
    // their values appear in .sess-meta, so the table keeps three readable columns.
    // D5: on a phone a session row is a two-line card: identity across the full width, then Tokens and Linked PRs on their own
    // aligned line. `.tok` and `.plc` carry data-label so that line can name its values.
    return `<tr class="sess-row tree-l${level}"><td><div class="tree-cell">${toggle}${mark}<div class="sess-id"><span class="sess-name">${esc(sessName(s).text)}</span><span class="role-tag">${esc(sub)}</span>${sessRef(s)}<span class="sess-meta">${U.PROVIDERS[s.provider]} · ${esc(s.model)} · Started ${when}</span></div></div></td>
      <td class="hide-sm">${U.PROVIDERS[s.provider]}</td><td class="hide-sm mono">${esc(s.model)}</td>
      <td class="hide-sm">${when}</td><td class="r tok" data-label="Tokens">${U.compact(s.total)}</td><td class="plc" data-label="Linked PRs"><div class="pl-list">${pl}</div></td></tr>`;
  }
  // A row that is not a session (group header, "show more", unknown-relationship header) still carries all six cells so the
  // columns stay aligned when some are hidden on a phone; colspan would span the wrong columns there.
  function treeRow(cls, first, tokens) {
    return `<tr class="${cls}"><td>${first}</td><td class="hide-sm"></td><td class="hide-sm"></td><td class="hide-sm"></td><td class="r">${tokens || ''}</td><td></td></tr>`;
  }
  function usageTree(ss) {
    const f = S.f, lm = linkMap();
    const groups = W.repos.filter(r => r.status === 'ok' && (!f.repos.length || f.repos.indexOf(r.id) >= 0)).map(r => ({ key: r.id, label: r.id, items: ss.filter(s => s.repo === r.id) }));
    if (!f.repos.length) {
      groups.push({ key: '__untracked', label: 'Untracked repos', note: 'repo recorded, not on your tracked list', items: ss.filter(s => s.repo && !isTracked(s.repo)) });
      groups.push({ key: '__unknown', label: 'Unknown repo', note: 'no repository recorded', items: ss.filter(s => !s.repo) });
    }
    const rows = [];
    groups.forEach(g => {
      if (!g.items.length && g.key.indexOf('__') === 0) return;
      const open = !!S.treeOpen[g.key];
      const roots = g.items.filter(s => s.role === 'root').sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
      const rootIds = {}; roots.forEach(r => { rootIds[r.id] = true; });
      const kidsBy = {}, orphans = [];
      g.items.filter(s => s.role === 'child').forEach(s => { if (rootIds[s.parent]) (kidsBy[s.parent] = kidsBy[s.parent] || []).push(s); else orphans.push(s); });
      const unknown = g.items.filter(s => s.role === 'unknown');
      const tok = provs().map(p => `<span class="prov">${U.provMark(p)}${U.compact(sum(g.items.filter(s => s.provider === p)))}</span>`).join(' ');
      rows.push(treeRow('tree-group tree-l1', `<div class="tree-cell"><button type="button" class="row-toggle" data-act="tree" data-val="${esc(g.key)}" data-fk="tg-${esc(g.key)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(g.label)}">${icon('chevronRight')}</button><div class="sess-id"><span class="sess-name">${esc(g.label)}</span><span class="role-tag">${roots.length} ${U.plural(roots.length, 'root')} · ${g.items.length} ${U.plural(g.items.length, 'session')}${g.note ? ' · ' + esc(g.note) : ''}</span></div></div>`, `<span class="prov-list">${tok}</span>`));
      if (!open) return;
      const lim = S.treeMore[g.key] || 15;
      roots.slice(0, lim).forEach(r => {
        const kids = kidsBy[r.id] || [], o = !!S.treeOpen[r.id];
        rows.push(sessRow(r, 2, kids.length, o, lm));
        if (o) kids.forEach(k => rows.push(sessRow(k, 3, 0, false, lm)));
      });
      if (roots.length > lim) rows.push(treeRow('tree-more tree-l2', `<div class="tree-cell"><button type="button" class="btn btn-ghost btn-sm" data-act="tree-more" data-val="${esc(g.key)}" data-fk="tm-${esc(g.key)}">Show ${Math.min(15, roots.length - lim)} more roots</button><span class="caption">${roots.length - lim} not shown</span></div>`));
      orphans.forEach(k => rows.push(sessRow(k, 2, 0, false, lm, 'parent outside current filters')));
      if (unknown.length) {
        const uk = g.key + '::unknown', uo = !!S.treeOpen[uk];
        rows.push(treeRow('tree-l2 row-sub', `<div class="tree-cell"><button type="button" class="row-toggle" data-act="tree" data-val="${esc(uk)}" data-fk="tg-${esc(uk)}" aria-expanded="${uo}" aria-label="${uo ? 'Hide' : 'Show'} sessions with unknown relationship">${icon('chevronRight')}</button><div class="sess-id"><span class="sess-name">Unknown relationship (${unknown.length})</span><span class="role-tag">Parent not recorded, so these aren’t counted as roots or children</span></div></div>`));
        if (uo) unknown.forEach(u => rows.push(sessRow(u, 3, 0, false, lm)));
      }
    });
    if (!rows.length) return '<p class="muted">No sessions in scope.</p>';
    return `<div class="table-wrap"><table class="table tree"><caption class="sr-only">Sessions grouped by repository, root session and child agents. Each row leads with the recorded agent name, or its relationship when no name was recorded, with the technical ID below. Linked PRs name their evidence level: Evidence link, Owner-confirmed, Suggested or Unlinked.</caption><thead><tr><th>Session</th><th class="hide-sm">Provider</th><th class="hide-sm">Model</th><th class="hide-sm">Started</th><th class="r">Tokens</th><th>Linked PRs</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }
  function pageUsage() {
    const f = S.f;
    const head = pageHead('Usage', esc(PERIOD_LABEL[f.period]) + ' · ' + esc(U.fmtRange(f.start, f.end)) + ' · ' + scopeUsage());
    if (!W.sessions.length) {
      return head + `<div class="empty">${U.crewArt('search')}<h3>No session detail on this machine</h3><p>No supported Codex, Claude Code or Paseo records were found here. Account-reported totals appear on Overview, but they can’t be broken down by repo, session, agent or PR.</p><div class="actions start"><a class="btn btn-secondary btn-sm" href="#/overview">View account-reported usage</a><a class="btn btn-primary btn-sm" href="#/sources">Check sources</a></div></div>`;
    }
    const ss = sessIn(f);
    const paseo = W.sources.paseo;
    return head + rangeNotices() +
      (paseo.status === 'partial' ? notice('warn', esc(paseo.note)) : '') +
      `<div class="grid">${provs().map(p => catCard(p, ss)).join('')}</div>
      <section class="card" aria-labelledby="us-tree-t"><div class="card-head"><div><h2 id="us-tree-t">Sessions by repository</h2><p class="scope">${scopeUsage()} · Repo → root session → child agents, where relationships are recorded. Paseo adds agent and workspace identity to provider sessions; it isn’t counted as extra usage.</p></div></div>${usageTree(ss)}</section>`;
  }

  // ---------- Sources & repos ----------
  function srcRow(k) {
    const s = W.sources[k], busy = S.busy[k];
    const label = { ok: 'Found', partial: 'Partial', failed: 'Refresh failed', notfound: 'Not found', denied: 'Access denied', notrunning: 'Not running', needspassword: 'Needs a password' }[s.status];
    const det = [];
    // D8: Paseo's two states use the same sentences as Setup, without Setup's closing "You can continue without it." (nothing is being
    // continued here). The last-snapshot clause is only said when a snapshot exists (a successful refresh), never otherwise.
    det.push(s.status === 'notfound' ? '<span>Nothing in its usual locations on this machine. If you use it here, run it once, then check again.</span>'
      : s.status === 'notrunning' ? `<span>Paseo isn’t running on this machine. ${s.oldest ? 'Showing its last snapshot.' : 'Start it, then check again.'}</span>`
      : s.status === 'needspassword' ? `<span>Paseo is asking for a password, which this dashboard doesn’t support.${s.oldest ? ' Names and parents come from its last snapshot.' : ''}</span>`
      : `<span>Location <span class="mono">${esc(s.location)}</span> · found automatically</span>`);
    if (s.oldest) det.push(`<span>History from ${U.fmtDayLong(s.oldest)}${s.sessions ? ' · ' + U.int(s.sessions) + ' sessions' : ''}</span>`);
    det.push(`<span>Last successful refresh: ${esc(s.lastSuccess)} · Latest attempt: ${esc(s.lastAttempt)}</span>`);
    if (s.error) det.push(`<span class="err">${esc(s.error)}</span>`);
    if (s.note) det.push(`<span>${esc(s.note)}</span>`);
    const primary = s.status === 'failed';
    return `<div class="src-row"><div class="src-name"><b>${s.name}</b>${busy ? U.statusTag('checking', 'Refreshing…') : U.statusTag(s.status, label)}</div><div class="src-details">${det.join('')}</div>
      <div class="src-actions"><button type="button" class="btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm" data-act="retry-source" data-val="${k}" data-fk="rs-${k}" ${busy ? 'disabled aria-busy="true"' : ''}>${icon('refresh')}${primary || s.status === 'needspassword' ? 'Retry' : s.status === 'notfound' || s.status === 'notrunning' ? 'Check again' : 'Refresh'}</button></div></div>`;
  }
  function acctRow(k) {
    const a = W.accounts[k], busy = S.busy['acct-' + k];
    const purpose = { chatgpt: 'Optional · account-reported Codex usage', claude: 'Optional · account-reported Claude usage', github: 'Needed for merged PR history and private repo access' }[k];
    const rep = k === 'github' ? 'Identity: ' + esc(a.login) + ' (used for “Authored by you”)'
      : !a.report ? 'Usage report: none until connected'
      : a.report.unit === 'tokens' ? 'Usage report: tokens · ' + esc(a.report.window.toLowerCase()) + ' · ' + esc(a.report.scope)
      : 'Usage report: percentage of limit only, so subscription tokens are unavailable';
    let act;
    if (k === 'github') act = `<button type="button" class="btn btn-secondary btn-sm" data-act="gh-check" data-fk="gh-check" ${busy ? 'disabled' : ''}>Check access</button>`;
    else if (a.status === 'reconnect') act = `<button type="button" class="btn btn-primary btn-sm" data-act="acct-connect" data-val="${k}" data-fk="ac-${k}" ${busy ? 'disabled' : ''}>Reconnect</button>`;
    else if (a.status === 'notconnected') act = `<button type="button" class="btn btn-primary btn-sm" data-act="acct-connect" data-val="${k}" data-fk="ac-${k}" ${busy ? 'disabled' : ''}>Connect ${a.name}</button>`;
    else act = `<button type="button" class="btn btn-secondary btn-sm" data-act="acct-disconnect" data-val="${k}" data-fk="ad-${k}">Disconnect</button>`;
    return `<div class="src-row"><div class="src-name"><b>${a.name}</b>${busy ? U.statusTag('connecting', 'Waiting for sign-in…') : U.statusTag(a.status, a.statusText)}</div><div class="src-details"><span>${purpose}</span><span>${rep}</span>${a.report && a.report.refreshed ? `<span>Last report: ${esc(a.report.refreshed)}</span>` : ''}</div><div class="src-actions">${act}</div></div>`;
  }
  function repoRow(r, ctx) {
    const confirm = S.confirmRemove === r.id;
    const n = W.prs.filter(p => p.repo === r.id).length;
    const st = r.status === 'ok' ? U.statusTag('ok', ctx === 'setup' ? 'Access confirmed' : 'Collecting') : U.statusTag('inaccessible', 'Inaccessible');
    const det = r.status === 'ok' ? (ctx === 'setup' ? 'Merged PRs will import after setup' : `${n} merged PRs in the last 12 months`) : `<span class="err">${esc(r.error)}</span>`;
    return `<div class="src-row"><div class="src-name"><b class="truncate">${esc(r.id)}</b>${st}</div><div class="src-details"><span>${det}</span></div>
      <div class="src-actions">${r.status !== 'ok' ? `<button type="button" class="btn btn-secondary btn-sm" data-act="repo-recheck" data-val="${esc(r.id)}" data-fk="rk-${esc(r.id)}">Check again</button>` : ''}<button type="button" class="btn btn-ghost btn-sm" data-act="repo-remove" data-val="${esc(r.id)}" data-ctx="${ctx}" data-fk="rr-${esc(r.id)}">${ctx === 'setup' ? 'Remove' : 'Stop tracking'}</button></div>
      ${confirm ? `<div class="confirm" role="group" aria-label="Confirm stop tracking ${esc(r.id)}"><p><b>Stop tracking ${esc(r.id)}?</b> Collection stops and it leaves the overview. Imported history stays on this machine for 12 months, so tracking it again restores it.</p><div class="actions"><button type="button" class="btn btn-secondary btn-sm" data-act="repo-remove-cancel" data-val="${esc(r.id)}" data-fk="rrc-${esc(r.id)}">Cancel</button><button type="button" class="btn btn-danger btn-sm" data-act="repo-remove-confirm" data-val="${esc(r.id)}" data-fk="rrk-${esc(r.id)}">Stop tracking</button></div></div>` : ''}</div>`;
  }
  function repoManager(ctx) {
    const list = ctx === 'setup' ? S.setup.repos : W.repos, err = S.repoError;
    return `<form class="field" data-form="repo-add" novalidate><label for="repo-in">Add a GitHub repository</label>
      <div class="field-row"><input class="input input-grow" id="repo-in" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="owner/name or https://github.com/owner/name" value="${esc(S.repoInput)}" data-input="repo" data-fk="repo-in" ${err ? 'aria-invalid="true" aria-describedby="repo-err"' : 'aria-describedby="repo-hint"'}>
      <button class="btn btn-primary" type="submit" data-fk="repo-add" ${S.repoBusy ? 'aria-busy="true" disabled' : ''}>${icon(S.repoBusy ? 'spinner' : 'plus')}${S.repoBusy ? 'Checking access…' : 'Add repository'}</button></div>
      ${err ? `<p class="field-error" id="repo-err" role="alert">${icon('error')}<span>${esc(err)}</span></p>` : '<p class="field-hint" id="repo-hint">Private repos work when your GitHub connection can read them. Prototype: names containing “private” simulate no access.</p>'}</form>
      <div>${list.length ? list.map(r => repoRow(r, ctx)).join('') : '<p class="muted">No repositories tracked yet.</p>'}</div>
      ${ctx === 'sources' && W.removedRepos.length ? `<div><h3>Previously tracked</h3><p class="caption">History is kept on this machine within the 12-month window.</p>${W.removedRepos.map(r => `<div class="src-row"><div class="src-name"><b>${esc(r.id)}</b>${U.statusTag('none', 'Not tracked')}</div><div class="src-details"><span>${W.prs.filter(p => p.repo === r.id).length} merged PRs retained · stopped ${esc(r.removedAt)}</span></div><div class="src-actions"><button type="button" class="btn btn-secondary btn-sm" data-act="repo-readd" data-val="${esc(r.id)}" data-fk="ra-${esc(r.id)}">Track again</button></div></div>`).join('')}</div>` : ''}`;
  }
  function pageSources() {
    return pageHead('Sources & repos', 'Setup and upkeep. Everyday review lives in Overview.', `<button type="button" class="btn btn-secondary btn-sm" data-act="refresh-all" data-fk="src-refresh" ${S.busy.all ? 'disabled aria-busy="true"' : ''}>${icon('refresh')}Refresh all</button>`) +
      `<section class="card" aria-labelledby="src-local-t"><div class="card-head"><div><h2 id="src-local-t">On this machine</h2><p class="scope">The dashboard reads supported agent records on the computer it’s installed on. There’s nothing to choose; what it finds appears here.</p></div></div><div>${['codex', 'claude', 'paseo'].map(srcRow).join('')}</div></section>
      <section class="card" aria-labelledby="src-acct-t"><div class="card-head"><div><h2 id="src-acct-t">Accounts</h2><p class="scope">Connection and report availability are shown separately. A connection doesn’t guarantee a report or local history.</p></div></div><div>${['github', 'chatgpt', 'claude'].map(acctRow).join('')}</div>
        <p class="footnote">Sign-in opens the provider’s own page. The dashboard never asks for your password, model API keys or browser cookies. Local usage works without any account connection.</p></section>
      <section class="card" aria-labelledby="src-repo-t"><div class="card-head"><div><h2 id="src-repo-t">Tracked repositories</h2><p class="scope">Merged PRs come only from repos listed here</p></div></div>${repoManager('sources')}</section>
      <section class="card" aria-labelledby="src-data-t"><div class="card-head"><div><h2 id="src-data-t">Data kept on this machine</h2><p class="scope">Design intent from requirements P-29 to P-31; not yet verified</p></div></div>
        <p>Usage metrics and link metadata are kept for 12 months on this machine so history survives log cleanup. Prompts, responses, tool output and credentials aren’t stored. GitHub and account-report reads are the only network requests.</p></section>`;
  }

  // ---------- Setup ----------
  function newSetup(mode) {
    return { mode, step: 1, disc: { codex: 'checking', claude: 'checking', paseo: 'checking' }, acc: { github: 'notconnected', chatgpt: mode === 'first' ? 'existing' : 'notconnected', claude: 'notconnected' }, repos: [] };
  }
  function startDiscovery() {
    // D8 (PASEO_STATUS_COPY): Paseo is a daemon the dashboard connects to, not a folder it reads, so it can never be "Access denied" or
    // "Not found". Its two ways of not being usable are a daemon that asks for a password (needspassword) and one that is not running
    // (notrunning). The keys are the server's status names, so Tech Spec and the product map them one to one.
    const res = S.setup.mode === 'first' ? { codex: 'found', claude: 'found', paseo: 'needspassword' } : { codex: 'notfound', claude: 'notfound', paseo: 'notrunning' };
    ['codex', 'claude', 'paseo'].forEach((k, i) => later(700 + i * 650, () => {
      if (!S.setup) return; S.setup.disc[k] = res[k];
      if (res[k] === 'found') S.entering['disc-' + k] = true;
      render();
      if (i === 2) announce('Discovery finished.');
    }));
  }
  function setupDiscover() {
    const d = S.setup.disc, keys = ['codex', 'claude', 'paseo'], names = { codex: 'Codex', claude: 'Claude Code', paseo: 'Paseo' };
    const done = keys.every(k => d[k] !== 'checking'), found = keys.filter(k => d[k] === 'found').length;
    const row = k => {
      const v = d[k];
      // Status words (D8). "Access denied" is a local folder the dashboard may not read (Codex, Claude Code); "Not found" is a folder with
      // no records. Paseo has neither: it is "Needs a password" (the daemon answered and asks for one, which isn't supported) or
      // "Not running" (nothing answered). The helper sentence names the fact first, then what the owner can do, then, in Setup only,
      // that the step can be finished without it.
      const tag = { checking: U.statusTag('checking', 'Looking…'), found: U.statusTag('ok', 'Found'), notfound: U.statusTag('notfound', 'Not found'), denied: U.statusTag('denied', 'Access denied'), needspassword: U.statusTag('needspassword', 'Needs a password'), notrunning: U.statusTag('notrunning', 'Not running') }[v];
      const det = {
        checking: 'Checking its usual locations on this machine.',
        found: k === 'codex' ? 'Sessions from Feb 2, 2026 · ~/.codex/sessions' : k === 'claude' ? 'Sessions from Mar 14, 2026 · ~/.claude/projects' : 'Agent metadata from Apr 20, 2026',
        notfound: 'No records in its usual locations. If you use ' + names[k] + ' here, run it once, then check again.',
        denied: names[k] + '’s data is here but couldn’t be read (permission denied). Allow read access, then retry. You can continue without it.',
        needspassword: 'Paseo is asking for a password, which this dashboard doesn’t support. You can continue without it.',
        notrunning: 'Paseo isn’t running on this machine. Start it, then check again. You can continue without it.'
      }[v];
      // Paseo is enrichment, not a provider, so it gets an icon rather than a buddy.
      const ent = takeEnter('disc-' + k) ? ' is-entering' : '';
      const mark = k === 'paseo' ? icon('layers')
        : U.buddy(k, { size: 18, mood: v === 'found' || v === 'checking' ? 'awake' : 'sleep', cls: v === 'found' ? 'pop' + ent : '' });
      return `<div class="src-row"><div class="src-name"><b>${mark}${names[k]}</b>${tag}</div><div class="src-details"><span>${det}</span></div><div class="src-actions">${v === 'denied' || v === 'needspassword' || v === 'notfound' || v === 'notrunning' ? `<button type="button" class="btn btn-secondary btn-sm" data-act="disc-retry" data-val="${k}" data-fk="dr-${k}">${v === 'denied' || v === 'needspassword' ? 'Retry' : 'Check again'}</button>` : ''}</div></div>`;
    };
    const summary = !done ? '<p class="caption" role="status">Looking for records…</p>'
      : found ? `<div role="status">${notice('info', `${found} of 3 sources found. History starts where each source’s records start. You can fix the rest later in Sources &amp; repos.`)}</div>`
      : `<div role="status">${notice('warn', 'No local agent records found on this machine. You can still connect accounts for account-reported usage and track repos for merged PRs.')}</div>`;
    return `<section class="card" aria-labelledby="s1-t"><div class="card-head"><div><h2 id="s1-t">Finding agent records on this machine</h2><p class="scope">Automatic and read-only</p></div></div><div>${keys.map(row).join('')}</div>${summary}</section>
      <div class="actions"><button type="button" class="btn btn-primary" data-act="setup-next" data-fk="setup-next" ${done ? '' : 'disabled aria-disabled="true"'}>Continue</button></div>`;
  }
  function setupAccounts() {
    const a = S.setup.acc, nothing = S.setup.mode === 'nothing';
    const rows = [['github', 'GitHub', 'Needed for merged PRs and private repo access.'], ['chatgpt', 'ChatGPT', 'Optional · adds account-reported Codex usage.'], ['claude', 'Claude', 'Optional · adds account-reported Claude usage, if your plan reports it.']];
    const row = r => {
      const k = r[0], v = a[k];
      const tag = { existing: U.statusTag('existing', 'Using your existing sign-in'), connected: U.statusTag('connected', 'Connected'), connecting: U.statusTag('connecting', 'Waiting for sign-in…'), notconnected: U.statusTag('notconnected', 'Not connected') }[v];
      const extra = (v === 'connected' || v === 'existing') && nothing && k !== 'github' ? `<span>Connected, but no local ${k === 'chatgpt' ? 'Codex' : 'Claude Code'} history was found on this machine. You’ll see account-reported totals only, without session detail.</span>` : '';
      const act = v === 'notconnected' ? `<button type="button" class="btn ${k === 'github' ? 'btn-primary' : 'btn-secondary'} btn-sm" data-act="setup-connect" data-val="${k}" data-fk="stc-${k}">Connect ${r[1]}</button>` : '';
      return `<div class="src-row"><div class="src-name"><b>${r[1]}</b>${tag}</div><div class="src-details"><span>${r[2]}</span>${extra}</div><div class="src-actions">${act}</div></div>`;
    };
    return `<section class="card" aria-labelledby="s2-t"><div class="card-head"><div><h2 id="s2-t">Connect accounts</h2><p class="scope">Only where they add data</p></div></div><div>${rows.map(row).join('')}</div>
      <p class="footnote">Sign-in happens on the provider’s own page. This dashboard never asks for your password, model API keys or browser cookies. Local usage works without any of these.</p></section>
      <div class="actions"><button type="button" class="btn btn-secondary" data-act="setup-back" data-fk="setup-back">Back</button><button type="button" class="btn btn-primary" data-act="setup-next" data-fk="setup-next">Continue</button></div>`;
  }
  function setupRepos() {
    return `<section class="card" aria-labelledby="s3-t"><div class="card-head"><div><h2 id="s3-t">Choose repositories to track</h2><p class="scope">Merged PRs come only from these repos. You can change this any time.</p></div></div>${repoManager('setup')}</section>
      <div class="actions"><button type="button" class="btn btn-secondary" data-act="setup-back" data-fk="setup-back">Back</button><button type="button" class="btn btn-primary" data-act="setup-finish" data-fk="setup-finish">Finish setup</button></div>`;
  }
  function pageSetup() {
    const st = S.setup, steps = ['Local sources', 'Accounts', 'Repositories'];
    const stepper = `<ol class="stepper" aria-label="Setup progress">${steps.map((l, i) => `<li class="step ${i + 1 < st.step ? 'is-done' : ''}" ${i + 1 === st.step ? 'aria-current="step"' : ''}><span class="step-n" aria-hidden="true">${i + 1 < st.step ? icon('check') : i + 1}</span>${l}${i + 1 < st.step ? '<span class="sr-only"> (done)</span>' : ''}</li>`).join('')}</ol>`;
    const body = st.step === 1 ? setupDiscover() : st.step === 2 ? setupAccounts() : setupRepos();
    const d = st.disc, done = ['codex', 'claude', 'paseo'].every(k => d[k] !== 'checking');
    const anyFound = ['codex', 'claude'].some(k => d[k] === 'found');
    const mood = !done ? 'search' : anyFound ? 'awake' : 'search';
    return `<div class="setup"><div class="setup-head">${U.crewArt(mood)}<div><h1 id="page-title" tabindex="-1" data-fk="page-title">Let’s find your agents</h1><p>This dashboard reads agent records on the computer it’s installed on, so there’s nothing to pick. Connect accounts only where they add data, then choose the repos to track.</p></div></div>${stepper}${body}</div>`;
  }

  // ---------- drawer, toasts, prototype panel ----------
  function drawer() {
    const c = S.charts[S.drawer.chart], b = c && c.buckets[S.drawer.i];
    if (!b) return '';
    const bf = bucketFilter(b);
    const np = b.a > T ? 0 : prsIn(bf).length, ns = b.a > T ? 0 : sessIn(bf).length;
    const ent = takeEnter('drawer') ? ' is-entering' : '';
    return `<div class="scrim${ent}" data-act="drawer-close"></div><aside class="drawer${ent}" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <div class="drawer-head"><div><h2 id="drawer-title" tabindex="-1" data-fk="drawer-title">${esc(b.label)}</h2><p class="scope">Records in this period · PRs: ${scopeDelivery()} · Sessions: ${scopeUsage()}</p></div><button type="button" class="icon-btn" data-act="drawer-close" aria-label="Close" data-fk="drawer-close">${icon('close')}</button></div>
      <div class="drawer-tabs">${seg('dtab', [['prs', `Merged PRs <span class="seg-count">${np}</span>`], ['sessions', `Sessions <span class="seg-count">${ns}</span>`]], S.drawerTab, 'Record type')}</div>
      <div class="drawer-body">${S.drawerTab === 'prs' ? prListBlock(b) : sessListBlock(b)}</div>
      <div class="drawer-foot actions"><button type="button" class="btn btn-secondary btn-sm" data-act="drill" data-val="usage" data-a="${b.a}" data-b="${b.b}" data-fk="dr-usage">Open in Usage</button><button type="button" class="btn btn-primary btn-sm" data-act="drill" data-val="delivery" data-a="${b.a}" data-b="${b.b}" data-fk="dr-delivery">Open in Delivery</button></div></aside>`;
  }
  function toast(msg, undo) {
    const id = String(Date.now()) + Math.floor(Math.random() * 1000);
    S.toasts = [{ id, msg, undo, fresh: true }];
    renderToasts();
    later(undo ? 8000 : 5000, () => { S.toasts = S.toasts.filter(t => t.id !== id); renderToasts(); });
  }
  function renderToasts() {
    const root = document.getElementById('toast-root');
    const key = S.toasts.map(t => t.id).join(',');
    if (root.getAttribute('data-key') === key) return; // unchanged: keep the live element (and its entrance)
    root.setAttribute('data-key', key);
    root.innerHTML = S.toasts.map(t => {
      const cls = t.fresh ? ' is-entering' : '';
      t.fresh = false;
      return `<div class="toast${cls}"><span>${esc(t.msg)}</span>${t.undo ? `<button type="button" class="btn btn-ghost btn-sm" data-act="toast-undo" data-val="${t.id}" data-fk="toast-undo">Undo</button>` : ''}</div>`;
    }).join('');
  }
  function proto() {
    return `<div class="proto"><button type="button" class="proto-toggle" data-act="proto" data-fk="proto-toggle" aria-expanded="${S.protoOpen}">${icon('layers')}Prototype states</button>${S.protoOpen ? `<div class="proto-panel" role="dialog" aria-label="Prototype states">
      <p class="proto-note">Review tool, not product UI. All data is synthetic fixture data; nothing is read from your machine, accounts or GitHub.</p>
      <fieldset><legend>Scenario</legend>${F.SCENARIOS.map(s => `<label class="proto-opt"><input type="radio" name="scenario" value="${s.id}" data-act="scenario" data-fk="scn-${s.id}" ${S.scenario === s.id ? 'checked' : ''}><span>${esc(s.label)}<small>${esc(s.desc)}</small></span></label>`).join('')}</fieldset>
      <fieldset><legend>Retry result (Refresh failed scenario)</legend>
        <label class="proto-opt"><input type="radio" name="retry-result" value="ok" data-act="retry-outcome" data-fk="retry-ok" ${S.retryFails ? '' : 'checked'}><span>Succeeds<small>Button shows “Retrying…”, then the banner clears and new sessions import</small></span></label>
        <label class="proto-opt"><input type="radio" name="retry-result" value="fail" data-act="retry-outcome" data-fk="retry-fail" ${S.retryFails ? 'checked' : ''}><span>Fails again<small>Banner stays with the new attempt time; cached data stays</small></span></label>
      </fieldset>
      <div class="proto-check"><button type="button" class="btn btn-secondary btn-sm" data-act="containment" data-fk="proto-check">Check layout containment</button>${S.protoOut ? `<pre class="proto-out" role="status">${esc(S.protoOut)}</pre>` : '<p class="caption">Measures this window: sideways overflow of the page, and content that spills out of its container. Resize the window to 390px or 320px wide first, then run it on each screen and scenario.</p>'}</div>
      <a href="style-guide.html">Open the design-system style guide</a></div>` : ''}</div>`;
  }

  // ---------- actions ----------
  function findPr(id) { return W.prs.find(p => p.id === id); }
  function linkAction(act, pid, sid) {
    const p = findPr(pid); if (!p) return;
    const i = p.links.findIndex(l => l.sid === sid); if (i < 0) return;
    const l = p.links[i], before = JSON.parse(JSON.stringify(l));
    const restore = () => { const j = p.links.findIndex(x => x.sid === sid); if (j >= 0) p.links[j] = before; else p.links.splice(Math.min(i, p.links.length), 0, before); render(); };
    if (act === 'link-confirm') { l.cls = 'owner'; l.basis = 'Confirmed by you (was suggested: ' + before.basis + ')'; toast('Link confirmed and labeled Owner-confirmed.', restore); }
    else if (act === 'link-dismiss') { p.links.splice(i, 1); toast('Suggestion dismissed.', restore); }
    else if (act === 'link-remove') { p.links.splice(i, 1); toast('Your link was removed.', restore); }
    else if (act === 'link-reject') { l.rejected = true; toast('Marked incorrect. The source’s claim is kept but not counted.', restore); }
    else if (act === 'link-restore') { l.rejected = false; toast('Evidence link restored.'); }
    S.focusNext = 'prt-' + pid;
    render();
  }
  function retrySource(k) {
    if (S.busy[k]) return;
    S.busy[k] = true; render();
    later(1000, () => {
      S.busy[k] = false;
      const s = W.sources[k];
      if (k === 'codex' && W.refresh.failed && S.retryFails) {
        // Review-tool choice (Prototype states): the retry fails again. The banner stays, with the new attempt time, and nothing changes.
        s.lastAttempt = 'Failed again today, ' + NOW;
        toast('Codex still couldn’t be refreshed. Cached data is still shown, and nothing was duplicated.');
      } else if (k === 'codex' && W.refresh.failed) {
        const add = W.pendingSessions || [];
        add.forEach(x => { W.sessions.push(x); W.sessionById[x.id] = x; });
        W.pendingSessions = [];
        Object.assign(s, { status: 'ok', staleAfter: null, error: null, lastSuccess: 'Today, ' + NOW, lastAttempt: 'Succeeded' });
        W.refresh.failed = false;
        toast(`Codex refreshed · ${add.length} new ${U.plural(add.length, 'session')} imported. Records already imported were skipped.`);
      } else if (s.status === 'notfound') toast(s.name + ': still no records on this machine.');
      else if (s.status === 'notrunning') toast(s.name + ' still isn’t running on this machine.');
      else if (s.status === 'needspassword') toast(s.name + ' is still asking for a password, which this dashboard doesn’t support.');
      else if (s.status === 'partial') toast(`${s.name} refreshed · ${s.unreadable} records still unreadable.`);
      else { s.lastSuccess = 'Today, ' + NOW; toast(s.name + ' refreshed · no new records. Nothing was duplicated.'); }
      render();
    });
  }
  function refreshAll() {
    if (S.busy.all) return;
    S.busy.all = true; render();
    later(1100, () => {
      S.busy.all = false;
      let msg = 'Refreshed all sources · no duplicates.';
      if (W.refresh.failed) {
        const add = W.pendingSessions || [];
        add.forEach(x => { W.sessions.push(x); W.sessionById[x.id] = x; }); W.pendingSessions = [];
        Object.assign(W.sources.codex, { status: 'ok', staleAfter: null, error: null, lastSuccess: 'Today, ' + NOW, lastAttempt: 'Succeeded' });
        W.refresh.failed = false;
        msg = `Refreshed all sources · Codex recovered with ${add.length} new sessions; nothing duplicated.`;
      }
      toast(msg); render();
    });
  }
  function connectAccount(k) {
    const key = 'acct-' + k; if (S.busy[key]) return;
    S.busy[key] = true;
    toast('Opening ' + W.accounts[k].name + ' sign-in in your browser… (simulated)');
    render();
    later(1200, () => {
      S.busy[key] = false;
      const a = W.accounts[k];
      a.status = 'connected'; a.statusText = 'Connected';
      if (!a.report && a.savedReport) a.report = a.savedReport;
      if (a.report) { a.report.stale = false; a.report.refreshed = 'Today, ' + NOW; }
      toast(a.name + ' connected. Usage report updated.'); render();
    });
  }
  function parseRepo(raw) {
    const m = raw.trim().match(/^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/);
    return m ? (m[1] + '/' + m[2]).toLowerCase() : null;
  }
  function addRepo(ctx) {
    const raw = S.repoInput;
    S.focusNext = 'repo-in';
    if (!raw.trim()) { S.repoError = 'Enter a repository as owner/name or a GitHub URL.'; render(); return; }
    const id = parseRepo(raw);
    if (!id) { S.repoError = 'That doesn’t look like a GitHub repository. Use owner/name, for example kelvin/atlas-api.'; render(); return; }
    const list = ctx === 'setup' ? S.setup.repos : W.repos;
    if (list.some(r => r.id === id)) { S.repoError = id + ' is already tracked.'; render(); return; }
    if (ctx === 'setup' && S.setup.acc.github !== 'connected') { S.repoError = 'Connect GitHub first (step 2) so the dashboard can check access to this repository.'; render(); return; }
    S.repoError = null; S.repoBusy = true; render();
    later(800, () => {
      S.repoBusy = false; S.focusNext = 'repo-in';
      if (/private|secret/.test(id)) {
        S.repoError = 'GitHub didn’t grant access to ' + id + '. Check the name, or that your GitHub connection can read this repository, then try again.';
        render(); return;
      }
      const ri = W.removedRepos.findIndex(r => r.id === id);
      if (ctx === 'sources' && ri >= 0) {
        W.removedRepos.splice(ri, 1); W.repos.push({ id, status: 'ok' });
        toast('Tracking ' + id + ' again · retained history restored without duplicates.');
      } else {
        list.push({ id, status: 'ok' });
        toast('Tracking ' + id + (ctx === 'sources' ? ' · importing merged PRs (fixture: none)' : ''));
      }
      S.repoInput = ''; render();
    });
  }
  function drill(where, a, b) {
    S.f.period = 'custom'; S.f.start = a; S.f.end = U.minDate(b, T); S.f.gran = autoGran(S.f.start, S.f.end);
    resetSelections(); S.prCap = 50;
    go(where);
  }
  function gotoPr(pid) {
    const p = findPr(pid); if (!p) return;
    if (p.date < S.f.start || p.date > S.f.end) { S.f.period = 'custom'; S.f.start = U.minDate(S.f.start, p.date); S.f.end = U.maxDate(S.f.end, p.date); S.f.gran = autoGran(S.f.start, S.f.end); }
    if (p.author !== ME) S.f.author = 'all';
    if (S.f.repos.length && S.f.repos.indexOf(p.repo) < 0) S.f.repos = [];
    S.prOpen[pid] = true; S.linkFilter = 'all'; S.prQuery = '';
    S.focusNext = 'prt-' + pid;
    go('delivery');
  }
  function go(route) {
    if (S.route === route) { render(); return; }
    location.hash = '#/' + route; // hashchange renders
  }
  function closeDrawer() { S.drawer = null; S.focusNext = S.returnFocus; render(); }

  function handle(act, val, el) {
    switch (act) {
      case 'period': setPeriod(val); S.openPop = null; S.customDraft = null; S.focusNext = 'period-' + (['today', 'week', 'month'].indexOf(val) >= 0 ? val : 'custom'); break;
      case 'pop':
        S.openPop = S.openPop === val ? null : val;
        if (S.openPop) S.entering.pop = true;
        S.customDraft = val === 'custom' ? { start: S.f.start, end: U.minDate(S.f.end, T) } : null;
        break;
      case 'pop-close': S.focusNext = S.openPop === 'repos' ? 'repos-btn' : 'period-custom'; S.openPop = null; S.customDraft = null; break;
      case 'custom-apply': {
        const d = S.customDraft;
        if (!d.start || !d.end) { d.error = 'Choose both dates.'; break; }
        if (d.start > d.end) { d.error = 'The start date must be on or before the end date.'; break; }
        if (d.start < F.LOOKBACK_START || d.end > T) { d.error = 'Choose dates between ' + U.fmtDayLong(F.LOOKBACK_START) + ' and today.'; break; }
        S.f.period = 'custom'; S.f.start = d.start; S.f.end = d.end; S.f.gran = autoGran(d.start, d.end);
        resetSelections(); S.openPop = null; S.customDraft = null; S.focusNext = 'period-custom'; break;
      }
      case 'gran': S.f.gran = val; resetSelections(); break;
      case 'provider': S.f.provider = val; break;
      case 'author': S.f.author = val; break;
      case 'repo-clear': S.f.repos = []; break;
      case 'filters-open': S.filtersOpen = true; S.entering.sheet = true; S.focusNext = 'fb-close'; break;
      case 'filters-close': S.filtersOpen = false; S.openPop = null; S.focusNext = 'fb-open'; break;
      case 'filters-reset': S.f = defaultFilters(); resetSelections(); break;
      case 'chartview': S.charts[el.getAttribute('data-chart')].view = val; break;
      case 'chart-retry': S.loadingPhase = 'loading'; later(900, () => { S.loadingPhase = null; render(); }); break;
      case 'bucket': activateBucket(el.getAttribute('data-chart'), +val); return;
      case 'trend-clear': S.trendSel = null; if (S.charts.tr) S.charts.tr.sel = null; S.focusNext = 'chart-tr'; break;
      case 'drawer-close': closeDrawer(); return;
      case 'dtab': S.drawerTab = val; break;
      case 'drill': S.drawer = null; drill(val, el.getAttribute('data-a'), el.getAttribute('data-b')); return;
      case 'pr-toggle': S.prOpen[val] = !S.prOpen[val]; if (!S.prOpen[val] && S.addLinkFor === val) S.addLinkFor = null; break;
      case 'pr-more': S.prCap += 50; break;
      case 'linkfilter': S.linkFilter = val; break;
      case 'link-confirm': case 'link-dismiss': case 'link-remove': case 'link-reject': case 'link-restore':
        linkAction(act, el.getAttribute('data-pr'), el.getAttribute('data-sid')); return;
      case 'link-add-open': { S.addLinkFor = val; const cs = candidates(findPr(val)); S.addLinkPick = cs.length ? cs[0].id : ''; S.focusNext = cs.length ? 'als-' + val : 'lac-' + val; break; }
      case 'link-add-cancel': S.focusNext = 'lao-' + S.addLinkFor; S.addLinkFor = null; break;
      case 'link-add': {
        const p = findPr(el.getAttribute('data-pr')), sid = S.addLinkPick;
        if (p && sid) {
          p.links.push({ sid, cls: 'owner', basis: 'Confirmed by you' });
          S.addLinkFor = null; S.focusNext = 'prt-' + p.id;
          toast('Session linked and labeled Owner-confirmed.', () => { p.links = p.links.filter(l => !(l.sid === sid && l.cls === 'owner')); render(); });
        }
        break;
      }
      case 'toast-undo': { const t = S.toasts.find(x => x.id === val); S.toasts = []; renderToasts(); if (t && t.undo) t.undo(); return; }
      case 'tree': S.treeOpen[val] = !S.treeOpen[val]; break;
      case 'tree-more': S.treeMore[val] = (S.treeMore[val] || 15) + 15; break;
      case 'goto-pr': gotoPr(val); return;
      case 'refresh-all': refreshAll(); return;
      case 'retry-source': retrySource(val); return;
      case 'acct-connect': connectAccount(val); return;
      case 'acct-disconnect': {
        const a = W.accounts[val]; a.savedReport = a.report; a.report = null; a.status = 'notconnected'; a.statusText = 'Not connected';
        S.focusNext = 'ac-' + val;
        toast(a.name + ' disconnected. Local usage is unaffected.', () => { a.report = a.savedReport; a.status = 'connected'; a.statusText = 'Connected'; render(); });
        break;
      }
      case 'gh-check': S.busy['acct-github'] = true; later(900, () => { S.busy['acct-github'] = false; toast('GitHub connection OK · ' + trackedIds().length + ' tracked repos readable.'); render(); }); break;
      case 'repo-remove':
        if (el.getAttribute('data-ctx') === 'setup') { S.setup.repos = S.setup.repos.filter(r => r.id !== val); S.focusNext = 'repo-in'; }
        else { S.confirmRemove = val; S.focusNext = 'rrc-' + val; }
        break;
      case 'repo-remove-cancel': S.confirmRemove = null; S.focusNext = 'rr-' + val; break;
      case 'repo-remove-confirm': {
        const r = W.repos.find(x => x.id === val); if (!r) break;
        W.repos = W.repos.filter(x => x.id !== val);
        if (r.status === 'ok') W.removedRepos.push({ id: val, removedAt: 'today' });
        S.f.repos = S.f.repos.filter(x => x !== val); S.confirmRemove = null; S.focusNext = 'repo-in';
        toast('Stopped tracking ' + val + '. History kept on this machine.', () => { W.removedRepos = W.removedRepos.filter(x => x.id !== val); W.repos.push(r); render(); });
        break;
      }
      case 'repo-readd': {
        W.removedRepos = W.removedRepos.filter(x => x.id !== val); W.repos.push({ id: val, status: 'ok' }); S.focusNext = 'repo-in';
        toast('Tracking ' + val + ' again · retained history restored without duplicates.');
        break;
      }
      case 'repo-recheck': toast('Still no access to ' + val + '. Its retained history stays readable.'); break;
      case 'proto': S.protoOpen = !S.protoOpen; break;
      case 'containment':
        S.protoOut = window.ContainmentCheck ? window.ContainmentCheck.run({ route: S.route, scenario: S.scenario }) : 'The containment check script did not load.';
        S.protoOpen = true; S.focusNext = 'proto-check'; break;
      case 'setup-next': S.setup.step = Math.min(3, S.setup.step + 1); S.repoError = null; S.focusNext = 'page-title'; break;
      case 'setup-back': S.setup.step = Math.max(1, S.setup.step - 1); S.repoError = null; S.focusNext = 'page-title'; break;
      case 'setup-connect':
        S.setup.acc[val] = 'connecting';
        later(1100, () => { if (!S.setup) return; S.setup.acc[val] = 'connected'; render(); announce('Connected.'); });
        break;
      case 'disc-retry': {
        // D8: looking again answers honestly. A Paseo that asks for a password, or is not running, is still that after the owner
        // looks again (the dashboard changes neither), so the row returns to the same words and the step can still be continued.
        const was = S.setup.disc[val];
        S.setup.disc[val] = 'checking';
        later(900, () => {
          if (!S.setup) return;
          S.setup.disc[val] = was === 'needspassword' || was === 'notrunning' ? was : 'notfound';
          render();
        });
        break;
      }
      case 'setup-finish': {
        const mode = S.setup.mode, n = S.setup.repos.length;
        loadScenario(mode === 'nothing' ? 'account-only' : n ? 'typical' : 'no-repos');
        toast('Setup complete. Showing fixture data for review.');
        return;
      }
    }
    render();
  }

  // ---------- render ----------
  function render() {
    const ae = document.activeElement;
    const fk = ae && ae.getAttribute ? ae.getAttribute('data-fk') : null;
    const caret = ae && ae.tagName === 'INPUT' && (ae.type === 'text' || ae.type === 'search') ? ae.selectionStart : null;
    const setup = S.route === 'setup' && S.setup;
    document.getElementById('app').classList.toggle('is-setup', !!setup);
    document.getElementById('appbar-actions').innerHTML = appbarActions();
    if (!setup) {
      document.getElementById('sidenav').innerHTML = nav();
      document.getElementById('banner-slot').innerHTML = banner();
      const fb = document.getElementById('filterbar');
      fb.innerHTML = filterbar();
      fb.classList.toggle('is-open', S.filtersOpen);
      fb.classList.toggle('is-entering', takeEnter('sheet'));
    } else {
      document.getElementById('banner-slot').innerHTML = '';
    }
    const pages = { overview: pageOverview, trends: pageTrends, delivery: pageDelivery, usage: pageUsage, sources: pageSources };
    document.getElementById('main').innerHTML = (setup ? pageSetup : pages[S.route] || pageOverview)();
    document.getElementById('drawer-root').innerHTML = S.drawer ? drawer() : '';
    document.getElementById('proto-root').innerHTML = proto();
    renderToasts();
    drawCharts();
    restoreHScroll();
    document.title = PAGE_NAMES[S.route] + ' · Kelvin Agent Crew (prototype)';

    const target = S.focusNext || fk;
    S.focusNext = null;
    if (target) {
      const el = document.querySelector('[data-fk="' + CSS.escape(target) + '"]');
      if (el) {
        el.focus({ preventScroll: target === fk });
        if (target === fk && caret != null && el.setSelectionRange) { try { el.setSelectionRange(caret, caret); } catch (e) { /* not a text input */ } }
      }
    }
  }

  function loadScenario(id) {
    S.timers.forEach(clearTimeout); S.timers = [];
    S.scenario = id; W = F.build(id);
    S.f = Object.assign(defaultFilters(), W.filters || {});
    Object.assign(S, {
      charts: {}, trendSel: null, drawer: null, prOpen: {}, linkFilter: 'all', prQuery: '', prCap: 50, addLinkFor: null,
      treeOpen: {}, treeMore: {}, repoInput: '', repoError: null, repoBusy: false, confirmRemove: null, busy: {},
      openPop: null, customDraft: null, filtersOpen: false, toasts: [], entering: {}, protoOut: null, loadingPhase: W.loading ? 'loading' : null
    });
    if (W.setup) { S.setup = newSetup(W.setup.mode); startDiscovery(); }
    else S.setup = null;
    const route = W.setup ? 'setup' : (S.route === 'setup' ? 'overview' : S.route);
    if (S.loadingPhase === 'loading') later(1400, () => { if (S.loadingPhase === 'loading') { S.loadingPhase = 'error'; render(); } });
    if (route !== S.route) { S.route = route; S.focusNext = 'page-title'; }
    setHash(route);
    render();
  }
  function setHash(route) {
    if (location.hash === '#/' + route) return;
    try { history.replaceState(null, '', '#/' + route); }
    catch (e) { location.hash = '#/' + route; } // sandboxed/opaque origins may reject replaceState
  }

  // ---------- events ----------
  document.addEventListener('click', e => {
    const bk = e.target.closest('.achart .bk');
    if (bk) { activateBucket(bk.closest('.achart').getAttribute('data-chart'), +bk.getAttribute('data-i')); return; }
    const yc = e.target.closest('.ycell');
    if (yc) { openDay(yc.getAttribute('data-day')); return; }
    let closed = false;
    if (S.openPop && !e.target.closest('.popover') && !e.target.closest('[data-act="pop"]')) { S.openPop = null; S.customDraft = null; closed = true; }
    const el = e.target.closest('[data-act]');
    if (!el) { if (closed) render(); return; }
    if (el.tagName === 'INPUT') { if (closed) render(); return; } // checkboxes/radios use change
    handle(el.getAttribute('data-act'), el.getAttribute('data-val'), el);
  });
  document.addEventListener('change', e => {
    const el = e.target, act = el.getAttribute('data-act'), inp = el.getAttribute('data-input');
    if (act === 'repo-toggle') {
      const id = el.getAttribute('data-val'), i = S.f.repos.indexOf(id);
      if (el.checked && i < 0) S.f.repos.push(id);
      if (!el.checked && i >= 0) S.f.repos.splice(i, 1);
      render();
    } else if (act === 'scenario') {
      loadScenario(el.value);
    } else if (act === 'retry-outcome') {
      S.retryFails = el.value === 'fail'; render();
    } else if (inp === 'addlink') {
      S.addLinkPick = el.value;
    } else if (inp === 'cr-start' && S.customDraft) { S.customDraft.start = el.value; }
    else if (inp === 'cr-end' && S.customDraft) { S.customDraft.end = el.value; }
  });
  document.addEventListener('input', e => {
    const el = e.target, k = el.getAttribute && el.getAttribute('data-input');
    if (k === 'repo') S.repoInput = el.value;
    else if (k === 'prq') { S.prQuery = el.value; S.prCap = 50; render(); }
    else if (k === 'cr-start' && S.customDraft) S.customDraft.start = el.value;
    else if (k === 'cr-end' && S.customDraft) S.customDraft.end = el.value;
  });
  document.addEventListener('submit', e => {
    if (e.target.closest('[data-form="repo-add"]')) { e.preventDefault(); addRepo(S.route === 'setup' ? 'setup' : 'sources'); }
  });
  document.addEventListener('mouseover', e => {
    const bk = e.target.closest && e.target.closest('.achart .bk');
    if (!bk) return;
    const id = bk.closest('.achart').getAttribute('data-chart'), c = S.charts[id], ro = document.getElementById('ro-' + id);
    if (c && ro) ro.innerHTML = readout(c.buckets[+bk.getAttribute('data-i')]);
  });
  document.addEventListener('focusin', e => {
    const t = e.target;
    if (t.classList && t.classList.contains('achart')) {
      const id = t.getAttribute('data-chart'), c = S.charts[id];
      if (c && c.focus == null) setFocusBucket(id, defaultBucket(c), true);
    }
  });
  function trapTab(e, box) {
    if (!box) return;
    const f = box.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t.classList && t.classList.contains('achart')) {
      const id = t.getAttribute('data-chart'), c = S.charts[id];
      if (c) {
        const n = c.buckets.length; let i = c.focus != null ? c.focus : defaultBucket(c);
        if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].indexOf(e.key) >= 0) {
          e.preventDefault();
          i = e.key === 'ArrowRight' ? Math.min(n - 1, i + 1) : e.key === 'ArrowLeft' ? Math.max(0, i - 1) : e.key === 'Home' ? 0 : n - 1;
          setFocusBucket(id, i, true); return;
        }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateBucket(id, i); return; }
      }
    }
    if (e.key === 'Escape') {
      if (S.drawer) { e.preventDefault(); closeDrawer(); return; }
      if (S.openPop) { S.focusNext = S.openPop === 'repos' ? 'repos-btn' : 'period-custom'; S.openPop = null; S.customDraft = null; render(); return; }
      if (S.filtersOpen) { S.filtersOpen = false; S.focusNext = 'fb-open'; render(); return; }
      if (S.protoOpen) { S.protoOpen = false; S.focusNext = 'proto-toggle'; render(); return; }
      if (S.confirmRemove) { const id = S.confirmRemove; S.confirmRemove = null; S.focusNext = 'rr-' + id; render(); return; }
    }
    if (e.key === 'Tab') {
      if (S.drawer) trapTab(e, document.querySelector('.drawer'));
      else if (S.filtersOpen && window.matchMedia('(max-width: 719px)').matches) trapTab(e, document.querySelector('.fb-controls'));
    }
  });
  function routeFromHash() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    return ['overview', 'trends', 'delivery', 'usage', 'sources', 'setup'].indexOf(h) >= 0 ? h : 'overview';
  }
  window.addEventListener('hashchange', () => {
    let r = routeFromHash();
    if (r === 'setup' && !S.setup) { r = 'overview'; setHash(r); }
    if (S.setup && r !== 'setup') { setHash('setup'); return; }
    if (r === S.route) { render(); return; }
    S.route = r; S.drawer = null; S.openPop = null; S.filtersOpen = false; S.confirmRemove = null; S.repoError = null;
    if (!S.focusNext) S.focusNext = 'page-title';
    window.scrollTo(0, 0);
    render();
  });
  window.addEventListener('resize', debounce(drawCharts, 120));

  // ---------- init ----------
  const r0 = routeFromHash();
  S.route = r0 === 'setup' ? 'overview' : r0;
  loadScenario('typical');
})();
