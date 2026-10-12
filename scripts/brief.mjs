// Scheduled job: run the weekly model for one team and publish the dashboard plus a
// plain-text brief an agent (e.g. Instinct) can read.
//
//   LEAGUE_ID=... ROSTER_ID=... BRIEF_TOKEN=... node scripts/brief.mjs
//
// Writes public/ (the dashboard) and public/<BRIEF_TOKEN>/brief.{txt,md,json} plus a small
// viewer page. The token keeps the brief's URL unguessable; the repo never contains it.
import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { loadLeague } from '../js/sleeper.js';
import { computeAll, buildBrief, DEFAULT_PREFS } from '../js/engine.js';

const env = (k, d) => (process.env[k] ? process.env[k].trim() : d);
const LEAGUE_ID = env('LEAGUE_ID');
const ROSTER_ID = Number(env('ROSTER_ID'));
const TOKEN = env('BRIEF_TOKEN');
const OWNER = env('OWNER_NAME', 'the team owner');
const TZ = env('TIMEZONE', 'America/Los_Angeles');
const SITE = env('SITE_URL', '');
if (!LEAGUE_ID || !ROSTER_ID || !TOKEN) {
  console.error('Set LEAGUE_ID, ROSTER_ID and BRIEF_TOKEN.');
  process.exit(1);
}

const started = Date.now();
const raw = await loadLeague(LEAGUE_ID);
const result = await computeAll({ raw, prefs: { ...DEFAULT_PREFS }, myRid: ROSTER_ID }, async (m) => console.log(m));
const dashboardUrl = SITE ? `${SITE.replace(/\/$/, '')}/?league=${LEAGUE_ID}&team=${ROSTER_ID}` : '';
const { markdown, json } = buildBrief(result, { owner: OWNER, timeZone: TZ, dashboardUrl });

mkdirSync(`public/${TOKEN}`, { recursive: true });
for (const f of ['index.html', 'serve.py']) cpSync(f, `public/${f}`);
cpSync('css', 'public/css', { recursive: true });
cpSync('js', 'public/js', { recursive: true });
writeFileSync('public/.nojekyll', '');
writeFileSync('public/robots.txt', 'User-agent: *\nDisallow: /\n');
writeFileSync(`public/${TOKEN}/brief.txt`, markdown);
writeFileSync(`public/${TOKEN}/brief.md`, markdown);
writeFileSync(`public/${TOKEN}/brief.json`, JSON.stringify(json, null, 2));
const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
writeFileSync(`public/${TOKEN}/index.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Chop Bid brief</title>
<style>body{margin:0;background:#07090d;color:#eef2f7;font:14px/1.6 ui-monospace,Menlo,monospace}main{max-width:900px;margin:0 auto;padding:24px 16px}pre{white-space:pre-wrap;word-break:break-word}a{color:#c3ff3c}</style></head>
<body><main><p><a href="brief.txt">brief.txt</a> · <a href="brief.json">brief.json</a></p><pre>${esc(markdown)}</pre></main></body></html>`);
console.log(`Brief for ${json.team?.name} (${json.league.name}, Week ${json.waiverWeek}) written in ${((Date.now() - started) / 1000).toFixed(1)}s`);
