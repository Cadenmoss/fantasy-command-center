import type { League, Player, Team } from "../espn/types.ts";
import type { Verdict } from "../projections/blend.ts";
import { bestLineupPoints } from "./optimizer.ts";
import { SLOT } from "../espn/constants.ts";
import { restOfSeasonValue } from "./value.ts";
import { replacementLevels, vorpForRoster } from "./vorp.ts";

export type TradeProposal = {
  partner: Team;
  give: Player[];
  receive: Player[];
  /** Change in MY best startable lineup. */
  myGain: number;
  /** Change in THEIR best startable lineup — must be positive or they decline. */
  theirGain: number;
  /** How even the deal is. Lopsided offers get ignored even when both sides gain. */
  fairness: number;
  /** Rough odds the other manager actually says yes. */
  likelihood: "likely" | "plausible" | "long shot";
  rationale: string[];
};

type Valued = { player: Player; points: number };

/** Trades are about the rest of the season, not this week's matchup. */
const rosValue = restOfSeasonValue;

function rosVerdicts(
  roster: Player[],
  verdicts: Map<number, Verdict>,
): Map<number, Verdict> {
  const out = new Map<number, Verdict>();
  for (const p of roster) {
    const v = verdicts.get(p.id);
    out.set(p.id, {
      ...(v ?? ({} as Verdict)),
      player: p,
      points: rosValue(p, v),
      // Bye weeks and this week's kickoff times are irrelevant to a trade.
      unplayable: false,
      locked: false,
      onBye: false,
      reasons: v?.reasons ?? [],
      sources: v?.sources ?? [],
      confidence: v?.confidence ?? 0.5,
      espnPoints: p.espnProjection,
    });
  }
  return out;
}

export function findTrades(
  league: League,
  myTeam: Team,
  verdicts: Map<number, Verdict>,
  opts: { maxPerPartner?: number; limit?: number } = {},
): TradeProposal[] {
  const { maxPerPartner = 2, limit = 10 } = opts;
  const partners = league.teams.filter((t) => t.id !== myTeam.id);

  const myRoster = myTeam.roster.filter((p) => p.lineupSlotId !== SLOT.IR);
  // Positional value, so a surplus quarterback is not mistaken for an upgrade.
  const levels = replacementLevels(league, verdicts);
  const usefulToMe = (p: Player) => vorpForRoster(league, myRoster, p, verdicts, levels);
  const myV = rosVerdicts(myRoster, verdicts);
  const myBase = bestLineupPoints(league, myRoster, myV);

  const proposals: TradeProposal[] = [];

  for (const partner of partners) {
    const theirRoster = partner.roster.filter((p) => p.lineupSlotId !== SLOT.IR);
    if (theirRoster.length < 5) continue;

    const theirV = rosVerdicts(theirRoster, verdicts);
    const theirBase = bestLineupPoints(league, theirRoster, theirV);

    // Combined valuation so both sides are scored on one scale.
    const allV = new Map([...myV, ...theirV]);

    // Cap the search: only the pieces either side would realistically move.
    const mine: Valued[] = myRoster
      .map((p) => ({ player: p, points: myV.get(p.id)!.points }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 12);
    const theirs: Valued[] = theirRoster
      .map((p) => ({ player: p, points: theirV.get(p.id)!.points }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 12);

    const forPartner: TradeProposal[] = [];

    for (const g of mine) {
      for (const r of theirs) {
        // Skip nonsense: never offer a swap of near-identical value at the same spot.
        if (g.player.position === r.player.position && Math.abs(g.points - r.points) < 1.2) continue;

        const myAfter = bestLineupPoints(
          league,
          [...myRoster.filter((p) => p.id !== g.player.id), r.player],
          allV,
        );
        const theirAfter = bestLineupPoints(
          league,
          [...theirRoster.filter((p) => p.id !== r.player.id), g.player],
          allV,
        );

        const myGain = Math.round((myAfter - myBase) * 100) / 100;
        const theirGain = Math.round((theirAfter - theirBase) * 100) / 100;

        // A player I cannot start is not an upgrade, whatever his raw points say.
        if (usefulToMe(r.player) - usefulToMe(g.player) <= 0) continue;
        // Both sides must actually improve, or it is not a trade anyone accepts.
        if (myGain <= 0.4) continue;
        // The other manager needs a real reason, not a rounding error. A deal
        // that hands them +0.4/wk while you take +10 reads as an insult and
        // costs you credibility for the offers that would have worked.
        if (theirGain < 1.2) continue;

        const fairness =
          1 - Math.abs(myGain - theirGain) / Math.max(myGain + theirGain, 0.01);

        // Anything this lopsided will not be accepted; proposing it is worse
        // than proposing nothing.
        if (fairness < 0.35) continue;

        const likelihood: TradeProposal["likelihood"] =
          fairness >= 0.7 ? "likely" : fairness >= 0.5 ? "plausible" : "long shot";

        forPartner.push({
          partner,
          give: [g.player],
          receive: [r.player],
          myGain,
          theirGain,
          fairness: Math.round(fairness * 100) / 100,
          likelihood,
          rationale: [
            `You gain +${myGain.toFixed(1)} rest-of-season pts/wk; ${partner.name} gains +${theirGain.toFixed(1)}`,
            `${r.player.name} (${r.player.position}) upgrades a starting slot for you`,
            `${g.player.name} (${g.player.position}) fills a hole on their roster — surplus for you`,
          ],
        });
      }
    }

    forPartner
      .sort((a, b) => b.myGain + b.fairness - (a.myGain + a.fairness))
      .slice(0, maxPerPartner)
      .forEach((p) => proposals.push(p));
  }

  // You can only acquire a given player once, so collapse duplicate offers for
  // the same target and keep the version that is most likely to be accepted.
  const byTarget = new Map<number, TradeProposal>();
  for (const p of proposals) {
    const key = p.receive[0]?.id;
    if (key === undefined) continue;
    const held = byTarget.get(key);
    if (!held || p.myGain * p.fairness > held.myGain * held.fairness) byTarget.set(key, p);
  }

  return [...byTarget.values()]
    .sort((a, b) => b.myGain * b.fairness - a.myGain * a.fairness)
    .slice(0, limit);
}
