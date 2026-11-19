import type { League, Player } from "../espn/types.ts";
import { SLOT, SLOT_LABEL, NON_STARTING_SLOTS } from "../espn/constants.ts";
import { fetchWeekSchedule } from "../projections/schedule.ts";

export type DropImpact = {
  /** Points-per-week penalty applied on top of the player's own value. */
  penalty: number;
  warnings: string[];
  /** True when dropping him leaves a future week unstartable. */
  breaksBye: boolean;
};

function requiredAt(league: League, slotId: number): number {
  return league.lineupSlotCounts[slotId] ?? 0;
}

function startingSlots(league: League): number[] {
  const out: number[] = [];
  for (const [id, count] of Object.entries(league.lineupSlotCounts)) {
    const slotId = Number(id);
    if (NON_STARTING_SLOTS.has(slotId)) continue;
    for (let i = 0; i < count; i++) out.push(slotId);
  }
  return out;
}

/** Can this set of players legally fill every starting slot? */
function canFill(league: League, players: Player[]): string[] {
  const slots = startingSlots(league);
  const used = new Set<number>();
  const unfillable: string[] = [];

  // Fill the scarcest slots first so FLEX doesn't consume a specialist.
  const order = [...slots].sort(
    (a, b) =>
      players.filter((p) => p.eligibleSlots.includes(a)).length -
      players.filter((p) => p.eligibleSlots.includes(b)).length,
  );

  for (const slotId of order) {
    const pick = players.find((p) => !used.has(p.id) && p.eligibleSlots.includes(slotId));
    if (pick) used.add(pick.id);
    else unfillable.push(SLOT_LABEL[slotId] ?? String(slotId));
  }
  return unfillable;
}

/**
 * What dropping this player actually costs beyond his weekly points.
 *
 * Weekly projection alone says a bench receiver is free to cut. It is not: he is
 * the body that covers a bye, the insurance if a starter goes down, and often the
 * only other player eligible for a thin slot. This prices that in, so "add a
 * streaming defense" stops looking free when it quietly means cutting your last
 * spare receiver.
 */
export async function dropImpact(
  league: League,
  roster: Player[],
  candidate: Player,
  weeksAhead = 6,
): Promise<DropImpact> {
  const warnings: string[] = [];
  let penalty = 0;
  let breaksBye = false;

  const active = roster.filter((p) => p.lineupSlotId !== SLOT.IR);
  const without = active.filter((p) => p.id !== candidate.id);

  // 1. Positional depth: is he the last body who can fill a slot he covers?
  for (const slotId of new Set(candidate.eligibleSlots)) {
    if (NON_STARTING_SLOTS.has(slotId)) continue;
    const need = requiredAt(league, slotId);
    if (!need) continue;
    const othersEligible = without.filter((p) => p.eligibleSlots.includes(slotId)).length;
    if (othersEligible < need) {
      penalty += 6;
      warnings.push(`he is your last ${SLOT_LABEL[slotId] ?? slotId}-eligible player`);
    } else if (othersEligible === need) {
      penalty += 2;
      warnings.push(`leaves you with zero spare at ${SLOT_LABEL[slotId] ?? slotId}`);
    }
  }

  // 2. Bye coverage: does cutting him make a future week unstartable?
  for (let w = league.week + 1; w <= Math.min(league.week + weeksAhead, 18); w++) {
    let sched;
    try {
      sched = await fetchWeekSchedule(league.season, w);
    } catch {
      break;
    }
    if (!sched.ok || !sched.onBye.size) continue;

    const availableWith = active.filter((p) => !sched.onBye.has(p.team));
    const availableWithout = without.filter((p) => !sched.onBye.has(p.team));

    const before = canFill(league, availableWith);
    const after = canFill(league, availableWithout);
    const newHoles = after.filter((slot) => !before.includes(slot));

    if (newHoles.length) {
      breaksBye = true;
      penalty += 8;
      warnings.push(`without him you cannot fill ${newHoles.join(", ")} in week ${w}`);
      break;
    }
  }

  // 3. Injury insurance: a healthy backup behind a shaky starter has real value.
  const shakyStarters = active.filter(
    (p) =>
      p.id !== candidate.id &&
      !NON_STARTING_SLOTS.has(p.lineupSlotId) &&
      ["QUESTIONABLE", "DOUBTFUL", "OUT", "INJURY_RESERVE"].includes((p.injuryStatus ?? "").toUpperCase()) &&
      p.eligibleSlots.some((sl) => candidate.eligibleSlots.includes(sl)),
  );
  if (shakyStarters.length && NON_STARTING_SLOTS.has(candidate.lineupSlotId)) {
    penalty += 3;
    warnings.push(`he is the cover for ${shakyStarters[0].name} (${shakyStarters[0].injuryStatus.toLowerCase()})`);
  }

  return { penalty: Math.round(penalty * 10) / 10, warnings, breaksBye };
}
