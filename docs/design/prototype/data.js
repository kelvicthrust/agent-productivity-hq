/*
  Kelvin Agent Crew — SYNTHETIC FIXTURE DATA for design review.
  Nothing here was read from Kelvin's machine, accounts or GitHub. Repos, logins, session IDs,
  models, paths, token counts and account reports are invented to exercise the required states.
  Source capabilities shown (e.g. account token reports, % limits, discovered paths) are
  conditional on Tech Spec feasibility checks; they are not established behavior.
*/
(function () {
  'use strict';
  var U = window.UI;

  var TODAY = '2026-11-04';
  var LOOKBACK_START = '2025-11-05'; // trailing 12 months
  var CODEX_FROM = '2026-02-02';
  var CLAUDE_FROM = '2026-03-14';
  var PASEO_FROM = '2026-04-20';
  var ZERO_DAYS = { '2026-11-01': true };
  var ME = 'kelvin';

  var REPOS = ['kelvin/atlas-api', 'kelvin/atlas-web', 'kelvin/notes-cli', 'open-tools/shared-schemas'];
  var REPO_W = [0.36, 0.30, 0.19, 0.15];
  var UNTRACKED = 'kelvin/dotfiles';
  var START_NUM = { 'kelvin/atlas-api': 180, 'kelvin/atlas-web': 120, 'kelvin/notes-cli': 20, 'open-tools/shared-schemas': 340 };
  var MODELS = { codex: ['gpt-5-codex', 'gpt-5-codex-mini'], claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] };
  var AGENTS = ['planner', 'implementer', 'reviewer', 'tester', 'researcher', 'docs'];
  var OTHERS = ['jmoreno', 'priya-s', 'dependabot[bot]'];
  var TITLES = [
    'Add retry backoff to sync worker', 'Extract session parser module', 'Fix timezone bucketing at DST change',
    'Paginate merged PR import', 'Cache provider model list', 'Tighten repo URL validation', 'Add empty state for no repos',
    'Normalize cached-token categories', 'Refactor filter state into URL', 'Improve error copy for denied access',
    'Add weekly aggregation tests', 'Handle renamed repositories', 'Speed up tree expansion', 'Add keyboard nav to chart',
    'Persist owner link corrections', 'Dedupe archived session copies', 'Add CSV export of PR table', 'Upgrade schema validator',
    'Fix off-by-one in month buckets', 'Split API client by provider', 'Add health check endpoint', 'Remove unused feature flag',
    'Document local data retention', 'Guard against duplicate repo adds', 'Show last refresh per source',
    'Add reduced-motion support', 'Fix flaky merge-time test', 'Index sessions by repo and date', 'Add Paseo workspace labels',
    'Improve chart table alternative', 'Handle squash-merge commit matching', 'Clarify account window labels'
  ];

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hex(r) { var s = ''; for (var i = 0; i < 4; i++) s += '0123456789abcdef'[Math.floor(r() * 16)]; return s; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function tokens(provider, r, scale) {
    var t;
    if (provider === 'codex') {
      var input = Math.round((150e3 + r() * 1.4e6) * scale);
      var output = Math.round((8e3 + r() * 60e3) * scale);
      t = { input: input, cached: Math.round(input * (0.55 + r() * 0.3)), output: output, reasoning: Math.round(output * (0.3 + r() * 0.4)) };
      t.total = t.input + t.output; // cached ⊂ input, reasoning ⊂ output
    } else {
      t = {
        input: Math.round((3e3 + r() * 40e3) * scale), cacheWrite: Math.round((40e3 + r() * 300e3) * scale),
        cacheRead: Math.round((300e3 + r() * 3.5e6) * scale), output: Math.round((8e3 + r() * 90e3) * scale)
      };
      t.total = t.input + t.cacheWrite + t.cacheRead + t.output; // separate categories
    }
    return t;
  }

  var base = null;

  function generate() {
    var r = rng(20261104);
    var sessions = [], prs = [], sid = 0, pid = 0;
    var dayIndex = 0;

    function count(mean) { var x = mean * (0.5 + r()); var n = Math.floor(x); if (r() < x - n) n++; return n; }
    function pickRepo() {
      var x = r();
      if (x < 0.07) return null;
      if (x < 0.15) return UNTRACKED;
      var y = r(), acc = 0;
      for (var i = 0; i < REPOS.length; i++) { acc += REPO_W[i]; if (y < acc) return REPOS[i]; }
      return REPOS[0];
    }
    function time(lo, hi) { return pad2(lo + Math.floor(r() * (hi - lo))) + ':' + pad2(Math.floor(r() * 60)); }
    function mk(o) {
      sid++;
      var s = {
        id: 's' + sid, date: o.date, time: o.time, provider: o.provider,
        model: o.model || MODELS[o.provider][Math.floor(r() * (o.provider === 'codex' ? 2 : 3))],
        repo: o.repo, role: o.role, parent: o.parent || null, kind: o.kind,
        paseo: o.paseo || null, ref: (o.provider === 'codex' ? 'thread ' : 'session ') + hex(r) + '…' + hex(r)
      };
      s.tokens = tokens(s.provider, r, o.role === 'root' ? 1 : 0.4);
      s.total = s.tokens.total;
      sessions.push(s);
      return s;
    }

    for (var d = LOOKBACK_START; d <= TODAY; d = U.addDays(d, 1), dayIndex++) {
      if (ZERO_DAYS[d]) continue;
      var w = U.dow(d), weekend = w === 0 || w === 6;
      if (weekend && r() < 0.25) continue; // some genuinely idle weekend days
      var intensity = weekend ? 0.35 : 1;
      var g = 0.6 + 0.6 * (dayIndex / 365);

      ['codex', 'claude'].forEach(function (prov) {
        var from = prov === 'codex' ? CODEX_FROM : CLAUDE_FROM;
        if (d < from) return;
        var nRoots = count((prov === 'codex' ? 1.5 : 2.0) * intensity * g);
        for (var k = 0; k < nRoots; k++) {
          var repo = pickRepo();
          var usePaseo = d >= PASEO_FROM && r() < 0.65;
          var root = mk({
            date: d, time: time(8, 22), provider: prov, repo: repo, role: 'root', kind: usePaseo ? 'paseo' : 'standalone',
            paseo: usePaseo ? { agent: 'planner', workspace: (repo ? repo.split('/')[1] : 'scratch') + ' · wt-' + (1 + Math.floor(r() * 3)) } : null
          });
          var nKids = usePaseo ? count(2.2) : count(0.5);
          for (var c = 0; c < nKids; c++) {
            var childProv = usePaseo ? (r() < 0.45 ? (prov === 'codex' ? 'claude' : 'codex') : prov) : prov;
            if (childProv === 'claude' && d < CLAUDE_FROM) childProv = prov;
            var unknownParent = usePaseo && r() < 0.08;
            var agentName = AGENTS[1 + Math.floor(r() * (AGENTS.length - 1))] + '-' + (c + 1);
            mk({
              date: d, time: root.time, provider: childProv, repo: repo,
              role: unknownParent ? 'unknown' : 'child', parent: unknownParent ? null : root.id,
              kind: usePaseo ? 'paseo' : 'native',
              paseo: usePaseo ? { agent: agentName, workspace: root.paseo.workspace } : null
            });
          }
        }
      });

      // merged PRs (GitHub history for tracked repos is available across the full lookback)
      var nMine = count(1.1 * intensity * (0.8 + 0.4 * dayIndex / 365));
      var nOther = count(0.28 * intensity);
      for (var m = 0; m < nMine + nOther; m++) {
        var mine = m < nMine;
        var y = r(), acc = 0, prRepo = REPOS[0];
        for (var q = 0; q < REPOS.length; q++) { acc += REPO_W[q]; if (y < acc) { prRepo = REPOS[q]; break; } }
        var author = mine ? ME : OTHERS[Math.floor(r() * OTHERS.length)];
        var mergedBy = mine ? (r() < 0.8 ? ME : 'priya-s') : (author === 'dependabot[bot]' ? ME : author);
        var pr = {
          id: 'p' + (++pid), repo: prRepo, title: TITLES[Math.floor(r() * TITLES.length)],
          date: d, time: time(10, 23), author: author, mergedBy: mergedBy, links: []
        };
        if (mine) {
          var lo = U.addDays(d, -2);
          var cands = sessions.filter(function (s) { return s.repo === prRepo && s.date >= lo && s.date <= d; });
          if (cands.length) {
            var roll = r();
            var pick = function () { return cands[Math.floor(r() * cands.length)]; };
            if (roll < 0.48) {
              var a = pick(); pr.links.push({ sid: a.id, cls: 'evidence', basis: r() < 0.5 ? 'PR reference recorded in session' : 'Session commit matches merged commit' });
              if (cands.length > 1 && r() < 0.5) { var b2 = pick(); if (b2.id !== a.id) pr.links.push({ sid: b2.id, cls: 'evidence', basis: 'Session commit matches merged commit' }); }
              if (cands.length > 2 && r() < 0.25) { var c3 = pick(); if (!pr.links.some(function (l) { return l.sid === c3.id; })) pr.links.push({ sid: c3.id, cls: 'suggested', basis: 'Same repo · active within 48 h before merge' }); }
            } else if (roll < 0.68) {
              pr.links.push({ sid: pick().id, cls: 'suggested', basis: 'Same repo · active within 48 h before merge' });
            } else if (roll < 0.78) {
              pr.links.push({ sid: pick().id, cls: 'owner', basis: 'Confirmed by you' });
            }
          }
        }
        prs.push(pr);
      }
    }

    // ---- curated showcase records (deterministic) for the most recent week ----
    function cur(o) {
      var s = {
        id: o.id, date: o.date, time: o.time, provider: o.provider, model: o.model, repo: o.repo, role: o.role,
        parent: o.parent || null, kind: o.kind, paseo: o.paseo || null, ref: o.ref
      };
      s.tokens = tokens(s.provider, r, o.role === 'root' ? 1 : 0.4); s.total = s.tokens.total;
      sessions.push(s); return s;
    }
    // Showcase records sit inside the default "This week" period (Mon Nov 2 – Sun Nov 8, "today" = Wed Nov 4)
    // so the first screen demonstrates every link class and a multi-provider Paseo tree.
    cur({ id: 'c1', date: '2026-11-02', time: '09:14', provider: 'codex', model: 'gpt-5-codex', repo: 'kelvin/atlas-api', role: 'root', kind: 'paseo', paseo: { agent: 'planner', workspace: 'atlas-api · wt-1' }, ref: 'thread 7f3a…2c91' });
    cur({ id: 'c2', date: '2026-11-02', time: '09:31', provider: 'claude', model: 'claude-sonnet-5-5', repo: 'kelvin/atlas-api', role: 'child', parent: 'c1', kind: 'paseo', paseo: { agent: 'implementer-1', workspace: 'atlas-api · wt-1' }, ref: 'session 41be…0d7a' });
    cur({ id: 'c3', date: '2026-11-02', time: '10:02', provider: 'codex', model: 'gpt-5-codex-mini', repo: 'kelvin/atlas-api', role: 'child', parent: 'c1', kind: 'paseo', paseo: { agent: 'tester-2', workspace: 'atlas-api · wt-1' }, ref: 'thread 9c04…e1f8' });
    cur({ id: 'c4', date: '2026-11-03', time: '14:20', provider: 'claude', model: 'claude-opus-5-5', repo: 'kelvin/atlas-web', role: 'root', kind: 'standalone', ref: 'session d2a7…551c' });
    cur({ id: 'c5', date: '2026-11-03', time: '14:40', provider: 'claude', model: 'claude-haiku-5-5', repo: 'kelvin/atlas-web', role: 'child', parent: 'c4', kind: 'native', ref: 'session d2a7…551c · subagent' });
    cur({ id: 'c6', date: '2026-11-02', time: '11:05', provider: 'codex', model: 'gpt-5-codex', repo: 'kelvin/notes-cli', role: 'root', kind: 'standalone', ref: 'thread 2b6e…a0f3' });
    cur({ id: 'c7', date: '2026-11-03', time: '16:30', provider: 'claude', model: 'claude-sonnet-5-5', repo: 'kelvin/atlas-api', role: 'unknown', kind: 'paseo', paseo: { agent: 'reviewer-3', workspace: 'atlas-api · wt-2' }, ref: 'session 88f1…3b2e' });
    cur({ id: 'c8', date: '2026-11-03', time: '20:10', provider: 'codex', model: 'gpt-5-codex', repo: null, role: 'root', kind: 'standalone', ref: 'thread 5e19…c47d' });
    cur({ id: 'c9', date: '2026-11-04', time: '08:50', provider: 'claude', model: 'claude-opus-5-5', repo: 'kelvin/atlas-web', role: 'root', kind: 'paseo', paseo: { agent: 'planner', workspace: 'atlas-web · wt-1' }, ref: 'session a91c…7e02' });
    cur({ id: 'c10', date: '2026-11-04', time: '09:05', provider: 'codex', model: 'gpt-5-codex', repo: 'kelvin/atlas-web', role: 'child', parent: 'c9', kind: 'paseo', paseo: { agent: 'implementer-1', workspace: 'atlas-web · wt-1' }, ref: 'thread 0d3f…b8a6' });

    function curPr(o) { o.id = 'p' + (++pid); prs.push(o); }
    curPr({ repo: 'kelvin/atlas-api', title: 'Split usage importer into provider adapters', date: '2026-11-02', time: '17:42', author: ME, mergedBy: ME,
      links: [{ sid: 'c1', cls: 'evidence', basis: 'PR reference recorded in session' }, { sid: 'c2', cls: 'evidence', basis: 'Session commit matches merged commit' }, { sid: 'c3', cls: 'suggested', basis: 'Same repo · active within 48 h before merge' }] });
    curPr({ repo: 'kelvin/atlas-web', title: 'Add coverage rail to trends chart', date: '2026-11-03', time: '19:05', author: ME, mergedBy: 'priya-s',
      links: [{ sid: 'c4', cls: 'owner', basis: 'Confirmed by you' }] });
    curPr({ repo: 'kelvin/notes-cli', title: 'Handle archived sessions in export', date: '2026-11-02', time: '18:20', author: ME, mergedBy: ME,
      links: [{ sid: 'c6', cls: 'suggested', basis: 'Same repo · active within 48 h before merge' }] });
    curPr({ repo: 'kelvin/atlas-api', title: 'Bump schema validator to 4.2', date: '2026-11-03', time: '10:11', author: 'dependabot[bot]', mergedBy: ME, links: [] });
    curPr({ repo: 'kelvin/atlas-api', title: 'Retry GitHub sync on secondary rate limit', date: '2026-11-03', time: '21:40', author: ME, mergedBy: ME, links: [] });
    curPr({ repo: 'open-tools/shared-schemas', title: 'Document cache token categories', date: '2026-11-02', time: '15:00', author: 'jmoreno', mergedBy: 'jmoreno', links: [] });
    curPr({ repo: 'kelvin/atlas-web', title: 'Show subscription window beside selected period', date: '2026-11-04', time: '11:30', author: ME, mergedBy: ME,
      links: [{ sid: 'c9', cls: 'evidence', basis: 'PR reference recorded in session' }, { sid: 'c10', cls: 'evidence', basis: 'Session commit matches merged commit' }] });

    // number PRs per repo in merge order
    prs.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
    var nums = {}; Object.keys(START_NUM).forEach(function (k) { nums[k] = START_NUM[k]; });
    prs.forEach(function (p) { nums[p.repo] += 1; p.number = nums[p.repo]; p.mergedAt = p.date + 'T' + p.time; });

    // account-reported Codex usage (fixture): broader than this machine
    var winStart = '2026-10-05', winEnd = '2026-11-03';
    var localCodex = 0;
    sessions.forEach(function (s) { if (s.provider === 'codex' && s.date >= winStart && s.date <= winEnd) localCodex += s.total; });

    var counts = { codex: 0, claude: 0 };
    sessions.forEach(function (s) { counts[s.provider]++; });

    return {
      sessions: sessions, prs: prs,
      chatgptWindow: { start: winStart, end: winEnd, total: Math.round(localCodex * 1.31 / 1e5) * 1e5 },
      counts: counts
    };
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function typicalWorld() {
    if (!base) base = generate();
    var b = clone(base);
    return {
      today: TODAY, tz: 'America/Los_Angeles', lookbackStart: LOOKBACK_START, me: ME,
      repos: REPOS.map(function (id) { return { id: id, status: 'ok', since: LOOKBACK_START }; })
        .concat([{ id: 'kelvin/archive-private', status: 'inaccessible', error: 'GitHub no longer grants your connection access to this repository. Its earlier history is kept.' }]),
      removedRepos: [],
      sessions: b.sessions, prs: b.prs,
      sources: {
        codex: { name: 'Codex', status: 'ok', location: '~/.codex/sessions', oldest: CODEX_FROM, sessions: b.counts.codex, lastSuccess: 'Today, 9:42 AM', lastAttempt: 'Succeeded' },
        claude: { name: 'Claude Code', status: 'ok', location: '~/.claude/projects', oldest: CLAUDE_FROM, sessions: b.counts.claude, lastSuccess: 'Today, 9:42 AM', lastAttempt: 'Succeeded' },
        paseo: { name: 'Paseo', status: 'partial', location: 'Paseo local agent metadata', oldest: PASEO_FROM, lastSuccess: 'Today, 9:42 AM', lastAttempt: 'Succeeded with problems', unreadable: 3,
          note: '3 agent records couldn’t be read (unsupported format). Their provider usage is still counted; their agent relationships show as Unknown.' }
      },
      accounts: {
        chatgpt: { name: 'ChatGPT', provider: 'codex', status: 'existing', statusText: 'Using your existing Codex sign-in',
          report: { unit: 'tokens', total: b.chatgptWindow.total, start: b.chatgptWindow.start, end: b.chatgptWindow.end, window: 'Rolling 30 days', scope: 'Account-wide · may include other devices and surfaces', refreshed: 'Today, 9:42 AM' } },
        claude: { name: 'Claude', provider: 'claude', status: 'connected', statusText: 'Connected',
          report: { unit: 'percent', value: 62, label: 'of weekly usage limit used', resets: 'Resets Thu, Nov 5', scope: 'Account-wide', refreshed: 'Today, 9:42 AM' } },
        github: { name: 'GitHub', status: 'connected', statusText: 'Connected as kelvin', login: ME }
      },
      refresh: { failed: false },
      filters: null, setup: null, loading: false
    };
  }

  var SCENARIOS = [
    { id: 'typical', label: 'Typical month', desc: 'Partial Paseo collection, unknown repo/parentage, all link classes, multi-provider PRs, inaccessible repo, account window differs.' },
    { id: 'first-launch', label: 'First launch — discovery', desc: 'Automatic discovery in progress, then Codex and Claude Code found and Paseo “Needs a password” (answers settle after about 2 seconds). Existing ChatGPT sign-in. No repos yet.' },
    { id: 'nothing-found', label: 'First launch — nothing found', desc: 'No local records on this machine: Codex and Claude Code “Not found”, Paseo “Not running” (answers settle after about 2 seconds). Connecting an account still works but adds no local history.' },
    { id: 'refresh-failed', label: 'Refresh failed (cached data)', desc: 'Codex refresh failed; cached data stays readable. Claude account needs reconnection.' },
    { id: 'no-repos', label: 'No tracked repos', desc: 'Local usage loads; delivery has nothing to show until repos are added.' },
    { id: 'account-only', label: 'Account-only usage', desc: 'No readable local records. Account-reported usage only, with no session or repo detail.' },
    { id: 'zero-day', label: 'True zero activity', desc: 'A covered day (Sun, Nov 1) with no recorded activity, which is different from unavailable history.' },
    { id: 'before-history', label: 'Before available history', desc: 'Nov 2025 – Mar 2026: delivery exists, local usage history starts Feb 2 (Codex) and Mar 14 (Claude Code).' },
    { id: 'loading', label: 'Chart loading → error', desc: 'Overview loading skeletons, then a chart build error with retry; the table alternative stays usable.' }
  ];

  function build(id) {
    var w = typicalWorld();
    w.scenario = id;
    switch (id) {
      case 'first-launch':
        w.setup = { mode: 'first' };
        w.repos = []; break;
      case 'nothing-found':
        w.setup = { mode: 'nothing' };
        w.repos = []; break;
      case 'refresh-failed':
        w.pendingSessions = w.sessions.filter(function (s) { return s.provider === 'codex' && s.date === TODAY; });
        w.sessions = w.sessions.filter(function (s) { return !(s.provider === 'codex' && s.date === TODAY); });
        w.sources.codex.status = 'failed';
        w.sources.codex.staleAfter = '2026-11-03';
        w.sources.codex.lastSuccess = 'Nov 3, 6:12 PM';
        w.sources.codex.lastAttempt = 'Failed today, 9:40 AM';
        w.sources.codex.error = 'Couldn’t read 2 new session files (unrecognized format). Already-imported history is unaffected.';
        w.refresh.failed = true;
        w.accounts.claude.status = 'reconnect';
        w.accounts.claude.statusText = 'Reconnect needed';
        w.accounts.claude.report.refreshed = 'Oct 30, 8:05 AM';
        w.accounts.claude.report.stale = true;
        break;
      case 'no-repos':
        w.repos = [];
        break;
      case 'account-only':
        w.sessions = [];
        w.prs.forEach(function (p) { p.links = []; });
        ['codex', 'claude', 'paseo'].forEach(function (k) {
          // D8: Paseo is a daemon, so with no records it is "Not running", never "Not found" (Codex and Claude Code are folders).
          var s = w.sources[k]; s.status = k === 'paseo' ? 'notrunning' : 'notfound'; s.oldest = null; s.sessions = 0; s.unreadable = 0; s.note = null;
          s.lastAttempt = 'No records found'; s.lastSuccess = '—';
        });
        break;
      case 'zero-day':
        w.filters = { period: 'custom', start: '2026-11-01', end: '2026-11-01', gran: 'day' };
        break;
      case 'before-history':
        w.filters = { period: 'custom', start: '2025-11-10', end: '2026-04-05', gran: 'week' };
        break;
      case 'loading':
        w.loading = true; break;
    }
    w.sessionById = {};
    w.sessions.forEach(function (s) { w.sessionById[s.id] = s; });
    return w;
  }

  window.FIXTURE = {
    TODAY: TODAY, LOOKBACK_START: LOOKBACK_START, ME: ME, CODEX_FROM: CODEX_FROM, CLAUDE_FROM: CLAUDE_FROM,
    SCENARIOS: SCENARIOS, build: build
  };
})();
