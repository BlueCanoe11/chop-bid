# Chop Bid Optimizer

A FAAB bid optimizer for Sleeper chopped (guillotine) leagues. It reads your league from
Sleeper's public API, simulates the rest of the season, models how each manager bids, and
recommends a bid for every available waiver player.

## Run it

```bash
python3 serve.py
```

Then open http://localhost:8765 and enter your Sleeper username (or a league ID).
Shortcut: `http://localhost:8765/?league=<LEAGUE_ID>&team=<ROSTER_ID>`.

No installs or API keys. Everything runs in the browser; `serve.py` only serves the files
(with caching off so code changes show on reload).

## Weekly brief for an agent (Instinct)

`scripts/brief.mjs` runs the same engine as the dashboard (`js/engine.js`) and writes a
plain-text brief: claims, bids, max bids, safe drops, both scenarios while the weekly
elimination is pending, and step-by-step instructions (text the owner, wait for approval,
then enter the claims in Sleeper). `.github/workflows/brief.yml` runs it on GitHub's
scheduler (right after eliminations post Monday night PT, through Tuesday, and daily) and
publishes to GitHub Pages:

- dashboard: `https://<user>.github.io/<repo>/`
- brief: `https://<user>.github.io/<repo>/<BRIEF_TOKEN>/brief.txt` (also `.json`, and an HTML view)

Setup (once): push this folder to a GitHub repository; in Settings → Secrets and variables
→ Actions add secrets `LEAGUE_ID`, `ROSTER_ID`, `BRIEF_TOKEN` (any long random string; the
brief's URL is only as private as this token) and variables `OWNER_NAME`, `TIMEZONE`
(e.g. `America/Los_Angeles`), `SITE_URL`; in Settings → Pages set Source to GitHub Actions;
then run the workflow once from the Actions tab.

Notes: GitHub Pages sites are public. The repo contains no league data; the brief is only
reachable through the token URL, but anyone who opens the hosted dashboard can run it for
any league. Sleeper's API is read-only, so claims are entered in the Sleeper app (by you,
or by an agent with access to your Sleeper account).

## How it works

| File | Job |
|---|---|
| `js/sleeper.js` | Fetches league, rosters, transactions (incl. losing bids), live matchups, schedule and projections. |
| `js/model.js` | League state, league scoring, weekly optimal lineups with free-agent streaming, the Monte Carlo survival simulator (and a week-by-week trace for display). |
| `js/market.js` | Who bids and how much, learned from this league's bids plus 28 public chopped leagues; P(win) by bid; the EV-maximizing bid. |
| `js/plan.js` | The bid plan: non-overlapping claims that fit your budget. |
| `js/app.js` / `js/charts.js` | Dashboard: bid plan, sortable bids-by-player table (CSV export), per-player derivation with Sleeper vs. model at each step, lineups by week, simulation charts, league tables, method and validation. |

1. **Lineups.** Every remaining team's best lineup is re-picked for each week from that
   week's projections (byes and expected injury returns included). Slots a roster can't
   fill above free-agent level are streamed at replacement level (the k-th best unrostered
   player at the position, k from how many players the league adds per week).
2. **Survival sim.** 6,000+ seasons: each week every team's score is drawn around its
   lineup projection (spread scaled ×0.9 and slightly right-skewed to match 3,466 real
   team-weeks; starters miss games at 2025 rates, covered by bench or streamer; every team
   keeps improving ~2.7 pts/week, weaker teams up to 25% faster) and the lowest is
   eliminated. If several teams outlast the last week, that week's top score wins.
3. **Player value.** Rerun the same simulated seasons with the player added. The change in
   expected weeks survived (or win probability) is his value, i.e. value over the free agent
   you could stream for $0.
4. **Cost of money.** Holding $B is worth V(B) = future value × B/(B + median rival FAAB);
   a winning bid of $b costs V(B) − V(B − b). Least certain input: every bid also shows its
   range if money were worth ½× or 2×.
5. **Competing bids.** Logistic bid propensity (lineup gain over the rival's own streamer,
   freshly released or not, projection, rival activity) fit on 10 completed 2025 leagues and
   validated on 18 others; bid size from this league's price curve and each manager's
   aggression; correlated interest in the same player; ties split 50/50.
6. **Bid.** Maximize `P(win) × (value − cost(bid))`; under 5% win probability is a Pass.
   The plan is scored exactly over every win/lose combination of its claims and each bid is
   re-priced given the others. If this week's elimination is open, both outcomes are priced.

## Validation (tools/)

`tools/` holds the backtest harness built by the review pass (28 public chopped leagues,
2025 season plus 2026 to date; cached under `tools/.cache/`, ~290 MB, safe to delete).

```bash
python3 tools/fetch.py all
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tools/eval_chop.mjs -- js
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tools/eval_market.mjs -- js forward
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tools/eval_user.mjs -- js quick
```

Held-out results (original → current model): eliminated team was the model's #1 pick 25% →
31% (top 3: 62% → 65%); predicted rival bids 3.9× actual → 0.8×; mean P(win) on actual bids
18% → 34% against a 36% actual win rate. `tools/baseline_js/` keeps the original model for comparison.

Second review (`tools/critique/`): elimination log loss 1.951 → 1.944 over 274
league-weeks; P(win) Brier on the top 2 players off each eliminated roster 0.124 → 0.118
(held-out). Re-run: `jsc -m tools/critique/crit_market_top.mjs`, `jsc -m tools/critique/tune_market.mjs`.

## Known simplifications

- Player scores are independent normals (no game-stack correlation, no boom/bust shape).
- The value of future money is a heuristic, not backtested (would need simulated future
  waiver runs); hence the ranges.
- For heavily contested stars, P(win) at 20–40% of the average budget still runs ~7 points
  high, i.e. bids there may be slightly low.
- The plan treats claims' win probabilities as independent and ignores the roster spot
  each claim costs.
- Recommendations are sensitive to projections: ±5% can move the top bids by about $40.
- IDP slots are ignored.
