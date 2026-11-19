export type StatusResp = {
  season: number;
  configured: boolean;
  problems: string[];
  leagues: { id: string; name: string; teamId: number; autoLineup: boolean }[];
  hasFantasyProsKey: boolean;
};

export type LeagueSummary =
  | {
      ok: true; id: string; name: string; label: string; week: number; autoLineup: boolean;
      record: string; teamName: string; gain: number; moveCount: number;
      currentProjected: number; optimalProjected: number;
      rationale: string[]; warnings: string[]; dataNotes: string[];
      topWaiver?: string; waiverCount: number; tradeCount: number;
    }
  | { ok: false; id: string; label: string; error: string };

export type SlotAssignment = {
  slotId: number; slotLabel: string; locked: boolean;
  player?: { id: number; name: string; position: string; team: string; injuryStatus: string };
  verdict?: Verdict;
};

export type Verdict = {
  points: number; espnPoints: number; expertPoints?: number; expertRank?: number;
  confidence: number; reasons: string[]; locked: boolean; onBye: boolean;
  unplayable: boolean; sources: string[];
};

export type LeagueDetail = {
  id: string; label: string; autoLineup: boolean;
  /** This league's goal is not finishing last: show last-place odds in place of title odds. */
  avoidLast: boolean;
  league: {
    name: string; week: number; season: number; scoring: string;
    waivers: { usesFaab: boolean; budget: number; minimumBid: number; acquisitionType: string };
  };
  myTeam: { id: number; name: string; wins: number; losses: number };
  lineup: {
    current: SlotAssignment[]; optimal: SlotAssignment[];
    moves: { playerId: number; playerName: string; fromSlot: number; toSlot: number }[];
    currentProjected: number; optimalProjected: number; gain: number;
    rationale: string[]; warnings: string[];
  };
  waivers: {
    player: {
      id: number; name: string; position: string; team: string; percentOwned: number;
      acquisitionStatus: "FREEAGENT" | "WAIVERS" | "ONTEAM";
    };
    verdict: Verdict; immediateGain: number; worthIt: boolean; score: number; trendingAdds?: number; trendingRank?: number;
    suggestedBid?: { amount: number; percentOfRemaining: number; tier: string; required: boolean; rationale: string };
    dropCandidate?: {
      player: { id: number; name: string; position: string };
      reason: string;
      impact?: { penalty: number; warnings: string[]; breaksBye: boolean };
    };
    reasons: string[];
  }[];
  trades: {
    partner: { id: number; name: string };
    give: { id: number; name: string; position: string; team: string }[];
    receive: { id: number; name: string; position: string; team: string }[];
    myGain: number; theirGain: number; fairness: number;
    likelihood: "likely" | "plausible" | "long shot"; rationale: string[];
  }[];
  byeRisks: ByeWeekRisk[];
  matchup: MatchupInfo | null;
  season: SeasonInfo | null;
  weaknesses: Weakness[];
  exploits: ExploitTrade[];
  roster: {
    id: number; name: string; position: string; team: string;
    lineupSlotId: number; injuryStatus: string; percentOwned: number;
  }[];
  rosterFull: boolean;
  myBudget: { spent: number; remaining: number; waiverRank?: number };
  dataNotes: string[];
  error?: string;
};

export type ByeWeekRisk = {
  week: number;
  out: { name: string; position: string; team: string; isStarter: boolean }[];
  unfillable: string[];
  thin: string[];
  severity: "critical" | "tight" | "fine";
  advice?: string;
};

export type IncomingOffer = {
  leagueId: string;
  leagueName: string;
  transactionId: string;
  fromTeam: string;
  youGive: { name: string; position: string; rosValue: number }[];
  youGet: { name: string; position: string; rosValue: number }[];
  netValue: number;
  recommendation: "accept" | "decline" | "close call";
  espnUrl: string;
};

export type ScoredSwap = {
  slot: string; inName: string; outName: string;
  projectedDelta: number;
  inActual: number | null; outActual: number | null; realizedDelta: number | null;
  reason: string;
};

export type Scorecard = {
  league: string; week: number; swaps: ScoredSwap[];
  realizedTotal: number; projectedTotal: number; settled: boolean;
};

export type MatchupInfo = {
  opponent: { id: number; name: string };
  winProbability: number;
  me: { mean: number; sigma: number };
  them: { mean: number; sigma: number };
  pointsFirst: { mean: number; sigma: number; winProbability: number };
  winFirst: { mean: number; sigma: number; winProbability: number };
  leverageMoves: {
    slot: string; inName: string; outName: string;
    pointsDelta: number; winProbDelta: number; reason: string;
  }[];
  advice: string;
};

export type PlayoffOdds = {
  teamId: number; name: string; isMe: boolean;
  makePlayoffs: number; winTitle: number; finishLast: number; topSeed: number;
  meanSeed: number; firstRoundBye: number;
  projectedWins: number; meanScore: number;
};

export type SeasonInfo = {
  me: PlayoffOdds;
  odds: PlayoffOdds[];
  simulations: number;
  weeksLeft: number;
  playoffSpots: number;
  everyoneQualifies: boolean;
  byeSeeds: number;
  thisWeekSwing: number;
  thisWeekLastSwing: number;
  objective: string;
};

export type Weakness = {
  team: { id: number; name: string };
  record: string;
  desperation: number;
  readAloud: string;
  holes: { slot: string; starter: string; points: number; gapToAverage: number }[];
};

export type ExploitTrade = {
  partner: { id: number; name: string };
  give: { id: number; name: string; position: string; team: string }[];
  receive: { id: number; name: string; position: string; team: string }[];
  theirLineupGain: number; myValueGain: number; myLineupGain: number;
  edge: number;
  likelihood: "likely" | "plausible" | "long shot";
  whyTheySayYes: string; whyItsGoodForMe: string; pitch: string;
};
