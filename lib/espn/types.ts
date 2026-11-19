export type RawStat = {
  scoringPeriodId: number;
  statSourceId: number;   // 0 actual, 1 projected
  statSplitTypeId: number;
  appliedTotal?: number;
  stats?: Record<string, number>;
};

export type RawPlayer = {
  id: number;
  fullName: string;
  firstName?: string;
  lastName?: string;
  defaultPositionId: number;
  eligibleSlots: number[];
  proTeamId: number;
  injuryStatus?: string;
  injured?: boolean;
  stats?: RawStat[];
  ownership?: { percentOwned?: number; percentChange?: number; percentStarted?: number };
};

export type RawPoolEntry = {
  id?: number;
  player: RawPlayer;
  /** "FREEAGENT" | "WAIVERS" | "ONTEAM" — decides which transaction type to send. */
  status?: string;
  onTeamId?: number;
  waiverProcessDate?: number;
};

export type RawRosterEntry = {
  playerId: number;
  lineupSlotId: number;
  acquisitionType?: string;
  playerPoolEntry: { player: RawPlayer; ratings?: unknown; onTeamId?: number };
};

export type RawTeam = {
  id: number;
  name?: string;
  location?: string;
  nickname?: string;
  abbrev?: string;
  owners?: string[];
  waiverRank?: number;
  transactionCounter?: { acquisitionBudgetSpent?: number; acquisitions?: number };
  roster?: { entries: RawRosterEntry[] };
  record?: { overall?: { wins: number; losses: number; ties: number; pointsFor: number } };
};

export type RawLeague = {
  id: number;
  seasonId: number;
  scoringPeriodId: number;
  settings?: {
    name?: string;
    acquisitionSettings?: {
      acquisitionType?: string;
      isUsingAcquisitionBudget?: boolean;
      acquisitionBudget?: number;
      minimumBid?: number;
    };
    rosterSettings?: { lineupSlotCounts?: Record<string, number> };
    scoringSettings?: { scoringType?: string; scoringItems?: unknown[] };
    scheduleSettings?: {
      matchupPeriodCount?: number;
      playoffTeamCount?: number;
      playoffSeedingRule?: string;
    };
  };
  teams?: RawTeam[];
  schedule?: RawMatchup[];
  status?: { currentMatchupPeriod?: number; latestScoringPeriod?: number; finalScoringPeriod?: number };
};

export type RawMatchup = {
  matchupPeriodId: number;
  home?: { teamId: number; totalPoints?: number };
  away?: { teamId: number; totalPoints?: number };
  winner?: string;
};

/** Our normalized player shape — everything downstream uses this, never RawPlayer. */
export type Player = {
  id: number;
  name: string;
  position: string;
  positionId: number;
  team: string;
  proTeamId: number;
  eligibleSlots: number[];
  lineupSlotId: number;
  injuryStatus: string;
  percentOwned: number;
  percentChange: number;
  /** "FREEAGENT" adds immediately; "WAIVERS" must go through a claim. */
  acquisitionStatus: "FREEAGENT" | "WAIVERS" | "ONTEAM";
  waiverProcessDate?: number;
  /** ESPN's own weekly projection — one input to the blend, never the last word. */
  espnProjection: number;
  actualPoints: number;
  seasonAverage: number;
  /** Games behind seasonAverage. In week 2 this is 1, and a 1-game average is noise. */
  gamesPlayed: number;
  byeWeek?: number;
};

export type Team = {
  id: number;
  name: string;
  abbrev: string;
  wins: number;
  losses: number;
  pointsFor: number;
  /** FAAB spent so far; remaining budget is the league budget minus this. */
  budgetSpent: number;
  /** Rolling-priority position in non-FAAB leagues (1 = first claim). */
  waiverRank?: number;
  roster: Player[];
};

export type Matchup = {
  period: number;
  homeTeamId: number;
  awayTeamId: number;
  homePoints: number;
  awayPoints: number;
  /** "HOME" | "AWAY" | "UNDECIDED" */
  winner: string;
  played: boolean;
};

export type PlayoffSettings = {
  teams: number;
  regularSeasonPeriods: number;
};

export type WaiverSettings = {
  /** FAAB leagues need a bid; rolling-priority leagues must send 0. */
  usesFaab: boolean;
  budget: number;
  minimumBid: number;
  acquisitionType: string;
};

export type League = {
  id: string;
  name: string;
  season: number;
  /** The scoring period this payload describes — the one that was requested. */
  week: number;
  /**
   * The scoring period the league itself is currently on.
   *
   * Distinct from `week` on purpose: ESPN echoes back whatever
   * `scoringPeriodId` was asked for, so `week` cannot answer "is that week
   * over?". Only this field can.
   */
  currentWeek: number;
  scoringType: string;
  lineupSlotCounts: Record<number, number>;
  waivers: WaiverSettings;
  schedule: Matchup[];
  playoffs: PlayoffSettings;
  teams: Team[];
  myTeamId: number;
};
