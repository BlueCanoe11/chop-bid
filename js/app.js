import { getState, getUser, getUserLeagues, loadLeague } from './sleeper.js';
import { lineup, simulateTrace } from './model.js';
import { computeAll, buildBrief } from './engine.js';
import { lineChart, multiLineChart } from './charts.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (p, d = 0) => `${(p * 100).toFixed(d)}%`;
const money = (v) => `$${Math.round(v)}`;
const tick = () => new Promise((r) => setTimeout(r, 0));
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const sum = (a) => a.reduce((x, y) => x + y, 0);

// ---------- persisted preferences (per-viewer convenience only) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(`chopbid.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`chopbid.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(`chopbid.${k}`); } catch { /* storage unavailable */ } },
};

const S = {
  raw: null, ls: null, proj: null, season: null, market: null, money: null, results: [], plan: null,
  trending: {}, selected: null, posFilter: 'ALL', userId: null, onlyUpgrades: false, sort: { key: 'bid', dir: -1 },
  prefs: { objective: 'weeks', thrift: 0, lastWeek: 17, sims: 6000, assumeChopped: 'auto', ...store.get('prefs', {}) },
};

// 3,000 simulations left 2-10% noise in player values; 6,000 is the floor now.
if (S.prefs.sims < 6000) S.prefs.sims = 6000;

function loading(on, text) {
  $('#loading').hidden = !on;
  if (text) $('#loading-text').textContent = text;
}

// ---------- setup ----------
function showSetup(message) {
  $('#dash').hidden = true;
  $('#setup').hidden = false;
  $('#pillnav').hidden = true;
  $('#btn-change').hidden = true; $('#btn-settings').hidden = true;
  $('#league-meta').textContent = '';
  if (message) $('#setup-results').innerHTML = `<p class="info warn">${esc(message)}</p>`;
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#setup-input').value.trim();
  const out = $('#setup-results');
  out.innerHTML = '';
  if (/^\d{12,}$/.test(q)) return openLeague(q);
  loading(true, 'Looking up user…');
  try {
    const [user, state] = await Promise.all([getUser(q), getState()]);
    if (!user) throw new Error(`No Sleeper user named “${q}”.`);
    S.userId = user.user_id;
    store.set('userId', user.user_id);
    const leagues = (await getUserLeagues(user.user_id, state.season)) || [];
    if (!leagues.length) throw new Error(`${user.display_name} has no ${state.season} NFL leagues.`);
    leagues.sort((a, b) => (b.settings?.type === 3) - (a.settings?.type === 3));
    out.innerHTML = `<div class="league-list">${leagues.map((l) => `
      <button class="league-item" type="button" data-id="${esc(l.league_id)}">
        <span><b>${esc(l.name)}</b><span class="meta">${l.total_rosters} teams · $${l.settings?.waiver_budget ?? '?'} FAAB</span></span>
        <span class="tag ${l.settings?.type === 3 ? 'chop' : ''}">${l.settings?.type === 3 ? 'Chopped' : 'Not chopped'}</span>
      </button>`).join('')}</div>`;
    out.querySelectorAll('.league-item').forEach((b) => b.addEventListener('click', () => openLeague(b.dataset.id)));
  } catch (err) {
    out.innerHTML = `<p class="info warn">${esc(err.message)}</p>`;
  } finally { loading(false); }
});

$('#btn-change').addEventListener('click', () => {
  store.del('leagueId');
  $('#setup-results').innerHTML = '';
  showSetup();
  window.scrollTo({ top: 0 });
});

async function openLeague(id) {
  loading(true, 'Reading league from Sleeper…');
  try {
    S.raw = await loadLeague(id);
    store.set('leagueId', id);
    S.userId = S.userId || store.get('userId', null);
    const urlTeam = new URLSearchParams(location.search).get('team');
    let myRid = urlTeam ? Number(urlTeam) : store.get(`team.${id}`, null);
    if (!myRid && S.userId) myRid = S.raw.rosters.find((r) => r.owner_id === S.userId)?.roster_id ?? null;
    S.myRid = myRid;
    $('#setup').hidden = true;
    $('#btn-change').hidden = false; $('#btn-settings').hidden = false;
    if (myRid == null) { loading(false); openSettings(true); return; }
    await compute();
  } catch (err) {
    loading(false);
    showSetup(err.message);
  }
}

// ---------- the model run (shared with the scheduled brief job via engine.js) ----------
async function compute() {
  loading(true, 'Loading projections…');
  try {
    const result = await computeAll({ raw: S.raw, prefs: S.prefs, myRid: S.myRid }, async (m) => { loading(true, m); await tick(); });
    S.outlook = result.outlook;
    S.trending = result.trending;
    S.scenarios = result.scenarios;
    S.result = result;
    applyScenario(0);
  } catch (err) {
    console.error(err);
    $('#dash').hidden = false;
    showNotice(`Something went wrong: ${esc(err.message)}`, true);
  } finally { loading(false); }
}

function applyScenario(i) {
  S.scenarioIdx = i;
  const b = S.scenarios[i].bundle;
  Object.assign(S, { ls: b.ls, proj: b.proj, season: b.season, market: b.market, money: b.money, results: b.results, plan: b.plan, _ranks: null });
  S.selected = S.plan?.claims[0]?.r.pl.id || S.results.find((r) => !r.opt.skip)?.pl.id || null;
  render();
}

function renderScenarios() {
  const box = $('#scenarios');
  if (!S.scenarios || S.scenarios.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="scen-head">Week ${S.ls.curWeek} elimination not settled · bids depend on who is cut · Sleeper runs waivers after it’s processed</div>
    <div class="scen-tabs">${S.scenarios.map((sc, i) => {
      const plan = sc.bundle.plan;
      const top = (plan?.claims || []).slice(0, 3).map((c) => `${esc(c.r.pl.name)} <b>${money(c.opt.bid)}</b>`).join(', ');
      return `<button type="button" class="scen-tab ${i === S.scenarioIdx ? 'on' : ''}" data-i="${i}">
        <span class="p">${pct(sc.p)}</span><div class="t">If ${esc(sc.name)} is cut</div>
        <div class="s">${top || 'No positive-value claims'}</div></button>`;
    }).join('')}</div>`;
  box.querySelectorAll('.scen-tab').forEach((b) => b.addEventListener('click', () => applyScenario(Number(b.dataset.i))));
}

// ---------- derived numbers ----------
function showNotice(html, warn = false) {
  const n = $('#notice');
  n.innerHTML = html; n.hidden = !html; n.classList.toggle('warn', warn);
}
const isWin = () => S.prefs.objective === 'win';
const fmtU = (dU) => (isWin() ? `${dU >= 0 ? '+' : ''}${dU.toFixed(2)} pp` : `${dU >= 0 ? '+' : ''}${dU.toFixed(2)} wk`);
const isMe = (t) => String(t.rid) === String(S.myRid);
const pname = (id) => S.season.players[id]?.name || '—';
const SLOT_LABEL = { FLEX: 'FLEX', SUPER_FLEX: 'SFLEX', WRRB_FLEX: 'W/R', REC_FLEX: 'W/T' };
const slotName = (slot) => SLOT_LABEL[slot] || slot;
const inPlan = (id) => (S.plan?.claims || []).findIndex((c) => c.r.pl.id === id);
// Same lineup scoring as the simulator, including free-agent streamers for weak or empty slots.
const lineupAt = (ids, w) => lineup(ids, S.season.players, S.season.slots, w, S.season.lastFetched, S.season.repl?.[w], S.season.avail?.[w]);
const streamsOf = (lu) => lu.streams || [];
const projAt = (id, w) => S.season.players[id]?.weeks?.[w] || 0;

// While the current week is still being played, Sleeper lineups are still set for it.
const setLabel = () => (S.ls.bidWeek > S.ls.curWeek ? `current lineup, set for Wk ${S.ls.curWeek}` : 'lineup as set');
// Sleeper's view of a team for a week: the lineup exactly as set in Sleeper, on Sleeper's projections.
function sleeperSetLineup(rid, w) {
  const roster = S.raw.rosters.find((r) => String(r.roster_id) === String(rid));
  const positions = (S.ls.league.roster_positions || []).filter((p) => !['BN', 'IR', 'TAXI'].includes(p));
  const starters = (roster?.starters || []).slice(0, positions.length);
  return { slots: positions.map((slot, i) => ({ slot, id: starters[i] && starters[i] !== '0' ? starters[i] : null })), total: sum(starters.map((id) => projAt(id, w))) };
}

// Sleeper position rank by projected points for the bid week, across all projected players.
function posRanks() {
  if (S._ranks) return S._ranks;
  const map = {};
  const byPos = {};
  for (const p of Object.values(S.season.players)) (byPos[p.pos] = byPos[p.pos] || []).push(p);
  for (const [pos, list] of Object.entries(byPos)) {
    // Only players with a projection this week are ranked (byes and injuries show as —).
    list.filter((p) => (p.next || 0) > 0).sort((a, b) => b.next - a.next).forEach((p, i) => { map[p.id] = `${pos}${i + 1}`; });
  }
  S._ranks = map;
  return map;
}

function roleText(role, withStarts = true) {
  const f = role?.first;
  if (!f) return 'No projected starts in the horizon';
  const now = f.week === S.ls.bidWeek;
  const who = f.replaced ? `replacing ${pname(f.replaced)}` : f.streamer ? 'replacing a free-agent streamer' : 'in an empty slot';
  const head = now ? `Starts at ${slotName(f.slot)} in Week ${f.week}, ${who}` : `First starts Week ${f.week} at ${slotName(f.slot)}, ${who}`;
  return withStarts ? `${head}; starts ${role.starts} of ${role.of} weeks` : head;
}

// ---------- rendering ----------
function render() {
  const { ls, season } = S;
  $('#dash').hidden = false;
  $('#setup').hidden = true;
  $('#pillnav').hidden = false;
  const me = season.teams[season.meIdx];
  $('#league-meta').textContent = `${ls.league.name} · Week ${ls.bidWeek} waivers · ${season.teams.length} teams remaining`;
  $('#dash-eyebrow').textContent = `${ls.league.name}${me ? ` · ${me.name}` : ''}`;
  $('#dash-title').textContent = `Week ${ls.bidWeek} waivers`;

  const notes = [];
  if (!me) notes.push('Your team is not among the remaining teams. Choose a different team in Settings.');
  if (ls.pendingVictim) {
    const odds = S.outlook?.chopOdds?.[ls.pendingVictim.rid];
    const rivals = (S.outlook?.rows || []).filter((r) => String(r.t.rid) !== String(ls.pendingVictim.rid) && r.pChop >= 0.05).sort((a, b) => b.pChop - a.pChop);
    const unsure = odds != null && odds < 0.9;
    notes.push(`Week ${ls.curWeek} has not been processed. Assuming <b>${esc(ls.pendingVictim.name)}</b> is eliminated${odds != null ? ` (P = ${pct(odds)} from live points plus remaining projections)` : ''}; their players are included as <span class="tag incoming">Incoming</span>.${unsure ? ` <b>This is not settled</b>${rivals.length ? `: ${rivals.map((r) => `${esc(r.t.name)} ${pct(r.pChop)}`).join(', ')}` : ''}. Incoming players and their bids only apply if that team is cut; reload after Sleeper processes the elimination, or choose a team in Settings.` : ' Override in Settings.'}`);
  }
  if (ls.unsupportedSlots.length) notes.push(`Slots not modeled: ${esc([...new Set(ls.unsupportedSlots)].join(', '))}.`);
  showNotice(notes.join('<br>'), !me);
  renderScenarios();

  if (!me) {
    $('#dash-lede').textContent = '';
    ['#kpis', '#plan-cards', '#plan-totals', '#targets', '#lineup-table', '#weeks-table', '#budgets-card', '#money-card'].forEach((s) => { $(s).innerHTML = ''; });
    $('#detail').hidden = true;
    $('#sim-sec').hidden = true;
    renderOutlook(); renderLive(); renderRisk(); renderMethod();
    return;
  }
  renderSummary(me);
  renderPlan(me);
  renderFilters();
  renderTargets();
  renderDetail();
  renderLineups(me);
  renderSim(me);
  renderOutlook();
  renderLive();
  renderRisk();
  renderBudgets();
  renderMoney(me);
  renderMethod();
  renderBrief();
}

// The same brief the scheduled job publishes for Instinct, for checking or pasting by hand.
function renderBrief() {
  const box = $('#brief');
  if (!box || !S.result) return;
  const { markdown } = buildBrief(S.result, { owner: S.season.teams[S.season.meIdx]?.name || 'the team owner' });
  const url = store.get('briefUrl', '');
  box.innerHTML = `
    <div class="brief-bar">
      <button class="btn-sm" type="button" id="brief-copy">Copy brief</button>
      <span class="muted small">${url ? `Published at <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : 'Not published yet. Once hosting is set up, Instinct reads this from a private link.'}</span>
    </div>
    <pre class="brief-text">${esc(markdown)}</pre>`;
  $('#brief-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(markdown); $('#brief-copy').textContent = 'Copied'; } catch { $('#brief-copy').textContent = 'Copy failed'; }
    setTimeout(() => { const b = $('#brief-copy'); if (b) b.textContent = 'Copy brief'; }, 1500);
  });
}

function riskRank() {
  const { chopNext } = S.season.baseline;
  const order = chopNext.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p);
  return order.findIndex((x) => x.i === S.season.meIdx) + 1;
}

function renderSummary(me) {
  const { baseline, horizon, teams, mu, sd, meIdx } = S.season;
  const w = S.ls.bidWeek;
  const plan = S.plan;
  const claims = plan?.claims || [];
  const expSpend = plan?.expSpend ?? sum(claims.map((c) => c.opt.p * c.opt.bid));
  const rank = riskRank();
  const sl = sleeperSetLineup(me.rid, w);
  const budRank = teams.map((t) => t.budgetLeft).sort((a, b) => b - a).indexOf(me.budgetLeft) + 1;
  const lam = S.money.lambda;
  $('#dash-lede').innerHTML = claims.length
    ? `The model recommends <b>${claims.length} claim${claims.length === 1 ? '' : 's'} totaling ${money(plan.total)}</b> (expected spend ${money(expSpend)} after win probabilities), retaining ${money(me.budgetLeft - plan.total)}. Week ${w} elimination probability is <b>${pct(baseline.pChopNext, 1)}</b>, ${ordinal(rank)} highest of ${teams.length}.`
    : `No claim has positive expected value at current prices. Week ${w} elimination probability is <b>${pct(baseline.pChopNext, 1)}</b>, ${ordinal(rank)} highest of ${teams.length}.`;
  const gauge = (f, cls = '') => `<div class="gauge ${cls}"><i style="width:${Math.max(0, Math.min(1, f)) * 100}%"></i></div>`;
  const maxRisk = Math.max(...S.season.baseline.chopNext, 0.01);
  $('#kpis').innerHTML = `
    <div class="metric risk"><div class="k">P(eliminated), Wk ${w}</div><div class="v">${pct(baseline.pChopNext, 1)}</div>${gauge(baseline.pChopNext / maxRisk, 'neg')}<div class="d">${ordinal(rank)} highest of ${teams.length}</div></div>
    <div class="metric"><div class="k">Projected score, Wk ${w}</div><div class="v">${mu[meIdx][0].toFixed(1)}</div>${gauge(mu[meIdx][0] / Math.max(...mu.map((m) => m[0])))}<div class="d">Model ±${sd[meIdx][0].toFixed(1)} · <b class="sl">Sleeper ${sl.total.toFixed(1)}</b> (${setLabel()})</div></div>
    <div class="metric"><div class="k">Expected weeks survived</div><div class="v">${baseline.expWeeks.toFixed(2)}</div>${gauge(baseline.expWeeks / horizon.length)}<div class="d">of ${horizon.length} remaining eliminations</div></div>
    <div class="metric"><div class="k">P(win league)</div><div class="v">${pct(baseline.pWin, 1)}</div>${gauge(baseline.pWin / Math.max(baseline.pWin, 2 / teams.length))}<div class="d">Uniform baseline ${pct(1 / teams.length, 1)}</div></div>
    <div class="metric"><div class="k">FAAB remaining</div><div class="v">${money(me.budgetLeft)}</div>${gauge(me.budgetLeft / Math.max(...teams.map((t) => t.budgetLeft), 1))}<div class="d">${ordinal(budRank)} of ${teams.length}</div></div>
    <div class="metric"><div class="k">${isWin() ? 'Price of +1 pp win prob.' : 'Price of +1 week survived'}</div><div class="v">${isFinite(lam) && lam > 0 ? money(1 / lam) : '—'}</div>${gauge(isFinite(lam) && lam > 0 ? (1 / lam) / me.budgetLeft : 0)}<div class="d">1 / λ (shadow price of FAAB)</div></div>`;
}

function renderPlan(me) {
  const plan = S.plan;
  const claims = plan?.claims || [];
  const expSpend = plan?.expSpend ?? sum(claims.map((c) => c.opt.p * c.opt.bid));
  $('#plan-sub').innerHTML = claims.length
    ? 'Each claim is chosen and priced by scoring the whole plan over every win/lose combination of its claims (win probabilities treated as independent), so a long-shot claim doesn’t crowd out its backups and overlapping players are valued together. Ranges show the bid if future money were worth half or twice as much.'
    : 'No claims recommended: every player’s expected value is negative at the bids required to win them.';
  $('#plan-cards').innerHTML = claims.map((c, i) => {
    const r = c.r;
    return `<button type="button" class="claim-card ${r.pl.id === S.selected ? 'sel' : ''}" data-id="${r.pl.id}">
      <div class="cc-top"><span class="cc-n">#${i + 1}</span><span class="cc-pos">${r.pl.pos} · ${esc(r.pl.team)}${r.pl.opp ? ` vs ${esc(r.pl.opp)}` : ''}</span>${r.incoming ? '<span class="tag incoming">Incoming</span>' : ''}</div>
      <div class="cc-name">${esc(r.pl.name)}</div>
      <div class="cc-bid"><span class="cc-amt">${money(c.opt.bid)}</span><span class="cc-p">${pct(c.opt.p)} <small>to win</small></span></div>
      <div class="pbar big"><i style="width:${Math.max(2, c.opt.p * 100).toFixed(0)}%"></i></div>
      ${r.range ? `<div class="cc-range">Range <b>${money(r.range.lo.skip ? 0 : r.range.lo.bid)}–${money(r.range.hi.bid)}</b> if money is worth 2× / ½×</div>` : ''}
      <dl class="cc-stats">
        <div><dt>Max bid</dt><dd>${money(c.opt.breakEven)}</dd></div>
        <div><dt>Market P50</dt><dd>${c.opt.median != null ? money(c.opt.median) : `&gt;${money(me.budgetLeft)}`}</dd></div>
        <div><dt>Adds</dt><dd>${fmtU(c.marg)}</dd></div>
      </dl>
      <p class="cc-role">${esc(roleText(c.r.role))}</p>
    </button>`;
  }).join('');
  $('#plan-totals').innerHTML = claims.length ? `
    <div><span>Total if all win</span><b>${money(plan.total)}</b></div>
    <div><span>Expected spend</span><b>${money(expSpend)}</b></div>
    <div><span>Remaining if all win</span><b>${money(me.budgetLeft - plan.total)}</b></div>
    <div><span>FAAB now</span><b>${money(me.budgetLeft)}</b></div>` : '';
  $('#plan-cards').querySelectorAll('.claim-card').forEach((b) => b.addEventListener('click', () => selectPlayer(b.dataset.id)));
}

// ---------- bids-by-player table ----------
function columns() {
  const ranks = posRanks();
  const w = S.ls.bidWeek;
  const of = S.season.horizon.length;
  return [
    { key: 'name', label: 'Player', l: true, get: (r) => r.pl.name, csv: (r) => r.pl.name,
      html: (r) => `<span class="pl">${esc(r.pl.name)}<small>${esc(r.pl.team)}${r.pl.opp ? ` vs ${esc(r.pl.opp)}` : ''}</small></span>${r.incoming ? '<span class="tag incoming">Incoming</span>' : ''}${r.pl.injury ? `<span class="tag inj">${esc(r.pl.injury)}</span>` : ''}` },
    { key: 'pos', label: 'Pos', l: true, get: (r) => r.pl.pos },
    { key: 'sproj', label: `Proj Wk ${w}`, src: 'Sleeper', grp: true, sleeper: true, get: (r) => r.pl.next, fmt: (v) => v.toFixed(1) },
    { key: 'savg', label: 'Proj avg', src: 'Sleeper', sleeper: true, get: (r) => r.pl.avg, fmt: (v) => v.toFixed(1) },
    { key: 'srank', label: 'Pos rank', src: 'Sleeper', sleeper: true, get: (r) => parseInt((ranks[r.pl.id] || 'X999').replace(/^\D+/, ''), 10), html: (r) => ranks[r.pl.id] || '—', csv: (r) => ranks[r.pl.id] || '' },
    { key: 'trend', label: 'Adds 24h', src: 'Sleeper', sleeper: true, get: (r) => S.trending[r.pl.id]?.count || 0, fmt: (v) => (v ? fmtCount(v) : '—'), csv: (r) => S.trending[r.pl.id]?.count || 0 },
    { key: 'gain', label: 'Lineup +/wk', src: 'Model', grp: true, get: (r) => r.gainWk, fmt: (v) => `+${v.toFixed(1)}` },
    { key: 'starts', label: 'Starts', src: 'Model', get: (r) => r.role?.starts || 0, fmt: (v) => `${v}/${of}` },
    { key: 'value', label: isWin() ? 'Δ P(win)' : 'Δ Exp. weeks', src: 'Model', get: (r) => r.v.dU, fmt: (v) => fmtU(v) },
    { key: 'bidders', label: 'Exp. bidders', src: 'Model', get: (r) => r.bidders, fmt: (v) => v.toFixed(1) },
    { key: 'market', label: 'Market P50', src: 'Model', get: (r) => (r.opt.median ?? Infinity), fmt: (v) => (isFinite(v) ? money(v) : '—') },
    { key: 'max', label: 'Max bid', src: 'Model', get: (r) => r.opt.breakEven, fmt: (v) => money(v) },
    { key: 'bid', label: 'Bid', src: 'Model', grp: true, get: (r) => (r.opt.skip ? -1 : r.opt.bid), html: (r) => (r.opt.skip ? '<span class="pass">Pass</span>' : `<span class="bid">${money(r.opt.bid)}</span>`), csv: (r) => (r.opt.skip ? '' : r.opt.bid) },
    { key: 'range', label: 'Range', src: 'λ ×2 / ×½', get: (r) => (r.range ? r.range.hi.bid : -1), html: (r) => (r.range ? `<span class="muted">${money(r.range.lo.skip ? 0 : r.range.lo.bid)}–${money(r.range.hi.bid)}</span>` : '<span class="pass">—</span>'), csv: (r) => (r.range ? `${r.range.lo.skip ? 0 : r.range.lo.bid}-${r.range.hi.bid}` : '') },
    { key: 'p', label: 'P(win)', src: 'Model', get: (r) => (r.opt.skip ? -1 : r.opt.p), html: (r) => (r.opt.skip ? '<span class="pass">—</span>' : `<span class="pcell"><span class="pbar"><i style="width:${Math.max(2, r.opt.p * 100).toFixed(0)}%"></i></span>${pct(r.opt.p)}</span>`), csv: (r) => (r.opt.skip ? '' : r.opt.p.toFixed(3)) },
    { key: 'plan', label: 'Plan', get: (r) => { const i = inPlan(r.pl.id); return i < 0 ? 99 : i + 1; }, html: (r) => { const i = inPlan(r.pl.id); return i < 0 ? '' : `<span class="tag plan">#${i + 1}</span>`; }, csv: (r) => { const i = inPlan(r.pl.id); return i < 0 ? '' : i + 1; } },
  ];
}

function visibleRows() {
  const byPos = S.results.filter((r) => S.posFilter === 'ALL' || r.pl.pos === S.posFilter);
  const rows = S.onlyUpgrades ? byPos.filter((r) => r.gainWk > 0.05) : byPos.slice();
  const cols = columns();
  const col = cols.find((c) => c.key === S.sort.key) || cols[0];
  const dir = S.sort.dir;
  rows.sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return (cmp * dir) || (b.v.dU - a.v.dU);
  });
  return { rows, hidden: byPos.length - rows.length };
}

function renderFilters() {
  const positions = ['ALL', ...new Set(S.results.map((r) => r.pl.pos))];
  if (!positions.includes(S.posFilter)) S.posFilter = 'ALL';
  $('#pos-filters').innerHTML = positions.map((p) => `<button type="button" role="tab" aria-selected="${p === S.posFilter}" class="${p === S.posFilter ? 'on' : ''}" data-pos="${p}">${p === 'ALL' ? 'All' : p}</button>`).join('');
  $('#pos-filters').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { S.posFilter = b.dataset.pos; renderFilters(); renderTargets(); }));
  $('#show-all').checked = S.onlyUpgrades;
}
$('#show-all').addEventListener('change', (e) => { S.onlyUpgrades = e.target.checked; renderTargets(); });

function renderTargets() {
  const cols = columns();
  const { rows, hidden } = visibleRows();
  const bidCount = rows.filter((r) => !r.opt.skip).length;
  const upgrades = rows.filter((r) => r.gainWk > 0.05).length;
  $('#targets-sub').innerHTML = `${rows.length} available players${hidden ? ` (${hidden} filtered)` : ''}: ${upgrades} would improve your lineup, ${bidCount} with a positive-value bid. Players who wouldn’t start for you are listed with their market price and a Pass. Each bid is priced independently; the plan above selects a consistent set. Click a row for the full derivation.`;
  $('#targets-legend').textContent = 'Sleeper columns: Sleeper (Rotowire) projections scored with your league settings, position rank among all projected players, and adds over the last 24 hours across all Sleeper leagues. Model columns: this app’s lineup optimizer, season simulation and bid model.';
  $('#targets').innerHTML = `
    <thead><tr>${cols.map((c) => `<th class="${c.l ? 'l' : ''} ${c.grp ? 'grp' : ''} ${c.sleeper ? 'sleeper' : ''}" data-key="${c.key}">${c.label}${S.sort.key === c.key ? `<span class="arrow">${S.sort.dir < 0 ? '▼' : '▲'}</span>` : ''}${c.src ? `<span class="src">${c.src}</span>` : ''}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr class="clickable ${r.pl.id === S.selected ? 'sel' : ''}" data-id="${r.pl.id}">${cols.map((c) => {
      const v = c.get(r);
      const body = c.html ? c.html(r) : c.fmt ? c.fmt(v) : esc(v);
      return `<td class="${c.l ? 'l' : ''} ${c.grp ? 'grp' : ''} ${c.sleeper ? 'sleeper' : ''}">${body}</td>`;
    }).join('')}</tr>`).join('')}</tbody>`;
  $('#targets').querySelectorAll('th[data-key]').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.key;
    S.sort = S.sort.key === key ? { key, dir: -S.sort.dir } : { key, dir: ['name', 'pos', 'srank', 'market'].includes(key) ? 1 : -1 };
    renderTargets();
  }));
  $('#targets').querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => selectPlayer(tr.dataset.id)));
}

$('#export-csv').addEventListener('click', () => {
  if (!S.results.length) return;
  const cols = columns();
  const rows = [...S.results].sort((a, b) => (b.opt.skip ? -1 : b.opt.bid) - (a.opt.skip ? -1 : a.opt.bid));
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map((c) => cell(`${c.label}${c.src ? ` (${c.src})` : ''}`)).join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => {
      if (c.csv) return cell(c.csv(r));
      const v = c.get(r);
      return cell(typeof v === 'number' ? (isFinite(v) ? +v.toFixed(3) : '') : v);
    }).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chop-bids-${S.ls.league.league_id}-week${S.ls.bidWeek}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

function selectPlayer(id, scroll = true) {
  S.selected = id;
  renderPlan(S.season.teams[S.season.meIdx]);
  renderTargets(); renderDetail();
  if (scroll) $('#detail').scrollIntoView({ block: 'start' });
}

// ---------- derivation for one player ----------
function weekImpact(pid) {
  const me = S.season.teams[S.season.meIdx];
  return S.season.horizon.map((w) => {
    const base = lineupAt(me.players, w);
    const withP = lineupAt([...me.players, pid], w);
    const starts = withP.starters.includes(pid);
    const replaced = starts ? base.starters.filter((id) => !withP.starters.includes(id)) : [];
    const streamOut = starts && !replaced.length ? streamsOf(base).find((x) => !streamsOf(withP).some((y) => y.slot === x.slot && y.mu === x.mu)) : null;
    return { w, proj: projAt(pid, w), starts, replaced, streamOut, base: base.mu, with: withP.mu, delta: withP.mu - base.mu };
  });
}

function renderDetail() {
  const r = S.results.find((x) => x.pl.id === S.selected);
  const box = $('#detail');
  if (!r) { box.hidden = true; return; }
  box.hidden = false;
  const { opt, opps, v, pl } = r;
  const base = S.season.baseline;
  const me = S.season.teams[S.season.meIdx];
  const w = S.ls.bidWeek;
  const rank = posRanks()[pl.id] || '—';
  const tr = S.trending[pl.id];
  const impact = weekImpact(pl.id);
  const startsN = impact.filter((x) => x.starts).length;
  const totalDelta = sum(impact.map((x) => x.delta));
  const projTotal = sum(impact.map((x) => x.proj));
  const rec = opt.skip ? 'Pass' : money(opt.bid);
  const top = opps.filter((o) => o.q > 0.05).sort((a, b) => b.q * b.median - a.q * a.median).slice(0, 8);
  const pIdx = inPlan(pl.id);
  box.innerHTML = `
    <div class="detail-head">
      <div>
        <p class="eyebrow">Derivation</p>
        <h2>${esc(pl.name)} <span class="muted" style="font-weight:500">${pl.pos} · ${esc(pl.team)}${pl.opp ? ` vs ${esc(pl.opp)}` : ''}</span></h2>
        <p class="sub">${esc(roleText(r.role))}.${pIdx >= 0 ? ` In the bid plan as claim #${pIdx + 1}.` : ''}</p>
      </div>
    </div>
    <div class="steps">
      <div class="step">
        <div class="step-k"><div class="n">Step 1</div><h4>Projection</h4><p>Input. The model uses Sleeper’s weekly projections as-is, scored with your league settings.</p></div>
        <div>
          <div class="compare">
            <div><div class="src">Sleeper · Week ${w}</div><div class="val">${pl.next.toFixed(1)}</div><div class="note">${rank} at his position</div></div>
            <div><div class="src">Sleeper · rest of season</div><div class="val">${projTotal.toFixed(0)}</div><div class="note">${pl.avg.toFixed(1)} per game, ${impact.filter((x) => x.proj > 0).length} of ${impact.length} weeks projected</div></div>
            <div><div class="src">Sleeper · adds, 24h</div><div class="val">${tr ? fmtCount(tr.count) : '—'}</div><div class="note">${tr ? `#${tr.rank} most-added on Sleeper` : 'Not among the most-added players'}</div></div>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-k"><div class="n">Step 2</div><h4>Lineup impact</h4><p>Your optimal lineup is re-picked each week with and without him. Only points above whoever he displaces count, including a free agent you could stream for $0.</p></div>
        <div>
          <div class="compare">
            <div><div class="src">Sleeper projection</div><div class="val">${projTotal.toFixed(0)} pts</div><div class="note">his own projected points, ${impact.length} weeks</div></div>
            <div><div class="src model">Model · added to your lineup</div><div class="val">+${totalDelta.toFixed(1)} pts</div><div class="note">starts ${startsN} of ${impact.length} weeks; +${(totalDelta / impact.length).toFixed(1)} per week</div></div>
          </div>
          <div class="table-wrap" style="margin-top:12px"><table class="data">
            <thead><tr><th class="l">Week</th><th>His proj</th><th class="l">Starts?</th><th class="l">Replaces</th><th>Lineup without</th><th>Lineup with</th><th>Δ</th></tr></thead>
            <tbody>${impact.map((x) => `<tr>
              <td class="l">${x.w}</td><td>${x.proj.toFixed(1)}</td>
              <td class="l">${x.starts ? 'Yes' : '<span class="muted">Bench</span>'}</td>
              <td class="l ${x.replaced.length ? '' : 'dim'}">${x.starts ? (x.replaced.map((id) => `${esc(pname(id))} (${projAt(id, x.w).toFixed(1)})`).join(', ') || (x.streamOut ? `Free-agent ${x.streamOut.pos} (${x.streamOut.mu.toFixed(1)})` : 'Empty slot')) : '—'}</td>
              <td>${x.base.toFixed(1)}</td><td>${x.with.toFixed(1)}</td>
              <td class="${x.delta > 0.05 ? 'pos-txt' : 'dim'}">${x.delta > 0.05 ? `+${x.delta.toFixed(1)}` : '0.0'}</td></tr>`).join('')}</tbody>
          </table></div>
        </div>
      </div>
      <div class="step">
        <div class="step-k"><div class="n">Step 3</div><h4>Survival impact</h4><p>The same ${S.prefs.sims.toLocaleString()} simulated seasons are rerun with him on your roster (common random numbers), so the difference is his effect alone.</p></div>
        <div>
          <div class="compare">
            <div><div class="src">P(eliminated), Wk ${w}</div><div class="val">${pct(base.pChopNext, 1)} → ${pct(v.res.pChopNext, 1)}</div><div class="note">${((v.res.pChopNext - base.pChopNext) * 100).toFixed(1)} pp</div></div>
            <div><div class="src">Expected weeks survived</div><div class="val">${base.expWeeks.toFixed(2)} → ${v.res.expWeeks.toFixed(2)}</div><div class="note">${(v.res.expWeeks - base.expWeeks >= 0 ? '+' : '')}${(v.res.expWeeks - base.expWeeks).toFixed(2)} weeks</div></div>
            <div><div class="src">P(win league)</div><div class="val">${pct(base.pWin, 1)} → ${pct(v.res.pWin, 1)}</div><div class="note">${((v.res.pWin - base.pWin) * 100 >= 0 ? '+' : '')}${((v.res.pWin - base.pWin) * 100).toFixed(2)} pp</div></div>
            <div><div class="src model">Value used for bidding</div><div class="val">${fmtU(v.dU)}</div><div class="note">objective: ${isWin() ? 'league win probability' : 'expected weeks survived'}</div></div>
          </div>
          <p class="explain">Sleeper has no elimination model; its projection treats a point in a safe week the same as a point in a week you are near the cut line. The simulation weights points by how often they change who is eliminated.</p>
        </div>
      </div>
      <div class="step">
        <div class="step-k"><div class="n">Step 4</div><h4>Competing bids</h4><p>Fit on ${S.market.nBids} past blind bids in this league (winning and losing), adjusted for each manager’s budget, need, and elimination risk.</p></div>
        <div>
          <div class="compare">
            <div><div class="src">Sleeper · adds, 24h</div><div class="val">${tr ? fmtCount(tr.count) : '—'}</div><div class="note">demand across all Sleeper leagues</div></div>
            <div><div class="src model">Model · expected bidders</div><div class="val">${r.bidders.toFixed(1)}</div><div class="note">of ${opps.length} opponents in your league</div></div>
            <div><div class="src model">Model · market price (P50)</div><div class="val">${opt.median != null ? money(opt.median) : `&gt;${money(me.budgetLeft)}`}</div><div class="note">bid at which P(win) reaches 50%</div></div>
          </div>
          ${top.length ? `<div class="table-wrap" style="margin-top:12px"><table class="data">
            <thead><tr><th class="l">Opponent</th><th>FAAB</th><th>P(bids)</th><th>Median bid</th><th>Lineup gain/wk</th><th>Aggression</th></tr></thead>
            <tbody>${top.map((o) => `<tr><td class="l">${esc(o.team.name)}</td><td>${money(o.cap)}</td><td>${pct(o.q)}</td><td>${money(o.median)}</td><td>${(o.gain ?? 0) > 0 ? `+${o.gain.toFixed(1)}` : '0.0'}</td><td>${o.aggression != null ? `×${o.aggression.toFixed(2)}` : '—'}</td></tr>`).join('')}</tbody>
          </table></div>` : '<p class="explain">No opponent is likely to bid.</p>'}
        </div>
      </div>
      <div class="step">
        <div class="step-k"><div class="n">Step 5</div><h4>Bid</h4><p>Choose the bid that maximizes P(win) × (value − cost of the money spent). You pay only if you win, and each extra dollar costs a little more than the last as your budget runs down.</p></div>
        <div>
          <div class="compare">
            <div><div class="src model">Recommended bid</div><div class="val">${rec}</div><div class="note">${opt.skip ? 'expected value is negative at every bid' : `P(win) ${pct(opt.p)}`}</div></div>
            <div><div class="src model">Max bid (break-even)</div><div class="val">${money(opt.breakEven)}</div><div class="note">where the money’s cost equals his value</div></div>
            <div><div class="src model">Range</div><div class="val">${r.range ? `${money(r.range.lo.skip ? 0 : r.range.lo.bid)}–${money(r.range.hi.bid)}` : '—'}</div><div class="note">if future money is worth 2× / ½× as much</div></div>
            <div><div class="src model">Cost of the money</div><div class="val">${opt.skip ? '—' : fmtU(S.money.cost(opt.bid))}</div><div class="note">future buying power a ${rec} win uses up</div></div>
          </div>
          <div class="charts2">
            <div><div class="chart-title">P(win) by bid</div><div id="chart-p"></div></div>
            <div><div class="chart-title">Expected value by bid <small>(${isWin() ? 'pp' : 'weeks'}, net of cost)</small></div><div id="chart-ev"></div></div>
          </div>
        </div>
      </div>
    </div>`;
  const maxX = Math.max(10, Math.min(me.budgetLeft, Math.max(opt.breakEven, opt.median || 0) * 1.6));
  const curve = opt.curve.filter((d) => d.bid <= maxX);
  lineChart($('#chart-p'), curve.map((d) => ({ x: d.bid, y: d.p })), {
    cls: 'line-1', yMin: 0, yMax: 1, yFmt: (x) => pct(x), xFmt: (x) => `$${x}`, label: 'Win probability by bid',
    marker: opt.skip ? null : { x: opt.bid, label: `Bid ${rec}` },
    tipFn: (d) => `$${d.x}: P(win) <b>${pct(d.y)}</b>`,
  });
  lineChart($('#chart-ev'), curve.map((d) => ({ x: d.bid, y: d.ev })), {
    cls: 'line-1', yFmt: (x) => x.toFixed(2), xFmt: (x) => `$${x}`, label: 'Expected value by bid',
    marker: opt.skip ? null : { x: opt.bid, label: 'Max EV' },
    tipFn: (d) => `$${d.x}: EV <b>${d.y >= 0 ? '+' : ''}${d.y.toFixed(3)}</b>`,
  });
}

// ---------- lineups ----------
function renderLineups(me) {
  const { horizon } = S.season;
  const w = S.ls.bidWeek;
  const claims = S.plan?.claims || [];
  const planIds = claims.map((c) => c.r.pl.id);
  const sl = sleeperSetLineup(me.rid, w);
  const opt = lineupAt(me.players, w);
  const withPlan = lineupAt([...me.players, ...planIds], w);
  // Align the model's slot assignments with the league's slot order.
  const align = (lu) => {
    const used = {};
    const all = [...(lu.slotted || []), ...streamsOf(lu).map((x) => ({ slot: x.slot, id: null, mu: x.mu, pos: x.pos, stream: true }))];
    return sl.slots.map(({ slot }) => {
      const k = used[slot] = (used[slot] ?? -1) + 1;
      return all.filter((s) => s.slot === slot)[k] || null;
    });
  };
  const optA = align(opt), planA = align(withPlan);
  const cell = (s) => (s ? (s.id ? `${esc(pname(s.id))} <span class="muted">${projAt(s.id, w).toFixed(1)}</span>` : `<span class="muted">Free-agent ${s.pos || ''} stream ${s.mu != null ? s.mu.toFixed(1) : ''}</span>`) : '<span class="dim">—</span>');
  $('#lineup-now-title').textContent = S.ls.bidWeek > S.ls.curWeek
    ? `Week ${w}: your Sleeper lineup (still set for Week ${S.ls.curWeek}) vs. model`
    : `Week ${w}: lineup as set in Sleeper vs. model`;
  $('#lineup-table').innerHTML = `
    <thead><tr><th class="l">Slot</th><th class="l sleeper">${S.ls.bidWeek > S.ls.curWeek ? `Current lineup (Wk ${S.ls.curWeek})` : 'As set in Sleeper'}<span class="src">Sleeper</span></th><th class="l grp">Optimal, current roster<span class="src">Model</span></th><th class="l grp">Optimal with bid plan<span class="src">Model</span></th></tr></thead>
    <tbody>${sl.slots.map((s, i) => {
      const changedSet = optA[i]?.id !== s.id;
      const isNew = planA[i]?.id && planIds.includes(planA[i].id);
      const changedPlan = planA[i]?.id !== optA[i]?.id;
      return `<tr>
        <td class="l">${slotName(s.slot)}</td>
        <td class="l sleeper">${s.id ? `${esc(pname(s.id))} <span class="muted">${projAt(s.id, w).toFixed(1)}</span>` : '<span class="neg-txt">Empty</span>'}</td>
        <td class="l grp ${changedSet ? '' : 'dim'}">${cell(optA[i])}</td>
        <td class="l grp ${changedPlan ? '' : 'dim'}">${isNew ? `<b>${cell(planA[i])}</b> <span class="tag plan">New</span>` : cell(planA[i])}</td>
      </tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td class="l">Total</td><td class="l sleeper">${sl.total.toFixed(1)}</td><td class="l grp">${opt.mu.toFixed(1)} <span class="muted">(${opt.mu - sl.total >= 0 ? '+' : ''}${(opt.mu - sl.total).toFixed(1)} vs Sleeper)</span></td><td class="l grp">${withPlan.mu.toFixed(1)} <span class="muted">(${withPlan.mu - opt.mu >= 0 ? '+' : ''}${(withPlan.mu - opt.mu).toFixed(1)} from plan)</span></td></tr></tfoot>`;

  const rows = horizon.map((wk) => {
    const a = lineupAt(me.players, wk);
    const b = lineupAt([...me.players, ...planIds], wk);
    const ins = b.starters.filter((id) => planIds.includes(id));
    const outs = a.starters.filter((id) => !b.starters.includes(id));
    return { wk, a: a.mu, b: b.mu, ins, outs, streams: streamsOf(a) };
  });
  $('#weeks-table').innerHTML = `
    <thead><tr><th class="l">Week</th><th>Optimal, current roster</th><th>With bid plan</th><th>Δ</th><th class="l">In (if claims win)</th><th class="l">Out of lineup</th><th class="l">Free-agent streams, current roster</th></tr></thead>
    <tbody>${rows.map((x) => `<tr>
      <td class="l">${x.wk}</td><td>${x.a.toFixed(1)}</td><td>${x.b.toFixed(1)}</td>
      <td class="${x.b - x.a > 0.05 ? 'pos-txt' : 'dim'}">${x.b - x.a > 0.05 ? `+${(x.b - x.a).toFixed(1)}` : '0.0'}</td>
      <td class="l wrap">${x.ins.length ? x.ins.map((id) => `${esc(pname(id))} <span class="muted">${projAt(id, x.wk).toFixed(1)}</span>`).join(', ') : '<span class="dim">—</span>'}</td>
      <td class="l wrap">${x.outs.length ? x.outs.map((id) => `${esc(pname(id))} <span class="muted">${projAt(id, x.wk).toFixed(1)}</span>`).join(', ') : x.ins.length ? '<span class="muted">Empty slot filled</span>' : '<span class="dim">—</span>'}</td>
      <td class="l ${x.streams.length ? '' : 'dim'}">${x.streams.length ? x.streams.map((st) => `${st.pos} ${st.mu.toFixed(1)}`).join(', ') : '—'}</td>
    </tr>`).join('')}</tbody>
    <tfoot><tr><td class="l">Total</td><td>${sum(rows.map((x) => x.a)).toFixed(0)}</td><td>${sum(rows.map((x) => x.b)).toFixed(0)}</td><td class="pos-txt">+${sum(rows.map((x) => x.b - x.a)).toFixed(0)}</td><td colspan="3"></td></tr></tfoot>`;
}

// ---------- simulation ----------
function renderSim(me) {
  const { mu, sd, meIdx, draws, horizon, strength } = S.season;
  const planIds = (S.plan?.claims || []).map((c) => c.r.pl.id);
  const base = simulateTrace(mu, sd, meIdx, draws);
  let withPlan = null;
  if (planIds.length) {
    const mine = S.season.teamStrength ? S.season.teamStrength(meIdx, [...me.players, ...planIds]) : strength([...me.players, ...planIds]);
    const mu2 = mu.slice(); mu2[meIdx] = mine.mu;
    const sd2 = sd.slice(); sd2[meIdx] = mine.sd;
    withPlan = simulateTrace(mu2, sd2, meIdx, draws);
  }
  const w = S.ls.bidWeek;
  const sims = draws.sims;
  const sl = sleeperSetLineup(me.rid, w);
  $('#sim-sec').hidden = false;
  const pElim = base.hazard[0];
  $('#sim-sub').innerHTML = `${sims.toLocaleString()} simulated seasons. Each week every remaining team’s optimal lineup (with free-agent streamers) is scored with random variation and the lowest score is eliminated. These are the same simulated seasons used to value every player.`;
  $('#sim-panels').innerHTML = `
    <div class="panel"><h3>Survival curve</h3><p class="sub">Probability you are still alive after each week${withPlan ? ', with your current roster and if every planned claim wins' : ''}.</p><div id="chart-survival"></div></div>
    <div class="panel"><h3>Week ${w}: your score vs. the cut line</h3><p class="sub">Distribution of your simulated score and of the lowest score among the other ${S.season.teams.length - 1} teams. You are eliminated when yours is lower.</p><div id="chart-cut"></div>
      <p class="sim-note">Your score falls below the cut line in <b>${pct(pElim, 1)}</b> of simulations. Model mean ${mu[meIdx][0].toFixed(1)} (optimal lineup) vs. Sleeper ${sl.total.toFixed(1)} (${setLabel()}).</p></div>
    <div class="panel wide"><div class="table-wrap"><table class="data">
      <thead><tr><th class="l">Week</th><th>Teams at start</th><th>P(alive at start)</th><th>P(eliminated | alive)</th><th>P(alive after)</th>${withPlan ? '<th class="grp">P(eliminated | alive), with plan</th><th>P(alive after), with plan</th>' : ''}</tr></thead>
      <tbody>${horizon.map((wk, i) => `<tr>
        <td class="l">${wk}</td><td>${S.season.teams.length - i}</td><td>${pct(i ? base.survival[i - 1] : 1, 1)}</td><td>${pct(base.hazard[i], 1)}</td><td>${pct(base.survival[i], 1)}</td>
        ${withPlan ? `<td class="grp">${pct(withPlan.hazard[i], 1)}</td><td>${pct(withPlan.survival[i], 1)}</td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div></div>`;

  const series = [{ name: 'Current roster', short: 'Now', color: 'var(--series-2)', points: horizon.map((wk, i) => ({ x: wk, y: base.survival[i] })) }];
  if (withPlan) series.push({ name: 'If every planned claim wins', short: 'Plan', color: 'var(--series-1)', points: horizon.map((wk, i) => ({ x: wk, y: withPlan.survival[i] })) });
  multiLineChart($('#chart-survival'), series, {
    yMin: 0, yMax: 1, yFmt: (v) => pct(v), xFmt: (v) => `Wk ${v}`, label: 'Survival probability by week', xTicks: horizon.filter((_, i) => i % 2 === 0),
    tipFn: (x, rows) => `Week ${x}<br>${rows.map((r) => `${r.name}: <b>${r.y != null ? pct(r.y, 1) : '—'}</b>`).join('<br>')}`,
  });

  // Histogram densities on shared 4-point bins.
  const lo = Math.floor(Math.min(...quantiles(base.cutLine, [0.005]), ...quantiles(base.myScore, [0.005])) / 4) * 4;
  const hi = Math.ceil(Math.max(...quantiles(base.cutLine, [0.995]), ...quantiles(base.myScore, [0.995])) / 4) * 4;
  const bins = [];
  for (let x = lo; x < hi; x += 4) bins.push(x);
  const dens = (arr) => {
    const c = new Array(bins.length).fill(0);
    for (const v of arr) { const k = Math.floor((v - lo) / 4); if (k >= 0 && k < c.length) c[k]++; }
    return bins.map((x, k) => ({ x: x + 2, y: c[k] / arr.length }));
  };
  multiLineChart($('#chart-cut'), [
    { name: 'Your score', short: 'You', color: 'var(--series-1)', points: dens(base.myScore) },
    { name: 'Lowest other score (cut line)', short: 'Cut', color: 'var(--series-2)', dash: true, points: dens(base.cutLine) },
  ], {
    yMin: 0, yFmt: (v) => pct(v, 0), xFmt: (v) => `${Math.round(v)}`, label: 'Score distributions', endLabels: false,
    tipFn: (x, rows) => `${Math.round(x - 2)}–${Math.round(x + 2)} pts<br>${rows.map((r) => `${r.name}: <b>${r.y != null ? pct(r.y, 1) : '—'}</b>`).join('<br>')}`,
  });
}

function quantiles(arr, qs) {
  const a = Array.from(arr).sort((x, y) => x - y);
  return qs.map((q) => a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))]);
}

// ---------- league ----------
function renderOutlook() {
  const { teams, mu, sd, baseline } = S.season;
  const w = S.ls.bidWeek;
  const rows = teams.map((t, i) => ({ t, i, sl: sleeperSetLineup(t.rid, w).total, mu: mu[i][0], sd: sd[i][0], p: baseline.chopNext[i] }));
  const slRank = rows.slice().sort((a, b) => a.sl - b.sl).map((x) => x.i);
  const pRank = rows.slice().sort((a, b) => b.p - a.p).map((x) => x.i);
  rows.sort((a, b) => b.p - a.p);
  $('#outlook-card').innerHTML = `<h3>Week ${w} elimination outlook</h3>
    <p class="sub">Sleeper projects each lineup as currently set${S.ls.bidWeek > S.ls.curWeek ? ` (still the Week ${S.ls.curWeek} lineups, so Week ${w} byes count as zero)` : ''}. The model re-optimizes every lineup and simulates the week; P(eliminated) is the share of simulations in which the team scores lowest.</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th class="l">Team</th><th>FAAB</th><th class="grp sleeper">Projected (as set)<span class="src">Sleeper</span></th><th class="sleeper">Rank, lowest first<span class="src">Sleeper</span></th><th class="grp">Projected (optimal)<span class="src">Model</span></th><th>σ<span class="src">Model</span></th><th>P(eliminated)<span class="src">Model</span></th><th>Rank<span class="src">Model</span></th></tr></thead>
      <tbody>${rows.map((x) => `<tr>
        <td class="l ${isMe(x.t) ? 'me' : ''}">${esc(x.t.name)}</td><td>${money(x.t.budgetLeft)}</td>
        <td class="grp sleeper">${x.sl.toFixed(1)}</td><td class="sleeper">${slRank.indexOf(x.i) + 1}</td>
        <td class="grp">${x.mu.toFixed(1)}</td><td>${x.sd.toFixed(1)}</td><td>${pct(x.p, 1)}</td><td>${pRank.indexOf(x.i) + 1}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

function renderLive() {
  const { ls, outlook } = S;
  const card = $('#live-card');
  if (!ls.liveStarted || ls.chopDoneThisWeek || !outlook) { card.hidden = true; return; }
  card.hidden = false;
  const sorted = outlook.rows.slice().sort((a, b) => (b.pChop - a.pChop) || (a.expected - b.expected));
  const shown = sorted.slice(0, 6);
  const mine = sorted.find((r) => isMe(r.t));
  if (mine && !shown.includes(mine)) shown.push(mine);
  const left = outlook.gamesLeft;
  card.innerHTML = `<h3>Week ${ls.curWeek} projected finish</h3>
    <p class="sub">${left ? `${left} game${left === 1 ? '' : 's'} remaining.` : 'All games final.'} Live points plus Sleeper projections for starters still to play.</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th class="l">Team</th><th>Live</th><th>To play</th><th>Projected final</th><th>P(eliminated)</th></tr></thead>
      <tbody>${shown.map((r) => `<tr>
        <td class="l ${isMe(r.t) ? 'me' : ''}">${esc(r.t.name)}${String(r.t.rid) === String(ls.pendingVictim?.rid) ? ' <span class="tag incoming">Assumed</span>' : ''}</td>
        <td>${r.live.toFixed(1)}</td><td>${r.toPlay}</td><td>${r.expected.toFixed(1)}</td><td>${r.pChop >= 0.0005 ? pct(r.pChop, 1) : '&lt;0.1%'}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

function renderRisk() {
  const { season } = S;
  const rows = season.teams.map((t, i) => ({ t, i, p: season.baseline.chopNext[i] })).sort((a, b) => b.p - a.p);
  const shown = rows.slice(0, 10);
  if (season.meIdx >= 0 && !shown.some((r) => r.i === season.meIdx)) shown.push(rows.find((r) => r.i === season.meIdx));
  const max = Math.max(...shown.map((r) => r.p), 0.01);
  $('#risk-card').innerHTML = `<h3>P(eliminated), Week ${S.ls.bidWeek}</h3>
    <p class="sub">Share of ${S.prefs.sims.toLocaleString()} simulations in which each team scores lowest.</p>
    <div class="bars">${shown.map((r) => `
      <div class="bar-row ${r.i === season.meIdx ? 'me' : ''}" title="${esc(r.t.name)}: ${pct(r.p, 1)}">
        <span class="nm">${esc(r.t.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(r.p / max) * 100}%"></span></span>
        <span class="v">${pct(r.p, 1)}</span>
      </div>`).join('')}</div>`;
}

function renderBudgets() {
  const market = S.market;
  const rows = S.season.teams.slice().sort((a, b) => b.budgetLeft - a.budgetLeft);
  $('#budgets-card').innerHTML = `<h3>Budgets and bidding behavior</h3>
    <p class="sub">From ${market.nBids} past bids. Aggression is each manager’s typical bid relative to the league price curve (×1.00 = average).</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th class="l">Team</th><th>FAAB</th><th>Bids</th><th>Won</th><th>Aggression</th><th>Runs with a bid</th></tr></thead>
      <tbody>${rows.map((t) => {
        const p = market.profile[t.rid] || {};
        return `<tr><td class="l ${isMe(t) ? 'me' : ''}">${esc(t.name)}</td><td>${money(t.budgetLeft)}</td><td>${p.nBids ?? 0}</td><td>${p.wins ?? 0}</td><td>${p.aggression != null ? `×${p.aggression.toFixed(2)}` : '—'}</td><td>${p.participation != null ? pct(p.participation) : '—'}</td></tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function renderMoney(me) {
  const m = S.money;
  const players = S.season.players;
  $('#money-card').innerHTML = `<h3>Value of future money (λ)</h3>
    <p class="sub">Money not spent now buys players from rosters eliminated later. λ converts dollars into ${isWin() ? 'win probability' : 'expected weeks survived'}.</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th class="l">Most likely next eliminations</th><th class="l">Best player for you</th><th>Discounted value</th></tr></thead>
      <tbody>${(m.details || []).map((d) => `<tr><td class="l">${esc(d.team)}</td><td class="l">${esc(players[d.best]?.name || '—')}</td><td>${d.value != null ? fmtU(d.value) : '—'}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="fine">Value of holding $B: V(B) = future value (${m.future != null ? fmtU(m.future) : '—'}) × the share of it you’d win, B ÷ (B + median rival FAAB ${money(m.median ?? 0)}). Winning a bid of $b costs V(B) − V(B − b)${S.prefs.thrift ? `, × ${(2 ** S.prefs.thrift).toFixed(2)} from settings` : ''}: ${[50, 150, 300].filter((b) => b <= me.budgetLeft).map((b) => `$${b} → ${fmtU(m.cost(b))}`).join(', ')}. This is the least certain input, which is why bids show a range.</p>`;
}

function renderMethod() {
  const p = S.prefs;
  const h = S.season.horizon;
  const k = S.season.replK || {};
  const kTxt = Object.entries(k).map(([pos, n]) => `${pos} ${n}`).join(', ');
  $('#method').innerHTML = `
    <li><b>Data.</b> Sleeper public API: rosters, lineups as set, live scores, and ${S.market?.nBids ?? 0} past blind bids in this league (winning and losing). Weekly projections (Rotowire via Sleeper) for Weeks ${h[0]}–${h[h.length - 1]}, scored with your league settings.</li>
    <li><b>Lineups.</b> Every remaining team’s optimal lineup is re-picked for each week from that week’s projections, so byes and expected injury returns are reflected week by week. Starters miss games at the rate lineup-relevant players did in 2025 (94% play next week, about 80% from six weeks out); a missed start is covered by the best bench player or a streamer. Any slot a roster can’t fill above free-agent level is filled by a streamer at that week’s replacement level: the k-th best unrostered player at the position${kTxt ? ` (k: ${kTxt}, from how many players this league adds per week)` : ''}. A pickup is credited only with points above that free agent.</li>
    <li><b>Simulation.</b> ${p.sims.toLocaleString()} seasons. Each week every remaining team’s score is drawn around its lineup projection (player-level spread scaled to match 3,466 real team-weeks, slightly right-skewed); the lowest score is eliminated. Every team keeps improving through pickups at the rate 2025 survivors did (about 2.7 points per week, more for weaker teams). If several teams outlast the last elimination week, that week’s top score wins. Outputs: P(eliminated) each week, expected weeks survived, P(win league).</li>
    <li><b>Player value.</b> The same simulated seasons are rerun with the player added (common random numbers); the change in ${isWin() ? 'win probability' : 'expected weeks survived'} is his value.</li>
    <li><b>Competing bids.</b> Whether each rival bids is a logistic model of his lineup gain over his own streamer, whether the player was just released by an elimination, the player’s projection, and the rival’s bidding activity, fit on 10 completed 2025 chopped leagues and checked on 18 others. Bid size follows this league’s price curve, priced on points above the free-agent level at the position (so plentiful QBs are cheap), adjusted for each manager’s aggression, budget, and elimination risk. Rivals’ interest in the same player is correlated (bidding wars), ties split 50/50.</li>
    <li><b>Value of money.</b> Holding $B is worth V(B) = (value of the best players on the rosters most likely to be eliminated next) × (share you’d expect to win at budget B). A winning bid of $b costs V(B) − V(B − b), so each dollar costs a bit more than the last. This input is the least certain, so each bid also shows its range if money were worth half or twice as much.</li>
    <li><b>Bid.</b> The bid maximizes P(win) × (value − cost of the money); bids with under 5% win probability are reported as Pass. The plan is scored exactly over every win/lose combination of its claims (values of player sets from the simulation), adding claims greedily and then re-pricing each one given the rest, within your budget.</li>
    <li><b>Undecided elimination.</b> When this week’s elimination is still open (two teams each 15%+), both outcomes are priced separately; Sleeper processes the elimination before waivers run, so place bids once it’s known.</li>
    <li><b>Validation</b> (backtest of 28 public chopped leagues, 2025 season plus 2026 to date; held-out leagues only):
      <div class="table-wrap" style="margin:10px 0 4px"><table class="data">
        <thead><tr><th class="l">Check</th><th>Original model</th><th>Current model</th><th class="l">Reference</th></tr></thead>
        <tbody>
          <tr><td class="l">Eliminated team was the model’s #1 pick (135 league-weeks)</td><td>25%</td><td>31%</td><td class="l muted">random pick ≈ 12% (about 8–9 teams left on average)</td></tr>
          <tr><td class="l">Eliminated team in the model’s top 3</td><td>62%</td><td>65%</td><td class="l muted">random ≈ 35%</td></tr>
          <tr><td class="l">Elimination log loss (lower is better)</td><td>2.106</td><td>1.995</td><td class="l muted">uniform guess 2.139</td></tr>
          <tr><td class="l">Predicted bids vs. bids actually placed</td><td>23,215 vs 6,018</td><td>4,641 vs 6,018</td><td class="l muted">3.9× too many → 0.8×</td></tr>
          <tr><td class="l">Bidders per player, average error</td><td>+2.25</td><td>−0.18</td><td class="l muted">mean abs. error 0.46</td></tr>
          <tr><td class="l">P(win) on actual bids: mean predicted vs. actual win rate</td><td>18% vs 36%</td><td>34% vs 36%</td><td class="l muted">log loss 1.53 → 0.52 (constant 0.65)</td></tr>
          <tr><td class="l">Second review: elimination log loss, all 274 league-weeks</td><td>1.951</td><td>1.944</td><td class="l muted">injuries, score spread/skew, team improvement</td></tr>
          <tr><td class="l">Second review: P(win) accuracy (Brier) on the top 2 players off each eliminated roster</td><td>0.124</td><td>0.118</td><td class="l muted">price curve on points above free-agent level</td></tr>
        </tbody>
      </table></div>
      The value of future money is not directly validated (it would require simulating future waiver runs), so treat bid ranges as real uncertainty; a ±5% change in projections also moves top bids by up to about $40.</li>`;
}

// ---------- settings ----------
function openSettings(firstRun = false) {
  const raw = S.raw;
  const users = Object.fromEntries(raw.users.map((u) => [u.user_id, u]));
  const teamOpts = raw.rosters
    .filter((r) => (r.players || []).length)
    .map((r) => ({ rid: r.roster_id, name: users[r.owner_id]?.metadata?.team_name || users[r.owner_id]?.display_name || `Team ${r.roster_id}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  $('#set-team').innerHTML = `${firstRun ? '<option value="">Choose your team…</option>' : ''}${teamOpts.map((t) => `<option value="${t.rid}" ${String(t.rid) === String(S.myRid) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;
  $('#set-objective').value = S.prefs.objective;
  $('#set-thrift').value = S.prefs.thrift;
  $('#set-lastweek').value = S.prefs.lastWeek;
  $('#set-sims').value = String(S.prefs.sims);
  $('#set-assume').innerHTML = `<option value="auto">Most likely to finish last (auto)</option><option value="none">None / already processed</option>${teamOpts.map((t) => `<option value="${t.rid}">${esc(t.name)}</option>`).join('')}`;
  $('#set-assume').value = S.prefs.assumeChopped;
  updateThriftLabel();
  $('#settings').showModal();
}
function updateThriftLabel() {
  const v = Number($('#set-thrift').value);
  $('#thrift-label').textContent = `(λ × ${(2 ** v).toFixed(2)})`;
}
$('#set-thrift').addEventListener('input', updateThriftLabel);
$('#btn-settings').addEventListener('click', () => openSettings(false));
$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'ok') {
    if (S.myRid == null) openSettings(true);
    return;
  }
  const team = $('#set-team').value;
  if (!team) { openSettings(true); return; }
  S.myRid = Number(team);
  store.set(`team.${store.get('leagueId')}`, S.myRid);
  S.prefs = {
    objective: $('#set-objective').value,
    thrift: Number($('#set-thrift').value),
    lastWeek: Math.max(2, Math.min(18, Number($('#set-lastweek').value) || 17)),
    sims: Number($('#set-sims').value),
    assumeChopped: $('#set-assume').value,
  };
  store.set('prefs', S.prefs);
  await compute();
});

// ---------- boot ----------
const params = new URLSearchParams(location.search);
const startId = params.get('league') || store.get('leagueId', null);
if (startId) openLeague(startId);
