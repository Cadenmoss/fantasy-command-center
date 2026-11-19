/**
 * Freeze everything the what-if simulator needs into data/whatif/snap.json, so
 * scenarios and trade searches run offline in seconds.
 *
 *   node --env-file-if-exists=.env.local scripts/whatif/snapshot.ts [--league Redline]
 *
 * Read-only. Nothing here writes to ESPN.
 *
 * Captures: every roster, ESPN's per-week projection for every rostered and top
 * free-agent player for the rest of the regular season, each player's actual
 * 2026 season average (what a trade partner sees), records and points for, the
 * remaining schedule, and live scores for a week already in progress.
 */
import fs from "node:fs";
import path from "node:path";
// calibrate must load before anything that pulls in engine/variance (circular import).
import "../../lib/learning/calibrate.ts";
import { loadConfig, configProblems } from "../../lib/config.ts";
import { fetchLeague, fetchFreeAgents } from "../../lib/espn/client.ts";
import { NON_STARTING_SLOTS } from "../../lib/espn/constants.ts";

const arg = (flag: string, fallback?: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const LEAGUE = arg("--league", "Redline")!;
const OUT = path.join(process.cwd(), "data", "whatif", "snap.json");

const cfg = loadConfig();
const problems = configProblems(cfg);
if (problems.length) { problems.forEach((p) => console.log(`✗ ${p}`)); process.exit(1); }
const lc = cfg.leagues.find((l) => l.name.trim().toLowerCase() === LEAGUE.toLowerCase());
if (!lc) { console.log(`✗ No league called "${LEAGUE}"`); process.exit(1); }
const auth = { swid: cfg.swid, espnS2: cfg.espnS2 };

const now = await fetchLeague(auth, cfg.season, lc.id, lc.teamId);
const liveWeek = now.currentWeek;
const lastRegular = now.playoffs.regularSeasonPeriods;
const L = await fetchLeague(auth, cfg.season, lc.id, lc.teamId, liveWeek);

// ---- live scores for the week in progress ---------------------------------
const schedFile = path.join(process.cwd(), "data", "cache", `sched-${cfg.season}-w${liveWeek}.json`);
const kick = new Map<string, string>();
if (fs.existsSync(schedFile)) for (const g of JSON.parse(fs.readFileSync(schedFile, "utf8"))) kick.set(g.team, g.kickoff);
/** A game is over 3.5h after kickoff. Unknown kickoff → treat as not yet played. */
const done = (team: string) => {
  const k = kick.get(team);
  return k ? new Date(k).getTime() + 3.5 * 3600e3 < Date.now() : false;
};
const BENCH = new Set([20, 21]);
const live: Record<number, { act: number; rem: number }> = {};
let anyPlayed = false;
for (const t of L.teams) {
  let act = 0, rem = 0;
  for (const p of t.roster) {
    if (BENCH.has(p.lineupSlotId)) continue;
    act += p.actualPoints;
    if (p.actualPoints !== 0 || done(p.team)) anyPlayed = true;
    if (!done(p.team)) rem += p.espnProjection;
  }
  live[t.id] = { act, rem };
}
const liveMatchups = L.schedule.filter((m) => m.period === liveWeek);
const weekFinished = liveMatchups.length > 0 && liveMatchups.every((m) => m.played);

// The live week is simulated from its live score only once games have started.
const firstFuture = anyPlayed ? liveWeek + 1 : liveWeek;
const weeks: number[] = [];
for (let w = firstFuture; w <= lastRegular; w++) weeks.push(w);

// ---- per-week projections ---------------------------------------------------
type P = { id: number; name: string; pos: string; team: string; slots: number[]; onTeam: number; status: string; own: number; acq: string; proj: Record<number, number>; avg: number; seasonPts: number };
const players: Record<number, P> = {};
const touch = (p: any, onTeam: number): P => {
  players[p.id] ??= {
    id: p.id, name: p.name, pos: p.position, team: p.team, slots: p.eligibleSlots, onTeam,
    status: p.injuryStatus, own: p.percentOwned, acq: p.acquisitionStatus, proj: {}, avg: 0, seasonPts: 0,
  };
  return players[p.id];
};
for (const t of L.teams) for (const p of t.roster) touch(p, t.id);
process.stdout.write(`fetching weeks ${weeks[0]}-${weeks.at(-1)}`);
for (const w of weeks) {
  const snap = await fetchLeague(auth, cfg.season, lc.id, lc.teamId, w);
  for (const t of snap.teams) for (const p of t.roster) touch(p, t.id).proj[w] = p.espnProjection;
  for (const p of await fetchFreeAgents(auth, cfg.season, lc.id, w, 400)) {
    const x = touch(p, 0);
    x.proj[w] = p.espnProjection;
    x.acq = p.acquisitionStatus;
  }
  process.stdout.write(".");
}

// ---- actual 2026 season averages (rostered players) -----------------------
const raw = await fetch(
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${cfg.season}/segments/0/leagues/${lc.id}?view=mRoster&scoringPeriodId=${liveWeek}`,
  { headers: { Cookie: `SWID=${cfg.swid}; espn_s2=${cfg.espnS2}` } },
).then((r) => r.json()) as any;
for (const t of raw.teams ?? []) for (const e of t.roster?.entries ?? []) {
  const pl = e.playerPoolEntry.player;
  const s = (pl.stats ?? []).find((s: any) => s.scoringPeriodId === 0 && s.statSourceId === 0 && s.statSplitTypeId === 0 && s.seasonId === cfg.season);
  if (players[pl.id] && s) { players[pl.id].avg = s.appliedAverage ?? 0; players[pl.id].seasonPts = s.appliedTotal ?? 0; }
}

// ---- weekly spread actually produced by these teams -----------------------
const scores = new Map<number, number[]>();
for (const m of L.schedule) {
  if (!m.played || m.period >= liveWeek) continue;
  scores.set(m.homeTeamId, [...(scores.get(m.homeTeamId) ?? []), m.homePoints]);
  scores.set(m.awayTeamId, [...(scores.get(m.awayTeamId) ?? []), m.awayPoints]);
}
let ss = 0, df = 0;
for (const xs of scores.values()) {
  if (xs.length < 2) continue;
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  ss += xs.reduce((a, b) => a + (b - mu) ** 2, 0);
  df += xs.length - 1;
}

const startingSlots: number[] = [];
for (const [id, n] of Object.entries(L.lineupSlotCounts)) {
  if (NON_STARTING_SLOTS.has(Number(id))) continue;
  for (let i = 0; i < n; i++) startingSlots.push(Number(id));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  takenAt: new Date().toISOString(),
  league: lc.name, season: cfg.season, me: lc.teamId,
  // Records from ESPN already include the live week once it is final; seed it only while it is open.
  liveWeek: anyPlayed && !weekFinished ? liveWeek : null,
  weeks, startingSlots,
  empSigma: df ? Math.sqrt(ss / df) : 19,
  teams: L.teams.map((t) => ({ id: t.id, name: t.name.trim(), wins: t.wins, losses: t.losses, pf: t.pointsFor, faabLeft: L.waivers.budget - t.budgetSpent, roster: t.roster.map((p) => p.id) })),
  schedule: L.schedule.filter((m) => m.period >= (anyPlayed && !weekFinished ? liveWeek : firstFuture) && m.period <= lastRegular).map((m) => ({ w: m.period, h: m.homeTeamId, a: m.awayTeamId })),
  live,
  players,
}));
console.log(` saved ${Object.keys(players).length} players → ${path.relative(process.cwd(), OUT)}`);
console.log(`live week ${liveWeek}${anyPlayed ? (weekFinished ? " (final)" : " (in progress, seeded from live scores)") : " (not started)"}; simulating weeks ${weeks.join(", ")}`);
