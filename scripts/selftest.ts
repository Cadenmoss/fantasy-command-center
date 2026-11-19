/**
 * End-to-end engine test against a synthetic league. Exercises the paths that
 * are expensive to get wrong in production: kickoff locks, byes, OUT players,
 * FLEX eligibility and the current-vs-optimal diff. No network, no credentials.
 *
 *   npm run selftest
 */
import { normalizeLeague } from "../lib/espn/client.ts";
import { evaluate, type ProjectionContext, type Verdict } from "../lib/projections/blend.ts";
import { optimizeLineup, bestLineupPoints, diffLineups } from "../lib/engine/optimizer.ts";
import { findTrades } from "../lib/engine/trades.ts";
import { restOfSeasonValue, sampleWeight } from "../lib/engine/value.ts";
import { protectionFor, rosterCapacity } from "../lib/engine/protect.ts";
import { suggestBid } from "../lib/engine/faab.ts";
import { calibrate, PRIORS } from "../lib/learning/calibrate.ts";
import { recordHealth, type Check } from "../lib/util/health.ts";
import fs from "node:fs";
import path from "node:path";
import { recordPredictions, readJournal, type PredictionRecord } from "../lib/learning/journal.ts";
import { dropImpact } from "../lib/engine/depth.ts";
import { replacementLevels, vorp, vorpForRoster } from "../lib/engine/vorp.ts";
import { playerSigma, winProbability, normalCdf } from "../lib/engine/variance.ts";
import { SLOT, SLOT_LABEL } from "../lib/espn/constants.ts";
import type { RawLeague, RawPlayer } from "../lib/espn/types.ts";
import type { GameInfo } from "../lib/projections/schedule.ts";

const WEEK = 5;
let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? `\n    ${detail}` : ""}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------- fixtures
type Spec = {
  id: number; name: string; pos: number; team: number; slot: number;
  proj: number; inj?: string; eligible?: number[];
};

const ELIG: Record<number, number[]> = {
  1: [SLOT.QB, SLOT.BENCH],
  2: [SLOT.RB, SLOT.RB_WR, SLOT.FLEX, SLOT.BENCH],
  3: [SLOT.WR, SLOT.RB_WR, SLOT.WR_TE, SLOT.FLEX, SLOT.BENCH],
  4: [SLOT.TE, SLOT.WR_TE, SLOT.FLEX, SLOT.BENCH],
  5: [SLOT.K, SLOT.BENCH],
  16: [SLOT.DST, SLOT.BENCH],
};

function player(s: Spec): RawPlayer {
  return {
    id: s.id,
    fullName: s.name,
    defaultPositionId: s.pos,
    eligibleSlots: s.eligible ?? ELIG[s.pos],
    proTeamId: s.team,
    injuryStatus: s.inj ?? "ACTIVE",
    ownership: { percentOwned: 50, percentChange: 0 },
    stats: [
      { scoringPeriodId: WEEK, statSourceId: 1, statSplitTypeId: 1, appliedTotal: s.proj },
      { scoringPeriodId: WEEK - 1, statSourceId: 0, statSplitTypeId: 1, appliedTotal: s.proj },
    ],
  };
}

// proTeamId: 12=KC, 9=GB, 25=SF, 21=PHI, 3=CHI(bye), 6=DAL(locked, already played)
const MY: Spec[] = [
  { id: 1, name: "Star QB", pos: 1, team: 12, slot: SLOT.QB, proj: 22 },
  { id: 2, name: "Bye RB", pos: 2, team: 3, slot: SLOT.RB, proj: 15 },          // on bye, starting
  { id: 3, name: "Good RB", pos: 2, team: 9, slot: SLOT.BENCH, proj: 14 },      // should come in
  { id: 4, name: "Out WR", pos: 3, team: 25, slot: SLOT.WR, proj: 13, inj: "OUT" },
  { id: 5, name: "Fine WR", pos: 3, team: 21, slot: SLOT.WR, proj: 11 },
  { id: 6, name: "Bench WR", pos: 3, team: 9, slot: SLOT.BENCH, proj: 12 },     // should come in
  { id: 7, name: "Locked TE", pos: 4, team: 6, slot: SLOT.TE, proj: 3 },        // played already, immovable
  { id: 8, name: "Better TE", pos: 4, team: 21, slot: SLOT.BENCH, proj: 10 },   // cannot replace locked TE
  { id: 9, name: "Flex WR", pos: 3, team: 12, slot: SLOT.FLEX, proj: 9 },
  { id: 10, name: "Kicker", pos: 5, team: 21, slot: SLOT.K, proj: 8 },
  { id: 11, name: "Defense", pos: 16, team: 25, slot: SLOT.DST, proj: 7 },
  { id: 12, name: "Scrub RB", pos: 2, team: 21, slot: SLOT.BENCH, proj: 2 },
];

const THEIRS: Spec[] = [
  { id: 20, name: "Elite RB", pos: 2, team: 9, slot: SLOT.RB, proj: 20 },
  { id: 21, name: "Their RB2", pos: 2, team: 21, slot: SLOT.RB, proj: 16 },
  { id: 22, name: "Their RB3", pos: 2, team: 12, slot: SLOT.FLEX, proj: 14 },
  { id: 23, name: "Weak WR", pos: 3, team: 25, slot: SLOT.WR, proj: 5 },
  { id: 24, name: "Weak WR2", pos: 3, team: 9, slot: SLOT.WR, proj: 4 },
  { id: 25, name: "Their QB", pos: 1, team: 21, slot: SLOT.QB, proj: 18 },
  { id: 26, name: "Their TE", pos: 4, team: 12, slot: SLOT.TE, proj: 9 },
  { id: 27, name: "Their K", pos: 5, team: 9, slot: SLOT.K, proj: 8 },
  { id: 28, name: "Their D", pos: 16, team: 21, slot: SLOT.DST, proj: 7 },
  // Stranded on their bench: their FLEX is already full, so he is pure surplus.
  { id: 29, name: "Their RB4", pos: 2, team: 9, slot: SLOT.BENCH, proj: 13 },
];

const raw: RawLeague = {
  id: 999, seasonId: 2026, scoringPeriodId: WEEK,
  settings: {
    name: "Self Test League",
    scoringSettings: { scoringType: "PPR" },
    rosterSettings: {
      lineupSlotCounts: {
        [SLOT.QB]: 1, [SLOT.RB]: 2, [SLOT.WR]: 2, [SLOT.TE]: 1,
        [SLOT.FLEX]: 1, [SLOT.K]: 1, [SLOT.DST]: 1, [SLOT.BENCH]: 6, [SLOT.IR]: 1,
      } as Record<string, number>,
    },
  },
  teams: [
    { id: 1, name: "My Team", record: { overall: { wins: 3, losses: 1, ties: 0, pointsFor: 400 } },
      roster: { entries: MY.map((s) => ({ playerId: s.id, lineupSlotId: s.slot, playerPoolEntry: { player: player(s) } })) } },
    { id: 2, name: "Trade Partner", record: { overall: { wins: 2, losses: 2, ties: 0, pointsFor: 380 } },
      roster: { entries: THEIRS.map((s) => ({ playerId: s.id, lineupSlotId: s.slot, playerPoolEntry: { player: player(s) } })) } },
  ],
};

// Schedule: CHI absent (bye), DAL already kicked off.
const g = (team: string, opp: string, started: boolean, total: number): GameInfo => ({
  team, opponent: opp, homeAway: "home", impliedTotal: total, spread: -1,
  kickoff: "2026-10-05T17:00:00Z", started,
});
const games = new Map<string, GameInfo>([
  ["KC", g("KC", "DEN", false, 26)], ["DEN", g("DEN", "KC", false, 20)],
  ["GB", g("GB", "MIN", false, 24)], ["MIN", g("MIN", "GB", false, 22)],
  ["SF", g("SF", "SEA", false, 25)], ["SEA", g("SEA", "SF", false, 21)],
  ["PHI", g("PHI", "NYG", false, 27)], ["NYG", g("NYG", "PHI", false, 18)],
  ["DAL", g("DAL", "WSH", true, 23)], ["WSH", g("WSH", "DAL", true, 22)],
]);

const ctx: ProjectionContext = {
  // Fixed tuning so the engine tests do not drift as the model calibrates.
  tuning: { expertWeight: 0.55, vegasStrength: 0.35, positionBias: {}, source: "test" },
  schedule: { week: WEEK, games, onBye: new Set(["CHI"]), ok: true },
  fantasyPros: { source: "test", ok: false, ranks: new Map() },
  sleeper: { source: "test", ok: false, ranks: new Map() },
  scoring: "PPR",
  notes: [],
};

// ---------------------------------------------------------------- run
const league = normalizeLeague(raw, "999", 1, WEEK);
const me = league.teams.find((t) => t.id === 1)!;
const verdicts = evaluate(league.teams.flatMap((t) => t.roster), ctx);
const result = optimizeLineup(league, me, verdicts);

console.log("\n\x1b[1mEngine self-test\x1b[0m\n");

check("League normalizes", league.teams.length === 2 && me.roster.length === 12);

// ESPN echoes back whatever scoringPeriodId was requested, so a league fetched
// for a past week still reports that week in `scoringPeriodId`. Only
// `status.latestScoringPeriod` says where the season really is. When these were
// the same field, "is this week over?" was always false — nothing was ever
// graded and the scorecard called finished weeks "in progress" forever.
{
  const past = normalizeLeague(
    { ...raw, scoringPeriodId: WEEK - 2, status: { latestScoringPeriod: WEEK } },
    "999", 1, WEEK - 2,
  );
  check("Past week is told apart from the current one",
    past.week === WEEK - 2 && past.currentWeek === WEEK && past.week < past.currentWeek,
    `week=${past.week} currentWeek=${past.currentWeek}`);

  const now = normalizeLeague({ ...raw, status: { latestScoringPeriod: WEEK } }, "999", 1, WEEK);
  check("Current week is not treated as settled", !(now.week < now.currentWeek),
    `week=${now.week} currentWeek=${now.currentWeek}`);

  // No mStatus in the payload must not fabricate a settled week.
  check("Unknown current week withholds a verdict", !(league.week < league.currentWeek),
    `week=${league.week} currentWeek=${league.currentWeek}`);
}
check("Bye week detected", verdicts.get(2)!.onBye && verdicts.get(2)!.points === 0,
  `Bye RB points=${verdicts.get(2)!.points}`);
check("OUT player zeroed", verdicts.get(4)!.points === 0 && verdicts.get(4)!.unplayable);
check("Kickoff lock detected", verdicts.get(7)!.locked === true);
check("Vegas line moves projection", verdicts.get(1)!.points !== 22,
  `Star QB 22.0 -> ${verdicts.get(1)!.points} (26-pt implied total)`);

const startingIds = new Set(result.optimal.map((s) => s.player?.id));
check("Bye player benched", !startingIds.has(2));
check("OUT player benched", !startingIds.has(4));
check("Bench RB promoted", startingIds.has(3));
check("Bench WR promoted", startingIds.has(6));

const lockedSlot = result.optimal.find((s) => s.slotLabel === "TE");
check("Locked starter left untouched", lockedSlot?.player?.id === 7,
  `TE slot holds ${lockedSlot?.player?.name} (must stay: game already started)`);
check("No move targets a locked player", !result.moves.some((m) => m.playerId === 7));

check("Lineup improves", result.gain > 0, `+${result.gain} pts`);
check("Every move is a real slot change", result.moves.every((m) => m.fromSlot !== m.toSlot));

const movedIds = result.moves.map((m) => m.playerId);
check("No duplicate moves", new Set(movedIds).size === movedIds.length);

// Slot integrity: no slot may hold an ineligible player.
const badSlot = result.optimal.find(
  (s) => s.player && !s.player.eligibleSlots.includes(s.slotId),
);
check("All assignments respect slot eligibility", !badSlot,
  badSlot ? `${badSlot.player!.name} illegally in ${badSlot.slotLabel}` : "");

// Slot counts must match league settings exactly.
const counts: Record<number, number> = {};
result.optimal.forEach((s) => { counts[s.slotId] = (counts[s.slotId] ?? 0) + 1; });
const countsOk = Object.entries(league.lineupSlotCounts)
  .filter(([id]) => Number(id) !== SLOT.BENCH && Number(id) !== SLOT.IR)
  .every(([id, n]) => counts[Number(id)] === n);
check("Starting slot counts match league settings", countsOk);

const trades = findTrades(league, me, verdicts);
check("Trade finder produces mutually-positive offers",
  trades.length > 0 && trades.every((t) => t.myGain > 0 && t.theirGain > 0),
  trades[0] ? `top: give ${trades[0].give[0].name} / get ${trades[0].receive[0].name} (you +${trades[0].myGain}, them +${trades[0].theirGain})` : "none found");

// A locked starter's slot is spoken for. A free agent must not be credited with
// replacing a player whose game already kicked off.
{
  const eliteTe = { ...me.roster.find((p) => p.id === 8)!, id: 900, name: "FA Elite TE" };
  const v2 = new Map(verdicts);
  v2.set(900, { ...verdicts.get(8)!, player: eliteTe, points: 20, locked: false });

  const naive = bestLineupPoints(league, [...me.roster, eliteTe], v2)
              - bestLineupPoints(league, me.roster, v2);
  const honest = bestLineupPoints(league, [...me.roster, eliteTe], v2, { respectLocks: true })
               - bestLineupPoints(league, me.roster, v2, { respectLocks: true });

  check("Locked slots are not counted as upgradeable by a pickup",
    honest < naive,
    `ignoring locks claims +${naive.toFixed(1)}; respecting the locked TE gives +${honest.toFixed(1)}`);
}

check("bestLineupPoints is monotonic under adding a stud",
  bestLineupPoints(league, [...me.roster, league.teams[1].roster[0]], verdicts) >=
  bestLineupPoints(league, me.roster, verdicts));

// --- regression: one big game must not look like a season -------------------
{
  const outlier = { ...me.roster[0], id: 901, name: "One-Week Wonder", seasonAverage: 30, gamesPlayed: 1 };
  const proven = { ...me.roster[0], id: 902, name: "Proven Starter", seasonAverage: 16, gamesPlayed: 8 };
  const wk: Verdict = { ...verdicts.get(me.roster[0].id)!, points: 8 };

  const outlierVal = restOfSeasonValue(outlier, wk);
  const provenVal = restOfSeasonValue(proven, wk);

  check("1-game average is discounted vs an 8-game average",
    outlierVal < provenVal,
    `30 pts in 1 game -> ${outlierVal.toFixed(1)}/wk; 16 pts over 8 games -> ${provenVal.toFixed(1)}/wk`);
  check("Sample weight grows with games played",
    sampleWeight(1) < sampleWeight(8) && sampleWeight(1) < 0.3,
    `w(1)=${sampleWeight(1).toFixed(2)} w(8)=${sampleWeight(8).toFixed(2)}`);
}

// --- regression: never nominate an injured star as the drop -----------------
{
  const star = { ...me.roster[0], id: 903, name: "Injured Star", percentOwned: 95, seasonAverage: 18, gamesPlayed: 3 };
  const starV: Verdict = { ...verdicts.get(me.roster[0].id)!, points: 0, unplayable: true, expertRank: 12 };
  const scrub = { ...me.roster[0], id: 904, name: "Scrub", percentOwned: 4, seasonAverage: 2, gamesPlayed: 3 };
  const scrubV: Verdict = { ...verdicts.get(me.roster[0].id)!, points: 2, expertRank: 400 };

  check("Injured star is protected from being dropped",
    protectionFor(star, starV).protected,
    protectionFor(star, starV).reason);
  check("Replaceable player is not protected",
    !protectionFor(scrub, scrubV).protected);
}

// --- FAAB bid sizing --------------------------------------------------------
{
  const mk = (gain: number, rank?: number) =>
    ({ immediateGain: gain, trendingRank: rank } as Parameters<typeof suggestBid>[0]);
  const opts = { budgetRemaining: 100, minimumBid: 0, weeksLeft: 15 };

  const stud = suggestBid(mk(8), opts);
  const starter = suggestBid(mk(4), opts);
  const flier = suggestBid(mk(1.5), opts);
  const junk = suggestBid(mk(0.2), opts);

  check("Bids scale with how much the player helps",
    stud.amount > starter.amount && starter.amount > flier.amount && flier.amount > junk.amount,
    `${stud.amount} > ${starter.amount} > ${flier.amount} > ${junk.amount} (of $100)`);
  check("A league-winning add is a real bid, not a token",
    stud.amount >= 25 && stud.tier === "priority", `$${stud.amount} (${stud.tier})`);
  check("Bid never exceeds the remaining budget",
    suggestBid(mk(20), { budgetRemaining: 7, minimumBid: 1, weeksLeft: 2 }).amount <= 7);
  check("Late-season bids are more aggressive than early ones",
    suggestBid(mk(5), { ...opts, weeksLeft: 2 }).amount > suggestBid(mk(5), { ...opts, weeksLeft: 15 }).amount);
  check("Hyped players cost more",
    suggestBid(mk(4, 2), opts).amount > suggestBid(mk(4, 500), opts).amount);
  check("Broke teams fall back to the minimum",
    suggestBid(mk(9), { budgetRemaining: 0, minimumBid: 0, weeksLeft: 5 }).amount === 0);
}

// --- regression: a shallow league must still have a legal drop ---------------
// In a 6-team league only ~96 players are rostered anywhere, so every roster
// spot is 90%+ owned. An absolute ownership threshold locked the entire roster,
// left no drop candidate, and ESPN answered 409 on a full roster.
{
  const shallow = me.roster.map((p, i) => ({
    ...p, percentOwned: 95, seasonAverage: 14 - i * 0.1, gamesPlayed: 2,
  }));
  const v2 = new Map(verdicts);
  shallow.forEach((p, i) => v2.set(p.id, { ...verdicts.get(p.id)!, expertRank: 45 + i }));

  const droppable = shallow.filter(
    (p) => !protectionFor(p, v2.get(p.id), { roster: shallow, verdicts: v2 }).protected,
  );
  check("A roster of highly-owned players still has legal drops",
    droppable.length >= 3,
    `${droppable.length} of ${shallow.length} droppable (was 0 before the fix)`);

  const elite = { ...shallow[0], id: 950, name: "Elite Star" };
  const eliteV: Verdict = { ...verdicts.get(shallow[0].id)!, expertRank: 4, unplayable: true, points: 0 };
  check("A top-40 player stays protected even when hurt",
    protectionFor(elite, eliteV, { roster: [...shallow, elite], verdicts: v2 }).protected);

  check("Roster capacity is derived from the league's own slots",
    rosterCapacity(league.lineupSlotCounts) === 16,
    `capacity ${rosterCapacity(league.lineupSlotCounts)}`);
}

// --- a drop costs more than the player's own points -------------------------
{
  const kicker = me.roster.find((p) => p.position === "K")!;
  const spareWr = me.roster.filter((p) => p.position === "WR");

  const kickerImpact = await dropImpact(league, me.roster, kicker, 2);
  check("Dropping your only kicker is penalised",
    kickerImpact.penalty >= 6 && kickerImpact.warnings.some((w) => /last K/.test(w)),
    `penalty ${kickerImpact.penalty}: ${kickerImpact.warnings.join("; ")}`);

  if (spareWr.length >= 3) {
    const depthWr = spareWr[spareWr.length - 1];
    const wrImpact = await dropImpact(league, me.roster, depthWr, 2);
    check("Dropping a spare receiver is not penalised the same way",
      wrImpact.penalty < kickerImpact.penalty,
      `${depthWr.name} penalty ${wrImpact.penalty} vs kicker ${kickerImpact.penalty}`);
  }
}

// --- positional value -------------------------------------------------------
{
  const levels = replacementLevels(league, verdicts);
  check("Replacement level is computed per position",
    Object.keys(levels).length >= 4 && (levels.QB ?? 0) > 0,
    Object.entries(levels).map(([k, v]) => `${k}=${v}`).join(" "));

  // QBs score more in raw points but replacement QB is also high, so raw points
  // across positions is the wrong comparison.
  const qb = me.roster.find((p) => p.position === "QB")!;
  const te = me.roster.find((p) => p.position === "TE")!;
  const qbRaw = verdicts.get(qb.id)?.points ?? 0;
  const teRaw = verdicts.get(te.id)?.points ?? 0;
  check("VORP is not just raw points",
    Math.abs(vorp(qb, verdicts.get(qb.id), levels) - qbRaw) > 0.5 ||
    Math.abs(vorp(te, verdicts.get(te.id), levels) - teRaw) > 0.5);

  // A backup QB behind a starter cannot crack the lineup, so he is worth a
  // fraction of his abstract value to THIS roster.
  const backupQb = { ...qb, id: 960, name: "Backup QB" };
  const v2 = new Map(verdicts);
  v2.set(960, { ...verdicts.get(qb.id)!, player: backupQb, points: (verdicts.get(qb.id)?.points ?? 0) - 2 });
  const rosterWithTwo = [...me.roster, backupQb];
  const abstract = vorp(backupQb, v2.get(960), levels);
  const toMe = vorpForRoster(league, rosterWithTwo, backupQb, v2, levels);
  check("A blocked backup QB is worth less to a roster than his raw VORP",
    toMe < abstract,
    `abstract ${abstract} vs to-this-roster ${toMe}`);
}

// --- win probability --------------------------------------------------------
{
  check("Normal CDF is calibrated", Math.abs(normalCdf(0) - 0.5) < 0.001 && normalCdf(1.96) > 0.97);
  check("Even projections give a coin flip",
    Math.abs(winProbability(100, 20, 100, 20) - 0.5) < 0.01);
  check("A big favourite wins more often than a small one",
    winProbability(120, 20, 100, 20) > winProbability(105, 20, 100, 20));

  // The whole point of the leverage strategy: variance helps the underdog.
  const tight = winProbability(90, 10, 110, 10);
  const wild = winProbability(90, 30, 110, 10);
  check("Extra variance raises an underdog's odds",
    wild > tight, `steady ${(tight * 100).toFixed(1)}% vs volatile ${(wild * 100).toFixed(1)}%`);

  // ...and costs the favourite.
  const safeFav = winProbability(110, 10, 90, 10);
  const wildFav = winProbability(110, 30, 90, 10);
  check("Extra variance lowers a favourite's odds",
    wildFav < safeFav, `steady ${(safeFav * 100).toFixed(1)}% vs volatile ${(wildFav * 100).toFixed(1)}%`);

  const qb = me.roster.find((p) => p.position === "QB")!;
  const te = me.roster.find((p) => p.position === "TE")!;
  check("Tight ends are modelled as more volatile than quarterbacks",
    playerSigma(te, verdicts.get(te.id)) / Math.max(verdicts.get(te.id)?.points ?? 1, 1) >
    playerSigma(qb, verdicts.get(qb.id)) / Math.max(verdicts.get(qb.id)?.points ?? 1, 1));
}

// --- regression: interchangeable slots are not a change ---------------------
// This bug shipped twice: diffing lineups by slot index reports a phantom swap
// when a player slides between two identical WR slots, which put players who
// never moved into both the rationale and the graded decision log.
{
  const wrSlots = result.optimal.filter((a) => a.slotLabel === "WR" && a.player);
  if (wrSlots.length >= 2) {
    const swapped = result.optimal.map((a) => ({ ...a }));
    const i = result.optimal.indexOf(wrSlots[0]);
    const j = result.optimal.indexOf(wrSlots[1]);
    swapped[i] = { ...wrSlots[1] };
    swapped[j] = { ...wrSlots[0] };

    const changes = diffLineups(result.optimal, swapped, verdicts);
    check("Shuffling players between identical slots is not reported as a change",
      changes.length === 0,
      `reported ${changes.length} change(s): ${changes.map((c) => `${c.in?.player?.name ?? "-"} over ${c.out?.player?.name ?? "-"}`).join(", ")}`);
  }

  // A genuine change is still reported, paired correctly.
  const real = diffLineups(result.current, result.optimal, verdicts);
  const paired = real.filter((c) => c.in?.player && c.out?.player);
  check("Genuine swaps are paired in-for-out",
    paired.length > 0 && paired.every((c) => c.in!.player!.id !== c.out!.player!.id),
    paired.map((c) => `${c.in!.player!.name} over ${c.out!.player!.name}`).join("; "));
}

// --- the learning loop actually learns --------------------------------------
// Proven here on data with a known answer, so a broken fit shows up now rather
// than silently mis-tuning the model weeks into the season.
{
  const mk = (i: number, o: Partial<PredictionRecord> = {}): PredictionRecord => ({
    season: 2026, week: 1 + (i % 6), leagueId: "test", playerId: i,
    name: `P${i}`, position: "RB", espn: 10, expert: 10, blended: 10,
    vegasMult: 1, confidence: 0.8, actual: 10, ...o,
  });

  // Case 1: the experts are right every time and ESPN is consistently off.
  const expertsRight = Array.from({ length: 600 }, (_, i) => {
    const truth = 8 + (i % 13);
    return mk(i, { espn: truth - 6, expert: truth, blended: truth - 3, actual: truth });
  });
  const c1 = calibrate(60, expertsRight);
  check("Learns to trust the expert consensus when it is the accurate source",
    c1.expertWeight > PRIORS.expertWeight,
    `weight ${PRIORS.expertWeight} -> ${c1.expertWeight}`);

  // Case 2: ESPN is right and the experts are consistently off.
  const espnRight = Array.from({ length: 600 }, (_, i) => {
    const truth = 8 + (i % 13);
    return mk(i, { espn: truth, expert: truth + 6, blended: truth + 3, actual: truth });
  });
  const c2 = calibrate(60, espnRight);
  check("Learns to distrust the experts when ESPN is the accurate source",
    c2.expertWeight < PRIORS.expertWeight,
    `weight ${PRIORS.expertWeight} -> ${c2.expertWeight}`);

  // Case 3: one position is systematically over-projected.
  const teHigh = Array.from({ length: 400 }, (_, i) =>
    mk(i, { position: "TE", blended: 12, espn: 12, expert: 12, actual: 9 }));
  const c3 = calibrate(60, teHigh);
  check("Detects a position that is systematically over-projected",
    (c3.positionBias.TE ?? 1) < 0.98,
    `TE bias ${c3.positionBias.TE?.toFixed(3)} (actual/projected was 0.75)`);

  // Case 4: a handful of rows must NOT move the model.
  const tiny = Array.from({ length: 8 }, (_, i) =>
    mk(i, { espn: 2, expert: 20, blended: 11, actual: 20 }));
  const c4 = calibrate(60, tiny);
  check("Refuses to rewrite itself on a tiny sample",
    Math.abs(c4.expertWeight - PRIORS.expertWeight) < 0.05,
    `weight stayed ${c4.expertWeight} on ${tiny.length} rows`);

  // Case 5: calibration should reduce error on weeks it was not fitted to.
  check("Calibration reduces projection error",
    c1.calibratedMae < c1.baselineMae,
    `MAE ${c1.baselineMae.toFixed(2)} -> ${c1.calibratedMae.toFixed(2)}`);

  // Case 6: a signal that reverses week to week is noise, and a fit on it is
  // worse than no fit at all. Plenty of rows and plenty of weeks, so sample-size
  // shrinkage alone will not catch it — only scoring the fit on a week it never
  // saw does. This is the failure the loop exists to prevent: shipping weights
  // that quietly make next week's projections worse.
  const flipFlop = Array.from({ length: 600 }, (_, i) => {
    const week = 1 + (i % 6);
    return mk(i, { week, espn: 10, expert: 10, blended: 10, actual: week % 2 === 0 ? 12.5 : 7.5 });
  });
  const c6 = calibrate(60, flipFlop);
  check("Discards a fit that does not beat the defaults out of sample",
    Math.abs(c6.expertWeight - PRIORS.expertWeight) < 1e-9 &&
      Object.keys(c6.positionBias).length === 0 &&
      c6.calibratedMae >= c6.baselineMae,
    `weight ${c6.expertWeight}, bias ${JSON.stringify(c6.positionBias)}, ` +
      `held-out MAE ${c6.baselineMae.toFixed(2)} -> ${c6.calibratedMae.toFixed(2)}`);
  check("...and says so rather than failing quietly",
    c6.notes.some((n) => /did no better than the defaults/.test(n)),
    c6.notes[0] ?? "(no notes)");
}

// --- a prediction is frozen at that player's kickoff ------------------------
// The journal used to replace a league-week's whole snapshot on every run, so
// the surviving rows came from the Monday pass — after most of the slate had
// been played, from expert ranks and an injury report that had already seen the
// result. The merge below is what makes a recorded prediction a prediction.
{
  const journalFile = path.join(process.cwd(), "data", "journal.json");
  const saved = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8") : null;
  try {
    fs.writeFileSync(journalFile, "[]");

    const row = (playerId: number, o: Partial<PredictionRecord> = {}): PredictionRecord => ({
      season: 2026, week: 7, leagueId: "L1", playerId, name: `P${playerId}`,
      position: "WR", espn: 10, blended: 10, vegasMult: 1.08, confidence: 0.8, ...o,
    });

    // Another league-week that must survive untouched.
    recordPredictions([row(99, { week: 6, leagueId: "L2", blended: 1.5 })]);

    // Thursday: everyone is ahead of his kickoff.
    recordPredictions([row(1, { blended: 11 }), row(2, { blended: 12 }), row(3, { blended: 13 })]);

    // Sunday morning: player 1 has played, so the caller does not pass him.
    // Player 2 is still to play and his number has moved.
    recordPredictions([row(2, { blended: 20, vegasMult: 1.01 }), row(3, { blended: 13 })]);

    const after = readJournal();
    const find = (id: number, week = 7, leagueId = "L1") =>
      after.find((r) => r.playerId === id && r.week === week && r.leagueId === leagueId);

    check("A locked player keeps the projection recorded before his kickoff",
      find(1)?.blended === 11,
      `blended=${find(1)?.blended} (expected 11, the pre-kickoff number)`);
    check("A player still to play has his projection updated",
      find(2)?.blended === 20 && find(2)?.vegasMult === 1.01,
      `blended=${find(2)?.blended} vegasMult=${find(2)?.vegasMult}`);
    check("Merging does not duplicate a player within a league-week",
      after.filter((r) => r.playerId === 2 && r.week === 7).length === 1,
      `${after.filter((r) => r.playerId === 2 && r.week === 7).length} row(s) for player 2`);
    check("Another league-week is left alone",
      find(99, 6, "L2")?.blended === 1.5 && after.length === 4,
      `${after.length} rows total (expected 4)`);

    // A graded row is history. Overwriting it would quietly replace a known
    // outcome with a fresh projection and flatter every accuracy number after.
    const settledJournal: PredictionRecord[] = [row(5, { blended: 9, actual: 21 })];
    fs.writeFileSync(journalFile, JSON.stringify(settledJournal));
    recordPredictions([row(5, { blended: 30 })]);
    const graded = readJournal().find((r) => r.playerId === 5);
    check("A graded prediction is never overwritten",
      graded?.actual === 21 && graded?.blended === 9,
      `blended=${graded?.blended} actual=${graded?.actual}`);
  } finally {
    if (saved !== null) fs.writeFileSync(journalFile, saved);
    else fs.rmSync(journalFile, { force: true });
  }
}

// --- alerting fires once, not every run -------------------------------------
// The point of alerting is that you act on it. An alert that repeats every run
// gets ignored, and one that never repeats after recovery leaves you thinking
// something is still broken. Both behaviours are pinned here.
{
  process.env.FFCC_NO_NOTIFY = "1";
  const healthFile = path.join(process.cwd(), "data", "health.json");
  const backup = fs.existsSync(healthFile) ? fs.readFileSync(healthFile, "utf8") : null;
  try {
    fs.rmSync(healthFile, { force: true });
    const down = (): Check[] => [
      { subsystem: "fantasypros", ok: false, detail: "scrape failed", severity: "degraded" },
    ];
    const up = (): Check[] => [
      { subsystem: "fantasypros", ok: true, detail: "ok", severity: "degraded" },
    ];

    const r1 = await recordHealth(down());
    check("A single blip does not raise an alert",
      r1.alerts.length === 0, "degraded sources need 2 consecutive failures");

    const r2 = await recordHealth(down());
    check("A sustained outage raises exactly one alert",
      r2.alerts.length === 1, r2.alerts[0] ?? "(none)");

    const r3 = await recordHealth(down());
    check("A continuing outage does not alert again",
      r3.alerts.length === 0, "no repeat while still down");

    const r4 = await recordHealth(up());
    check("Recovery is reported",
      r4.recovered.length === 1, r4.recovered[0] ?? "(none)");

    const r5 = await recordHealth(up());
    check("A healthy system stays quiet",
      r5.alerts.length === 0 && r5.recovered.length === 0);

    // Critical subsystems must not wait for a second failure.
    fs.rmSync(healthFile, { force: true });
    const crit = await recordHealth([
      { subsystem: "espn-auth", ok: false, detail: "login expired", severity: "critical" },
    ]);
    check("A critical failure alerts immediately",
      crit.alerts.length === 1, crit.alerts[0] ?? "(none)");
  } finally {
    if (backup !== null) fs.writeFileSync(healthFile, backup);
    else fs.rmSync(healthFile, { force: true });
    delete process.env.FFCC_NO_NOTIFY;
  }
}

console.log("\n\x1b[1mOptimal lineup\x1b[0m");
result.optimal.forEach((s) =>
  console.log(`  ${(SLOT_LABEL[s.slotId] ?? "").padEnd(5)} ${(s.player?.name ?? "—").padEnd(12)} ${(s.verdict?.points ?? 0).toFixed(1).padStart(5)}${s.locked ? "  \x1b[36m(locked)\x1b[0m" : ""}`));
console.log(`\n  ${result.currentProjected.toFixed(1)} → ${result.optimalProjected.toFixed(1)} (+${result.gain.toFixed(1)})`);

console.log("\n\x1b[1mMoves ESPN would receive\x1b[0m");
result.moves.forEach((m) =>
  console.log(`  ${m.playerName.padEnd(12)} ${SLOT_LABEL[m.fromSlot]} → ${SLOT_LABEL[m.toSlot]}`));
result.warnings.forEach((w) => console.log(`  \x1b[33m! ${w}\x1b[0m`));

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m\n` : `\n\x1b[32mAll checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
