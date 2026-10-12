// Opponent bid model + bid optimizer.
//
// Sleeper keeps every blind bid, winners and losers, so we can learn how this
// league spends: a price curve (bid as a share of the average remaining budget,
// by player quality and weeks left), a per-manager aggression factor and how
// actively each manager bids. Whether a rival bids at all (bidPropensity) and how
// much (SIZE_COEF) use relationships fit across 28 public Sleeper chopped leagues
// (see tools/); rivals' bids on one player share a common "heat" (pWinAt).
import { lineupGain, streamDepth } from './model.js';

// Bids barely shrink as the season runs out once budgets are measured against the
// league's average remaining budget: across 28 leagues the weeks-left elasticity of
// bid size is ~0.1 (the old fixed 0.6 overpriced early weeks and underpriced late ones).
const WL_EXP = 0.1;
const DEFAULT_A = Math.log(0.1) - 2 * Math.log(15) - 0.6 * Math.log(14);
const DEFAULT_B = 2;
const MIN_WIN_P = 0.05; // don't recommend lottery tickets

// Bid propensity q = P(a team bids on a player at all) is logistic in: the player's
// lineup gain for that team (over the free agent it would stream; log1p, plus a flag
// for any real gain), whether he was just released by a chop ("fresh": long-time free
// agents were already passed over), his projection, and the team's bidding activity
// (distinct players bid per week alive, shrunk to the league's rate, relative to the
// cross-league norm). Fit on 10 completed 2025 Sleeper chopped leagues and validated
// on 18 others (tools/fit_bidprop.py): held-out log loss 0.155 vs 0.276 for a constant
// rate and 0.93 for the old participation-based q, which predicted ~4x too many bidders.
const Q_COEF = { b0: -8.0585, gain: 1.2051, wants: 0.8353, activity: 0.9587, proj: 0.6293, fresh: 3.1442 };
const BIDS_PER_TEAM_WEEK = 3.1635;
const ACT_PRIOR_TEAM = 2; // weeks of the league rate mixed into each team's rate
const ACT_PRIOR_LEAGUE = 40; // team-weeks of the cross-league norm mixed into the league rate

export function bidPropensity(gain, activity, projAvg, fresh) {
  const z = Q_COEF.b0 + Q_COEF.gain * Math.log1p(Math.max(0, gain)) + (gain > 0.05 ? Q_COEF.wants : 0)
    + Q_COEF.activity * Math.log(Math.max(0.05, activity)) + Q_COEF.proj * Math.log(Math.max(1, projAvg || 0))
    + (fresh ? Q_COEF.fresh : 0);
  return 1 / (1 + Math.exp(-z));
}

// Bids on the same player are not independent: some players draw a crowd and a
// bidding war, others nobody (news, hype, how the managers read the projections). In
// 28 leagues ~45% of the variance of log bids around the price curve is shared by all
// bidders on a player, and bidder counts are ~2.5x more dispersed than independent
// coin flips. pWinAt therefore integrates over a player-level "heat" h ~ N(0,1) that
// shifts every rival's log bid by tau*h (tau² = heatIcc·sigma²; the rest of sigma is
// idiosyncratic) and the logit of every rival's bid propensity by heatKappa*h.
// heatIcc/heatKappa chosen on the TRAIN leagues (pWin log loss of real bids, scored
// conditional on the bidder's own bid); the harness may override TUNING for experiments.
// Re-tuned with the value-over-replacement price curve (tools/critique/tune_market.mjs,
// chosen on TRAIN leagues): heatKappa 1.5 -> 0.5. Held-out Brier on the top-2 players
// released by each chop 0.124 -> 0.118; all released players unchanged (0.071).
export const TUNING = { heatIcc: 0.2, heatKappa: 0.5, tieCredit: 0.5, p0Fresh: 0.08, p0FA: 0.29, wlExp: WL_EXP, priceOnVor: true, sigmaScale: 1 };

// Bid size given a real bid: log-median = log(league price curve) + these terms, fit on
// the TRAIN leagues' positive bids (tools/fit_bidsize.py). The old hand-set factors
// (aggression^1, budget share^0.7, need 0.5-1.6, danger^1) spread rivals' medians too
// wide and ignored that just-chopped players go for ~3.7x what equally projected
// free agents fetch. Held-out residual bias +0.28 -> +0.05.
const SIZE_COEF = { b0: -1.938, agg: 0.488, budget: 0.398, gain: 0.486, fresh: 1.301, danger: 2.7 };
// A share of "bids" are minimum-bid flyers (8% on just-chopped players, 29% on other
// free agents in TRAIN leagues): any higher bid beats them.
// 10-point Gauss–Hermite rule for E[f(h)], h ~ N(0,1)
const GH = (() => {
  const x = [0.3429013272237046, 1.0366108297895137, 1.7566836492998818, 2.5327316742327897, 3.4361591188377376];
  const w = [0.6108626337353258, 0.2401386110823147, 0.03387439445548106, 0.0013436457467812327, 7.640432855232621e-06];
  const nodes = [], weights = [];
  x.forEach((xi, i) => { for (const s of [-1, 1]) { nodes.push(s * Math.SQRT2 * xi); weights.push(w[i] / Math.sqrt(Math.PI)); } });
  return { nodes, weights };
})();

function phi(x) {
  // Abramowitz–Stegun normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export function learnMarket(ls, players, lastWeek) {
  const { transactions, budget, teams } = ls;
  const legs = Object.keys(transactions).map(Number).sort((a, b) => a - b);

  const chopLeg = {};
  for (const l of legs) for (const t of transactions[l]) {
    if (t.type === 'chopped' && t.status === 'complete') (t.roster_ids || []).forEach((r) => { chopLeg[r] = l; });
  }
  const spentBefore = {}; // rid -> dollars won before current leg
  const bids = [];
  const legsActive = {}, legsBid = {};
  const distinct = {}; // rid -> distinct players bid on, summed over legs
  let totDistinct = 0, totTeamLegs = 0;

  for (const l of legs) {
    const waivers = transactions[l].filter((t) => t.type === 'waiver' && t.settings && t.settings.waiver_bid != null);
    if (waivers.length) {
      const aliveAt = teams.filter((t) => !(chopLeg[t.rid] <= l) && (t.players.length > 0 || chopLeg[t.rid]));
      const avgB = aliveAt.reduce((a, t) => a + (budget - (spentBefore[t.rid] || 0)), 0) / Math.max(1, aliveAt.length);
      const bidders = new Set();
      const seen = new Set();
      for (const t of waivers) {
        const rid = (t.roster_ids || [])[0];
        const pid = Object.keys(t.adds || {})[0];
        if (rid == null || !pid) continue;
        bidders.add(rid);
        bids.push({ leg: l, rid, pid, bid: t.settings.waiver_bid, won: t.status === 'complete', avgB, wl: Math.max(1, lastWeek - l) });
        // a manager can file several claims on one player (different drops)
        if (!seen.has(`${rid}:${pid}`)) { seen.add(`${rid}:${pid}`); distinct[rid] = (distinct[rid] || 0) + 1; totDistinct++; }
      }
      aliveAt.forEach((t) => { legsActive[t.rid] = (legsActive[t.rid] || 0) + 1; });
      totTeamLegs += aliveAt.length;
      bidders.forEach((r) => { legsBid[r] = (legsBid[r] || 0) + 1; });
    }
    for (const t of waivers) {
      if (t.status !== 'complete') continue;
      const rid = (t.roster_ids || [])[0];
      spentBefore[rid] = (spentBefore[rid] || 0) + t.settings.waiver_bid;
    }
  }

  // Price on value over the free agent a manager could stream instead, not raw points:
  // in these leagues QBs projected 17-20 went for $1-55 because startable QBs are always
  // on waivers. Raw points forced a flat curve with huge residuals (sigma pinned at its
  // cap), which made the highest rival bid on contested stars far too dispersed.
  const replAvg = replacementAverages(ls, players);
  const quality = (pid) => (TUNING.priceOnVor ? priceX(players[pid], replAvg) : Math.log(Math.max(1, players[pid]?.avg || 0)));
  // Fit ln(bid/avgB) - wlExp*ln(wl) = a + b*x on positive bids for players we can project.
  const wlExp = TUNING.wlExp ?? WL_EXP;
  const pts = bids
    .filter((b) => b.bid > 0 && players[b.pid]?.avg > 0)
    .map((b) => ({ ...b, x: quality(b.pid), y: Math.log(b.bid / Math.max(1, b.avgB)) - wlExp * Math.log(b.wl) }));
  let a = DEFAULT_A + (0.6 - wlExp) * Math.log(14), b = DEFAULT_B, fitted = false;
  if (pts.length >= 8) {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
    const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0), sxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
    if (sxx > 1e-6) {
      b = Math.min(4, Math.max(0.5, sxy / sxx));
      a = my - b * mx;
      fitted = true;
    }
  }
  const resid = pts.map((p) => ({ rid: p.rid, r: p.y - (a + b * p.x), bid: p.bid }));
  // Spread of real bids around the curve; $1-5 flyers are a different behavior (covered
  // by the p0 flyer share) and would otherwise inflate it.
  const real = resid.filter((x) => x.bid > 5);
  const sigma = real.length > 4
    ? Math.min(1.5, Math.max(0.45, Math.sqrt(real.reduce((s, x) => s + x.r ** 2, 0) / (real.length - 1))))
    : 0.8;

  // Bidding activity: distinct players bid per week alive, shrunk to the league rate,
  // which is itself shrunk to the cross-league norm; 1 = a typical manager.
  const leagueRate = (totDistinct + ACT_PRIOR_LEAGUE * BIDS_PER_TEAM_WEEK) / (totTeamLegs + ACT_PRIOR_LEAGUE);

  const profile = {};
  for (const t of teams) {
    const mine = resid.filter((x) => x.rid === t.rid);
    const n = mine.length;
    const mean = n ? mine.reduce((s, x) => s + x.r, 0) / n : 0;
    const act = legsActive[t.rid] || 0, bidL = legsBid[t.rid] || 0;
    profile[t.rid] = {
      aggression: Math.exp(mean * (n / (n + 3))),
      participation: (bidL + 0.7 * 2) / (act + 2),
      activity: ((distinct[t.rid] || 0) + ACT_PRIOR_TEAM * leagueRate) / (act + ACT_PRIOR_TEAM) / BIDS_PER_TEAM_WEEK,
      nBids: bids.filter((x) => x.rid === t.rid).length,
      wins: bids.filter((x) => x.rid === t.rid && x.won).length,
      spent: spentBefore[t.rid] || 0,
    };
  }

  // Players released by the chop that opens this waiver run: they draw far more bids
  // than free agents of the same quality who have already been passed over.
  const fresh = new Set();
  for (const t of transactions[ls.bidWeek - 1] || []) {
    if (t.type === 'chopped' && t.status === 'complete') Object.keys(t.drops || {}).forEach((p) => fresh.add(p));
  }
  return { a, b, sigma, fitted, nBids: bids.length, nFit: pts.length, profile, bids, leagueRate, fresh, replAvg: TUNING.priceOnVor ? replAvg : null };
}

// Free-agent level per position: the k-th best season-average projection among players
// no remaining team rosters (k = how deep this league picks the pool each week).
function replacementAverages(ls, players) {
  const rostered = new Set((ls.alive || ls.teams).flatMap((t) => t.players));
  const k = streamDepth(ls, players);
  const byPos = {};
  for (const pl of Object.values(players)) {
    if (rostered.has(pl.id) || !(pl.avg > 0)) continue;
    (byPos[pl.pos] = byPos[pl.pos] || []).push(pl.avg);
  }
  const out = {};
  for (const [pos, vals] of Object.entries(byPos)) {
    vals.sort((x, y) => y - x);
    out[pos] = vals[Math.min(Math.max(1, k[pos] || 3), vals.length) - 1] || 0;
  }
  return out;
}

// Price-curve input: log(1 + projected points per game above the free-agent level).
const priceX = (pl, replAvg) => Math.log1p(Math.max(0, (pl?.avg || 0) - (replAvg?.[pl?.pos] || 0)));

// Predicted bid distribution of each opponent for one player.
export function opponentBids(season, ls, market, pid, lastWeek) {
  const pl = season.players[pid];
  const opps = season.teams.map((t, i) => ({ t, i })).filter((x) => x.i !== season.meIdx);
  const avgB = season.teams.reduce((s, t) => s + t.budgetLeft, 0) / Math.max(1, season.teams.length);
  const wl = Math.max(1, lastWeek - ls.bidWeek + 1);
  const x = market.replAvg ? priceX(pl, market.replAvg) : Math.log(Math.max(1, pl?.avg || 0));
  const basePrice = Math.exp(market.a + market.b * x + (TUNING.wlExp ?? WL_EXP) * Math.log(wl)) * avgB;

  const gains = opps.map((o) => lineupGain(season, o.i, pid));

  const fresh = !!(market.fresh?.has(pid) || season.incoming?.has(pid));
  return opps.map((o, k) => {
    const prof = market.profile[o.t.rid] || { aggression: 1, participation: 0.7, activity: 1 };
    const gain = gains[k];
    const danger = 1 + 1.2 * (season.baseline.chopNext[o.i] || 0);
    const median = Math.min(o.t.budgetLeft, basePrice * Math.exp(SIZE_COEF.b0 + SIZE_COEF.agg * Math.log(prof.aggression)
      + SIZE_COEF.budget * Math.log(Math.max(1, o.t.budgetLeft) / Math.max(1, avgB))
      + SIZE_COEF.gain * Math.log1p(Math.max(0, gain)) + (fresh ? SIZE_COEF.fresh : 0) + SIZE_COEF.danger * Math.log(danger)));
    const q = o.t.budgetLeft < ls.minBid ? 0 : bidPropensity(gain, prof.activity ?? 1, pl?.avg, fresh);
    const p0 = fresh ? TUNING.p0Fresh : TUNING.p0FA;
    return { team: o.t, gain, q, median: Math.max(0.5, median), cap: o.t.budgetLeft, danger, aggression: prof.aggression, base: basePrice, fresh, p0, floor: ls.minBid || 0 };
  });
}

// P(my bid b wins). Bids are whole dollars; Sleeper breaks FAAB ties at random in
// these leagues (≈50/50 over 260 cross-team ties), so a tie counts tieCredit. Rivals
// share the player-level heat described at TUNING.
export function pWinAt(b, opps, sigma) {
  let total = 0;
  for (let k = 0; k < GH.nodes.length; k++) total += GH.weights[k] * pWinGivenHeat(b, opps, sigma, GH.nodes[k]);
  return total;
}
export const HEAT_RULE = GH;
// logit scale that keeps a rival's average bid propensity at o.q once heat is mixed in
export const heatLogitScale = () => Math.sqrt(1 + (Math.PI * TUNING.heatKappa * TUNING.heatKappa) / 8);

// P(my bid b wins | player heat h).
export function pWinGivenHeat(b, opps, sigma, h) {
  const { heatIcc, heatKappa, tieCredit } = TUNING;
  sigma *= TUNING.sigmaScale ?? 1;
  const tau = Math.sqrt(heatIcc) * sigma, sw = Math.sqrt(1 - heatIcc) * sigma;
  const zScale = heatLogitScale();
  // log of the bid I beat outright, and the half-credit point for ties
  const lo = b >= 1 ? Math.log(b - 0.5) : null, hi = Math.log(b + 0.5);
  let p = 1;
  for (const o of opps) {
    if (b > o.cap || !(o.q > 0)) continue;
    const q = o.q >= 1 ? 1 : 1 / (1 + Math.exp(-(Math.log(o.q / (1 - o.q)) * zScale + heatKappa * h)));
    const lm = Math.log(o.median) + tau * h;
    const bx = lo == null ? 0 : phi((lo - lm) / sw);
    const tx = phi((hi - lm) / sw) - bx;
    // minimum-bid flyer with probability p0, else the lognormal bid
    const p0 = o.p0 || 0, floor = o.floor || 0;
    const below = b > floor ? p0 + (1 - p0) * bx : (1 - p0) * bx;
    const tie = b > floor ? (1 - p0) * tx : p0 + (1 - p0) * tx;
    p *= 1 - q + q * (below + tieCredit * tie);
  }
  return p;
}

// Choose the bid maximizing P(win)·(value − cost(bid)). You only pay when you win.
// `costFn(b)` is the value of the money a winning bid of b uses up; without it the cost
// is linear, λ·b.
export function optimizeBid(dU, lambda, myBudget, minBid, opps, sigma, costFn) {
  const cost = costFn || ((x) => lambda * x);
  const curve = [];
  let best = { bid: minBid, p: pWinAt(minBid, opps, sigma), ev: -Infinity };
  const step = myBudget > 300 ? Math.ceil(myBudget / 300) : 1;
  let median = null;
  for (let bid = minBid; bid <= myBudget; bid += bid < 20 ? 1 : step) {
    const p = pWinAt(bid, opps, sigma);
    const ev = p * (dU - cost(bid));
    curve.push({ bid, p, ev });
    if (median == null && p >= 0.5) median = bid;
    if (p >= MIN_WIN_P && ev > best.ev + 1e-12) best = { bid, p, ev };
  }
  let breakEven = 0;
  if (costFn) { while (breakEven < myBudget && cost(breakEven + 1) <= dU) breakEven++; } else breakEven = lambda > 0 && isFinite(lambda) ? Math.min(myBudget, Math.floor(dU / lambda)) : myBudget;
  if (dU <= 0 || !(best.ev > 0)) best = { bid: 0, p: 0, ev: 0, skip: true };
  return { ...best, breakEven, median, curve };
}
