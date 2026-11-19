import type { League, Player, Team } from "../espn/types.ts";
import { SLOT, SLOT_LABEL, NON_STARTING_SLOTS } from "../espn/constants.ts";
import { fetchWeekSchedule } from "../projections/schedule.ts";

export type ByeWeekRisk = {
  week: number;
  /** Your players who are off that week. */
  out: { name: string; position: string; team: string; isStarter: boolean }[];
  /** Slots you cannot legally fill, e.g. your only QB is on bye. */
  unfillable: string[];
  /** Slots you can fill but only with replacement-level bodies. */
  thin: string[];
  severity: "critical" | "tight" | "fine";
  advice?: string;
};

function startingSlots(league: League): number[] {
  const out: number[] = [];
  for (const [id, count] of Object.entries(league.lineupSlotCounts)) {
    const slotId = Number(id);
    if (NON_STARTING_SLOTS.has(slotId)) continue;
    for (let i = 0; i < count; i++) out.push(slotId);
  }
  return out;
}

/**
 * Looks ahead for bye weeks that break your lineup.
 *
 * The problem with byes is that the week you notice is the week it is too late:
 * the replacement you needed was on waivers seven days earlier. This checks
 * whether each upcoming week can still field a legal lineup, so a hole shows up
 * while you can still do something about it.
 */
export async function findByeRisks(
  league: League,
  team: Team,
  weeksAhead = 6,
): Promise<ByeWeekRisk[]> {
  const slots = startingSlots(league);
  const roster = team.roster.filter((p) => p.lineupSlotId !== SLOT.IR);
  const risks: ByeWeekRisk[] = [];

  for (let w = league.week + 1; w <= Math.min(league.week + weeksAhead, 18); w++) {
    const sched = await fetchWeekSchedule(league.season, w);
    if (!sched.ok || !sched.onBye.size) continue;

    const available = roster.filter((p) => !sched.onBye.has(p.team));
    const out = roster
      .filter((p) => sched.onBye.has(p.team))
      .map((p) => ({
        name: p.name,
        position: p.position,
        team: p.team,
        isStarter: !NON_STARTING_SLOTS.has(p.lineupSlotId),
      }));
    if (!out.length) continue;

    // Greedy feasibility check per slot type: can each slot still be filled?
    const unfillable: string[] = [];
    const thin: string[] = [];
    const used = new Set<number>();

    // Fill the most constrained slots first so FLEX doesn't steal a scarce body.
    const order = [...slots].sort(
      (a, b) =>
        available.filter((p) => p.eligibleSlots.includes(a)).length -
        available.filter((p) => p.eligibleSlots.includes(b)).length,
    );

    for (const slotId of order) {
      const pick = available
        .filter((p) => !used.has(p.id) && p.eligibleSlots.includes(slotId))
        .sort((a, b) => b.seasonAverage - a.seasonAverage)[0];

      const label = SLOT_LABEL[slotId] ?? String(slotId);
      if (!pick) {
        unfillable.push(label);
      } else {
        used.add(pick.id);
        // A body who is barely rostered anywhere is a hole in all but name.
        if (pick.percentOwned < 25 && pick.seasonAverage < 6) thin.push(`${label} (${pick.name})`);
      }
    }

    const startersOut = out.filter((p) => p.isStarter).length;
    const severity: ByeWeekRisk["severity"] =
      unfillable.length ? "critical" : thin.length || startersOut >= 3 ? "tight" : "fine";
    if (severity === "fine") continue;

    risks.push({
      week: w,
      out,
      unfillable,
      thin,
      severity,
      advice: unfillable.length
        ? `You cannot field a legal lineup at ${unfillable.join(", ")} in week ${w}. Add cover before then.`
        : startersOut >= 3
          ? `${startersOut} starters are off in week ${w} — line up replacements early.`
          : `Week ${w} is startable but thin at ${thin.join(", ")}.`,
    });
  }

  return risks;
}

/** Players on your roster whose bye is still ahead, grouped by week. */
export function byeSummary(risks: ByeWeekRisk[]): string[] {
  return risks.map((r) => `Week ${r.week}: ${r.out.map((p) => `${p.name} (${p.position})`).join(", ")}`);
}

export type { Player };
