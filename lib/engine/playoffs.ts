import type { League, Team } from "../espn/types.ts";
import type { Verdict } from "../projections/blend.ts";
import { optimizeLineup } from "./optimizer.ts";
import { lineupSigma } from "./variance.ts";

export type TeamStrength = {
  teamId: number;
  name: string;
  /** Expected points per week from their best startable lineup. */
  mean: number;
  sigma: number;
  wins: number;
  losses: number;
  pointsFor: number;
};

export type PlayoffOdds = {
  teamId: number;
  name: string;
  isMe: boolean;
  makePlayoffs: number;
  winTitle: number;
  /** Odds of finishing dead last in the regular season (wins, then points for). */
  finishLast: number;
  topSeed: number;
  /** Average finishing seed across simulations — the real target when everyone qualifies. */
  meanSeed: number;
  /** Odds of a first-round bye, when the bracket grants one. */
  firstRoundBye: number;
  projectedWins: number;
  meanScore: number;
};

export type SeasonOutlook = {
  odds: PlayoffOdds[];
  me: PlayoffOdds;
  simulations: number;
  weeksLeft: number;
  playoffSpots: number;
  /** True when the bracket takes every team, so qualifying is not the goal. */
  everyoneQualifies: boolean;
  /** Seeds that receive a first-round bye. */
  byeSeeds: number;
  /** Change in your own playoff odds from winning vs losing this week. */
  thisWeekSwing: number;
  /** Change in your own last-place odds from losing vs winning this week. */
  thisWeekLastSwing: number;
  /** What the simulation says you should actually be optimising for. */
  objective: string;
};

/** A team's weekly scoring distribution, from the lineup they can actually field. */
export function teamStrengths(league: League, verdicts: Map<number, Verdict>): TeamStrength[] {
  return league.teams.map((t: Team) => {
    const opt = optimizeLineup(league, t, verdicts);
    const filled = opt.optimal.filter((a) => a.player);
    const mean = filled.reduce((a, s) => a + (verdicts.get(s.player!.id)?.points ?? 0), 0);
    const sigma = lineupSigma(
      filled.map((s) => ({ player: s.player!, verdict: verdicts.get(s.player!.id) })),
    );
    return {
      teamId: t.id,
      name: t.name,
      mean: Math.round(mean * 100) / 100,
      // A floor keeps a team with a wrecked roster from being treated as a
      // deterministic loss for the rest of the year.
      sigma: Math.max(sigma, 12),
      wins: t.wins,
      losses: t.losses,
      pointsFor: t.pointsFor,
    };
  });
}

/** Box–Muller, so each simulated week draws a real normal score. */
function gauss(mean: number, sigma: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.max(0, mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

/**
 * Monte Carlo over the rest of the season.
 *
 * Weekly points are the thing everyone optimises, but they are not the goal —
 * the goal is a playoff berth and a title. Simulating the remaining schedule
 * turns "you are projected 3 points better" into "this is worth 4 points of
 * playoff probability", which is the number that should actually drive a trade
 * or a waiver claim.
 */
export function simulateSeason(
  league: League,
  verdicts: Map<number, Verdict>,
  runs = 20000,
): SeasonOutlook {
  const strengths = teamStrengths(league, verdicts);
  const byId = new Map(strengths.map((s) => [s.teamId, s]));

  const remaining = league.schedule.filter(
    (m) => !m.played && m.period <= league.playoffs.regularSeasonPeriods,
  );
  const spots = league.playoffs.teams;

  const tally = new Map<number, { playoffs: number; title: number; top: number; bye: number; last: number; seedSum: number }>();
  strengths.forEach((s) => tally.set(s.teamId, { playoffs: 0, title: 0, top: 0, bye: 0, last: 0, seedSum: 0 }));
  const lastSeed = strengths.length - 1;

  // A bracket that is not a power of two gives byes to the top seeds.
  const byeSeeds = spots > 1 ? (2 ** Math.ceil(Math.log2(spots)) - spots) : 0;

  const runOnce = (forceThisWeek?: "win" | "loss"): number[] => {
    const wins = new Map<number, number>();
    const pf = new Map<number, number>();
    strengths.forEach((s) => {
      wins.set(s.teamId, s.wins);
      pf.set(s.teamId, s.pointsFor);
    });

    for (const m of remaining) {
      const h = byId.get(m.homeTeamId);
      const a = byId.get(m.awayTeamId);
      if (!h || !a) continue;

      let hs = gauss(h.mean, h.sigma);
      let as = gauss(a.mean, a.sigma);

      // For the swing calculation, pin this week's result and let the rest play out.
      if (forceThisWeek && m.period === league.week) {
        const iAmHome = m.homeTeamId === league.myTeamId;
        const iAmAway = m.awayTeamId === league.myTeamId;
        if (iAmHome || iAmAway) {
          const meWins = forceThisWeek === "win";
          const mineHigher = (iAmHome && meWins) || (iAmAway && !meWins);
          if (mineHigher) { hs = Math.max(hs, as + 1); } else { as = Math.max(as, hs + 1); }
        }
      }

      pf.set(m.homeTeamId, (pf.get(m.homeTeamId) ?? 0) + hs);
      pf.set(m.awayTeamId, (pf.get(m.awayTeamId) ?? 0) + as);
      if (hs > as) wins.set(m.homeTeamId, (wins.get(m.homeTeamId) ?? 0) + 1);
      else wins.set(m.awayTeamId, (wins.get(m.awayTeamId) ?? 0) + 1);
    }

    // Seeding: wins first, total points as the tiebreak (this league's rule).
    return [...wins.entries()]
      .sort((x, y) => y[1] - x[1] || (pf.get(y[0]) ?? 0) - (pf.get(x[0]) ?? 0))
      .map(([id]) => id);
  };

  for (let i = 0; i < runs; i++) {
    const order = runOnce();
    order.forEach((id, seed) => {
      const t = tally.get(id)!;
      t.seedSum += seed + 1;
      if (seed < spots) t.playoffs++;
      if (seed === 0) t.top++;
      if (seed < byeSeeds) t.bye++;
      if (seed === lastSeed) t.last++;
    });

    // Playoff bracket: seeds are re-drawn head to head until one team is left.
    let field = order.slice(0, spots);
    while (field.length > 1) {
      const next: number[] = [];
      // Byes for the top seeds when the field is not a power of two.
      const byes = field.length % 2 === 0 ? 0 : 1;
      if (byes) next.push(field[0]);
      const rest = field.slice(byes);
      for (let k = 0; k < rest.length / 2; k++) {
        const a = rest[k];
        const b = rest[rest.length - 1 - k];
        if (a === undefined || b === undefined || a === b) continue;
        const sa = byId.get(a)!;
        const sb = byId.get(b)!;
        next.push(gauss(sa.mean, sa.sigma) >= gauss(sb.mean, sb.sigma) ? a : b);
      }
      field = next;
    }
    if (field[0] !== undefined) tally.get(field[0])!.title++;
  }

  const odds: PlayoffOdds[] = strengths.map((s) => {
    const t = tally.get(s.teamId)!;
    return {
      teamId: s.teamId,
      name: s.name,
      isMe: s.teamId === league.myTeamId,
      makePlayoffs: Math.round((t.playoffs / runs) * 1000) / 10,
      winTitle: Math.round((t.title / runs) * 1000) / 10,
      finishLast: Math.round((t.last / runs) * 1000) / 10,
      topSeed: Math.round((t.top / runs) * 1000) / 10,
      meanSeed: Math.round((t.seedSum / runs) * 10) / 10,
      firstRoundBye: Math.round((t.bye / runs) * 1000) / 10,
      projectedWins: Math.round((s.wins + (remaining.filter((m) => m.homeTeamId === s.teamId || m.awayTeamId === s.teamId).length * 0.5)) * 10) / 10,
      meanScore: s.mean,
    };
  }).sort((a, b) => b.makePlayoffs - a.makePlayoffs || b.winTitle - a.winTitle);

  const everyoneQualifies = spots >= league.teams.length;

  // How much this week actually matters, in playoff-probability terms.
  const swingRuns = Math.min(4000, runs);
  let winCase = 0;
  let lossCase = 0;
  let winLast = 0;
  let lossLast = 0;
  for (let i = 0; i < swingRuns; i++) {
    const w = runOnce("win");
    const l = runOnce("loss");
    if (w.slice(0, spots).includes(league.myTeamId)) winCase++;
    if (l.slice(0, spots).includes(league.myTeamId)) lossCase++;
    if (w[lastSeed] === league.myTeamId) winLast++;
    if (l[lastSeed] === league.myTeamId) lossLast++;
  }

  const me = odds.find((o) => o.isMe)!;
  return {
    odds,
    me,
    simulations: runs,
    weeksLeft: new Set(remaining.map((m) => m.period)).size,
    playoffSpots: spots,
    everyoneQualifies,
    byeSeeds,
    thisWeekSwing: Math.round(((winCase - lossCase) / swingRuns) * 1000) / 10,
    thisWeekLastSwing: Math.round(((lossLast - winLast) / swingRuns) * 1000) / 10,
    objective: everyoneQualifies
      ? byeSeeds > 0
        ? `Every team makes the bracket, so qualifying is not the goal — seeding is. You are projected to finish ${me.meanSeed.toFixed(1)}, and the top ${byeSeeds} seed${byeSeeds === 1 ? "" : "s"} get a first-round bye (you: ${me.firstRoundBye.toFixed(0)}%).`
        : `Every team makes the bracket, so play for seeding and total points rather than wins alone. You are projected to finish ${me.meanSeed.toFixed(1)}.`
      : me.makePlayoffs < 35
        ? `You need wins now — at ${me.makePlayoffs.toFixed(0)}% to qualify, take variance and upside over safety.`
        : me.makePlayoffs > 80
          ? `You are close to locked in at ${me.makePlayoffs.toFixed(0)}%. Protect the roster and play for seeding.`
          : `You are on the bubble at ${me.makePlayoffs.toFixed(0)}% — every week swings real playoff probability.`,
  };
}
