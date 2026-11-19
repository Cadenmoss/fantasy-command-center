/**
 * How likely am I to finish dead last?
 *
 *   node --env-file-if-exists=.env.local scripts/lastplace.ts --league Redline
 *
 * Read-only. Nothing here writes to ESPN.
 *
 * Why this is not `simulateSeason()` from lib/engine/playoffs.ts: that model takes
 * *this week's* projections as every team's strength for the whole rest of the
 * season. Two things break when the question spans nine weeks.
 *
 *   - This week's byes become permanent. Six NFL teams are off in week 6, so a
 *     roster with three players on bye looks wrecked until January.
 *   - Injured players never come back. `evaluate()` zeroes anyone currently OUT
 *     or on IR, every week, forever.
 *
 * Both are exactly what the question is about, so strength is rebuilt week by
 * week from ESPN's own per-week projections for the rest of the regular season.
 * Those already carry each team's real bye week and ESPN's expected return date
 * for an injured player, and they are applied to all twelve rosters, so nobody
 * gets a favour the others don't.
 *
 * The scenarios differ only in what *I* do. Opponents behave identically in all
 * of them: best legal lineup every week, and they compete for the same waiver
 * wire I do. A model where I work the wire and eleven other managers don't is
 * not an answer to "assuming I make good roster moves" — it is a thumb on the
 * scale.
 */
// lib/learning/calibrate.ts and lib/engine/variance.ts import each other, and
// calibrate reads POSITION_CV at module init. Loading calibrate first lets
// variance finish initializing before that read; the other order throws.
import { readCalibration } from "../lib/learning/calibrate.ts";
import { POSITION_CV } from "../lib/engine/variance.ts";
import { loadConfig, configProblems } from "../lib/config.ts";
import { fetchLeague, fetchFreeAgents } from "../lib/espn/client.ts";
import { maximizeAssignment } from "../lib/engine/assign.ts";
import { NON_STARTING_SLOTS } from "../lib/espn/constants.ts";
import type { League, Player } from "../lib/espn/types.ts";

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", m: "\x1b[35m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };

const arg = (flag: string, fallback?: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const LEAGUE_NAME = arg("--league", "Redline")!;
const RUNS = Number(arg("--runs", "50000"));
/** Persistent per-team error in projected strength, points/week. Reported as a sensitivity too. */
const SHOCK = Number(arg("--shock", "6"));
/** Starters one team can land off the wire in a week. */
const STREAM_CAP = Number(arg("--stream-cap", "2"));
/** Wire pickups that crack *anyone's* lineup in a week, league-wide. The wire is scarce. */
const WIRE_AWARDS = Number(arg("--wire-awards", "6"));

/**
 * Where ESPN's weekly projection is known to be wrong, and why.
 *
 * ESPN zeroes a player on IR for every remaining week when it has no return
 * date, which reads as "out for the season" even when the reporting says
 * otherwise. Each override is a specific, sourced disagreement — not an
 * optimism knob.
 */
const INJURY_OVERRIDES: Record<string, { fromWeek: number; points: number; note: string }> = {
  "Michael Pittman Jr.": {
    fromWeek: 10,
    points: 7,
    note:
      "ESPN has him at 0 for every remaining week. Reporting says plantar fasciitis, " +
      "multi-week, earliest return after Pittsburgh's week-9 bye — a WR3 again from " +
      "week 10, not written off for the season.",
  },
};

const cfg = loadConfig();
const problems = configProblems(cfg);
if (problems.length) { problems.forEach((p) => console.log(`${C.r}✗${C.x} ${p}`)); process.exit(1); }
const lc = cfg.leagues.find((l) => l.name.trim().toLowerCase() === LEAGUE_NAME.trim().toLowerCase());
if (!lc) {
  console.log(`${C.r}✗${C.x} No league called "${LEAGUE_NAME}". Known: ${cfg.leagues.map((l) => l.name).join(", ")}`);
  process.exit(1);
}
const auth = { swid: cfg.swid, espnS2: cfg.espnS2 };

// ---------------------------------------------------------------- data

const league: League = await fetchLeague(auth, cfg.season, lc.id, lc.teamId);
const lastRegular = league.playoffs.regularSeasonPeriods;
const weeks: number[] = [];
for (let w = league.week; w <= lastRegular; w++) weeks.push(w);

const nTeams = league.teams.length;
const meId = league.myTeamId;
const meTeam = league.teams.find((t) => t.id === meId)!;
const nameOf = (id: number) => league.teams.find((t) => t.id === id)!.name.trim();

process.stdout.write(`${C.d}fetching week-by-week projections${C.x}`);
const projByWeek = new Map<number, Map<number, number>>();
const faByWeek = new Map<number, Player[]>();
for (const w of weeks) {
  const snap = w === league.week ? league : await fetchLeague(auth, cfg.season, lc.id, lc.teamId, w);
  const m = new Map<number, number>();
  snap.teams.forEach((t) => t.roster.forEach((p) => m.set(p.id, p.espnProjection)));
  try {
    const fas = await fetchFreeAgents(auth, cfg.season, lc.id, w, 300);
    faByWeek.set(w, fas);
    // The free-agent pool is fetched per week too, so its projections belong in
    // the same week's map — without this the wire reads as zero and never helps.
    fas.forEach((p) => m.set(p.id, p.espnProjection));
  } catch {
    faByWeek.set(w, []);
  }
  projByWeek.set(w, m);
  process.stdout.write(".");
}
console.log(` ${C.g}done${C.x} (weeks ${weeks[0]}-${weeks.at(-1)})`);

/** A player's projection for a week, after the documented overrides. */
function projOf(p: Player, week: number): number {
  const o = INJURY_OVERRIDES[p.name];
  const espn = projByWeek.get(week)?.get(p.id) ?? 0;
  return o && week >= o.fromWeek ? Math.max(espn, o.points) : espn;
}

// ---------------------------------------------------------------- lineups

const startingSlots: number[] = [];
for (const [id, count] of Object.entries(league.lineupSlotCounts)) {
  const slotId = Number(id);
  if (NON_STARTING_SLOTS.has(slotId)) continue;
  for (let i = 0; i < count; i++) startingSlots.push(slotId);
}

/** Position volatility, preferring this league's own graded weeks when there are enough. */
const cal = readCalibration();
const CV: Record<string, number> =
  cal && cal.sampleSize >= 60 ? { ...POSITION_CV, ...cal.positionCv } : POSITION_CV;

type Lineup = { mean: number; sigma: number; used: { p: Player; pts: number }[] };

/** Best legal lineup from a pool of players, and its spread. */
function bestLineup(pool: Player[], week: number): Lineup {
  const weights = pool.map((p) =>
    startingSlots.map((slotId) => (p.eligibleSlots.includes(slotId) ? projOf(p, week) : -1e6)),
  );
  const assigned = weights.length ? maximizeAssignment(weights) : [];
  const used = pool
    .map((p, i) => ({ p, slot: assigned[i], pts: projOf(p, week) }))
    .filter((x) => x.slot >= 0 && x.slot < startingSlots.length);

  const mean = used.reduce((a, x) => a + x.pts, 0);
  const variance = used.reduce((a, x) => a + ((CV[x.p.position] ?? 0.55) * x.pts) ** 2, 0);
  return { mean, sigma: Math.sqrt(variance), used: used.map((x) => ({ p: x.p, pts: x.pts })) };
}

/** The streamers worth bidding on in a week: the top few free agents at each position. */
function wireMenu(week: number, perPosition = 2): Player[] {
  const fas = faByWeek.get(week) ?? [];
  const out: Player[] = [];
  for (const pos of ["QB", "RB", "WR", "TE", "K", "D/ST"]) {
    out.push(
      ...fas
        .filter((p) => p.position === pos && projOf(p, week) > 0)
        .sort((a, b) => projOf(b, week) - projOf(a, week))
        .slice(0, perPosition),
    );
  }
  return out;
}

// ---------------------------------------------------------------- calibration

/** Pooled within-team SD of weekly scores — what a team week actually swings. */
function empiricalSigma(): { sigma: number; teamWeeks: number } {
  const scores = new Map<number, number[]>(league.teams.map((t) => [t.id, []]));
  for (const m of league.schedule) {
    if (!m.played || m.period >= league.week) continue;
    scores.get(m.homeTeamId)?.push(m.homePoints);
    scores.get(m.awayTeamId)?.push(m.awayPoints);
  }
  let ss = 0;
  let df = 0;
  let n = 0;
  for (const [, xs] of scores) {
    if (xs.length < 2) continue;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    ss += xs.reduce((a, b) => a + (b - mean) ** 2, 0);
    df += xs.length - 1;
    n += xs.length;
  }
  return { sigma: df > 0 ? Math.sqrt(ss / df) : 0, teamWeeks: n };
}
const emp = empiricalSigma();

// ---------------------------------------------------------------- strength

type WeekStrength = { mean: number; sigma: number };
type Strengths = Map<number, Map<number, WeekStrength>>;

/**
 * Rest-of-season strength for every team, week by week.
 *
 * The wire is allocated exclusively and by need: every participating team's gain
 * from every available streamer is priced, the largest gain is awarded first, and
 * that player leaves the pool. Handing the same top free agent to twelve rosters
 * at once would flatter the field as badly as handing the wire to me alone
 * flatters me.
 */
function buildStrengthsWithAwards(
  maxAwards: number,
  opts: { myRoster?: Player[]; iStream: boolean },
): Strengths {
  const rosters = new Map<number, Player[]>(
    league.teams.map((t) => [t.id, t.id === meId && opts.myRoster ? opts.myRoster : t.roster]),
  );
  const participants = league.teams
    .map((t) => t.id)
    .filter((id) => id !== meId || opts.iStream);

  const out: Strengths = new Map(league.teams.map((t) => [t.id, new Map()]));

  for (const w of weeks) {
    const pool = wireMenu(w);
    const have = new Map<number, Player[]>(league.teams.map((t) => [t.id, []]));
    const taken = new Set<number>();

    // gain[teamId][playerId], recomputed only for the team that just signed someone.
    const gain = new Map<number, Map<number, number>>();
    const priceFor = (teamId: number) => {
      const base = bestLineup([...rosters.get(teamId)!, ...have.get(teamId)!], w).mean;
      const m = new Map<number, number>();
      for (const fa of pool) {
        if (taken.has(fa.id)) continue;
        m.set(fa.id, bestLineup([...rosters.get(teamId)!, ...have.get(teamId)!, fa], w).mean - base);
      }
      gain.set(teamId, m);
    };
    participants.forEach(priceFor);

    for (let awarded = 0; awarded < maxAwards; awarded++) {
      let best: { teamId: number; playerId: number; gain: number } | null = null;
      for (const teamId of participants) {
        if (have.get(teamId)!.length >= STREAM_CAP) continue;
        for (const [playerId, g] of gain.get(teamId)!) {
          if (taken.has(playerId)) continue;
          if (g > 0.5 && (!best || g > best.gain)) best = { teamId, playerId, gain: g };
        }
      }
      if (!best) break;
      have.get(best.teamId)!.push(pool.find((p) => p.id === best!.playerId)!);
      taken.add(best.playerId);
      priceFor(best.teamId);
    }

    for (const t of league.teams) {
      const l = bestLineup([...rosters.get(t.id)!, ...have.get(t.id)!], w);
      // The model treats starters as independent, which understates a real
      // lineup; the floor is what these twelve teams have actually swung.
      out.get(t.id)!.set(w, { mean: l.mean, sigma: Math.max(l.sigma, emp.sigma) });
    }
  }
  return out;
}

const buildStrengths = (opts: { myRoster?: Player[]; iStream: boolean }) =>
  buildStrengthsWithAwards(WIRE_AWARDS, opts);

/**
 * The spare quarterback, priced.
 *
 * This league starts one quarterback and its FLEX takes RB/WR/TE only, so the
 * second of Mahomes and Hurts scores nothing from the bench. The tempting
 * conclusion is that trading him is free points. It is not: his edge over the
 * best quarterback sitting in free agency is about -1 point a week, so a rival
 * who needs a quarterback can simply sign one. `--trade-rate` is the fraction of
 * his weekly projection you get back in a receiver, and the realistic end of
 * that range is low, not high.
 */
const TRADE_RATE = Number(arg("--trade-rate", "0.4"));
const SPARE_QB = arg("--spare-qb", "Jalen Hurts")!;
function rosterAfterQbTrade(): Player[] | null {
  const spare = meTeam.roster.find((p) => p.name === SPARE_QB);
  if (!spare) return null;
  const healthy = weeks.filter((w) => projOf(spare, w) > 0);
  const level = healthy.reduce((a, w) => a + projOf(spare, w), 0) / Math.max(1, healthy.length);
  const synthetic: Player = {
    ...spare,
    id: -999,
    name: `WR back for ${SPARE_QB}`,
    position: "WR",
    eligibleSlots: [3, 4, 5, 23, 20],
    injuryStatus: "ACTIVE",
  };
  // He has a bye of his own rather than borrowing the quarterback's.
  const synthBye = weeks[Math.floor(weeks.length / 2)];
  for (const w of weeks) {
    projByWeek.get(w)!.set(synthetic.id, w === synthBye ? 0 : level * TRADE_RATE);
  }
  return [...meTeam.roster.filter((p) => p.id !== spare.id), synthetic];
}

type Scenario = { key: string; label: string; strengths: Strengths };
const tradedRoster = rosterAfterQbTrade();

process.stdout.write(`${C.d}building week-by-week strength for every team${C.x}`);
const scenarios: Scenario[] = [];
const add = (key: string, label: string, s: Strengths) => { scenarios.push({ key, label, s: undefined, strengths: s } as Scenario); process.stdout.write("."); };
add("nowire", "Nobody works the wire (reference point)", buildStrengths({ iStream: false }));
// Re-run the reference with the wire open to everyone *but* me, so the only
// difference between the next two scenarios is my own behaviour.
add("passive", "I only set my best lineup; the others work the wire", buildStrengths({ iStream: false }));
add("active", "I work the wire too, on the same terms as everyone else", buildStrengths({ iStream: true }));
if (tradedRoster) {
  add("trade", `…and I trade the spare quarterback for a receiver at ${(TRADE_RATE * 100).toFixed(0)}% of his value`, buildStrengths({ iStream: true, myRoster: tradedRoster }));
}
console.log(` ${C.g}done${C.x}`);

// The "nobody" reference needs the wire shut for everyone, which buildStrengths
// does by participant list; rebuild it with an empty wire instead.
{
  const saved = new Map(faByWeek);
  weeks.forEach((w) => faByWeek.set(w, []));
  scenarios[0].strengths = buildStrengths({ iStream: false });
  saved.forEach((v, k) => faByWeek.set(k, v));
}

// ---------------------------------------------------------------- simulation

const remaining = league.schedule.filter(
  (m) => !m.played && m.period >= league.week && m.period <= lastRegular,
);

function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

type SimOut = { finish: Map<number, number[]> };

function simulate(st: Strengths, runs: number, shock = SHOCK, forceThisWeek?: "win" | "loss"): SimOut {
  const ids = league.teams.map((t) => t.id);
  const finish = new Map<number, number[]>(ids.map((id) => [id, new Array(nTeams).fill(0)]));
  const base = new Map(league.teams.map((t) => [t.id, { w: t.wins, pf: t.pointsFor }]));

  for (let r = 0; r < runs; r++) {
    // One draw per team per season: projection error and the injuries nobody has
    // had yet. Without it a nine-week answer comes out overconfident.
    const shocks = new Map(ids.map((id) => [id, shock > 0 ? gauss() * shock : 0]));
    const wins = new Map(ids.map((id) => [id, base.get(id)!.w]));
    const pf = new Map(ids.map((id) => [id, base.get(id)!.pf]));

    for (const m of remaining) {
      const hs = st.get(m.homeTeamId)!.get(m.period)!;
      const as = st.get(m.awayTeamId)!.get(m.period)!;
      let h = Math.max(0, hs.mean + shocks.get(m.homeTeamId)! + gauss() * hs.sigma);
      let a = Math.max(0, as.mean + shocks.get(m.awayTeamId)! + gauss() * as.sigma);

      if (forceThisWeek && m.period === league.week) {
        const iAmHome = m.homeTeamId === meId;
        if (iAmHome || m.awayTeamId === meId) {
          const mineHigher = (iAmHome && forceThisWeek === "win") || (!iAmHome && forceThisWeek === "loss");
          if (mineHigher) h = Math.max(h, a + 1); else a = Math.max(a, h + 1);
        }
      }

      pf.set(m.homeTeamId, pf.get(m.homeTeamId)! + h);
      pf.set(m.awayTeamId, pf.get(m.awayTeamId)! + a);
      if (h > a) wins.set(m.homeTeamId, wins.get(m.homeTeamId)! + 1);
      else wins.set(m.awayTeamId, wins.get(m.awayTeamId)! + 1);
    }

    // Standings: wins, then total points — this league's own tiebreak
    // (playoffSeedingRule TOTAL_POINTS_SCORED).
    [...ids]
      .sort((x, y) => wins.get(y)! - wins.get(x)! || pf.get(y)! - pf.get(x)!)
      .forEach((id, pos) => { finish.get(id)![pos]++; });
  }
  return { finish };
}

const pct = (n: number, runs: number) => (n / runs) * 100;

// ---------------------------------------------------------------- output

console.log(`\n${C.b}══════ ${league.name.trim()} · odds of finishing last ══════${C.x}`);
console.log(`${C.d}${meTeam.name.trim()} · ${meTeam.wins}-${meTeam.losses} · ${meTeam.pointsFor.toFixed(1)} PF · week ${league.week} of ${lastRegular} · ${remaining.length} league games left${C.x}`);
console.log(`${C.d}${RUNS.toLocaleString()} simulated seasons · weekly spread calibrated on ${emp.teamWeeks} played team-weeks (±${emp.sigma.toFixed(1)}) · strength shock ±${SHOCK}${C.x}`);

for (const [name, o] of Object.entries(INJURY_OVERRIDES)) {
  console.log(`\n${C.b}Injury override${C.x} ${C.c}${name}${C.x} ${C.d}→ ${o.points} pts/wk from week ${o.fromWeek}${C.x}`);
  console.log(`  ${C.d}${o.note}${C.x}`);
}

const active = scenarios.find((s) => s.key === "active")!;

// What the spare quarterback is actually worth: his edge over the best
// quarterback anyone can sign for nothing.
const spare = meTeam.roster.find((p) => p.name === SPARE_QB);
if (spare) {
  const diffs = weeks
    .filter((w) => projOf(spare, w) > 0)
    .map((w) => {
      const topFaQb = (faByWeek.get(w) ?? [])
        .filter((p) => p.position === "QB")
        .sort((a, b) => projOf(b, w) - projOf(a, w))[0];
      return projOf(spare, w) - (topFaQb ? projOf(topFaQb, w) : 0);
    });
  const edge = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
  console.log(`\n${C.b}Your spare quarterback${C.x} ${C.d}(${SPARE_QB}, unstartable behind Mahomes — FLEX takes RB/WR/TE only)${C.x}`);
  console.log(`  ${edge >= 0 ? C.y : C.r}${edge >= 0 ? "+" : ""}${edge.toFixed(1)} pts/wk${C.x} versus the best quarterback sitting in free agency`);
  console.log(`  ${C.d}${edge < 0 ? "a rival who needs a quarterback can sign one for nothing, so his trade value is thin" : "worth shopping"}${C.x}`);
}
console.log(`\n${C.b}Your week-by-week outlook${C.x} ${C.d}(best legal lineup, wire contested)${C.x}`);
for (const w of weeks) {
  const mine = active.strengths.get(meId)!.get(w)!;
  const lg = league.teams.reduce((a, t) => a + active.strengths.get(t.id)!.get(w)!.mean, 0) / nTeams;
  const gap = mine.mean - lg;
  const tone = gap >= 0 ? C.g : gap > -8 ? C.y : C.r;
  console.log(`  wk ${String(w).padStart(2)}  ${mine.mean.toFixed(1).padStart(6)}  ${C.d}league ${lg.toFixed(1)}${C.x}  ${tone}${gap >= 0 ? "+" : ""}${gap.toFixed(1)}${C.x}`);
}

for (const sc of scenarios) {
  const { finish } = simulate(sc.strengths, RUNS);
  const mine = finish.get(meId)!;
  const pLast = pct(mine[nTeams - 1], RUNS);
  const pBottom2 = pct(mine[nTeams - 1] + mine[nTeams - 2], RUNS);
  const pBottom3 = pct(mine.slice(nTeams - 3).reduce((a, b) => a + b, 0), RUNS);
  const meanPos = mine.reduce((a, c, i) => a + c * (i + 1), 0) / RUNS;

  console.log(`\n${C.b}${sc.label}${C.x}`);
  console.log(`  ${C.r}${C.b}P(dead last)   ${pLast.toFixed(1)}%${C.x}   ${C.y}bottom two ${pBottom2.toFixed(1)}%${C.x}  ${C.d}bottom three ${pBottom3.toFixed(1)}%  ·  mean finish ${meanPos.toFixed(1)} of ${nTeams}${C.x}`);
  const mean = weeks.reduce((a, w) => a + sc.strengths.get(meId)!.get(w)!.mean, 0) / weeks.length;
  const lg = league.teams.reduce((a, t) => a + weeks.reduce((b, w) => b + sc.strengths.get(t.id)!.get(w)!.mean, 0) / weeks.length, 0) / nTeams;
  console.log(`  ${C.d}you project ${mean.toFixed(1)} pts/wk, league average ${lg.toFixed(1)} (${(mean - lg >= 0 ? "+" : "")}${(mean - lg).toFixed(1)})${C.x}`);

  if (sc.key === "active") {
    console.log(`  ${C.d}who ends up last:${C.x}`);
    [...finish.entries()]
      .map(([id, counts]) => ({ id, p: pct(counts[nTeams - 1], RUNS) }))
      .sort((a, b) => b.p - a.p)
      .filter((x) => x.p >= 0.5)
      .forEach((x) => console.log(`     ${x.p.toFixed(1).padStart(5)}%  ${nameOf(x.id)}${x.id === meId ? `${C.g} ← you${C.x}` : ""}`));
    console.log(`  ${C.d}your finishing position:${C.x}`);
    console.log(`     ${mine.map((c, i) => ({ pos: i + 1, p: pct(c, RUNS) })).filter((x) => x.p >= 0.5).map((x) => `${x.pos}: ${x.p.toFixed(0)}%`).join("   ")}`);
  }
}

// ---- this week ---------------------------------------------------------------
const swingRuns = Math.min(20000, RUNS);
const win = pct(simulate(active.strengths, swingRuns, SHOCK, "win").finish.get(meId)![nTeams - 1], swingRuns);
const loss = pct(simulate(active.strengths, swingRuns, SHOCK, "loss").finish.get(meId)![nTeams - 1], swingRuns);
const mine6 = remaining.find((m) => m.period === league.week && (m.homeTeamId === meId || m.awayTeamId === meId));
const opp = mine6 ? nameOf(mine6.homeTeamId === meId ? mine6.awayTeamId : mine6.homeTeamId) : "—";
console.log(`\n${C.b}What week ${league.week} is worth${C.x} ${C.d}(vs ${opp}, main scenario)${C.x}`);
console.log(`  win  → P(last) ${C.g}${win.toFixed(1)}%${C.x}`);
console.log(`  lose → P(last) ${C.r}${loss.toFixed(1)}%${C.x}`);

// ---- sensitivity -------------------------------------------------------------
console.log(`\n${C.b}Sensitivity${C.x} ${C.d}(main scenario, ${swingRuns.toLocaleString()} runs)${C.x}`);
for (const s of [0, 3, 6, 10, 14]) {
  const r = simulate(active.strengths, swingRuns, s);
  console.log(`  strength shock ±${String(s).padStart(2)} pts/wk → P(last) ${pct(r.finish.get(meId)![nTeams - 1], swingRuns).toFixed(1)}%`);
}

// How much the answer rides on the one assumption with no data behind it: how
// much the waiver wire is really worth to twelve managers in a week. Everyone,
// me included, gets whatever this allows.
console.log(`\n${C.b}Sensitivity to how live the waiver wire is${C.x} ${C.d}(pickups league-wide per week that crack a lineup)${C.x}`);
const wireLevels = [0, 2, 4, 6, 9, 12];
for (const n of wireLevels) {
  const st = buildStrengthsWithAwards(n, { iStream: true });
  const r = simulate(st, swingRuns);
  const mean = weeks.reduce((a, w) => a + st.get(meId)!.get(w)!.mean, 0) / weeks.length;
  const lg = league.teams.reduce((a, t) => a + weeks.reduce((b, w) => b + st.get(t.id)!.get(w)!.mean, 0) / weeks.length, 0) / nTeams;
  console.log(
    `  ${String(n).padStart(2)} pickups/wk → P(last) ${pct(r.finish.get(meId)![nTeams - 1], swingRuns).toFixed(1).padStart(5)}%` +
    `   ${C.d}you ${mean.toFixed(1)} vs league ${lg.toFixed(1)} pts/wk${C.x}`,
  );
}
console.log(`  ${C.d}for reference, these twelve teams have actually averaged ${(league.teams.reduce((a, t) => a + t.pointsFor, 0) / (nTeams * (league.week - 1))).toFixed(1)} pts/wk through week ${league.week - 1}${C.x}`);
console.log();
