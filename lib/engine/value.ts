import type { Player } from "../espn/types.ts";
import type { Verdict } from "../projections/blend.ts";

/**
 * How much to trust a player's own season average versus his projection.
 *
 * Early in the year the "average" is one or two games — a single 30-point outing
 * makes a waiver-wire body look like a star, which wrecks trade valuations. This
 * shrinks the observed average toward the projection in proportion to sample
 * size: at 1 game it counts for 20%, at 8 games for 67%, approaching full weight
 * only once there is a real season behind it.
 */
const PRIOR_GAMES = 4;

export function sampleWeight(gamesPlayed: number): number {
  return gamesPlayed / (gamesPlayed + PRIOR_GAMES);
}

/**
 * Rest-of-season value, in points per week. Used for trades and drop decisions,
 * where a single week's matchup is irrelevant.
 */
export function restOfSeasonValue(p: Player, v?: Verdict): number {
  const weekly = v?.points ?? p.espnProjection;
  const w = sampleWeight(p.gamesPlayed);
  const base = w * p.seasonAverage + (1 - w) * weekly;

  // A long-term absence is worth less than the per-game rate suggests.
  const out = v?.unplayable && !v?.onBye ? 0.5 : 1;
  return Math.round(base * out * 10) / 10;
}
