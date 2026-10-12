// League state, projections, lineups, and the survival simulator.
//
// The simulator answers one question: given every surviving team's projected
// lineup, how long do I last? Each simulated week every alive team draws a score
// from Normal(lineup mean, lineup sd); the lowest is chopped. A player's value to
// me is how much adding him improves that outcome.
import { getProjections, getSchedule } from './sleeper.js';

export const SLOT_ELIGIBLE = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};

// ---------- league state ----------

export function buildLeagueState(raw, opts) {
  const { league, rosters, users, transactions, matchups, curWeek } = raw;
  const s = league.settings || {};
  const budget = s.waiver_budget ?? 100;
  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));

  const choppedRids = new Set();
  const choppedLegs = new Set();
  for (const [leg, list] of Object.entries(transactions)) {
    for (const t of list) {
      if (t.type === 'chopped' && t.status === 'complete') {
        (t.roster_ids || []).forEach((r) => choppedRids.add(r));
        choppedLegs.add(Number(leg));
      }
    }
  }

  const teams = rosters.map((r) => {
    const u = userById[r.owner_id] || {};
    return {
      rid: r.roster_id,
      ownerId: r.owner_id,
      name: (u.metadata?.team_name || u.display_name || `Team ${r.roster_id}`).trim(),
      manager: u.display_name || '',
      players: (r.players || []).filter(Boolean),
      budgetLeft: Math.max(0, budget - (r.settings?.waiver_budget_used || 0)),
    };
  });

  const livePts = Object.fromEntries(matchups.map((m) => [m.roster_id, m.points || 0]));
  const matchupByRid = Object.fromEntries(matchups.map((m) => [m.roster_id, m]));
  const isAlive = (t) => t.players.length > 0 && !choppedRids.has(t.rid);
  const aliveNow = teams.filter(isAlive);
  const liveStarted = aliveNow.some((t) => (livePts[t.rid] || 0) > 0);
  const chopDoneThisWeek = choppedLegs.has(curWeek);

  // A pickup from the next waiver run first plays in bidWeek.
  const bidWeek = opts.bidWeek || (liveStarted || chopDoneThisWeek ? curWeek + 1 : curWeek);

  // If this week's games have scores but Sleeper hasn't chopped yet, someone is
  // about to be cut and their roster will hit waivers. Default: lowest live score.
  let pendingVictim = null;
  if (liveStarted && !chopDoneThisWeek && bidWeek > curWeek) {
    if (opts.assumeChopped === 'none') pendingVictim = null;
    else if (opts.assumeChopped && opts.assumeChopped !== 'auto') {
      pendingVictim = aliveNow.find((t) => String(t.rid) === String(opts.assumeChopped)) || null;
    } else {
      // Most likely to finish last on expected final score; live score if we have no outlook.
      const odds = opts.chopOdds;
      pendingVictim = aliveNow.slice().sort((a, b) => (odds
        ? (odds[b.rid] || 0) - (odds[a.rid] || 0)
        : (livePts[a.rid] || 0) - (livePts[b.rid] || 0)))[0] || null;
    }
  }
  const alive = aliveNow.filter((t) => t !== pendingVictim);

  return {
    league, budget, teams, alive, aliveNow, livePts, matchupByRid, liveStarted, chopDoneThisWeek,
    pendingVictim, curWeek, bidWeek, minBid: s.waiver_bid_min ?? 0,
    scoring: league.scoring_settings || {},
    slots: (league.roster_positions || []).filter((p) => SLOT_ELIGIBLE[p]),
    unsupportedSlots: (league.roster_positions || []).filter((p) => !SLOT_ELIGIBLE[p] && !['BN', 'IR', 'TAXI'].includes(p)),
    transactions,
  };
}

// ---------- projections ----------

export function pointsFor(stats, scoring, pos) {
  let pts = 0;
  for (const k in stats) {
    const m = scoring[k];
    if (m !== undefined && typeof stats[k] === 'number') pts += stats[k] * m;
  }
  if (pts === 0 && (pos === 'K' || pos === 'DEF')) pts = stats.pts_ppr || 0;
  return pts;
}

export async function loadProjections(ls, lastWeek) {
  const positions = [...new Set(ls.slots.flatMap((s) => SLOT_ELIGIBLE[s]))];
  const weeks = [];
  // Every remaining week: projections encode byes and expected injury returns week by week.
  for (let w = ls.bidWeek; w <= lastWeek; w++) weeks.push(w);
  const lists = await Promise.all(weeks.map((w) => getProjections(ls.league.season, w, positions).catch(() => [])));
  return projectionsFromLists(ls, weeks, lists);
}

// Pure core of loadProjections (no network): `lists[i]` is Sleeper's projection
// list for `weeks[i]`.
export function projectionsFromLists(ls, weeks, lists) {
  const positions = [...new Set(ls.slots.flatMap((s) => SLOT_ELIGIBLE[s]))];
  const players = {};
  lists.forEach((list, i) => {
    const w = weeks[i];
    for (const row of list) {
      const p = row.player || {};
      const pos = p.position;
      if (!positions.includes(pos)) continue;
      const pl = players[row.player_id] || (players[row.player_id] = {
        id: row.player_id,
        name: pos === 'DEF' ? `${p.first_name || ''} ${p.last_name || ''}`.trim() || row.player_id : `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        pos, team: row.team || p.team || 'FA',
        injury: p.injury_status || null,
        weeks: {},
      });
      pl.weeks[w] = pointsFor(row.stats || {}, ls.scoring, pos);
      if (i === 0) pl.opp = row.opponent || null;
    }
  });
  for (const pl of Object.values(players)) {
    const vals = weeks.map((w) => pl.weeks[w] || 0).filter((v) => v > 0);
    pl.avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    pl.next = pl.weeks[ls.bidWeek] || 0;
  }
  return { players, fetchedWeeks: weeks };
}

// Projected points for a player in a horizon week. Every week through the last chop
// is fetched; the average is only a fallback for weeks beyond that.
export function projFor(pl, w, lastFetched) {
  if (!pl) return 0;
  if (w <= lastFetched) return pl.weeks[w] || 0;
  return pl.avg * 0.94;
}

// Player score spread: ~45% of the mean plus a floor, scaled by 0.9 because actual team
// scores were 0.92x as spread out as the unscaled rule (3,466 team-weeks, tools/critique).
const SD_SCALE = 0.9;
export const playerVar = (mu) => (mu <= 0 ? 0 : (SD_SCALE * (0.45 * mu + 1.5)) ** 2);
// Team scores are right-skewed (skewness about +0.25): fewer disasters than a normal.
const SKEW = 0.25;

// P(a lineup-relevant player plays k weeks from now | he is playing now), 2025 Sleeper
// data with byes excluded: 0.94 next week, 0.88 at +2, ~0.80 from +6 on. Rotowire's
// future projections assume health, so starters miss time at this rate in expectation.
export const availability = (k) => 0.8 + 0.14 * Math.exp(-(Math.max(1, k) - 1) / 1.5);

// Rosters don't stay frozen: in 2025 chopped leagues surviving lineups gained ~2.7
// projected points per week from pickups, more for weaker teams (tools/critique). The
// weak-team premium is kept modest (±25%): part of it is survivorship (weak teams that
// lasted are the ones that improved), and a large one would let the worst rosters
// overtake the best within a few weeks.
const DRIFT_PER_WEEK = 2.7;
const DRIFT_RANK_SLOPE = 0.25;
const DRIFT_MULT_RANGE = [0.75, 1.25];

// Greedy optimal lineup: fill the most restrictive slots first.
// Optional `repl` ({pos: pts} for week w): free-agent replacement level. A slot whose
// best rostered eligible player projects below it (or that would sit empty because of
// a bye or injury) is streamed at replacement level instead. Streamed slots are listed
// in `streams` and never appear in `starters`/`slotted`, which hold real player ids.
// Optional `avail` (0-1): chance each starter actually plays. A missed start is filled by
// the best unused bench player who could play the slot, or a streamer, whichever is better.
export function lineup(playerIds, players, slots, w, lastFetched, repl, avail) {
  const pool = playerIds
    .map((id) => ({ id, pos: players[id]?.pos, mu: projFor(players[id], w, lastFetched) }))
    .filter((p) => p.pos && p.mu > 0)
    .sort((a, b) => b.mu - a.mu);
  const order = slots.slice().sort((a, b) => SLOT_ELIGIBLE[a].length - SLOT_ELIGIBLE[b].length);
  const used = new Set();
  let mu = 0, v = 0;
  const starters = [], slotted = [], streams = [];
  for (const slot of order) {
    const pick = pool.find((p) => !used.has(p.id) && SLOT_ELIGIBLE[slot].includes(p.pos));
    let rv = 0, rpos = null;
    if (repl) for (const pos of SLOT_ELIGIBLE[slot]) if ((repl[pos] || 0) > rv) { rv = repl[pos]; rpos = pos; }
    if (rv > 0 && (!pick || pick.mu < rv)) {
      mu += rv; v += playerVar(rv);
      streams.push({ slot, pos: rpos, mu: rv });
      continue;
    }
    if (!pick) continue;
    used.add(pick.id);
    starters.push(pick.id);
    slotted.push({ slot, id: pick.id, mu: pick.mu, rv });
  }
  for (const s of slotted) {
    const m = s.mu;
    if (!(avail > 0 && avail < 1)) { mu += m; v += playerVar(m); continue; }
    const bench = pool.find((p) => !used.has(p.id) && SLOT_ELIGIBLE[s.slot].includes(p.pos));
    const fill = Math.max(s.rv || 0, bench ? bench.mu : 0);
    mu += avail * m + (1 - avail) * fill;
    v += avail * playerVar(m) + (1 - avail) * playerVar(fill) + avail * (1 - avail) * (m - fill) ** 2;
  }
  for (const s of slotted) { delete s.mu; delete s.rv; }
  return { mu, sd: Math.sqrt(v), starters, slotted, streams };
}

// ---------- replacement level (free-agent streaming) ----------

// Completed adds per finished week at each position, across 28 Sleeper chopped leagues
// (2025-26, weeks 2+). Used as a prior for how deep the free-agent pool gets picked over.
const ADDS_PER_WEEK_PRIOR = { QB: 2.4, RB: 5.1, WR: 5.9, TE: 2.7, K: 1.5, DEF: 1.5 };
const ADDS_PRIOR_WEEKS = 3;

// How many players at each position a team must expect to lose to rivals before it
// gets its streamer: typical adds per week (this league's completed waiver and
// free-agent adds in finished weeks after Week 1, shrunk toward the prior) + 1.
export function streamDepth(ls, players) {
  const finished = (l) => l >= 2 && (l < ls.curWeek || (l === ls.curWeek && ls.chopDoneThisWeek));
  const legs = Object.keys(ls.transactions || {}).map(Number).filter(finished);
  const counts = {};
  for (const l of legs) {
    for (const t of ls.transactions[l] || []) {
      if ((t.type !== 'waiver' && t.type !== 'free_agent') || t.status !== 'complete') continue;
      for (const pid of Object.keys(t.adds || {})) {
        const pos = players[pid]?.pos;
        if (pos) counts[pos] = (counts[pos] || 0) + 1;
      }
    }
  }
  const k = {};
  for (const [pos, prior] of Object.entries(ADDS_PER_WEEK_PRIOR)) {
    k[pos] = 1 + Math.round(((counts[pos] || 0) + ADDS_PRIOR_WEEKS * prior) / (legs.length + ADDS_PRIOR_WEEKS));
  }
  return k;
}

// Replacement level per horizon week: the k-th best projection among players no alive
// team rosters (free agents, waivers, and the incoming chopped roster). If fewer than
// k are projected that week (byes), the worst projected one: the pool only deepens
// as more rosters are chopped.
export function replacementLevels(players, rostered, horizon, lastFetched, k, positions) {
  const byPos = {};
  for (const pl of Object.values(players)) {
    if (rostered.has(pl.id) || !positions.includes(pl.pos)) continue;
    (byPos[pl.pos] = byPos[pl.pos] || []).push(pl);
  }
  const repl = {};
  for (const w of horizon) {
    repl[w] = {};
    for (const pos of positions) {
      const vals = (byPos[pos] || []).map((pl) => projFor(pl, w, lastFetched)).filter((v) => v > 0).sort((a, b) => b - a);
      repl[w][pos] = vals.length ? vals[Math.min(Math.max(1, k[pos] || 3), vals.length) - 1] : 0;
    }
  }
  return repl;
}

// ---------- simulator ----------

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shared random draws (common random numbers): every candidate is evaluated against
// the same simulated seasons, so differences between candidates are signal, not noise.
export function makeDraws(sims, weeks, teams, seed = 7) {
  const rnd = mulberry32(seed);
  const z = new Float32Array(sims * weeks * teams);
  for (let i = 0; i < z.length; i += 2) {
    const u = Math.max(rnd(), 1e-12), v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    z[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < z.length) z[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  // Cornish-Fisher: right skew without changing mean or (materially) variance.
  for (let i = 0; i < z.length; i++) z[i] += (SKEW / 6) * (z[i] * z[i] - 1);
  return { z, sims, weeks, teams };
}

// mu/sd are [team][week]. Returns outcomes for team index `me` plus per-team
// next-week chop odds.
export function simulate(mu, sd, me, draws) {
  const { z, sims, weeks, teams } = draws;
  const alive = new Uint8Array(teams);
  const chopNext = new Float64Array(teams);
  let weeksSum = 0, winSum = 0, chopMeNext = 0;
  for (let s = 0; s < sims; s++) {
    alive.fill(1);
    let left = teams, survived = weeks, out = false, topI = -1;
    for (let w = 0; w < weeks && left > 1; w++) {
      let minI = -1, minV = Infinity, maxV = -Infinity;
      const base = (s * weeks + w) * teams;
      for (let t = 0; t < teams; t++) {
        if (!alive[t]) continue;
        const v = mu[t][w] + sd[t][w] * z[base + t];
        if (v < minV) { minV = v; minI = t; }
        if (v > maxV) { maxV = v; topI = t; }
      }
      alive[minI] = 0; left--;
      if (w === 0) chopNext[minI]++;
      if (minI === me) { survived = w; out = true; if (w === 0) chopMeNext++; break; }
    }
    weeksSum += survived;
    // If several teams survive the last elimination week, the top score that week wins.
    if (!out) winSum += left === 1 || topI === me ? 1 : 0;
  }
  return {
    expWeeks: weeksSum / sims,
    pWin: winSum / sims,
    pChopNext: chopMeNext / sims,
    chopNext: Array.from(chopNext, (c) => c / sims),
  };
}

// The same simulated seasons as `simulate`, traced week by week for display:
// P(still alive after each week), P(eliminated in a week | alive at its start), and
// the first week's draws of my score against the cut line (lowest other score).
export function simulateTrace(mu, sd, me, draws) {
  const { z, sims, weeks, teams } = draws;
  const alive = new Uint8Array(teams);
  const elimAt = new Float64Array(weeks);
  const myScore = new Float32Array(sims), cutLine = new Float32Array(sims);
  for (let s = 0; s < sims; s++) {
    alive.fill(1);
    let left = teams;
    for (let w = 0; w < weeks && left > 1; w++) {
      let minI = -1, minV = Infinity, minOther = Infinity;
      const base = (s * weeks + w) * teams;
      for (let t = 0; t < teams; t++) {
        if (!alive[t]) continue;
        const v = mu[t][w] + sd[t][w] * z[base + t];
        if (v < minV) { minV = v; minI = t; }
        if (t !== me && v < minOther) minOther = v;
        if (w === 0 && t === me) myScore[s] = v;
      }
      if (w === 0) cutLine[s] = minOther;
      alive[minI] = 0; left--;
      if (minI === me) { elimAt[w]++; break; }
    }
  }
  const survival = [], hazard = [];
  let aliveP = 1;
  for (let w = 0; w < weeks; w++) {
    const e = elimAt[w] / sims;
    hazard.push(aliveP > 0 ? e / aliveP : 0);
    aliveP -= e;
    survival.push(aliveP);
  }
  return { survival, hazard, myScore, cutLine };
}

// ---------- the season model ----------

export function buildSeason(ls, proj, opts) {
  const { players, fetchedWeeks } = proj;
  const lastFetched = fetchedWeeks[fetchedWeeks.length - 1] || ls.bidWeek;
  const chopsLeft = Math.max(1, ls.alive.length - 1);
  const horizon = [];
  for (let w = ls.bidWeek; w <= opts.lastWeek && horizon.length < chopsLeft; w++) horizon.push(w);
  if (!horizon.length) horizon.push(ls.bidWeek);

  const teams = ls.alive;
  const meIdx = teams.findIndex((t) => String(t.rid) === String(opts.myRid));
  const rostered = new Set(teams.flatMap((t) => t.players));

  // Every team can stream a free agent into a bye/injury hole or below-replacement
  // slot, so lineups are scored with that week's replacement level. (opts.stream=false
  // turns it off; opts.replK overrides the stream depth per position.)
  const positions = [...new Set(ls.slots.flatMap((s) => SLOT_ELIGIBLE[s]))];
  const replK = opts.replK || streamDepth(ls, players);
  const repl = opts.stream === false ? null : replacementLevels(players, rostered, horizon, lastFetched, replK, positions);

  // Week i of the horizon is i+1 weeks from now.
  const avail = opts.injuries === false ? null : Object.fromEntries(horizon.map((w, i) => [w, availability(i + 1)]));
  const strength = (ids) => {
    const m = [], d = [];
    for (const w of horizon) { const l = lineup(ids, players, ls.slots, w, lastFetched, repl && repl[w], avail && avail[w]); m.push(l.mu); d.push(l.sd); }
    return { mu: m, sd: d };
  };
  const base = teams.map((t) => strength(t.players));
  // Every team keeps improving through pickups; weaker teams faster (rank-dependent drift).
  const mu0 = base.map((b) => b.mu[0]);
  const sorted0 = mu0.slice().sort((a, b) => a - b);
  const median0 = sorted0[Math.floor(sorted0.length / 2)];
  const spread0 = Math.sqrt(mu0.reduce((a, x) => a + (x - median0) ** 2, 0) / Math.max(1, mu0.length - 1)) || 1;
  const drift = teams.map((_, t) => {
    const mult = Math.min(DRIFT_MULT_RANGE[1], Math.max(DRIFT_MULT_RANGE[0], 1 + (DRIFT_RANK_SLOPE * (median0 - mu0[t])) / spread0));
    return horizon.map((_, i) => (opts.drift === false ? 0 : DRIFT_PER_WEEK * i * mult));
  });
  const teamStrength = (t, ids) => { const st = strength(ids); return { mu: st.mu.map((m, i) => m + drift[t][i]), sd: st.sd }; };
  const draws = makeDraws(opts.sims, horizon.length, teams.length, opts.seed ?? 7);
  const mu = base.map((b, t) => b.mu.map((m, i) => m + drift[t][i])), sd = base.map((b) => b.sd);
  const baseline = meIdx >= 0 ? simulate(mu, sd, meIdx, draws) : simulate(mu, sd, 0, draws);

  const incoming = new Set(ls.pendingVictim ? ls.pendingVictim.players : []);
  const pool = Object.values(players).filter((p) => !rostered.has(p.id) && p.avg > 0);

  return { horizon, lastFetched, teams, meIdx, base, mu, sd, draws, baseline, pool, incoming, players, strength, teamStrength, drift, slots: ls.slots, repl, replK, avail };
}

export const utilityOf = (res, objective) => (objective === 'win' ? res.pWin * 100 : res.expWeeks);

// Value of adding a set of players to my roster, in the chosen objective's units.
export function valueOfAdding(season, ls, ids, objective) {
  const { meIdx, mu, sd, draws, teams, baseline } = season;
  if (meIdx < 0) return { dU: 0, res: baseline, gain: 0 };
  const mine = season.teamStrength ? season.teamStrength(meIdx, [...teams[meIdx].players, ...ids]) : season.strength([...teams[meIdx].players, ...ids]);
  const gain = mine.mu.reduce((a, v, i) => a + v - mu[meIdx][i], 0);
  if (gain <= 1e-6) return { dU: 0, res: baseline, gain: 0 };
  const mu2 = mu.slice(); mu2[meIdx] = mine.mu;
  const sd2 = sd.slice(); sd2[meIdx] = mine.sd;
  const res = simulate(mu2, sd2, meIdx, draws);
  return { dU: utilityOf(res, objective) - utilityOf(baseline, objective), res, gain };
}

// Lineup gain for any team (used by the opponent model to judge need), over the
// free-agent streamer the team would otherwise use.
export function lineupGain(season, teamIdx, pid, weeks = 3) {
  const { teams, players, horizon, lastFetched } = season;
  const baseMu = (season.base || [])[teamIdx]?.mu || season.mu[teamIdx];
  let g = 0;
  const ids = [...teams[teamIdx].players, pid];
  for (let i = 0; i < Math.min(weeks, horizon.length); i++) {
    const w = horizon[i];
    g += lineup(ids, players, season.slots, w, lastFetched, season.repl?.[w], season.avail?.[w]).mu - baseMu[i];
  }
  return g / Math.min(weeks, horizon.length);
}

// Shadow price of a FAAB dollar, in utility units. Money unspent today buys
// players off future chopped rosters; we estimate that future value from the
// rosters of the teams most likely to be chopped next.
export function moneyValue(season, ls, objective, myBudget) {
  const { teams, meIdx, base, baseline, horizon } = season;
  if (meIdx < 0 || myBudget <= 0) return { lambda: Infinity, future: 0, capture: 0, details: [] };
  const n = horizon.length;
  const order = teams
    .map((t, i) => ({ t, i, s: base[i].mu.slice(0, 3).reduce((a, b) => a + b, 0) }))
    .filter((x) => x.i !== meIdx)
    .sort((a, b) => a.s - b.s);
  const K = Math.min(3, Math.max(0, n - 1));
  let future = 0;
  const details = [];
  for (let k = 0; k < K && k < order.length; k++) {
    const roster = order[k].t.players;
    const scored = roster
      .map((pid) => ({ pid, ...valueOfAdding(season, ls, [pid], objective) }))
      .sort((a, b) => b.dU - a.dU);
    const discount = Math.max(0, (n - (k + 1)) / n);
    const v = discount * ((scored[0]?.dU || 0) + 0.5 * (scored[1]?.dU || 0));
    future += Math.max(0, v);
    details.push({ team: order[k].t.name, best: scored[0]?.pid, value: v });
  }
  const others = teams.filter((_, i) => i !== meIdx).map((t) => t.budgetLeft).sort((a, b) => a - b);
  const median = others.length ? others[Math.floor(others.length / 2)] : myBudget;
  const captureAt = (b) => Math.min(0.9, Math.max(0.1, b / (b + median || 1)));
  const capture = captureAt(myBudget);
  const floor = (0.05 * utilityOf(baseline, objective)) / myBudget;
  // Value of holding B dollars: V(B) = future × capture share(B). A winning bid of b costs
  // what it removes, V(B) − V(B − b): cheap at first, steeper as the budget runs down.
  // (Charging the average V(B)/B per dollar overstated the cost of big bids by ~1.6-1.9x.)
  const V = (b) => future * captureAt(Math.max(0, b));
  const costOf = (b) => Math.max(floor * b, V(myBudget) - V(myBudget - b));
  const lambdaAvg = Math.max(floor, (future * capture) / myBudget);
  const lambda = Math.max(floor, costOf(1));
  return { lambda, lambdaAvg, costOf, future, capture, details, floor, median };
}

// What a pickup would do for me: the first week he'd start, which slot, and who
// he'd push to the bench (null with `streamer: true` when he takes the spot of a
// free-agent streamer); plus how many of the projected weeks he'd start.
export function roleOf(season, pid) {
  const { meIdx, teams, players, horizon, lastFetched, slots } = season;
  const mine = teams[meIdx].players;
  const weeks = horizon.filter((w) => w <= lastFetched);
  let first = null, starts = 0;
  for (const w of weeks) {
    const r = season.repl?.[w];
    const withP = lineup([...mine, pid], players, slots, w, lastFetched, r, season.avail?.[w]);
    const s = withP.slotted.find((x) => x.id === pid);
    if (!s) continue;
    starts++;
    if (!first) {
      const base = lineup(mine, players, slots, w, lastFetched, r, season.avail?.[w]);
      const replaced = base.starters.find((id) => !withP.starters.includes(id)) || null;
      first = { week: w, slot: s.slot, replaced, streamer: !replaced && (base.streams || []).length > (withP.streams || []).length };
    }
  }
  return { first, starts, of: weeks.length };
}

// This week's chop, before Sleeper processes it: live points plus projections for
// starters whose games haven't finished, then simulate who ends up lowest.
export async function liveOutlook(ls, sims = 5000) {
  if (!ls.liveStarted || ls.chopDoneThisWeek) return null;
  const season = ls.league.season, week = ls.curWeek;
  const positions = [...new Set(ls.slots.flatMap((s) => SLOT_ELIGIBLE[s]))];
  const [sched, proj] = await Promise.all([
    getSchedule(season).catch(() => []),
    getProjections(season, week, positions).catch(() => []),
  ]);
  return liveOutlookFrom(ls, sched, proj, sims);
}

// Pure core of liveOutlook (no network): `sched` is Sleeper's season schedule and
// `proj` this week's projection list.
export function liveOutlookFrom(ls, sched, proj, sims = 5000) {
  if (!ls.liveStarted || ls.chopDoneThisWeek) return null;
  const week = ls.curWeek;
  const status = {};
  for (const g of sched || []) if (g.week === week) { status[g.home] = g.status; status[g.away] = g.status; }
  const projBy = {};
  for (const row of proj) projBy[row.player_id] = { pts: pointsFor(row.stats || {}, ls.scoring, row.player?.position), team: row.team || row.player?.team };

  const rows = ls.aliveNow.map((t) => {
    const starters = (ls.matchupByRid[t.rid]?.starters || []).filter((id) => id && id !== '0');
    let remaining = 0, v = 0, toPlay = 0;
    for (const id of starters) {
      const pr = projBy[id];
      if (!pr) continue;
      // Unknown elapsed time for games in progress: assume half remains.
      const frac = status[pr.team] === 'pre_game' ? 1 : status[pr.team] === 'in_game' ? 0.5 : 0;
      if (frac > 0) { const mu = pr.pts * frac; remaining += mu; v += playerVar(mu); toPlay++; }
    }
    const live = ls.livePts[t.rid] || 0;
    return { t, live, remaining, expected: live + remaining, sd: Math.sqrt(v), toPlay, pChop: 0 };
  });

  const rnd = mulberry32(11);
  const counts = new Float64Array(rows.length);
  for (let s = 0; s < sims; s++) {
    let minI = 0, minV = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const u = Math.max(rnd(), 1e-12), z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
      const val = rows[i].expected + rows[i].sd * z;
      if (val < minV) { minV = val; minI = i; }
    }
    counts[minI]++;
  }
  rows.forEach((r, i) => { r.pChop = counts[i] / sims; });
  const gamesLeft = Object.values(status).filter((x) => x !== 'complete').length / 2;
  return { rows, gamesLeft, chopOdds: Object.fromEntries(rows.map((r) => [r.t.rid, r.pChop])) };
}
