import type { Player } from "../espn/types.ts";
import type { Verdict } from "../projections/blend.ts";
import { readCalibration } from "../learning/calibrate.ts";

/**
 * Week-to-week volatility by position, as a coefficient of variation.
 *
 * Measured over top-24 RB / top-36 WR / top-12 TE / top-12 QB seasons since 2015
 * (Underdog Network best-ball variance study). Tight ends swing hardest relative
 * to their average, quarterbacks least — which is exactly why a quarterback is
 * the cheapest place to buy volatility when you need it.
 *
 * K and D/ST are not in that study; those two are estimates, and they are the
 * least trustworthy numbers here.
 */
export const POSITION_CV: Record<string, number> = {
  QB: 0.36,
  RB: 0.54,
  WR: 0.58,
  TE: 0.63,
  K: 0.45,
  "D/ST": 0.75,
};

/**
 * Volatility per position, preferring what these leagues have actually produced
 * over the published study once enough weeks have been graded.
 */
let cvCache: { at: number; cv: Record<string, number> } | null = null;
function currentCv(): Record<string, number> {
  // Cheap cache: this is called once per player per lineup evaluation.
  if (cvCache && Date.now() - cvCache.at < 60_000) return cvCache.cv;
  const cal = readCalibration();
  const cv = cal && cal.sampleSize >= 60 ? { ...POSITION_CV, ...cal.positionCv } : POSITION_CV;
  cvCache = { at: Date.now(), cv };
  return cv;
}

/** Standard deviation of a player's week, in fantasy points. */
export function playerSigma(p: Player, v?: Verdict): number {
  const mean = v?.points ?? p.espnProjection;
  if (mean <= 0) return 0;

  const cv = currentCv()[p.position] ?? 0.55;
  let sigma = mean * cv;

  // When the experts themselves disagree, the outcome is wider than the
  // position baseline implies.
  if (v && v.confidence < 0.6) sigma *= 1 + (0.6 - v.confidence);

  // A questionable tag is a coin flip on usage, not a small haircut.
  if ((p.injuryStatus ?? "").toUpperCase() === "QUESTIONABLE") sigma *= 1.25;

  return Math.round(sigma * 100) / 100;
}

/** Total lineup sigma, treating players as independent. */
export function lineupSigma(players: { player: Player; verdict?: Verdict }[]): number {
  // Real lineups correlate a little (shared game scripts, QB-WR stacks), so this
  // slightly understates the spread. It is close enough to rank decisions by and
  // avoids inventing a correlation matrix we cannot validate.
  const varianceSum = players.reduce((a, x) => {
    const s = playerSigma(x.player, x.verdict);
    return a + s * s;
  }, 0);
  return Math.round(Math.sqrt(varianceSum) * 100) / 100;
}

/** Φ(z) — standard normal CDF, via the Abramowitz & Stegun approximation. */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Probability your lineup outscores theirs.
 *
 * Normal approximation on the difference of two sums. With eight or nine
 * starters the central limit theorem does most of the work, and the error is far
 * smaller than the error already in the projections.
 */
export function winProbability(
  myMean: number,
  mySigma: number,
  oppMean: number,
  oppSigma: number,
): number {
  const spread = Math.sqrt(mySigma * mySigma + oppSigma * oppSigma);
  if (spread <= 0) return myMean > oppMean ? 1 : myMean < oppMean ? 0 : 0.5;
  return Math.max(0.001, Math.min(0.999, normalCdf((myMean - oppMean) / spread)));
}
