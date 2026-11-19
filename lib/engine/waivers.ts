import type { League, Player, Team } from "../espn/types.ts";
import type { Verdict } from "../projections/blend.ts";
import { evaluate, type ProjectionContext } from "../projections/blend.ts";
import { bestLineupPoints } from "./optimizer.ts";
import { SLOT } from "../espn/constants.ts";
import { nameKey } from "../util/name.ts";
import { fetchTrendingAdds } from "../projections/sources.ts";
import { protectionFor } from "./protect.ts";
import { suggestBid } from "./faab.ts";
import { dropImpact, type DropImpact } from "./depth.ts";
import { restOfSeasonValue } from "./value.ts";

export type WaiverTarget = {
  player: Player;
  verdict: Verdict;
  /** Net change to this week's optimal lineup, after dropping `dropCandidate`. */
  immediateGain: number;
  /** False when the drop costs more than the add is worth. */
  worthIt: boolean;
  /** Always present: an add on a full roster must name its casualty. */
  dropCandidate: { player: Player; verdict: Verdict; reason: string; impact?: DropImpact } | undefined;
  /** Blended priority score: this week + rest-of-season + market momentum. */
  score: number;
  trendingAdds?: number;
  /** 1 = hottest add in the league-wide market right now. */
  trendingRank?: number;
  /** FAAB leagues only. */
  suggestedBid?: { amount: number; percentOfRemaining: number; tier: string; required: boolean; rationale: string };
  reasons: string[];
};

export async function recommendWaivers(
  league: League,
  team: Team,
  freeAgents: Player[],
  ctx: ProjectionContext,
  rosterVerdicts: Map<number, Verdict>,
  limit = 12,
): Promise<WaiverTarget[]> {
  // Evaluate the free-agent pool on the same scale as our own roster so the
  // expert-rank curve is built across every player we might start.
  const combined = [...team.roster, ...freeAgents];
  const verdicts = evaluate(combined, ctx);
  for (const [id, v] of rosterVerdicts) if (!verdicts.has(id)) verdicts.set(id, v);

  // Locks matter here: this is a same-week gain, not a rest-of-season one.
  const baseline = bestLineupPoints(league, team.roster, verdicts, { respectLocks: true });
  const trending = await fetchTrendingAdds();
  // Sleeper's add counts are absolute and swing by orders of magnitude week to
  // week, so an absolute threshold is meaningless. Normalize against the hottest
  // add in the current list instead.
  const maxAdds = Math.max(1, ...trending.map((t) => t.adds));
  const trendMap = new Map(trending.map((t) => [nameKey(t.name), t.adds]));
  const trendRank = new Map(
    [...trending].sort((a, b) => b.adds - a.adds).map((t, i) => [nameKey(t.name), i + 1]),
  );

  // Drop candidates must be ranked by REST-OF-SEASON value, never by this week's
  // points. A star on IR projects 0.0 this week, so a weekly ranking nominates
  // your best injured asset as the obvious cut — the single worst piece of advice
  // this app could give.
  const dropValue = (p: Player): number =>
    Math.max(restOfSeasonValue(p, verdicts.get(p.id)), p.percentOwned / 10);

  const rosterCtx = { roster: team.roster, verdicts };
  const isProtected = (p: Player): boolean => protectionFor(p, verdicts.get(p.id), rosterCtx).protected;

  const movable = team.roster.filter(
    (p) => p.lineupSlotId !== SLOT.IR && !verdicts.get(p.id)?.locked,
  );
  const droppable = movable.filter((p) => !isProtected(p)).sort((a, b) => dropValue(a) - dropValue(b));

  // A full roster cannot add without dropping, so there must always be a
  // nominee. If the guard locked everyone, fall back to the least valuable
  // movable player rather than proposing an add ESPN will reject.
  const fallbackDrop = [...movable].sort((a, b) => dropValue(a) - dropValue(b))[0];
  const drop = droppable[0] ?? fallbackDrop;

  // The drop is the same for every target, so price its knock-on cost once:
  // lost bye coverage, a slot left with no spare body, insurance for a shaky
  // starter. Weekly points alone make a bench player look free to cut.
  const impact: DropImpact | undefined = drop
    ? await dropImpact(league, team.roster, drop).catch(() => undefined)
    : undefined;

  const targets: WaiverTarget[] = [];

  for (const fa of freeAgents) {
    const v = verdicts.get(fa.id);
    if (!v || v.unplayable) continue;

    // Net of the drop. Measuring the add alone pretends roster spots are free —
    // in a shallow league your worst player is still a starter, and "add a
    // streaming defense" can quietly mean "cut a productive WR to do it".
    const after = drop
      ? [...team.roster.filter((p) => p.id !== drop.id), fa]
      : [...team.roster, fa];
    const withFa = bestLineupPoints(league, after, verdicts, { respectLocks: true });
    const immediateGain = Math.round((withFa - baseline) * 100) / 100;

    const adds = trendMap.get(nameKey(fa.name));
    const addRank = trendRank.get(nameKey(fa.name));
    const reasons: string[] = [];

    // Rest-of-season signal: expert rank and rising ownership both matter more
    // than a single week for a stash, so they get their own weight.
    // Net of what the drop costs you for the rest of the season, not just this
    // week. Otherwise a streaming defense looks like a free upgrade even when it
    // means cutting a real contributor.
    const rosPoints = Math.max(fa.seasonAverage, v.points * 0.8);
    // The drop costs its own value plus what it does to your depth.
    const dropRos = drop ? restOfSeasonValue(drop, verdicts.get(drop.id)) + (impact?.penalty ?? 0) : 0;
    const rosValue = (rosPoints - dropRos) / 20;
    const momentum = adds ? adds / maxAdds : 0;
    const ownershipTrend = Math.max(0, fa.percentChange) / 10;

    const score =
      immediateGain * 1.0 +
      rosValue * 3.0 +
      momentum * 2.5 +
      ownershipTrend * 1.5;

    if (immediateGain > 0.5) {
      reasons.push(
        `Net +${immediateGain.toFixed(1)} pts this week` +
        (drop ? ` after dropping ${drop.name}` : ""),
      );
    } else if (drop && immediateGain <= 0) {
      reasons.push(`Not worth it right now — ${drop.name} is worth more than the upgrade`);
    }
    if (impact?.warnings.length) {
      reasons.push(`Dropping ${drop!.name}: ${impact.warnings[0]}`);
    }
    if (addRank && addRank <= 25) {
      reasons.push(`#${addRank} most-added player in the last 24h (${formatAdds(adds!)} leagues)`);
    }
    if (fa.percentChange > 2) reasons.push(`Ownership up ${fa.percentChange.toFixed(1)}% and climbing`);
    if (v.expertRank && v.expertRank < 150) reasons.push(`Expert consensus has him at #${v.expertRank} overall`);
    reasons.push(...v.reasons.filter((r) => !reasons.includes(r)).slice(0, 2));

    // Keep the board populated and honest. "Here is the best available, and none
    // of it beats what you would have to drop" is useful information; an empty
    // list just looks broken.
    if (score <= -1.5 && immediateGain <= 0) continue;

    const partial: WaiverTarget = {
      player: fa,
      verdict: v,
      immediateGain,
      worthIt: immediateGain > 0,
      score: Math.round(score * 100) / 100,
      trendingAdds: adds,
      trendingRank: addRank,
      dropCandidate: drop
        ? {
            player: drop,
            verdict: verdicts.get(drop.id)!,
            reason: impact?.breaksBye
              ? `Cheapest you can spare, but cutting him breaks a future bye week`
              : `Lowest rest-of-season value you can spare (${dropValue(drop).toFixed(1)} pts/wk, ${drop.percentOwned.toFixed(0)}% owned)`,
            impact,
          }
        : undefined,
      reasons: reasons.slice(0, 4),
    };

    if (league.waivers.usesFaab) {
      partial.suggestedBid = suggestBid(partial, {
        budgetRemaining: Math.max(0, league.waivers.budget - team.budgetSpent),
        minimumBid: league.waivers.minimumBid,
        // Regular season runs to week 17 in most ESPN leagues.
        weeksLeft: Math.max(1, 17 - league.week),
      });
    }

    targets.push(partial);
  }

  // Defense streaming is real but repetitive — a board of six D/STs hides the
  // actual pickups. Keep the best two and let other positions through.
  const ranked = targets.sort((a, b) => b.score - a.score);
  const out: WaiverTarget[] = [];
  let defenses = 0;
  for (const t of ranked) {
    const isDst = t.player.position === "D/ST";
    if (isDst && defenses >= 2) continue;
    if (isDst) defenses++;
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

function formatAdds(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
