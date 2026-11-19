import type { League, Player } from "../espn/types.ts";
import type { Verdict } from "../projections/blend.ts";
import { restOfSeasonValue } from "./value.ts";
import { SLOT, NON_STARTING_SLOTS } from "../espn/constants.ts";

/**
 * Value over replacement, by position.
 *
 * Raw points are not comparable across positions and treating them as if they
 * are produces confidently terrible trades. A 20-point quarterback looks better
 * than a 12-point tight end until you notice the waiver wire has an 18-point
 * quarterback and a 5-point tight end: the real edges are +2 and +7, and the
 * tight end is the more valuable asset.
 *
 * Replacement level here is the last player at each position who would start
 * somewhere in this league — below that, the position is free.
 */
export type ReplacementLevels = Record<string, number>;

const FLEX_POSITIONS = new Set(["RB", "WR", "TE"]);

function startersNeededAt(league: League, position: string): number {
  const counts = league.lineupSlotCounts;
  const teams = league.teams.length || 10;

  const direct: Record<string, number> = {
    QB: counts[SLOT.QB] ?? 0,
    RB: counts[SLOT.RB] ?? 0,
    WR: counts[SLOT.WR] ?? 0,
    TE: counts[SLOT.TE] ?? 0,
    K: counts[SLOT.K] ?? 0,
    "D/ST": counts[SLOT.DST] ?? 0,
  };

  let n = direct[position] ?? 0;
  // Flex slots get absorbed by RB/WR/TE roughly in proportion to how often each
  // actually fills them.
  const flex = counts[SLOT.FLEX] ?? 0;
  if (flex && FLEX_POSITIONS.has(position)) {
    const share: Record<string, number> = { RB: 0.45, WR: 0.45, TE: 0.1 };
    n += flex * (share[position] ?? 0);
  }
  return Math.max(1, Math.round(n * teams));
}

export function replacementLevels(
  league: League,
  verdicts: Map<number, Verdict>,
  pool: Player[] = [],
): ReplacementLevels {
  const everyone = [...league.teams.flatMap((t) => t.roster), ...pool].filter(
    (p) => p.lineupSlotId !== SLOT.IR,
  );

  const levels: ReplacementLevels = {};
  for (const position of ["QB", "RB", "WR", "TE", "K", "D/ST"]) {
    const ranked = everyone
      .filter((p) => p.position === position)
      .map((p) => restOfSeasonValue(p, verdicts.get(p.id)))
      .sort((a, b) => b - a);
    if (!ranked.length) { levels[position] = 0; continue; }

    const idx = Math.min(startersNeededAt(league, position), ranked.length - 1);
    levels[position] = Math.round(ranked[idx] * 10) / 10;
  }
  return levels;
}

/** A player's value above the freely-available alternative at his position. */
export function vorp(p: Player, v: Verdict | undefined, levels: ReplacementLevels): number {
  const raw = restOfSeasonValue(p, v);
  const replacement = levels[p.position] ?? 0;
  return Math.round((raw - replacement) * 10) / 10;
}

/**
 * What a player is worth to a *specific* roster.
 *
 * VORP says what he is worth in the abstract; this says whether you can use him.
 * A third quarterback has real VORP and no value to a team that can only start
 * one, which is exactly the trade a naive model talks you into.
 */
export function vorpForRoster(
  league: League,
  roster: Player[],
  p: Player,
  verdicts: Map<number, Verdict>,
  levels: ReplacementLevels,
): number {
  const base = vorp(p, verdicts.get(p.id), levels);
  if (base <= 0) return base;

  // How many players you already have who are better and block the same slots.
  const blockers = roster.filter(
    (x) =>
      x.id !== p.id &&
      x.position === p.position &&
      vorp(x, verdicts.get(x.id), levels) >= base,
  ).length;

  const slotsForPosition = p.eligibleSlots.filter(
    (s) => !NON_STARTING_SLOTS.has(s),
  ).length
    ? Object.entries(league.lineupSlotCounts)
        .filter(([id]) => p.eligibleSlots.includes(Number(id)) && !NON_STARTING_SLOTS.has(Number(id)))
        .reduce((a, [, n]) => a + n, 0)
    : 0;

  if (blockers >= slotsForPosition) {
    // He cannot crack your lineup: worth only his trade/insurance value.
    return Math.round(base * 0.25 * 10) / 10;
  }
  return base;
}
