import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJournal, settledRows, type PredictionRecord } from "./journal.ts";
import { POSITION_CV } from "../engine/variance.ts";

const DIR = process.env.VERCEL ? path.join(os.tmpdir(), "ffcc") : path.join(process.cwd(), "data");
const FILE = path.join(DIR, "calibration.json");

/** Priors — the values used before this league has taught us anything. */
export const PRIORS = {
  expertWeight: 0.55,
  vegasStrength: 0.35,
  positionBias: {} as Record<string, number>,
  positionCv: POSITION_CV,
};

export type Calibration = {
  updatedAt: string;
  sampleSize: number;
  weeksCovered: number;
  expertWeight: number;
  vegasStrength: number;
  /** Multiplicative correction per position, 1 = unbiased. */
  positionBias: Record<string, number>;
  positionCv: Record<string, number>;
  /** Mean absolute error before and after, on the data it was fitted to. */
  baselineMae: number;
  calibratedMae: number;
  notes: string[];
};

export function readCalibration(): Calibration | null {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Calibration;
  } catch {
    return null;
  }
}

/**
 * Shrinks a fitted value toward its prior according to how much data backs it.
 *
 * With two weeks of football, any "learned" parameter is mostly noise. This
 * makes the model move a little on a little evidence and a lot on a lot, so an
 * early fluke cannot rewrite the weights — the same reason season averages are
 * shrunk toward projections early in the year.
 */
function shrink(fitted: number, prior: number, n: number, k: number): number {
  const w = n / (n + k);
  return w * fitted + (1 - w) * prior;
}

function mae(rows: PredictionRecord[], predict: (r: PredictionRecord) => number): number {
  if (!rows.length) return 0;
  return rows.reduce((a, r) => a + Math.abs(predict(r) - (r.actual ?? 0)), 0) / rows.length;
}

/** The parameters a fit is allowed to move. */
type Params = {
  expertWeight: number;
  vegasStrength: number;
  positionBias: Record<string, number>;
};

const PRIOR_PARAMS: Params = {
  expertWeight: PRIORS.expertWeight,
  vegasStrength: PRIORS.vegasStrength,
  positionBias: {},
};

/**
 * Rebuilds a projection from a journalled row under a given set of parameters.
 *
 * This mirrors the live blend — expert/ESPN mix, then the betting line, then the
 * learned per-position correction — but it cannot reproduce it exactly, because
 * the journal does not store the season-average regression or the injury
 * haircut that the live number also went through. That is fine for its purpose:
 * both the prior and the fitted parameters are scored through this same
 * function, so the two numbers differ only by the parameters, which is the
 * thing being compared.
 *
 * The earlier code compared a full journalled `blended` value against a cruder
 * expert/ESPN mix with no line applied, so it was comparing two different
 * models rather than two sets of weights, and reported "no improvement" even
 * where the fit was strictly better.
 */
function predictWith(r: PredictionRecord, p: Params): number {
  const base =
    r.expert !== undefined && r.expert > 0
      ? (1 - p.expertWeight) * r.espn + p.expertWeight * r.expert
      : r.espn;
  // Back out the raw market edge from the multiplier recorded at the time, then
  // re-apply it at this strength.
  const rawEdge = (r.vegasMult - 1) / PRIORS.vegasStrength;
  return base * (1 + rawEdge * p.vegasStrength) * (p.positionBias[r.position] ?? 1);
}

/** Fits the parameters on `rows`. Pure — no I/O, so it can be cross-validated. */
function fit(rows: PredictionRecord[]): { params: Params; positionCv: Record<string, number>; notes: string[] } {
  const notes: string[] = [];
  const withExpert = rows.filter((r) => r.expert !== undefined && r.expert > 0);

  // --- 1. how much to trust the experts -----------------------------------
  let fittedWeight = PRIORS.expertWeight;
  if (withExpert.length >= 20) {
    let best = Infinity;
    for (let w = 0; w <= 1.0001; w += 0.05) {
      const err = mae(withExpert, (r) => (1 - w) * r.espn + w * (r.expert ?? r.espn));
      if (err < best) { best = err; fittedWeight = w; }
    }
  } else {
    notes.push(`Not enough expert-matched rows yet (${withExpert.length}) — keeping the default blend.`);
  }
  const expertWeight = Math.round(shrink(fittedWeight, PRIORS.expertWeight, withExpert.length, 300) * 100) / 100;

  // --- 2. systematic bias per position ------------------------------------
  const positionBias: Record<string, number> = {};
  const positionCv: Record<string, number> = { ...PRIORS.positionCv };
  const byPos = new Map<string, PredictionRecord[]>();
  for (const r of rows) {
    if (!byPos.has(r.position)) byPos.set(r.position, []);
    byPos.get(r.position)!.push(r);
  }

  for (const [pos, list] of byPos) {
    const usable = list.filter((r) => r.blended > 1);
    if (usable.length >= 10) {
      // Ratio of what happened to what we said would happen.
      const ratio =
        usable.reduce((a, r) => a + (r.actual ?? 0), 0) /
        Math.max(1, usable.reduce((a, r) => a + r.blended, 0));
      // Clamp: a real bias is modest, anything wilder is small-sample noise.
      const clamped = Math.max(0.8, Math.min(1.2, ratio));
      positionBias[pos] = Math.round(shrink(clamped, 1, usable.length, 40) * 1000) / 1000;
    }

    // Realised volatility in these leagues, versus the published study.
    const actuals = list.map((r) => r.actual ?? 0);
    if (actuals.length >= 15) {
      const mean = actuals.reduce((a, b) => a + b, 0) / actuals.length;
      if (mean > 1) {
        const sd = Math.sqrt(actuals.reduce((a, b) => a + (b - mean) ** 2, 0) / actuals.length);
        const cv = sd / mean;
        positionCv[pos] =
          Math.round(shrink(cv, PRIORS.positionCv[pos] ?? 0.55, actuals.length, 40) * 1000) / 1000;
      }
    }
  }

  // --- 3. how hard the betting line should push ---------------------------
  let vegasStrength = PRIORS.vegasStrength;
  const withVegas = rows.filter((r) => Math.abs(r.vegasMult - 1) > 0.01);
  if (withVegas.length >= 40) {
    let best = Infinity;
    for (let s = 0; s <= 1.0001; s += 0.05) {
      const err = mae(withVegas, (r) => {
        const rawEdge = (r.vegasMult - 1) / PRIORS.vegasStrength;
        return r.blended * (1 + rawEdge * s);
      });
      if (err < best) { best = err; vegasStrength = s; }
    }
    vegasStrength = Math.round(shrink(vegasStrength, PRIORS.vegasStrength, withVegas.length, 200) * 100) / 100;
  } else {
    notes.push(`Only ${withVegas.length} rows carry a betting line — keeping the default Vegas weight.`);
  }

  return { params: { expertWeight, vegasStrength, positionBias }, positionCv, notes };
}

/**
 * Mean absolute error on weeks the parameters were NOT fitted to.
 *
 * Refitting on the same rows you score against always looks like an
 * improvement — the expert weight is literally chosen by minimising error on
 * them. Holding out one week at a time is the cheapest honest answer to "would
 * these weights have helped on a week they had never seen?", and it is that
 * number, not the in-sample one, that decides whether the fit is used at all.
 */
function heldOutMae(rows: PredictionRecord[]): { prior: number; fitted: number; weeks: number } | null {
  const weekKeys = [...new Set(rows.map((r) => `${r.season}-${r.week}`))];
  if (weekKeys.length < 2) return null;

  let priorErr = 0;
  let fittedErr = 0;
  let n = 0;
  for (const key of weekKeys) {
    const test = rows.filter((r) => `${r.season}-${r.week}` === key);
    const train = rows.filter((r) => `${r.season}-${r.week}` !== key);
    const { params } = fit(train);
    for (const r of test) {
      priorErr += Math.abs(predictWith(r, PRIOR_PARAMS) - (r.actual ?? 0));
      fittedErr += Math.abs(predictWith(r, params) - (r.actual ?? 0));
      n++;
    }
  }
  if (!n) return null;
  return { prior: priorErr / n, fitted: fittedErr / n, weeks: weekKeys.length };
}

/**
 * Refits the blend against outcomes.
 *
 * Only parameters that can be checked against reality are fitted: how much to
 * trust the expert consensus over ESPN, how hard the betting line should push,
 * whether a position is systematically over- or under-projected, and how
 * volatile each position actually is in *these* leagues rather than in a
 * published study.
 *
 * A fit that does not beat the defaults on a week it never saw is discarded.
 * Shrinkage keeps a small sample from moving the weights far, but it cannot
 * tell a weak signal from a wrong one, and quietly shipping weights that make
 * next week's projections worse is the one failure this whole loop exists to
 * prevent.
 */
export function calibrate(minSample = 60, injected?: PredictionRecord[]): Calibration {
  // `injected` exists so the fitting logic can be tested against data with a
  // known answer, rather than only being exercised weeks from now on live data.
  const rows = injected ?? settledRows(readJournal());
  const weeks = new Set(rows.map((r) => `${r.season}-${r.week}`)).size;

  const { params: fittedParams, positionCv, notes } = fit(rows);

  // Score the defaults and the fit through the same function, so the only
  // difference between the two numbers is the parameters themselves.
  const held = heldOutMae(rows);
  const baselineMae = held ? held.prior : mae(rows, (r) => predictWith(r, PRIOR_PARAMS));
  const calibratedMae = held ? held.fitted : mae(rows, (r) => predictWith(r, fittedParams));

  let params = fittedParams;

  if (rows.length < minSample) {
    notes.unshift(
      `Only ${rows.length} graded predictions so far. Calibration needs about ${minSample} before it ` +
      `changes anything meaningfully — every value below is still mostly the default.`,
    );
  } else if (!held) {
    params = PRIOR_PARAMS;
    notes.unshift(
      `All ${rows.length} graded predictions come from a single week, so there is no week to test a ` +
      `fit against — keeping the defaults until there are two.`,
    );
  } else if (held.fitted >= held.prior) {
    params = PRIOR_PARAMS;
    notes.unshift(
      `Fitted weights did no better than the defaults on weeks they had not seen ` +
      `(${held.prior.toFixed(2)} → ${held.fitted.toFixed(2)} pts of error across ${held.weeks} held-out ` +
      `week(s)), so they were discarded and the defaults kept.`,
    );
  }

  return {
    updatedAt: new Date().toISOString(),
    sampleSize: rows.length,
    weeksCovered: weeks,
    expertWeight: params.expertWeight,
    vegasStrength: params.vegasStrength,
    positionBias: params.positionBias,
    // Volatility is a measurement of these leagues rather than a fitted weight,
    // so it is not subject to the accuracy gate above.
    positionCv,
    baselineMae: Math.round(baselineMae * 100) / 100,
    calibratedMae: Math.round(calibratedMae * 100) / 100,
    notes,
  };
}

export function saveCalibration(c: Calibration) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(c, null, 2));
  } catch {
    // If we cannot persist, the model simply keeps using its priors.
  }
}
