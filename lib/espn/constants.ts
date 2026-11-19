// ESPN Fantasy Football domain constants.
// These IDs are stable across seasons and are what every ESPN payload speaks in.

export const SLOT = {
  QB: 0,
  TQB: 1,
  RB: 2,
  RB_WR: 3,
  WR: 4,
  WR_TE: 5,
  TE: 6,
  OP: 7,
  DT: 8,
  DE: 9,
  LB: 10,
  DL: 11,
  CB: 12,
  S: 13,
  DB: 14,
  DP: 15,
  DST: 16,
  K: 17,
  P: 18,
  HC: 19,
  BENCH: 20,
  IR: 21,
  FLEX: 23,
} as const;

export const SLOT_LABEL: Record<number, string> = {
  0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE",
  7: "OP", 8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB",
  15: "DP", 16: "D/ST", 17: "K", 18: "P", 19: "HC", 20: "BE", 21: "IR", 23: "FLEX",
};

/** Slots that hold a player who is not in your active lineup. */
export const NON_STARTING_SLOTS = new Set<number>([SLOT.BENCH, SLOT.IR]);

export const POSITION: Record<number, string> = {
  1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST",
};

export const PRO_TEAM: Record<number, string> = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA",
  16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT",
  24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX",
  33: "BAL", 34: "HOU",
};

/** Injury designations that make a player unstartable or high-risk. */
export const UNPLAYABLE_INJURY = new Set([
  "OUT", "INJURY_RESERVE", "SUSPENSION", "NON_FOOTBALL_INJURY", "DOUBTFUL",
]);
export const RISKY_INJURY = new Set(["QUESTIONABLE", "DOUBTFUL"]);

/** statSourceId in ESPN player stat entries. */
export const STAT_SOURCE = { ACTUAL: 0, PROJECTED: 1 } as const;

export const READ_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
export const WRITE_BASE = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl";
