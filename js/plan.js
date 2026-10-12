// Bid plan: which claims to place, and for how much.
//
// A plan is scored exactly over every win/loss outcome of its claims (independent win
// probabilities): E[value of the players actually won] − E[cost of the money actually
// spent]. Values of player sets come from the same simulated seasons as everything else,
// so overlap is handled naturally (two backup QBs add little together) and a long-shot
// claim no longer blocks its backups: if CMC is only 24% to win, a second RB still has
// most of his value. Claims are added greedily, each at the bid that maximizes the plan's
// expected value given the others; then every bid is re-optimized once.
import { valueOfAdding } from './model.js';

const MAX_CLAIMS = 6;
const CANDIDATES = 12;
const MIN_WIN_P = 0.05;

export async function buildPlan({ season, ls, market, results, lambda, costFn, budget, objective = 'weeks', onProgress }) {
  const cost = costFn || ((b) => lambda * b);
  const pool = results
    .filter((r) => !r.opt.skip && r.opt.curve?.length)
    .sort((a, b) => b.opt.ev - a.opt.ev)
    .slice(0, CANDIDATES);

  const cache = new Map();
  const valueOf = (ids) => {
    if (!ids.length) return 0;
    const key = ids.slice().sort().join('|');
    if (!cache.has(key)) cache.set(key, valueOfAdding(season, ls, ids, objective).dU);
    return cache.get(key);
  };

  // Outcomes of a set of claims: [{ won: ids, p, spent }]
  const outcomes = (claims) => {
    const out = [];
    for (let m = 0; m < 1 << claims.length; m++) {
      let p = 1, spent = 0;
      const won = [];
      claims.forEach((c, i) => {
        if (m & (1 << i)) { p *= c.p; spent += c.bid; won.push(c.r.pl.id); } else p *= 1 - c.p;
      });
      if (p > 1e-9) out.push({ won, p, spent });
    }
    return out;
  };

  // Best bid for candidate r given the other claims: maximize
  // p(b) · E_S[ V(S ∪ r) − V(S) − (cost(spent_S + b) − cost(spent_S)) ].
  const bestBid = (r, others) => {
    const outs = outcomes(others);
    const dV = outs.reduce((a, o) => a + o.p * (valueOf([...o.won, r.pl.id]) - valueOf(o.won)), 0);
    const room = budget - others.reduce((a, c) => a + c.bid, 0);
    let best = null;
    for (const pt of r.opt.curve) {
      if (pt.bid > room || pt.p < MIN_WIN_P) continue;
      const dC = outs.reduce((a, o) => a + o.p * (cost(o.spent + pt.bid) - cost(o.spent)), 0);
      const gain = pt.p * (dV - dC);
      if (!best || gain > best.gain) best = { bid: pt.bid, p: pt.p, gain, dV };
    }
    let breakEven = 0;
    while (breakEven < room && outs.reduce((a, o) => a + o.p * (cost(o.spent + breakEven + 1) - cost(o.spent)), 0) <= dV) breakEven++;
    return best ? { ...best, breakEven } : null;
  };

  let plan = [];
  for (let round = 0; round < MAX_CLAIMS; round++) {
    if (onProgress) await onProgress(round);
    let pick = null;
    for (const r of pool) {
      if (plan.some((c) => c.r === r)) continue;
      const b = bestBid(r, plan);
      if (b && b.gain > 1e-6 && (!pick || b.gain > pick.b.gain)) pick = { r, b };
    }
    if (!pick) break;
    plan.push({ r: pick.r, bid: pick.b.bid, p: pick.b.p, marg: pick.b.dV, gain: pick.b.gain, breakEven: pick.b.breakEven });
  }
  // One pass of re-optimizing each bid given the final set of other claims.
  for (let i = 0; i < plan.length; i++) {
    const others = plan.filter((_, j) => j !== i);
    const b = bestBid(plan[i].r, others);
    if (b && b.gain > 0) plan[i] = { ...plan[i], bid: b.bid, p: b.p, marg: b.dV, gain: b.gain, breakEven: b.breakEven };
  }
  plan = plan.filter((c) => c.gain > 1e-6);

  const outs = outcomes(plan);
  const expectedValue = outs.reduce((a, o) => a + o.p * (valueOf(o.won) - cost(o.spent)), 0);
  const expSpend = outs.reduce((a, o) => a + o.p * o.spent, 0);
  return {
    claims: plan.map((c) => ({
      r: c.r,
      marg: c.marg,
      opt: { ...c.r.opt, bid: c.bid, p: c.p, ev: c.gain, breakEven: c.breakEven, skip: false },
    })),
    total: plan.reduce((a, c) => a + c.bid, 0),
    expectedValue,
    expSpend,
    pAll: plan.reduce((a, c) => a * c.p, 1),
  };
}
