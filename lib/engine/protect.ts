import type { Player } from "../espn/types.ts";
import type { Verdict } from "../projections/blend.ts";
import { restOfSeasonValue } from "./value.ts";

export type Protection = {
  /** Hard block: refuse the drop unless the user explicitly overrides. */
  protected: boolean;
  /** Soft flag: allowed, but worth a second look. */
  warn?: boolean;
  reason?: string;
};

/**
 * Decides whether a player is too valuable to drop.
 *
 * Ownership percentage looked like a clean signal and is not: in a 6-team league
 * only ~96 players are rostered anywhere, so every single roster spot is 90%+
 * owned and an absolute threshold locks the entire roster. That left no legal
 * drop, so claims went out with nothing to drop and ESPN rejected them.
 *
 * Protection is therefore relative to your own roster. Someone has to be your
 * worst player, and your worst player is always droppable — the guard exists to
 * stop you cutting a star who happens to be hurt this week, not to stop you
 * managing your roster.
 */
export function protectionFor(
  p: Player,
  v?: Verdict,
  ctx?: { roster: Player[]; verdicts?: Map<number, Verdict> },
): Protection {
  // Genuinely elite players are never a routine cut, whatever else is true.
  if (v?.expertRank && v.expertRank <= 40) {
    return { protected: true, reason: `experts rank him #${v.expertRank} overall — an elite asset` };
  }

  if (ctx?.roster?.length) {
    const value = (x: Player) => restOfSeasonValue(x, ctx.verdicts?.get(x.id));
    const ranked = [...ctx.roster].sort((a, b) => value(a) - value(b));
    const position = ranked.findIndex((x) => x.id === p.id);

    // The bottom quarter of your own roster is always fair game, however well
    // owned they are league-wide.
    const bottomCount = Math.max(3, Math.ceil(ranked.length * 0.25));
    if (position >= 0 && position < bottomCount) {
      const hurtStar = v?.unplayable && (v?.expertRank ?? 999) <= 90;
      return hurtStar
        ? { protected: false, warn: true, reason: `out this week but experts still rank him #${v!.expertRank}` }
        : { protected: false };
    }

    // Everyone above that is a real contributor on this roster.
    return {
      protected: true,
      reason: `he is your #${position + 1} most valuable player of ${ranked.length}`,
    };
  }

  // No roster context: fall back to absolute signals, used only for ranking.
  if (v?.expertRank && v.expertRank <= 120) {
    return { protected: true, reason: `experts still rank him #${v.expertRank} overall` };
  }
  if (p.seasonAverage >= 12 && p.gamesPlayed >= 3) {
    return { protected: true, reason: `averaging ${p.seasonAverage.toFixed(1)} pts/game` };
  }
  return { protected: false };
}

/** Roster capacity from the league's slot settings; a full roster must drop to add. */
export function rosterCapacity(lineupSlotCounts: Record<number, number>): number {
  return Object.values(lineupSlotCounts).reduce((a, n) => a + n, 0);
}
