import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = process.env.VERCEL ? path.join(os.tmpdir(), "ffcc") : path.join(process.cwd(), "data");
const FILE = path.join(DIR, "journal.json");

/**
 * One prediction, recorded before the games are played.
 *
 * Calibration is only honest if the prediction is written down BEFORE the
 * outcome is known. Recomputing a projection after the fact would silently use
 * updated inputs and make the model look better than it was.
 */
export type PredictionRecord = {
  season: number;
  week: number;
  leagueId: string;
  playerId: number;
  name: string;
  position: string;
  /** Component inputs, so weights can be refit later. */
  espn: number;
  expert?: number;
  /** The blended number we actually acted on. */
  blended: number;
  /** Multiplier the betting line contributed, 1 = none. */
  vegasMult: number;
  confidence: number;
  /** Filled in later, once the week is settled. */
  actual?: number;
};

export type Journal = PredictionRecord[];

export function readJournal(): Journal {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Journal;
  } catch {
    return [];
  }
}

function writeJournal(j: Journal) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    // Two seasons of every rostered player is plenty of history to fit on.
    fs.writeFileSync(FILE, JSON.stringify(j.slice(-40000)));
  } catch {
    // Journalling is a nicety; it must never break a lineup run.
  }
}

/**
 * Records this week's predictions, merged per player.
 *
 * A lineup runs several times a week, and each run sees a player either before
 * his kickoff or after it. Replacing the whole league-week on every run meant
 * the LAST run of the week won — the Monday pass, by which point most of the
 * slate had been played. Those rows were written as predictions but computed
 * from post-game expert ranks, a settled injury report and a betting line that
 * no longer existed, and players ruled out in the meantime dropped out of the
 * sample altogether. The journal graded itself generously and the betting
 * weight could never be fitted at all, because a finished game carries no line.
 *
 * So each player is merged on his own: his row is updated while his game is
 * still ahead of him, and frozen as soon as it is not. The caller does not pass
 * locked players, so "absent from this batch" means "already frozen" and his
 * existing row is kept. What survives is the last projection taken before that
 * player's own kickoff — the number the lineup actually acted on.
 */
export function recordPredictions(rows: PredictionRecord[]) {
  if (!rows.length) return;
  const { season, week, leagueId } = rows[0];
  const existing = readJournal();

  const sameWeek = (r: PredictionRecord) =>
    r.season === season && r.week === week && r.leagueId === leagueId;

  const byPlayer = new Map<number, PredictionRecord>();
  for (const r of existing.filter(sameWeek)) byPlayer.set(r.playerId, r);

  for (const row of rows) {
    // A graded row is history; never overwrite an outcome we already know.
    if (byPlayer.get(row.playerId)?.actual !== undefined) continue;
    byPlayer.set(row.playerId, row);
  }

  writeJournal([...existing.filter((r) => !sameWeek(r)), ...byPlayer.values()]);
}

/** Fills in what actually happened for a settled week. */
export function settleWeek(
  season: number,
  week: number,
  leagueId: string,
  actuals: Map<number, number>,
): number {
  const j = readJournal();
  let filled = 0;
  for (const r of j) {
    if (r.season !== season || r.week !== week || r.leagueId !== leagueId) continue;
    if (r.actual !== undefined) continue;
    const a = actuals.get(r.playerId);
    if (a === undefined) continue;
    r.actual = a;
    filled++;
  }
  if (filled) writeJournal(j);
  return filled;
}

/** Rows with a known outcome — the only ones worth fitting on. */
export function settledRows(journal: Journal = readJournal()): PredictionRecord[] {
  return journal.filter((r) => r.actual !== undefined && r.espn > 0);
}
