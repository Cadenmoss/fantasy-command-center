import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = process.env.VERCEL ? path.join(os.tmpdir(), "ffcc") : path.join(process.cwd(), "data");
const FILE = path.join(DIR, "history.json");

export type DecisionRecord = {
  at: string;
  leagueId: string;
  leagueName: string;
  week: number;
  season: number;
  /** One entry per swap the optimizer made. */
  swaps: {
    slot: string;
    inId: number;
    inName: string;
    outId: number;
    outName: string;
    /** What we predicted the swap was worth when we made it. */
    projectedDelta: number;
    reason: string;
  }[];
};

export type ScoredSwap = DecisionRecord["swaps"][number] & {
  inActual: number | null;
  outActual: number | null;
  realizedDelta: number | null;
};

export type Scorecard = {
  league: string;
  week: number;
  swaps: ScoredSwap[];
  realizedTotal: number;
  projectedTotal: number;
  /** null while the week's games are still being played. */
  settled: boolean;
};

export function readHistory(): DecisionRecord[] {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as DecisionRecord[];
  } catch {
    return [];
  }
}

/**
 * Records what the auto-lineup actually changed, so its decisions can be graded
 * against real scores later. Without this the app can only ever claim it helped;
 * with it you can check.
 */
export function recordDecision(rec: DecisionRecord) {
  try {
    const all = readHistory();
    // One record per league-week: a later run supersedes an earlier one.
    const rest = all.filter((r) => !(r.leagueId === rec.leagueId && r.week === rec.week && r.season === rec.season));
    rest.push(rec);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(rest.slice(-200), null, 2));
  } catch {
    // History is a nicety; never let it break a lineup run.
  }
}
