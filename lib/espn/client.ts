import { READ_BASE, WRITE_BASE, POSITION, PRO_TEAM, STAT_SOURCE, SLOT } from "./constants.ts";
import type {
  RawLeague, RawPlayer, RawPoolEntry, RawRosterEntry, RawTeam,
  Player, Team, League, WaiverSettings, Matchup, PlayoffSettings,
} from "./types.ts";
import { normalizeSwid } from "../config.ts";

export class EspnError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "EspnError";
    this.status = status;
    this.body = body;
  }
}

export type EspnAuth = { swid: string; espnS2: string };

/**
 * ESPN's fantasy endpoints reject requests that don't look like they came from
 * their own web client, so we mirror the headers the site itself sends.
 */
function headers(auth: EspnAuth, extra: Record<string, string> = {}) {
  return {
    Cookie: `SWID=${normalizeSwid(auth.swid)}; espn_s2=${auth.espnS2}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Fantasy-Source": "kona",
    "X-Fantasy-Platform": "kona-PROD-appleseed",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    ...extra,
  };
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401
        ? " — your espn_s2/SWID cookies are missing, expired, or belong to a different account."
        : res.status === 404
          ? " — check the league id and that the season has started."
          : res.status === 409
            ? " — ESPN rejected this as a conflict. Usually that means your roster is full " +
              "and nobody was dropped, the player was claimed by someone else, or rosters are " +
              "locked for the current games."
            : res.status === 400
              ? " — ESPN rejected the request shape. If this started suddenly, capture a manual " +
                "transaction from DevTools → Network and compare it to setLineup/addDropPlayer."
              : "";
    throw new EspnError(`ESPN ${res.status} ${res.statusText}${hint}`, res.status, text.slice(0, 500));
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function leagueUrl(base: string, season: number, leagueId: string) {
  return `${base}/seasons/${season}/segments/0/leagues/${leagueId}`;
}

// ---------------------------------------------------------------- reads

export async function fetchLeague(
  auth: EspnAuth,
  season: number,
  leagueId: string,
  myTeamId: number,
  week?: number,
): Promise<League> {
  const views = ["mTeam", "mRoster", "mSettings", "mMatchupScore", "mStatus"];
  const qs = new URLSearchParams();
  views.forEach((v) => qs.append("view", v));
  if (week) qs.set("scoringPeriodId", String(week));

  const raw = await request<RawLeague>(
    `${leagueUrl(READ_BASE, season, leagueId)}?${qs}`,
    { headers: headers(auth) },
  );
  return normalizeLeague(raw, leagueId, myTeamId, week);
}

/**
 * Raw, unnormalized league payload. Used by `npm run verify` to show the actual
 * shape ESPN returned, so an assumption that has drifted (stat split ids, for
 * instance) fails loudly at setup instead of silently zeroing every projection.
 */
export async function fetchRawLeague(
  auth: EspnAuth,
  season: number,
  leagueId: string,
  week: number,
): Promise<RawLeague> {
  const qs = new URLSearchParams();
  ["mTeam", "mRoster", "mSettings"].forEach((v) => qs.append("view", v));
  qs.set("scoringPeriodId", String(week));
  return request<RawLeague>(`${leagueUrl(READ_BASE, season, leagueId)}?${qs}`, {
    headers: headers(auth),
  });
}

/**
 * The free-agent pool. ESPN gates this behind a JSON x-fantasy-filter header —
 * without it you get an unusable slice of the player universe.
 */
export async function fetchFreeAgents(
  auth: EspnAuth,
  season: number,
  leagueId: string,
  week: number,
  limit = 200,
): Promise<Player[]> {
  const filter = {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      filterSlotIds: { value: [SLOT.QB, SLOT.RB, SLOT.WR, SLOT.TE, SLOT.K, SLOT.DST] },
      limit,
      offset: 0,
      sortPercOwned: { sortAsc: false, sortPriority: 1 },
      filterRanksForScoringPeriodIds: { value: [week] },
    },
  };

  const raw = await request<{ players?: RawPoolEntry[] }>(
    `${leagueUrl(READ_BASE, season, leagueId)}?view=kona_player_info&scoringPeriodId=${week}`,
    { headers: headers(auth, { "X-Fantasy-Filter": JSON.stringify(filter) }) },
  );

  return (raw.players ?? []).map((e) =>
    normalizePlayer(e.player, SLOT.BENCH, week, { status: e.status, waiverProcessDate: e.waiverProcessDate }),
  );
}

// ---------------------------------------------------------------- writes

export type LineupMove = {
  playerId: number;
  playerName: string;
  fromSlot: number;
  toSlot: number;
};

export type LineupWriteResult = {
  applied: boolean;
  dryRun: boolean;
  moves: LineupMove[];
  /** Read-back verification: did ESPN actually persist what we sent? */
  verified?: boolean;
  verifyDetail?: string;
  error?: string;
};

/**
 * Submit start/sit changes as a single ROSTER transaction.
 *
 * ESPN applies the items atomically, so a start and its matching bench move must
 * travel together — sending them as separate requests leaves the roster in an
 * illegal intermediate state and ESPN rejects the second one.
 */
export async function setLineup(
  auth: EspnAuth,
  season: number,
  leagueId: string,
  teamId: number,
  week: number,
  moves: LineupMove[],
  opts: { dryRun?: boolean } = {},
): Promise<LineupWriteResult> {
  if (!moves.length) {
    return { applied: false, dryRun: !!opts.dryRun, moves: [], verified: true, verifyDetail: "No changes needed" };
  }
  if (opts.dryRun) {
    return { applied: false, dryRun: true, moves };
  }

  const body = {
    isLeagueManager: false,
    teamId,
    type: "ROSTER",
    memberId: normalizeSwid(auth.swid),
    scoringPeriodId: week,
    executionType: "EXECUTE",
    items: moves.map((m) => ({
      playerId: m.playerId,
      type: "LINEUP",
      fromLineupSlotId: m.fromSlot,
      toLineupSlotId: m.toSlot,
    })),
  };

  try {
    await request(`${leagueUrl(WRITE_BASE, season, leagueId)}/transactions/`, {
      method: "POST",
      headers: headers(auth),
      body: JSON.stringify(body),
    });
  } catch (err) {
    const e = err as EspnError;
    return { applied: false, dryRun: false, moves, verified: false, error: e.message };
  }

  // Never trust a 200 alone. Read the roster back and confirm each player landed
  // in the slot we asked for — ESPN can accept a transaction and silently drop it.
  const after = await fetchLeague(auth, season, leagueId, teamId, week);
  const mine = after.teams.find((t) => t.id === teamId);
  const bySlot = new Map(mine?.roster.map((p) => [p.id, p.lineupSlotId]) ?? []);
  const mismatched = moves.filter((m) => bySlot.get(m.playerId) !== m.toSlot);

  return {
    applied: true,
    dryRun: false,
    moves,
    verified: mismatched.length === 0,
    verifyDetail: mismatched.length
      ? `ESPN accepted the request but ${mismatched.map((m) => m.playerName).join(", ")} did not move`
      : `All ${moves.length} move(s) confirmed on ESPN`,
  };
}

/**
 * Every ESPN transaction item carries these, even when they are meaningless for
 * the transaction type. Captured from real payloads on the account — omitting
 * them gets the request rejected.
 */
type TxItem = {
  playerId: number;
  type: "ADD" | "DROP" | "TRADE" | "LINEUP";
  fromTeamId: number;
  toTeamId: number;
  fromLineupSlotId: number;
  toLineupSlotId: number;
  isKeeper: boolean;
  overallPickNumber: number;
};

const item = (
  playerId: number,
  type: TxItem["type"],
  from: { teamId: number; slot: number },
  to: { teamId: number; slot: number },
): TxItem => ({
  playerId,
  type,
  fromTeamId: from.teamId,
  toTeamId: to.teamId,
  fromLineupSlotId: from.slot,
  toLineupSlotId: to.slot,
  isKeeper: false,
  overallPickNumber: 0,
});

export type AddDropResult = {
  applied: boolean;
  dryRun: boolean;
  /** "WAIVER" queues a claim that processes later; "FREEAGENT" is immediate. */
  kind: "WAIVER" | "FREEAGENT";
  addName: string;
  dropName?: string;
  bidAmount?: number;
  verified?: boolean;
  verifyDetail?: string;
  error?: string;
};

/**
 * Add a player, optionally dropping one to make room.
 *
 * A pending WAIVER claim does not change the roster until ESPN processes it, so
 * the two kinds verify differently: a free-agent add is confirmed by reading the
 * roster back, a waiver claim by finding the claim in pending transactions.
 */
export async function addDropPlayer(
  auth: EspnAuth,
  season: number,
  leagueId: string,
  teamId: number,
  week: number,
  opts: {
    add: { id: number; name: string; status: "FREEAGENT" | "WAIVERS" | "ONTEAM" };
    drop?: { id: number; name: string; lineupSlotId: number };
    bidAmount?: number;
    dryRun?: boolean;
  },
): Promise<AddDropResult> {
  const kind = opts.add.status === "WAIVERS" ? "WAIVER" : "FREEAGENT";
  const base: AddDropResult = {
    applied: false,
    dryRun: !!opts.dryRun,
    kind,
    addName: opts.add.name,
    dropName: opts.drop?.name,
    bidAmount: opts.bidAmount,
  };
  if (opts.dryRun) return base;

  const items: TxItem[] = [
    item(opts.add.id, "ADD", { teamId: 0, slot: -1 }, { teamId, slot: -1 }),
  ];
  if (opts.drop) {
    items.push(item(opts.drop.id, "DROP", { teamId, slot: opts.drop.lineupSlotId }, { teamId: 0, slot: -1 }));
  }

  const body = {
    // Carry the bid on either transaction type: in a FAAB league the claim is
    // still resolved against other managers' bids at the next processing run.
    bidAmount: opts.bidAmount ?? 0,
    executionType: "EXECUTE",
    isActingAsTeamOwner: false,
    isLeagueManager: false,
    memberId: normalizeSwid(auth.swid),
    scoringPeriodId: week,
    teamId,
    type: kind,
    items,
  };

  try {
    await request(`${leagueUrl(WRITE_BASE, season, leagueId)}/transactions/`, {
      method: "POST",
      headers: headers(auth),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ...base, error: (err as EspnError).message };
  }

  if (kind === "FREEAGENT") {
    const after = await fetchLeague(auth, season, leagueId, teamId, week);
    const mine = after.teams.find((t) => t.id === teamId);
    const has = mine?.roster.some((p) => p.id === opts.add.id);
    const gone = !opts.drop || !mine?.roster.some((p) => p.id === opts.drop!.id);
    return {
      ...base,
      applied: true,
      verified: !!has && gone,
      verifyDetail: has && gone
        ? `${opts.add.name} is on your roster${opts.drop ? `, ${opts.drop.name} dropped` : ""}`
        : `ESPN accepted the request but the roster does not reflect it yet`,
    };
  }

  const pending = await fetchPendingTransactions(auth, season, leagueId).catch(() => []);
  const mineClaim = pending.find(
    (t) => t.type === "WAIVER" && t.teamId === teamId &&
      t.items.some((i) => i.playerId === opts.add.id && i.type === "ADD"),
  );
  return {
    ...base,
    applied: true,
    verified: !!mineClaim,
    verifyDetail: mineClaim
      ? `Waiver claim queued for ${opts.add.name}${base.bidAmount ? ` at $${base.bidAmount}` : ""} — processes at the next waiver run`
      : `ESPN accepted the request but no pending claim is visible; check the league's waiver page`,
  };
}

export type PendingTransaction = {
  id: string;
  type: string;
  teamId: number;
  status?: string;
  scoringPeriodId?: number;
  proposedDate?: number;
  items: { playerId: number; type: string; fromTeamId: number; toTeamId: number; fromLineupSlotId?: number }[];
};

export async function fetchPendingTransactions(
  auth: EspnAuth,
  season: number,
  leagueId: string,
): Promise<PendingTransaction[]> {
  const raw = await request<{ pendingTransactions?: PendingTransaction[] }>(
    `${leagueUrl(READ_BASE, season, leagueId)}?view=mPendingTransactions`,
    { headers: headers(auth) },
  );
  return raw.pendingTransactions ?? [];
}

export type TradeResult = {
  applied: boolean;
  dryRun: boolean;
  give: string[];
  receive: string[];
  partnerName: string;
  verified?: boolean;
  verifyDetail?: string;
  error?: string;
};

/**
 * Send a trade offer to another manager.
 *
 * A proposal changes neither roster, so a roster read-back proves nothing here.
 * Verification instead looks for the offer in the league's pending transactions.
 */
export async function proposeTrade(
  auth: EspnAuth,
  season: number,
  leagueId: string,
  myTeamId: number,
  week: number,
  opts: {
    partnerTeamId: number;
    partnerName: string;
    give: { id: number; name: string; lineupSlotId: number }[];
    receive: { id: number; name: string; lineupSlotId: number }[];
    dryRun?: boolean;
  },
): Promise<TradeResult> {
  const base: TradeResult = {
    applied: false,
    dryRun: !!opts.dryRun,
    give: opts.give.map((p) => p.name),
    receive: opts.receive.map((p) => p.name),
    partnerName: opts.partnerName,
  };
  if (opts.dryRun) return base;

  const items: TxItem[] = [
    ...opts.give.map((p) =>
      item(p.id, "TRADE", { teamId: myTeamId, slot: p.lineupSlotId }, { teamId: opts.partnerTeamId, slot: -1 })),
    ...opts.receive.map((p) =>
      item(p.id, "TRADE", { teamId: opts.partnerTeamId, slot: p.lineupSlotId }, { teamId: myTeamId, slot: -1 })),
  ];

  const body = {
    bidAmount: 0,
    executionType: "EXECUTE",
    isActingAsTeamOwner: false,
    isLeagueManager: false,
    memberId: normalizeSwid(auth.swid),
    scoringPeriodId: week,
    teamId: myTeamId,
    type: "TRADE_PROPOSAL",
    items,
  };

  try {
    await request(`${leagueUrl(WRITE_BASE, season, leagueId)}/transactions/`, {
      method: "POST",
      headers: headers(auth),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ...base, error: (err as EspnError).message };
  }

  const pending = await fetchPendingTransactions(auth, season, leagueId).catch(() => []);
  const wanted = new Set(opts.receive.map((p) => p.id));
  const found = pending.find(
    (t) => t.type === "TRADE_PROPOSAL" && t.teamId === myTeamId &&
      t.items.some((i) => wanted.has(i.playerId)),
  );
  return {
    ...base,
    applied: true,
    verified: !!found,
    verifyDetail: found
      ? `Offer is pending with ${opts.partnerName}`
      : `ESPN accepted the request but the offer is not visible in pending transactions — check the league's trade page`,
  };
}

export type DeclineResult = {
  applied: boolean;
  verified?: boolean;
  verifyDetail?: string;
  error?: string;
};

/**
 * Decline a trade offer someone sent you.
 *
 * A decline is its own new transaction that points back at the proposal through
 * `relatedTransactionId`; it carries no items and ESPN assigns its `id`. Passing
 * the proposal's id as `id` instead — which is the obvious-looking guess — gets
 * a 409 Conflict, because that id already belongs to the proposal.
 *
 * There is deliberately no accept() counterpart: no TRADE_ACCEPT record exists
 * on this account to copy, and accepting is irreversible and binds another
 * manager, so the UI sends you to ESPN for that.
 */
export async function declineTrade(
  auth: EspnAuth,
  season: number,
  leagueId: string,
  teamId: number,
  week: number,
  transactionId: string,
): Promise<DeclineResult> {
  const body = {
    // No `id`: ESPN mints one for the decline itself.
    relatedTransactionId: transactionId,
    type: "TRADE_DECLINE",
    executionType: "EXECUTE",
    isActingAsTeamOwner: false,
    isLeagueManager: false,
    memberId: normalizeSwid(auth.swid),
    scoringPeriodId: week,
    teamId,
    bidAmount: 0,
  };

  try {
    await request(`${leagueUrl(WRITE_BASE, season, leagueId)}/transactions/`, {
      method: "POST",
      headers: headers(auth),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { applied: false, error: (err as EspnError).message };
  }

  // The offer should no longer be pending. If it still is, say so rather than
  // reporting success off a bare 200.
  const pending = await fetchPendingTransactions(auth, season, leagueId).catch(() => null);
  if (!pending) {
    return { applied: true, verified: false, verifyDetail: "Sent, but could not re-read pending offers to confirm" };
  }
  const stillThere = pending.some((t) => t.id === transactionId);
  return {
    applied: true,
    verified: !stillThere,
    verifyDetail: stillThere
      ? "ESPN accepted the request but the offer is still pending — decline it on ESPN"
      : "Offer declined",
  };
}

// ---------------------------------------------------------------- normalize

function statFor(p: RawPlayer, week: number, source: number): number {
  const hit = p.stats?.find(
    (s) => s.scoringPeriodId === week && s.statSourceId === source && s.statSplitTypeId === 1,
  ) ?? p.stats?.find((s) => s.scoringPeriodId === week && s.statSourceId === source);
  return round2(hit?.appliedTotal ?? 0);
}

function seasonStats(p: RawPlayer, week: number): { average: number; games: number } {
  const weekly = (p.stats ?? []).filter(
    (s) => s.statSourceId === STAT_SOURCE.ACTUAL && s.scoringPeriodId > 0 && s.scoringPeriodId < week,
  );
  if (!weekly.length) return { average: 0, games: 0 };
  const total = weekly.reduce((a, s) => a + (s.appliedTotal ?? 0), 0);
  return { average: round2(total / weekly.length), games: weekly.length };
}

export function normalizePlayer(
  p: RawPlayer,
  lineupSlotId: number,
  week: number,
  pool?: { status?: string; waiverProcessDate?: number },
): Player {
  const status = (pool?.status ?? "ONTEAM").toUpperCase();
  const season = seasonStats(p, week);
  return {
    acquisitionStatus:
      status === "WAIVERS" ? "WAIVERS" : status === "FREEAGENT" ? "FREEAGENT" : "ONTEAM",
    waiverProcessDate: pool?.waiverProcessDate,
    id: p.id,
    name: p.fullName ?? `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(),
    position: POSITION[p.defaultPositionId] ?? "FLEX",
    positionId: p.defaultPositionId,
    team: PRO_TEAM[p.proTeamId] ?? "FA",
    proTeamId: p.proTeamId,
    eligibleSlots: p.eligibleSlots ?? [],
    lineupSlotId,
    injuryStatus: p.injuryStatus ?? (p.injured ? "QUESTIONABLE" : "ACTIVE"),
    percentOwned: round2(p.ownership?.percentOwned ?? 0),
    percentChange: round2(p.ownership?.percentChange ?? 0),
    espnProjection: statFor(p, week, STAT_SOURCE.PROJECTED),
    actualPoints: statFor(p, week, STAT_SOURCE.ACTUAL),
    seasonAverage: season.average,
    gamesPlayed: season.games,
  };
}

function teamName(t: RawTeam): string {
  return (
    t.name?.trim() ||
    [t.location, t.nickname].filter(Boolean).join(" ").trim() ||
    t.abbrev ||
    `Team ${t.id}`
  );
}

export function normalizeLeague(
  raw: RawLeague,
  leagueId: string,
  myTeamId: number,
  weekOverride?: number,
): League {
  const week = weekOverride ?? raw.scoringPeriodId ?? raw.status?.latestScoringPeriod ?? 1;

  // ESPN echoes the requested scoringPeriodId back in `raw.scoringPeriodId`, so
  // it says nothing about where the season actually is. `latestScoringPeriod`
  // from the mStatus view is the real current week. Falling back to `week`
  // means an unknown current week reads as "this week is not over yet", which
  // is the safe direction: it withholds a verdict rather than inventing one.
  const currentWeek = raw.status?.latestScoringPeriod ?? week;

  const acq = raw.settings?.acquisitionSettings ?? {};
  const waivers: WaiverSettings = {
    // FAAB leagues expect a real bid; rolling-priority leagues reject anything but 0.
    usesFaab: !!acq.isUsingAcquisitionBudget,
    budget: acq.acquisitionBudget ?? 0,
    minimumBid: acq.minimumBid ?? 0,
    acquisitionType: acq.acquisitionType ?? "WAIVERS_TRADITIONAL",
  };

  const sched = raw.settings?.scheduleSettings ?? {};
  const playoffs: PlayoffSettings = {
    teams: sched.playoffTeamCount ?? 6,
    regularSeasonPeriods: sched.matchupPeriodCount ?? 14,
  };

  const schedule: Matchup[] = (raw.schedule ?? [])
    .filter((m) => m.home && m.away)
    .map((m) => ({
      period: m.matchupPeriodId,
      homeTeamId: m.home!.teamId,
      awayTeamId: m.away!.teamId,
      homePoints: round2(m.home!.totalPoints ?? 0),
      awayPoints: round2(m.away!.totalPoints ?? 0),
      winner: m.winner ?? "UNDECIDED",
      played: (m.winner ?? "UNDECIDED") !== "UNDECIDED",
    }));

  const lineupSlotCounts: Record<number, number> = {};
  for (const [k, v] of Object.entries(raw.settings?.rosterSettings?.lineupSlotCounts ?? {})) {
    if (v > 0) lineupSlotCounts[Number(k)] = v;
  }

  const teams: Team[] = (raw.teams ?? []).map((t) => ({
    id: t.id,
    name: teamName(t),
    abbrev: t.abbrev ?? `T${t.id}`,
    wins: t.record?.overall?.wins ?? 0,
    losses: t.record?.overall?.losses ?? 0,
    pointsFor: round2(t.record?.overall?.pointsFor ?? 0),
    budgetSpent: t.transactionCounter?.acquisitionBudgetSpent ?? 0,
    waiverRank: t.waiverRank,
    roster: (t.roster?.entries ?? []).map((e: RawRosterEntry) =>
      normalizePlayer(e.playerPoolEntry.player, e.lineupSlotId, week),
    ),
  }));

  return {
    id: leagueId,
    name: raw.settings?.name ?? `League ${leagueId}`,
    season: raw.seasonId,
    week,
    currentWeek,
    scoringType: raw.settings?.scoringSettings?.scoringType ?? "STANDARD",
    lineupSlotCounts,
    waivers,
    schedule,
    playoffs,
    teams,
    myTeamId,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
