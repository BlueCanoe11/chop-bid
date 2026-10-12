// Thin client for Sleeper's public, read-only API. Every request is cached for the
// lifetime of the page, so recomputing the model never refetches.
const BASE = 'https://api.sleeper.app';
const cache = new Map();

function get(path) {
  if (cache.has(path)) return cache.get(path);
  const p = fetch(BASE + path).then((r) => {
    if (!r.ok) throw new Error(`Sleeper returned ${r.status} for ${path}`);
    return r.json();
  });
  cache.set(path, p);
  p.catch(() => cache.delete(path));
  return p;
}

export const getState = () => get('/v1/state/nfl');
export const getUser = (name) => get(`/v1/user/${encodeURIComponent(name)}`);
export const getUserLeagues = (userId, season) => get(`/v1/user/${userId}/leagues/nfl/${season}`);
export const getLeague = (id) => get(`/v1/league/${id}`);
export const getRosters = (id) => get(`/v1/league/${id}/rosters`);
export const getUsers = (id) => get(`/v1/league/${id}/users`);
export const getMatchups = (id, week) => get(`/v1/league/${id}/matchups/${week}`);
export const getTransactions = (id, leg) => get(`/v1/league/${id}/transactions/${leg}`);

export const getSchedule = (season) => get(`/schedule/nfl/regular/${season}`);

export function getProjections(season, week, positions) {
  const q = positions.map((p) => `position%5B%5D=${encodeURIComponent(p)}`).join('&');
  return get(`/projections/nfl/${season}/${week}?season_type=regular&${q}`);
}

// Everything the model needs for one league, fetched in parallel.
export async function loadLeague(leagueId) {
  const [state, league, rosters, users] = await Promise.all([
    getState(), getLeague(leagueId), getRosters(leagueId), getUsers(leagueId),
  ]);
  if (!league) throw new Error(`No Sleeper league with ID ${leagueId}`);
  const inSeason = String(state.season) === String(league.season);
  const curWeek = inSeason ? Math.max(1, state.week || 1) : Math.max(1, league.settings.leg || 1);
  const legs = Array.from({ length: curWeek }, (_, i) => i + 1);
  const [txLists, matchups] = await Promise.all([
    Promise.all(legs.map((l) => getTransactions(leagueId, l).catch(() => []))),
    getMatchups(leagueId, curWeek).catch(() => []),
  ]);
  const transactions = {};
  legs.forEach((l, i) => { transactions[l] = txLists[i] || []; });
  return { state, league, rosters, users, transactions, matchups: matchups || [], curWeek };
}
