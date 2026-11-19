import { loadConfig, configProblems } from "../config.ts";
import {
  addDropPlayer, proposeTrade, fetchLeague, fetchFreeAgents, fetchPendingTransactions,
  declineTrade,
  type AddDropResult, type TradeResult, type PendingTransaction,
} from "../espn/client.ts";
import { buildContext, evaluate, type Verdict } from "../projections/blend.ts";
import { protectionFor, rosterCapacity } from "./protect.ts";
import { restOfSeasonValue } from "./value.ts";
import { bestLineupPoints } from "./optimizer.ts";
import { markWriteValidated } from "../util/writeGate.ts";
import type { Player } from "../espn/types.ts";
import { SLOT } from "../espn/constants.ts";

export type ClaimRequest = {
  leagueId: string;
  addPlayerId: number;
  dropPlayerId?: number;
  bidAmount?: number;
  dryRun?: boolean;
  /** Set only when the user has seen and overridden a protection warning. */
  overrideProtection?: boolean;
};

export type ClaimOutcome = {
  ok: boolean;
  result?: AddDropResult;
  blocked?: string;
  /** True when the block is "pick someone to drop", not "that drop is unwise". */
  needsDrop?: boolean;
  error?: string;
  /** FAAB leagues only. */
  budgetRemaining?: number;
};

export async function submitClaim(req: ClaimRequest): Promise<ClaimOutcome> {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) return { ok: false, error: problems.join("; ") };

  const lc = cfg.leagues.find((l) => l.id === req.leagueId);
  if (!lc) return { ok: false, error: `League ${req.leagueId} is not configured` };

  const auth = { swid: cfg.swid, espnS2: cfg.espnS2 };
  const league = await fetchLeague(auth, cfg.season, lc.id, lc.teamId);
  const myTeam = league.teams.find((t) => t.id === lc.teamId);
  if (!myTeam) return { ok: false, error: `Team ${lc.teamId} not found in ${league.name}` };

  // The target has to come from the live pool so we know whether it is a waiver
  // claim or a straight add — sending the wrong type gets rejected.
  const pool = await fetchFreeAgents(auth, cfg.season, lc.id, league.week, 400);
  const add = pool.find((p) => p.id === req.addPlayerId);
  if (!add) {
    return { ok: false, error: "That player is no longer a free agent — someone else got there first." };
  }

  // A full roster must drop to add. Sending the claim anyway is what produced
  // ESPN 409 Conflict, with no hint about why.
  const capacity = rosterCapacity(league.lineupSlotCounts);
  const onRoster = myTeam.roster.filter((p) => p.lineupSlotId !== SLOT.IR).length;
  if (!req.dropPlayerId && onRoster >= capacity) {
    return {
      ok: false,
      blocked:
        `Your roster is full (${onRoster}/${capacity}), so ESPN needs someone dropped ` +
        `to make room for ${add.name}. Pick who to drop and try again.`,
      needsDrop: true,
    };
  }

  let drop: Player | undefined;
  if (req.dropPlayerId) {
    drop = myTeam.roster.find((p) => p.id === req.dropPlayerId);
    if (!drop) return { ok: false, error: "The player you're dropping is not on your roster." };

    // Irreversible: refuse to drop someone valuable unless explicitly overridden.
    const ctx = await buildContext(league);
    const verdicts = evaluate([...myTeam.roster, ...pool], ctx);
    const guard = protectionFor(drop, verdicts.get(drop.id));
    if (guard.protected && !req.overrideProtection) {
      return {
        ok: false,
        blocked:
          `Refusing to drop ${drop.name} — ${guard.reason}. ` +
          `Dropping him cannot be undone. Pick someone else, or confirm the override.`,
      };
    }
  }

  // No gate check here: every claim originates from an explicit click, which is
  // itself the supervision the gate exists to guarantee. We still record the
  // first verified success so the UI can report that the path is proven.
  const result = await addDropPlayer(auth, cfg.season, lc.id, lc.teamId, league.week, {
    add: { id: add.id, name: add.name, status: add.acquisitionStatus },
    drop: drop ? { id: drop.id, name: drop.name, lineupSlotId: drop.lineupSlotId } : undefined,
    // FAAB: always attach the bid. A player's status can flip between the
    // suggestion and the click, and a claim with no bid loses by default.
    bidAmount: league.waivers.usesFaab ? (req.bidAmount ?? league.waivers.minimumBid) : 0,
    dryRun: req.dryRun,
  });

  if (result.applied && result.verified) {
    markWriteValidated("freeagent", `${league.name}: added ${result.addName}`);
  }

  return { ok: !result.error, result, error: result.error };
}

export type TradeRequest = {
  leagueId: string;
  partnerTeamId: number;
  givePlayerIds: number[];
  receivePlayerIds: number[];
  dryRun?: boolean;
};

export type TradeOutcome = { ok: boolean; result?: TradeResult; error?: string };

export async function submitTrade(req: TradeRequest): Promise<TradeOutcome> {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) return { ok: false, error: problems.join("; ") };

  const lc = cfg.leagues.find((l) => l.id === req.leagueId);
  if (!lc) return { ok: false, error: `League ${req.leagueId} is not configured` };

  const auth = { swid: cfg.swid, espnS2: cfg.espnS2 };
  const league = await fetchLeague(auth, cfg.season, lc.id, lc.teamId);
  const myTeam = league.teams.find((t) => t.id === lc.teamId);
  const partner = league.teams.find((t) => t.id === req.partnerTeamId);
  if (!myTeam || !partner) return { ok: false, error: "Team not found in this league" };

  const give = req.givePlayerIds.map((id) => myTeam.roster.find((p) => p.id === id)).filter(Boolean) as Player[];
  const receive = req.receivePlayerIds.map((id) => partner.roster.find((p) => p.id === id)).filter(Boolean) as Player[];

  if (give.length !== req.givePlayerIds.length || receive.length !== req.receivePlayerIds.length) {
    return { ok: false, error: "One of these players has moved since the suggestion was generated. Refresh and try again." };
  }

  const result = await proposeTrade(auth, cfg.season, lc.id, lc.teamId, league.week, {
    partnerTeamId: partner.id,
    partnerName: partner.name,
    give: give.map((p) => ({ id: p.id, name: p.name, lineupSlotId: p.lineupSlotId })),
    receive: receive.map((p) => ({ id: p.id, name: p.name, lineupSlotId: p.lineupSlotId })),
    dryRun: req.dryRun,
  });

  if (result.applied && result.verified) {
    markWriteValidated("trade", `${league.name}: offered ${result.give.join(", ")} for ${result.receive.join(", ")}`);
  }

  return { ok: !result.error, result, error: result.error };
}

export async function declineOffer(leagueId: string, transactionId: string) {
  const cfg = loadConfig();
  const lc = cfg.leagues.find((l) => l.id === leagueId);
  if (!lc) return { ok: false, error: `League ${leagueId} is not configured` };

  const auth = { swid: cfg.swid, espnS2: cfg.espnS2 };
  const league = await fetchLeague(auth, cfg.season, lc.id, lc.teamId);
  const result = await declineTrade(auth, cfg.season, lc.id, lc.teamId, league.week, transactionId);
  return { ok: !result.error, result, error: result.error };
}

export type IncomingOffer = {
  leagueId: string;
  leagueName: string;
  transactionId: string;
  fromTeam: string;
  youGive: { name: string; position: string; rosValue: number }[];
  youGet: { name: string; position: string; rosValue: number }[];
  netValue: number;
  recommendation: "accept" | "decline" | "close call";
  /** Accepting happens on ESPN — see declineTrade() for why. */
  espnUrl: string;
};

/** Trade offers other managers have sent you, scored with the same engine. */
export async function fetchIncomingOffers(): Promise<IncomingOffer[]> {
  const cfg = loadConfig();
  if (configProblems(cfg).length) return [];
  const auth = { swid: cfg.swid, espnS2: cfg.espnS2 };
  const out: IncomingOffer[] = [];

  for (const lc of cfg.leagues) {
    try {
      const [league, pending] = await Promise.all([
        fetchLeague(auth, cfg.season, lc.id, lc.teamId),
        fetchPendingTransactions(auth, cfg.season, lc.id),
      ]);
      const offers = pending.filter(
        (t: PendingTransaction) =>
          t.type === "TRADE_PROPOSAL" && t.teamId !== lc.teamId &&
          t.items.some((i) => i.toTeamId === lc.teamId || i.fromTeamId === lc.teamId),
      );
      if (!offers.length) continue;

      const ctx = await buildContext(league);
      const verdicts = evaluate(league.teams.flatMap((t) => t.roster), ctx);
      const byId = new Map(league.teams.flatMap((t) => t.roster).map((p) => [p.id, p]));
      const teamName = new Map(league.teams.map((t) => [t.id, t.name]));

      // Rest-of-season value, same basis the trade finder uses.
      const val = (p: Player) => restOfSeasonValue(p, verdicts.get(p.id));

      for (const t of offers) {
        const give = t.items.filter((i) => i.fromTeamId === lc.teamId).map((i) => byId.get(i.playerId)).filter(Boolean) as Player[];
        const get = t.items.filter((i) => i.toTeamId === lc.teamId).map((i) => byId.get(i.playerId)).filter(Boolean) as Player[];
        if (!give.length && !get.length) continue;

        // Score the offer the same way the trade finder scores its own ideas:
        // by how much the lineup you can actually field improves. A raw value sum
        // flatters every 2-for-1, because it credits you for a second player you
        // may have no slot to start.
        const myRoster = league.teams.find((t) => t.id === lc.teamId)?.roster ?? [];
        const rosV = new Map<number, Verdict>(
          [...myRoster, ...get].map((p) => {
            const v = verdicts.get(p.id);
            // Rest-of-season framing: this week's byes and kickoff locks are
            // irrelevant to whether the trade itself is good.
            const verdict: Verdict = {
              player: p,
              points: val(p),
              espnPoints: p.espnProjection,
              expertPoints: v?.expertPoints,
              expertRank: v?.expertRank,
              confidence: v?.confidence ?? 0.5,
              reasons: v?.reasons ?? [],
              sources: v?.sources ?? [],
              locked: false,
              onBye: false,
              unplayable: false,
            };
            return [p.id, verdict];
          }),
        );
        const before = bestLineupPoints(league, myRoster, rosV);
        const giveIds = new Set(give.map((p) => p.id));
        const after = bestLineupPoints(league, [...myRoster.filter((p) => !giveIds.has(p.id)), ...get], rosV);
        const net = Math.round((after - before) * 10) / 10;

        out.push({
          leagueId: lc.id,
          leagueName: league.name,
          transactionId: t.id,
          fromTeam: teamName.get(t.teamId) ?? `Team ${t.teamId}`,
          youGive: give.map((p) => ({ name: p.name, position: p.position, rosValue: val(p) })),
          youGet: get.map((p) => ({ name: p.name, position: p.position, rosValue: val(p) })),
          netValue: net,
          recommendation: net > 2 ? "accept" : net < -2 ? "decline" : "close call",
          espnUrl: `https://fantasy.espn.com/football/team?leagueId=${lc.id}&teamId=${lc.teamId}&seasonId=${cfg.season}`,
        });
      }
    } catch {
      // A league that fails to load should not hide offers in the others.
    }
  }
  return out;
}
