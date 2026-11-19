import type { Player, League } from "../espn/types.ts";
import { UNPLAYABLE_INJURY, RISKY_INJURY } from "../espn/constants.ts";
import { fetchFantasyPros, fetchSleeper, type SourceResult, type ExpertRank } from "./sources.ts";
import { fetchWeekSchedule, type WeekSchedule } from "./schedule.ts";
import { matchKeys } from "../util/name.ts";
import { readCalibration } from "../learning/calibrate.ts";

export type Verdict = {
  player: Player;
  /** What the betting line multiplied the projection by, 1 = no adjustment. */
  vegasMult?: number;
  /** Final blended projection, in this league's scoring units. */
  points: number;
  espnPoints: number;
  expertPoints?: number;
  expertRank?: number;
  /** 0–1. Low when sources disagree, when the player is questionable, or when experts are silent. */
  confidence: number;
  /** Human-readable drivers, shown in the UI and in the auto-lineup log. */
  reasons: string[];
  locked: boolean;
  onBye: boolean;
  unplayable: boolean;
  sources: string[];
};

export type Tuning = {
  expertWeight: number;
  vegasStrength: number;
  positionBias: Record<string, number>;
  /** Where these numbers came from, so the UI can be honest about it. */
  source: string;
};

export type ProjectionContext = {
  tuning: Tuning;
  schedule: WeekSchedule;
  fantasyPros: SourceResult;
  sleeper: SourceResult;
  scoring: "PPR" | "HALF" | "STD";
  notes: string[];
};

export function scoringOf(league: League): "PPR" | "HALF" | "STD" {
  const t = (league.scoringType ?? "").toUpperCase();
  if (t.includes("PPR") && !t.includes("HALF")) return "PPR";
  if (t.includes("HALF")) return "HALF";
  return "STD";
}

export async function buildContext(league: League): Promise<ProjectionContext> {
  const scoring = scoringOf(league);
  const [schedule, fantasyPros, sleeper] = await Promise.all([
    fetchWeekSchedule(league.season, league.week),
    fetchFantasyPros(league.season, league.week, scoring, process.env.FANTASYPROS_API_KEY),
    fetchSleeper(),
  ]);

  // Weights learned from this league's own settled weeks, where enough have
  // been graded; otherwise the defaults.
  const cal = readCalibration();
  const tuning: Tuning = cal && cal.sampleSize >= 60
    ? {
        expertWeight: cal.expertWeight,
        vegasStrength: cal.vegasStrength,
        positionBias: cal.positionBias,
        source: `calibrated on ${cal.sampleSize} graded predictions across ${cal.weeksCovered} week(s)`,
      }
    : {
        expertWeight: 0.55,
        vegasStrength: 0.35,
        positionBias: {},
        source: cal
          ? `defaults (only ${cal.sampleSize} graded predictions so far — needs ~60)`
          : "defaults (no graded predictions yet)",
      };

  const notes: string[] = [];
  if (!schedule.ok) notes.push("NFL schedule/odds unavailable — bye and kickoff detection degraded");
  if (!fantasyPros.ok) notes.push(`Expert consensus unavailable (${fantasyPros.note}) — leaning on ESPN + market rank`);
  if (!sleeper.ok) notes.push(`Sleeper market data unavailable (${sleeper.note})`);

  return { tuning, schedule, fantasyPros, sleeper, scoring, notes };
}

function lookup(src: SourceResult, p: Player): ExpertRank | undefined {
  for (const k of matchKeys(p.name)) {
    const hit = src.ranks.get(k);
    // Guard against two different players sharing a normalized name.
    if (hit && (!hit.position || !p.position || samePosition(hit.position, p.position))) return hit;
  }
  return undefined;
}

function samePosition(a: string, b: string): boolean {
  const norm = (s: string) => (s === "DEF" || s === "DST" ? "D/ST" : s);
  return norm(a) === norm(b);
}

/**
 * Expert rankings are ordinal, ESPN's projections are cardinal. To blend them we
 * map each position's expert ordering onto that same position's ESPN point curve:
 * the expert's #1 RB inherits the point value ESPN assigned to its own #1 RB.
 * That puts expert opinion on the league's actual scoring scale, so a disagreement
 * shows up as a point difference rather than an incomparable rank.
 */
function expertPointCurves(pool: Player[], ctx: ProjectionContext): Map<number, number> {
  const out = new Map<number, number>();
  const byPosition = new Map<string, Player[]>();
  for (const p of pool) {
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position)!.push(p);
  }

  for (const [, players] of byPosition) {
    const curve = players
      .map((p) => p.espnProjection)
      .sort((a, b) => b - a);

    const ranked = players
      .map((p) => ({ p, rank: lookup(ctx.fantasyPros, p)?.overallRank ?? lookup(ctx.sleeper, p)?.overallRank }))
      .filter((x): x is { p: Player; rank: number } => x.rank !== undefined)
      .sort((a, b) => a.rank - b.rank);

    ranked.forEach(({ p }, i) => {
      // Guard the tail: more ranked players than curve slots means the surplus
      // sits at the bottom of the curve, not off the end of it.
      const value = curve[Math.min(i, curve.length - 1)] ?? 0;
      out.set(p.id, value);
    });
  }
  return out;
}

export function evaluate(pool: Player[], ctx: ProjectionContext): Map<number, Verdict> {
  const curves = expertPointCurves(pool, ctx);
  const result = new Map<number, Verdict>();

  for (const p of pool) {
    const reasons: string[] = [];
    const sources: string[] = ["ESPN"];
    let vegasMult = 1;
    const game = ctx.schedule.games.get(p.team);
    const onBye = ctx.schedule.ok && p.team !== "FA" && !game;
    const locked = !!game?.started;

    const fp = lookup(ctx.fantasyPros, p);
    const sl = lookup(ctx.sleeper, p);
    const expertPoints = curves.get(p.id);
    const expertRank = fp?.overallRank ?? sl?.overallRank;

    if (fp) sources.push("FantasyPros ECR");
    if (sl?.overallRank) sources.push("Sleeper market");

    // --- blend -------------------------------------------------------------
    // Weighted toward the expert consensus: ESPN's in-house numbers are slow to
    // react to usage and news, which is the whole reason for a second opinion.
    // Regress ESPN's own number toward what the player has actually produced,
    // BEFORE blending. Applying this afterwards would quietly claw back part of
    // the 0.55 weight we deliberately gave the expert consensus.
    const espnSide =
      p.seasonAverage > 0 ? 0.8 * p.espnProjection + 0.2 * p.seasonAverage : p.espnProjection;

    const wExpert = ctx.tuning.expertWeight;

    let points: number;
    if (expertPoints !== undefined) {
      points = (1 - wExpert) * espnSide + wExpert * expertPoints;
      const delta = expertPoints - p.espnProjection;
      if (Math.abs(delta) >= 2) {
        reasons.push(
          `Experts are ${delta > 0 ? "higher" : "lower"} than ESPN by ${Math.abs(delta).toFixed(1)} pts` +
          (fp?.overallRank ? ` (ECR #${fp.overallRank})` : ""),
        );
      }
    } else {
      points = espnSide;
      if (p.espnProjection > 0) reasons.push("No expert consensus found — ESPN projection only");
    }

    // --- matchup (betting market) -----------------------------------------
    if (game?.impliedTotal !== undefined && p.position !== "D/ST") {
      const league_avg = 22.5;
      const edge = (game.impliedTotal - league_avg) / league_avg; // roughly -0.4..+0.4
      const mult = 1 + Math.max(-0.12, Math.min(0.12, edge * ctx.tuning.vegasStrength));
      if (Math.abs(mult - 1) > 0.03) {
        reasons.push(
          `${game.impliedTotal.toFixed(1)}-pt implied team total vs ${game.opponent} ` +
          `(${mult > 1 ? "+" : ""}${((mult - 1) * 100).toFixed(0)}%)`,
        );
      }
      points *= mult;
      vegasMult = mult;
      sources.push("Vegas line");
    } else if (game?.impliedTotal !== undefined && p.position === "D/ST") {
      // Defenses want the *opponent* to be bad, so the signal inverts.
      const oppTotal = ctx.schedule.games.get(game.opponent)?.impliedTotal;
      if (oppTotal !== undefined) {
        const mult = 1 + Math.max(-0.15, Math.min(0.15, (22.5 - oppTotal) / 22.5 * 0.5));
        points *= mult;
        vegasMult = mult;
        reasons.push(`${game.opponent} implied for only ${oppTotal.toFixed(1)}`);
        sources.push("Vegas line");
      }
    }

    // --- learned bias correction -------------------------------------------
    const bias = ctx.tuning.positionBias[p.position];
    if (bias && Math.abs(bias - 1) > 0.005) {
      points *= bias;
      if (Math.abs(bias - 1) >= 0.03) {
        reasons.push(
          `${p.position}s have come in ${bias > 1 ? "above" : "below"} projection here ` +
          `(${((bias - 1) * 100).toFixed(0)}% adjustment learned from past weeks)`,
        );
      }
    }

    // --- availability ------------------------------------------------------
    const status = (p.injuryStatus ?? "ACTIVE").toUpperCase();
    let unplayable = false;

    if (onBye) {
      points = 0;
      unplayable = true;
      reasons.unshift("On bye this week");
    } else if (UNPLAYABLE_INJURY.has(status)) {
      points = status === "DOUBTFUL" ? points * 0.15 : 0;
      unplayable = status !== "DOUBTFUL";
      reasons.unshift(`Listed ${status.replace(/_/g, " ").toLowerCase()}`);
    } else if (RISKY_INJURY.has(status)) {
      points *= 0.92;
      reasons.unshift("Questionable — small haircut applied");
    }

    // --- confidence --------------------------------------------------------
    let confidence = expertPoints !== undefined ? 0.85 : 0.55;
    if (fp?.stdDev && fp.overallRank) {
      // Wide expert disagreement relative to the player's rank = low confidence.
      const noise = Math.min(1, fp.stdDev / Math.max(8, fp.overallRank * 0.35));
      confidence -= noise * 0.3;
    }
    if (RISKY_INJURY.has(status)) confidence -= 0.2;
    if (!ctx.schedule.ok) confidence -= 0.1;
    confidence = Math.max(0.05, Math.min(1, confidence));

    result.set(p.id, {
      player: p,
      vegasMult: Math.round(vegasMult * 1000) / 1000,
      points: Math.round(Math.max(0, points) * 100) / 100,
      espnPoints: p.espnProjection,
      expertPoints: expertPoints !== undefined ? Math.round(expertPoints * 100) / 100 : undefined,
      expertRank,
      confidence: Math.round(confidence * 100) / 100,
      reasons,
      locked,
      onBye,
      unplayable,
      sources: [...new Set(sources)],
    });
  }

  return result;
}
