// Type-only so the runtime import graph stays one-directional (waivers -> faab).
import type { WaiverTarget } from "./waivers.ts";

export type BidSuggestion = {
  /** Dollars, already clamped to what you can actually spend. */
  amount: number;
  percentOfRemaining: number;
  tier: "priority" | "solid" | "flier" | "minimum";
  /**
   * Always true in a FAAB league. You commit a number when the claim goes in and
   * only learn at processing whether someone outbid you, so there is no "free"
   * add to plan around — the bid is the decision.
   */
  required: boolean;
  rationale: string;
};

/**
 * Suggests a FAAB bid.
 *
 * The two ways to lose FAAB are overpaying for a streamer and losing a genuine
 * starter by a dollar. This sizes the bid off how much the player actually
 * improves your startable lineup, scaled by budget left and weeks remaining —
 * $20 in week 3 is a very different bid from $20 in week 13.
 */
export function suggestBid(
  target: WaiverTarget,
  opts: { budgetRemaining: number; minimumBid: number; weeksLeft: number },
): BidSuggestion {
  const { budgetRemaining, minimumBid, weeksLeft } = opts;
  // Every add in a FAAB league is a sealed bid. ESPN may currently label a player
  // a free agent, but the claim still resolves at the next processing run against
  // whoever else wanted him, so we always quote a real number.
  const required = true;

  if (budgetRemaining <= minimumBid) {
    return {
      amount: Math.max(0, budgetRemaining),
      percentOfRemaining: 100,
      tier: "minimum",
      required,
      rationale: "Almost nothing left in the budget",
    };
  }

  const gain = target.immediateGain;
  const hyped = (target.trendingRank ?? 999) <= 10;

  // Base share of the remaining budget, by how much he helps right now.
  let share: number;
  let tier: BidSuggestion["tier"];
  if (gain >= 6) { share = 0.35; tier = "priority"; }
  else if (gain >= 3) { share = 0.18; tier = "solid"; }
  else if (gain >= 1) { share = 0.07; tier = "flier"; }
  else { share = 0.02; tier = "minimum"; }

  // Budget you never spend is budget wasted, so loosen up late in the year.
  // Early on, hold back for the injuries that have not happened yet.
  const urgency = weeksLeft <= 4 ? 1.6 : weeksLeft <= 8 ? 1.2 : 1.0;
  share *= urgency;

  // If the whole league is chasing him, the winning bid is higher.
  if (hyped) share *= 1.35;

  const raw = budgetRemaining * share;
  let amount = Math.max(minimumBid, Math.min(budgetRemaining, Math.round(raw)));

  // Bids are sealed: a useful player is lost by a single dollar and you never
  // find out until processing. Anyone who actually improves the lineup gets at
  // least a dollar above the floor instead of a bid that ties everyone else's.
  if (gain >= 1 && amount <= minimumBid) {
    amount = Math.min(budgetRemaining, minimumBid + 1);
  }

  const parts = [
    gain >= 1
      ? `worth +${gain.toFixed(1)} pts to your lineup this week`
      : "depth add, not a starter",
  ];
  if (hyped) parts.push(`#${target.trendingRank} most-added, expect competition`);
  if (weeksLeft <= 4) parts.push("late season — unspent budget is wasted");

  return {
    amount,
    percentOfRemaining: Math.round((amount / Math.max(budgetRemaining, 1)) * 100),
    tier,
    required,
    rationale: parts.join("; "),
  };
}
