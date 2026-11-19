import { loadConfig, configProblems, type LeagueConfig, type AppConfig } from "../config.ts";
import { fetchLeague, fetchFreeAgents, setLineup, type LineupWriteResult } from "../espn/client.ts";
import { buildContext, evaluate, type Verdict } from "../projections/blend.ts";
import { optimizeLineup, diffLineups, type OptimizeResult } from "./optimizer.ts";
import { recommendWaivers, type WaiverTarget } from "./waivers.ts";
import { findTrades, type TradeProposal } from "./trades.ts";
import { findByeRisks, type ByeWeekRisk } from "./byes.ts";
import { analyzeMatchup, type MatchupOutlook } from "./matchup.ts";
import { simulateSeason, type SeasonOutlook } from "./playoffs.ts";
import { scanWeaknesses, findExploitTrades, type TeamWeakness, type ExploitTrade } from "./exploit.ts";
import type { League, Team } from "../espn/types.ts";
import { isWriteValidated, markWriteValidated, writeGateHelp } from "../util/writeGate.ts";
import { recordDecision, readHistory, type Scorecard, type ScoredSwap } from "./history.ts";
import { recordPredictions, settleWeek, readJournal, type PredictionRecord } from "../learning/journal.ts";
import { calibrate, saveCalibration, readCalibration, type Calibration } from "../learning/calibrate.ts";
import { recordHealth, checkHeartbeat, type Check } from "../util/health.ts";
import { notify } from "../util/notify.ts";
import { SLOT_LABEL } from "../espn/constants.ts";

export type LeagueAnalysis = {
  config: LeagueConfig;
  league: League;
  myTeam: Team;
  lineup: OptimizeResult;
  waivers: WaiverTarget[];
  trades: TradeProposal[];
  byeRisks: ByeWeekRisk[];
  /** Every evaluated player in the league, not just your starters. */
  verdicts: Map<number, Verdict>;
  /** Per-source availability, so a silent fallback can be alerted on. */
  sources: {
    fantasyPros: { ok: boolean; note?: string };
    sleeper: { ok: boolean; note?: string };
    schedule: { ok: boolean };
    projectionsNonZero: number;
    rosterSize: number;
  };
  matchup: MatchupOutlook | null;
  season: SeasonOutlook | null;
  weaknesses: TeamWeakness[];
  exploits: ExploitTrade[];
  dataNotes: string[];
  error?: string;
};

export type AnalysisOptions = {
  includeWaivers?: boolean;
  includeTrades?: boolean;
  includeByes?: boolean;
  includeSeason?: boolean;
  includeExploits?: boolean;
  simulations?: number;
  week?: number;
};

export async function analyzeLeague(
  cfg: AppConfig,
  lc: LeagueConfig,
  opts: AnalysisOptions = {},
): Promise<LeagueAnalysis> {
  const auth = { swid: cfg.swid, espnS2: cfg.espnS2 };
  const league = await fetchLeague(auth, cfg.season, lc.id, lc.teamId, opts.week);

  const myTeam = league.teams.find((t) => t.id === lc.teamId);
  if (!myTeam) {
    throw new Error(
      `Team ${lc.teamId} not found in "${league.name}". Teams present: ` +
      league.teams.map((t) => `${t.id}=${t.name}`).join(", "),
    );
  }

  const ctx = await buildContext(league);

  // Build the expert-rank curve across every rostered player in the league, not
  // just mine — a 12-team curve is far better calibrated than a 16-player one.
  const allRostered = league.teams.flatMap((t) => t.roster);
  const verdicts: Map<number, Verdict> = evaluate(allRostered, ctx);

  const lineup = optimizeLineup(league, myTeam, verdicts);

  let waivers: WaiverTarget[] = [];
  if (opts.includeWaivers !== false) {
    try {
      const fas = await fetchFreeAgents(auth, cfg.season, lc.id, league.week);
      waivers = await recommendWaivers(league, myTeam, fas, ctx, verdicts);
    } catch (err) {
      ctx.notes.push(`Waiver pool unavailable: ${(err as Error).message}`);
    }
  }

  const trades = opts.includeTrades === false ? [] : findTrades(league, myTeam, verdicts);

  let byeRisks: ByeWeekRisk[] = [];
  if (opts.includeByes !== false) {
    try {
      byeRisks = await findByeRisks(league, myTeam);
    } catch (err) {
      ctx.notes.push(`Bye-week lookahead unavailable: ${(err as Error).message}`);
    }
  }

  const matchup = (() => {
    try {
      return analyzeMatchup(league, myTeam, verdicts);
    } catch (err) {
      ctx.notes.push(`Matchup model unavailable: ${(err as Error).message}`);
      return null;
    }
  })();

  let season: SeasonOutlook | null = null;
  if (opts.includeSeason !== false) {
    try {
      season = simulateSeason(league, verdicts, opts.simulations ?? 20000);
    } catch (err) {
      ctx.notes.push(`Season simulation unavailable: ${(err as Error).message}`);
    }
  }

  let weaknesses: TeamWeakness[] = [];
  let exploits: ExploitTrade[] = [];
  if (opts.includeExploits !== false) {
    try {
      weaknesses = scanWeaknesses(league, verdicts, myTeam.id);
      exploits = findExploitTrades(league, myTeam, verdicts, weaknesses);
    } catch (err) {
      ctx.notes.push(`Opponent scan unavailable: ${(err as Error).message}`);
    }
  }

  return {
    config: lc,
    league,
    myTeam,
    lineup,
    waivers,
    trades,
    byeRisks,
    verdicts,
    sources: {
      fantasyPros: { ok: ctx.fantasyPros.ok, note: ctx.fantasyPros.note },
      sleeper: { ok: ctx.sleeper.ok, note: ctx.sleeper.note },
      schedule: { ok: ctx.schedule.ok },
      projectionsNonZero: myTeam.roster.filter((p) => p.espnProjection > 0).length,
      rosterSize: myTeam.roster.length,
    },
    matchup,
    season,
    weaknesses,
    exploits,
    dataNotes: ctx.notes,
  };
}

export type AutoLineupOutcome = {
  league: string;
  leagueId: string;
  week: number;
  gain: number;
  moves: number;
  write?: LineupWriteResult;
  rationale: string[];
  warnings: string[];
  skipped?: string;
  error?: string;
};

/**
 * The automated start/sit pass. Runs across every configured league and, for
 * leagues flagged autoLineup, submits the changes to ESPN and verifies them.
 */
export async function runAutoLineup(
  opts: {
    dryRun?: boolean;
    onlyLeagueId?: string;
    forceApply?: boolean;
    /** A supervised, user-initiated single-league write (dashboard click or --confirm). */
    supervised?: boolean;
  } = {},
): Promise<{ outcomes: AutoLineupOutcome[]; problems: string[] }> {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) return { outcomes: [], problems };

  const leagues = opts.onlyLeagueId
    ? cfg.leagues.filter((l) => l.id === opts.onlyLeagueId)
    : cfg.leagues;

  // Unattended runs stay blocked until one supervised write has been verified.
  if (!opts.dryRun && !opts.supervised && !isWriteValidated("roster")) {
    return { outcomes: [], problems: [writeGateHelp("roster")] };
  }

  const outcomes: AutoLineupOutcome[] = [];
  const checks: Check[] = [];
  let authFailed = false;

  for (const lc of leagues) {
    try {
      // Skip the expensive waiver/trade work — this path only sets lineups.
      const a = await analyzeLeague(cfg, lc, {
        includeWaivers: false, includeTrades: false, includeByes: false,
        includeSeason: false, includeExploits: false,
      });

      // Write down every projection BEFORE kickoff so it can be graded honestly
      // later. This runs on every pass, not only when the lineup changes —
      // a week where nothing needed moving is still a week of evidence about
      // whose projections were right.
      try {
        const vmap = a.verdicts;
        const rows: PredictionRecord[] = a.myTeam.roster.flatMap((p) => {
          const v = vmap.get(p.id);
          if (!v || v.points <= 0) return [];
          // His game has already started, so this projection is no longer a
          // prediction — the expert ranks, injury report and betting line
          // behind it have all seen the result. Whatever was recorded for him
          // before kickoff stands; recording now would be grading our own
          // homework with the answers in hand.
          if (v.locked) return [];
          return [{
            season: cfg.season, week: a.league.week, leagueId: lc.id,
            playerId: p.id, name: p.name, position: p.position,
            espn: p.espnProjection, expert: v.expertPoints,
            blended: v.points, vegasMult: v.vegasMult ?? 1,
            confidence: v.confidence,
          }];
        });
        recordPredictions(rows);
      } catch {
        // Journalling must never interfere with setting a lineup.
      }

      // A source that silently drops out is the failure mode that quietly costs
      // points, so each one is checked on every pass.
      checks.push(
        {
          subsystem: "fantasypros",
          ok: a.sources.fantasyPros.ok,
          detail: a.sources.fantasyPros.ok
            ? "expert consensus available"
            : `expert rankings unavailable (${a.sources.fantasyPros.note ?? "unknown"}) — lineups are running on ESPN + market data only`,
          severity: "degraded",
        },
        {
          subsystem: "sleeper",
          ok: a.sources.sleeper.ok,
          detail: a.sources.sleeper.ok ? "market data available" : "Sleeper market data unavailable",
          severity: "minor",
        },
        {
          subsystem: "nfl-schedule",
          ok: a.sources.schedule.ok,
          detail: a.sources.schedule.ok
            ? "schedule and lines available"
            : "NFL schedule/odds unavailable — bye weeks and kickoff locks are not being detected",
          severity: "degraded",
        },
        {
          subsystem: "espn-projections",
          ok: a.sources.projectionsNonZero > 0,
          detail: a.sources.projectionsNonZero > 0
            ? `${a.sources.projectionsNonZero}/${a.sources.rosterSize} projections parsed`
            : `every projection in ${a.league.name.trim()} read as zero — ESPN's payload shape has changed`,
          severity: "critical",
        },
      );

      const base: AutoLineupOutcome = {
        league: a.league.name,
        leagueId: lc.id,
        week: a.league.week,
        gain: a.lineup.gain,
        moves: a.lineup.moves.length,
        rationale: a.lineup.rationale,
        warnings: a.lineup.warnings,
      };

      if (!a.lineup.moves.length) {
        outcomes.push({ ...base, skipped: "Lineup already optimal" });
        continue;
      }
      // forceApply is an explicit click in the dashboard, which counts as approval
      // even for leagues configured as propose-only.
      if (!lc.autoLineup && !opts.forceApply) {
        outcomes.push({ ...base, skipped: "League is set to propose-only" });
        continue;
      }

      const write = await setLineup(
        { swid: cfg.swid, espnS2: cfg.espnS2 },
        cfg.season,
        lc.id,
        lc.teamId,
        a.league.week,
        a.lineup.moves,
        { dryRun: opts.dryRun },
      );
      outcomes.push({ ...base, write });

      checks.push({
        subsystem: "lineup-write",
        ok: !write.error && write.verified !== false,
        detail: write.error ?? write.verifyDetail ?? "write ok",
        severity: "critical",
      });

      if (write.applied && write.verified) {
        markWriteValidated("roster", `${a.league.name} week ${a.league.week}: ${write.moves.length} move(s)`);

        // Log what we changed so the decision can be graded once games finish.
        // Same diff the rationale uses, so the scorecard never grades a swap
        // that did not happen.
        recordDecision({
          at: new Date().toISOString(),
          leagueId: lc.id,
          leagueName: a.league.name,
          week: a.league.week,
          season: cfg.season,
          swaps: diffLineups(a.lineup.current, a.lineup.optimal, a.verdicts)
            .flatMap((c) =>
              c.in?.player && c.out?.player
                ? [{
                    slot: SLOT_LABEL[c.in.slotId] ?? String(c.in.slotId),
                    inId: c.in.player.id,
                    inName: c.in.player.name,
                    outId: c.out.player.id,
                    outName: c.out.player.name,
                    projectedDelta:
                      Math.round(((c.in.verdict?.points ?? 0) - (c.out.verdict?.points ?? 0)) * 10) / 10,
                    reason: c.in.verdict?.reasons?.[0] ?? "higher blended projection",
                  }]
                : [],
            ),
        });
      }

      // A bad transaction body is a systemic failure, not a per-league one.
      // Stop rather than repeating the same broken write against your other leagues.
      if (write.error || write.verified === false) {
        outcomes.push({
          league: "(remaining leagues)", leagueId: "", week: 0, gain: 0, moves: 0,
          rationale: [], warnings: [],
          skipped: "Halted after a failed write — fix the cause before retrying.",
        });
        break;
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (/401|cookie|espn_s2|SWID/i.test(msg)) authFailed = true;
      outcomes.push({
        league: lc.name,
        leagueId: lc.id,
        week: 0,
        gain: 0,
        moves: 0,
        rationale: [],
        warnings: [],
        error: msg,
      });
    }
  }

  checks.push({
    subsystem: "espn-auth",
    ok: !authFailed,
    detail: authFailed
      ? "Your ESPN login expired — re-copy espn_s2 and run npm run verify"
      : "authenticated",
    severity: "critical",
  });

  if (!opts.dryRun) {
    const { alerts } = await recordHealth(checks);
    if (alerts.length) {
      outcomes.push({
        league: "(health)", leagueId: "", week: 0, gain: 0, moves: 0,
        rationale: alerts, warnings: [],
        skipped: "Alerts raised — see the notification",
      });
    }
  }

  return { outcomes, problems: [] };
}


/**
 * Grades past auto-lineup decisions against what actually happened.
 *
 * Projections are easy to trust and easy to be wrong about, so this compares the
 * points the players we started actually scored against the points the players
 * we benched actually scored. It is the only honest measure of whether any of
 * this is working.
 */
export async function buildScorecards(): Promise<Scorecard[]> {
  const cfg = loadConfig();
  if (configProblems(cfg).length) return [];
  const auth = { swid: cfg.swid, espnS2: cfg.espnS2 };

  const history = readHistory().filter((r) => r.season === cfg.season && r.swaps.length);
  const out: Scorecard[] = [];

  // Group by league-week so each needs only one fetch.
  const byKey = new Map<string, typeof history>();
  for (const r of history) {
    const k = `${r.leagueId}:${r.week}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }

  for (const [key, recs] of byKey) {
    const [leagueId, weekStr] = key.split(":");
    const week = Number(weekStr);
    const rec = recs[recs.length - 1];
    const lc = cfg.leagues.find((l) => l.id === leagueId);
    if (!lc) continue;

    try {
      const league = await fetchLeague(auth, cfg.season, leagueId, lc.teamId, week);
      const actual = new Map<number, number>();
      league.teams.forEach((t) => t.roster.forEach((p) => actual.set(p.id, p.actualPoints)));

      // A week is settled once it is behind the league's current scoring period.
      const settled = week < league.currentWeek;

      const swaps: ScoredSwap[] = rec.swaps.map((sw) => {
        const inA = actual.get(sw.inId) ?? null;
        const outA = actual.get(sw.outId) ?? null;

        // Before kickoff, "0 points" and "hasn't played yet" look identical in
        // ESPN's data. Reporting an unplayed game as a 0.0 result would claim a
        // verdict we do not have, so leave it pending instead.
        const played = settled || (inA ?? 0) !== 0 || (outA ?? 0) !== 0;

        return {
          ...sw,
          inActual: played ? inA : null,
          outActual: played ? outA : null,
          realizedDelta:
            played && inA !== null && outA !== null ? Math.round((inA - outA) * 10) / 10 : null,
        };
      });

      out.push({
        league: rec.leagueName,
        week,
        swaps,
        realizedTotal: Math.round(swaps.reduce((a, s) => a + (s.realizedDelta ?? 0), 0) * 10) / 10,
        projectedTotal: Math.round(swaps.reduce((a, s) => a + s.projectedDelta, 0) * 10) / 10,
        settled,
      });
    } catch {
      // A league we can no longer read should not hide the others' results.
    }
  }

  return out.sort((a, b) => b.week - a.week || a.league.localeCompare(b.league));
}


export type LearningReport = {
  settled: { league: string; week: number; graded: number }[];
  calibration: Calibration;
  previous: Calibration | null;
  changes: string[];
  alerts: string[];
};

/**
 * The weekly learning pass: grade past predictions, then refit.
 *
 * Run after the week's games finish. Everything it changes is a parameter that
 * can be checked against outcomes — how much to trust the expert consensus over
 * ESPN, how hard the betting line should push, whether a position is being
 * systematically over-projected, and how volatile each position really is in
 * these leagues. Nothing here invents a signal that is not measurable.
 */
export async function runLearning(): Promise<LearningReport> {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) throw new Error(problems.join("; "));

  const auth = { swid: cfg.swid, espnS2: cfg.espnS2 };
  const previous = readCalibration();
  const settled: LearningReport["settled"] = [];

  // Fill in actuals for any journalled week that has finished.
  const pending = new Map<string, { leagueId: string; week: number }>();
  for (const r of readJournal()) {
    if (r.actual === undefined && r.season === cfg.season) {
      pending.set(`${r.leagueId}:${r.week}`, { leagueId: r.leagueId, week: r.week });
    }
  }

  // Where each league actually is, so "that week is over and still ungraded"
  // can be told apart from "that week is still being played".
  const currentWeekByLeague = new Map<string, number>();

  for (const { leagueId, week } of pending.values()) {
    const lc = cfg.leagues.find((l) => l.id === leagueId);
    if (!lc) continue;
    try {
      const league = await fetchLeague(auth, cfg.season, leagueId, lc.teamId, week);
      currentWeekByLeague.set(leagueId, league.currentWeek);
      // Only grade a week that is genuinely over.
      if (week >= league.currentWeek) continue;

      const actuals = new Map<number, number>();
      league.teams.forEach((t) => t.roster.forEach((p) => actuals.set(p.id, p.actualPoints)));
      const graded = settleWeek(cfg.season, week, leagueId, actuals);
      if (graded) settled.push({ league: league.name.trim(), week, graded });
    } catch {
      // A league we cannot read this minute gets graded on the next pass.
    }
  }

  const calibration = calibrate();
  saveCalibration(calibration);

  const changes: string[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  if (previous) {
    if (Math.abs(calibration.expertWeight - previous.expertWeight) >= 0.01) {
      changes.push(
        `Expert consensus weight ${pct(previous.expertWeight)} → ${pct(calibration.expertWeight)}`,
      );
    }
    if (Math.abs(calibration.vegasStrength - previous.vegasStrength) >= 0.01) {
      changes.push(`Betting-line strength ${previous.vegasStrength} → ${calibration.vegasStrength}`);
    }
    for (const [pos, bias] of Object.entries(calibration.positionBias)) {
      const before = previous.positionBias[pos] ?? 1;
      if (Math.abs(bias - before) >= 0.01) {
        changes.push(`${pos} bias ${before.toFixed(2)} → ${bias.toFixed(2)}`);
      }
    }
  } else if (calibration.sampleSize > 0) {
    changes.push(`First calibration from ${calibration.sampleSize} graded predictions.`);
  }

  // The weekly pass is also the right moment to notice problems that no
  // individual run could catch.
  const alerts: string[] = [];

  // 1. Has the scheduler itself gone quiet? Nothing inside a run can detect a
  //    run that never happened.
  const quiet = await checkHeartbeat();
  if (quiet) alerts.push(quiet);

  // 2. Is the model getting worse rather than better? Calibration is supposed to
  //    reduce error; if it stops doing so once there is real data behind it,
  //    something upstream has changed and the weights are chasing noise.
  if (calibration.sampleSize >= 120 && calibration.calibratedMae > calibration.baselineMae + 0.25) {
    const msg =
      `Calibration is no longer improving accuracy (${calibration.baselineMae.toFixed(2)} → ` +
      `${calibration.calibratedMae.toFixed(2)} pts). A data source may have changed.`;
    alerts.push(msg);
    await notify("Fantasy Command Center", msg, "Model accuracy check");
  }

  // 3. Predictions left ungraded for a week that is already OVER mean weeks are
  //    not settling — usually the journal and ESPN drifting apart on player ids.
  //
  //    This used to wait for 400 ungraded rows before saying anything. At the
  //    forty-odd rows a week these leagues actually produce that is ten weeks of
  //    silence, which is how a grading bug ran from week 2 to week 6 unnoticed.
  //    The honest test is not how many rows are waiting but whether any of them
  //    belong to a week that has finished.
  //    The unit is a completed league-week with NOTHING graded in it, not a
  //    count of ungraded rows. A handful of rows always fail to match — a
  //    player ESPN no longer returns for that week — and alerting on those
  //    would cry wolf on every manual run that happens to settle nothing.
  const ungraded = new Map<string, number>();
  const gradedCount = new Map<string, number>();
  for (const r of readJournal()) {
    if (r.season !== cfg.season) continue;
    const current = currentWeekByLeague.get(r.leagueId);
    if (current === undefined || r.week >= current) continue;
    const key = `${r.leagueId}:${r.week}`;
    const bucket = r.actual === undefined ? ungraded : gradedCount;
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }

  const stuck = [...ungraded.keys()].filter((k) => !gradedCount.has(k));
  if (stuck.length) {
    const weeks = [...new Set(stuck.map((k) => Number(k.split(":")[1])))].sort((a, b) => a - b);
    const rows = stuck.reduce((a, k) => a + (ungraded.get(k) ?? 0), 0);
    const msg =
      `${stuck.length} completed league-week(s) have no graded predictions at all ` +
      `(week(s) ${weeks.join(", ")}, ${rows} row(s)) — weeks are not settling, so the model is not learning.`;
    alerts.push(msg);
    await notify("Fantasy Command Center", msg, "Learning stalled");
  }

  return { settled, calibration, previous, changes, alerts };
}
