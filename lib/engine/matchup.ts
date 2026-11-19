import type { League, Player, Team } from "../espn/types.ts";
import type { Verdict } from "../projections/blend.ts";
import { optimizeLineup, type SlotAssignment } from "./optimizer.ts";
import { lineupSigma, playerSigma, winProbability } from "./variance.ts";
import { SLOT, NON_STARTING_SLOTS } from "../espn/constants.ts";

export type SideProjection = {
  team: Team;
  lineup: SlotAssignment[];
  mean: number;
  sigma: number;
};

export type MatchupOutlook = {
  opponent: Team;
  week: number;
  me: SideProjection;
  them: SideProjection;
  winProbability: number;
  /** The best lineup by expected points, and what it wins at. */
  pointsFirst: { mean: number; sigma: number; winProbability: number };
  /** The best lineup by win probability, which may score fewer points. */
  winFirst: { mean: number; sigma: number; winProbability: number };
  /** Swaps that raise win probability at the cost of expected points. */
  leverageMoves: {
    slot: string;
    inName: string;
    outName: string;
    pointsDelta: number;
    winProbDelta: number;
    reason: string;
  }[];
  advice: string;
};

export function findOpponent(league: League, teamId: number, period?: number): Team | undefined {
  const week = period ?? league.week;
  const m = league.schedule.find(
    (x) => x.period === week && (x.homeTeamId === teamId || x.awayTeamId === teamId),
  );
  if (!m) return undefined;
  const oppId = m.homeTeamId === teamId ? m.awayTeamId : m.homeTeamId;
  return league.teams.find((t) => t.id === oppId);
}

function summarize(assignments: SlotAssignment[], verdicts: Map<number, Verdict>) {
  const filled = assignments.filter((a) => a.player);
  const mean = filled.reduce((a, s) => a + (verdicts.get(s.player!.id)?.points ?? 0), 0);
  const sigma = lineupSigma(filled.map((s) => ({ player: s.player!, verdict: verdicts.get(s.player!.id) })));
  return { mean: Math.round(mean * 100) / 100, sigma };
}

/**
 * Picks the lineup most likely to WIN, which is not always the one that scores
 * the most.
 *
 * Expected points is the wrong objective in a head-to-head league: you get one
 * win for beating your opponent by a point and nothing extra for beating them by
 * forty. When you are a clear underdog, a boom-or-bust starter with a lower mean
 * but a fatter right tail is the better bet, and when you are comfortably ahead
 * the safe floor is. The research is specific that this has to be deliberate —
 * randomly adding volatility does not help, and every extra boom/bust starter
 * costs a favourite win probability — so this only ever swaps when the win
 * probability actually improves.
 */
export function analyzeMatchup(
  league: League,
  myTeam: Team,
  verdicts: Map<number, Verdict>,
): MatchupOutlook | null {
  const opponent = findOpponent(league, myTeam.id);
  if (!opponent) return null;

  const mine = optimizeLineup(league, myTeam, verdicts);
  const theirs = optimizeLineup(league, opponent, verdicts);

  const myBase = summarize(mine.optimal, verdicts);
  const oppBase = summarize(theirs.optimal, verdicts);

  const baseWp = winProbability(myBase.mean, myBase.sigma, oppBase.mean, oppBase.sigma);

  // Local search: try swapping each starter for each eligible bench player and
  // keep whatever raises win probability.
  const bench = myTeam.roster.filter(
    (p) =>
      p.lineupSlotId !== SLOT.IR &&
      !mine.optimal.some((a) => a.player?.id === p.id) &&
      !verdicts.get(p.id)?.locked &&
      !verdicts.get(p.id)?.unplayable,
  );

  let best = mine.optimal.map((a) => ({ ...a }));
  let bestStats = myBase;
  let bestWp = baseWp;
  const leverageMoves: MatchupOutlook["leverageMoves"] = [];

  let improved = true;
  let rounds = 0;
  while (improved && rounds < 3) {
    improved = false;
    rounds++;

    for (let i = 0; i < best.length; i++) {
      const slot = best[i];
      if (slot.locked || NON_STARTING_SLOTS.has(slot.slotId)) continue;

      for (const cand of bench) {
        if (!cand.eligibleSlots.includes(slot.slotId)) continue;
        if (best.some((a) => a.player?.id === cand.id)) continue;

        const trial = best.map((a) => ({ ...a }));
        trial[i] = { ...slot, player: cand, verdict: verdicts.get(cand.id) };

        const stats = summarize(trial, verdicts);
        const wp = winProbability(stats.mean, stats.sigma, oppBase.mean, oppBase.sigma);

        // Require a real edge, not floating-point noise.
        if (wp > bestWp + 0.004) {
          const outP = slot.player;
          leverageMoves.push({
            slot: slot.slotLabel,
            inName: cand.name,
            outName: outP?.name ?? "(empty)",
            pointsDelta: Math.round((stats.mean - bestStats.mean) * 10) / 10,
            winProbDelta: Math.round((wp - bestWp) * 1000) / 10,
            reason:
              stats.mean < bestStats.mean
                ? `you are the underdog — ${cand.name} has a wider range and a better shot at the upset`
                : `${cand.name} improves both the projection and the odds`,
          });
          best = trial;
          bestStats = stats;
          bestWp = wp;
          improved = true;
        }
      }
    }
  }

  const underdog = baseWp < 0.45;
  const favourite = baseWp > 0.6;
  const advice = leverageMoves.length
    ? underdog
      ? `You are a ${(baseWp * 100).toFixed(0)}% underdog. Adding variance raises your odds to ${(bestWp * 100).toFixed(0)}% even though it costs projected points — the safe lineup loses this matchup on average.`
      : `These swaps raise your win odds from ${(baseWp * 100).toFixed(0)}% to ${(bestWp * 100).toFixed(0)}%.`
    : favourite
      ? `You are a ${(baseWp * 100).toFixed(0)}% favourite. Hold the safe lineup — extra volatility only helps the underdog.`
      : `Your points-optimal lineup is also your best shot at winning (${(baseWp * 100).toFixed(0)}%).`;

  return {
    opponent,
    week: league.week,
    me: { team: myTeam, lineup: best, ...bestStats },
    them: { team: opponent, lineup: theirs.optimal, ...oppBase },
    winProbability: bestWp,
    pointsFirst: { ...myBase, winProbability: baseWp },
    winFirst: { ...bestStats, winProbability: bestWp },
    leverageMoves,
    advice,
  };
}

/** Per-player volatility, for display next to a projection. */
export function volatilityOf(p: Player, v?: Verdict): { sigma: number; label: string } {
  const sigma = playerSigma(p, v);
  const mean = v?.points ?? p.espnProjection;
  const cv = mean > 0 ? sigma / mean : 0;
  const label = cv >= 0.65 ? "boom/bust" : cv >= 0.5 ? "swingy" : "steady";
  return { sigma, label };
}
