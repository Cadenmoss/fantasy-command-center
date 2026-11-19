import type { League, Player, Team } from "../espn/types.ts";
import { SLOT, SLOT_LABEL, NON_STARTING_SLOTS } from "../espn/constants.ts";
import type { Verdict } from "../projections/blend.ts";
import type { LineupMove } from "../espn/client.ts";
import { maximizeAssignment } from "./assign.ts";

export type SlotAssignment = {
  slotId: number;
  slotLabel: string;
  player?: Player;
  verdict?: Verdict;
  locked: boolean;
};

export type OptimizeResult = {
  current: SlotAssignment[];
  optimal: SlotAssignment[];
  moves: LineupMove[];
  currentProjected: number;
  optimalProjected: number;
  gain: number;
  /** Plain-language explanation of each swap, for the auto-lineup log. */
  rationale: string[];
  warnings: string[];
};

/** Expand lineupSlotCounts into one entry per startable slot. */
function startingSlots(league: League): number[] {
  const slots: number[] = [];
  for (const [id, count] of Object.entries(league.lineupSlotCounts)) {
    const slotId = Number(id);
    if (NON_STARTING_SLOTS.has(slotId)) continue;
    for (let i = 0; i < count; i++) slots.push(slotId);
  }
  // Fill scarce slots first so the assignment matrix is easier to read in debug.
  return slots.sort((a, b) => a - b);
}

export function optimizeLineup(
  league: League,
  team: Team,
  verdicts: Map<number, Verdict>,
): OptimizeResult {
  const warnings: string[] = [];
  const slots = startingSlots(league);

  const pointsOf = (p: Player) => verdicts.get(p.id)?.points ?? p.espnProjection;
  const isLocked = (p: Player) => verdicts.get(p.id)?.locked ?? false;

  // IR players cannot be started at all; leave them entirely out of the problem.
  const roster = team.roster.filter((p) => p.lineupSlotId !== SLOT.IR);

  // --- current lineup ----------------------------------------------------
  const current: SlotAssignment[] = [];
  const usedForCurrent = new Set<number>();
  for (const slotId of slots) {
    const p = roster.find(
      (x) => x.lineupSlotId === slotId && !usedForCurrent.has(x.id),
    );
    if (p) usedForCurrent.add(p.id);
    current.push({
      slotId,
      slotLabel: SLOT_LABEL[slotId] ?? String(slotId),
      player: p,
      verdict: p ? verdicts.get(p.id) : undefined,
      locked: p ? isLocked(p) : false,
    });
  }

  // --- freeze locked starters -------------------------------------------
  // Once a player's game kicks off ESPN refuses to move him, and trying corrupts
  // the whole transaction. His slot leaves the optimization entirely.
  const frozen = new Map<number, Player>(); // slot index -> player
  const openSlotIdx: number[] = [];
  const lockedPlayerIds = new Set<number>();

  current.forEach((a, idx) => {
    if (a.player && a.locked) {
      frozen.set(idx, a.player);
      lockedPlayerIds.add(a.player.id);
    } else {
      openSlotIdx.push(idx);
    }
  });

  // A locked player sitting on the bench is also immovable this week.
  const benchLocked = roster.filter(
    (p) => !lockedPlayerIds.has(p.id) && isLocked(p) &&
      !slots.some((_, i) => current[i].player?.id === p.id),
  );
  benchLocked.forEach((p) => lockedPlayerIds.add(p.id));
  if (benchLocked.length) {
    warnings.push(
      `${benchLocked.length} bench player(s) already played this week and cannot be moved: ` +
      benchLocked.map((p) => p.name).join(", "),
    );
  }

  const candidates = roster.filter((p) => !lockedPlayerIds.has(p.id));

  // --- optimal assignment -------------------------------------------------
  const weights = candidates.map((p) =>
    openSlotIdx.map((idx) => {
      const slotId = current[idx].slotId;
      if (!p.eligibleSlots.includes(slotId)) return -1e6; // ineligible
      const v = verdicts.get(p.id);
      if (v?.unplayable) return -1e5;                     // bye / OUT: never start
      return pointsOf(p);
    }),
  );

  const assigned = weights.length && openSlotIdx.length ? maximizeAssignment(weights) : [];

  const optimal: SlotAssignment[] = current.map((a, idx) => {
    const p = frozen.get(idx);
    return p
      ? { ...a, player: p, verdict: verdicts.get(p.id), locked: true }
      : { slotId: a.slotId, slotLabel: a.slotLabel, player: undefined, verdict: undefined, locked: false };
  });

  candidates.forEach((p, row) => {
    const col = assigned[row];
    if (col === undefined || col < 0) return;
    const idx = openSlotIdx[col];
    if (idx === undefined) return;
    if (weights[row][col] <= -1e4) return; // refused to place an ineligible/unplayable body
    optimal[idx] = {
      slotId: current[idx].slotId,
      slotLabel: current[idx].slotLabel,
      player: p,
      verdict: verdicts.get(p.id),
      locked: false,
    };
  });

  for (const a of optimal) {
    if (!a.player) warnings.push(`No eligible, healthy player available for ${a.slotLabel}`);
  }

  // --- diff into ESPN moves ----------------------------------------------
  const targetSlot = new Map<number, number>();
  optimal.forEach((a) => { if (a.player) targetSlot.set(a.player.id, a.slotId); });

  const moves: LineupMove[] = [];
  for (const p of roster) {
    const to = targetSlot.get(p.id) ?? SLOT.BENCH;
    const from = p.lineupSlotId;
    if (to !== from && !lockedPlayerIds.has(p.id)) {
      moves.push({ playerId: p.id, playerName: p.name, fromSlot: from, toSlot: to });
    }
  }

  const sum = (list: SlotAssignment[]) =>
    Math.round(list.reduce((a, s) => a + (s.player ? pointsOf(s.player) : 0), 0) * 100) / 100;

  const currentProjected = sum(current);
  const optimalProjected = sum(optimal);

  return {
    current,
    optimal,
    moves,
    currentProjected,
    optimalProjected,
    gain: Math.round((optimalProjected - currentProjected) * 100) / 100,
    rationale: explain(current, optimal, verdicts),
    warnings,
  };
}

export type LineupChange = {
  in?: SlotAssignment;
  out?: SlotAssignment;
};

/**
 * The real changes between two lineups, paired in-for-out.
 *
 * Diffing by slot index is wrong and has produced phantom swaps twice: with two
 * WR slots, a player sliding from WR1 to WR2 looks like a change when nothing
 * moved. Membership is what matters, and each incoming player is paired with
 * whoever vacated the slot he is filling — pairing by point value instead lines
 * a QB up against a WR and reports a delta between players who never competed
 * for the same spot.
 *
 * Both the human-readable rationale and the decision log that the scorecard
 * grades run through here, so they cannot drift apart.
 */
export function diffLineups(
  current: SlotAssignment[],
  optimal: SlotAssignment[],
  verdicts: Map<number, Verdict>,
): LineupChange[] {
  const before = new Map(current.filter((s) => s.player).map((s) => [s.player!.id, s]));
  const after = new Map(optimal.filter((s) => s.player).map((s) => [s.player!.id, s]));

  const benched = [...before.values()].filter((s) => !after.has(s.player!.id));
  const started = [...after.values()].filter((s) => !before.has(s.player!.id));

  const pts = (a: SlotAssignment) => verdicts.get(a.player!.id)?.points ?? 0;
  started.sort((a, b) => pts(b) - pts(a));
  benched.sort((a, b) => pts(a) - pts(b));

  const pool = [...benched];
  const changes: LineupChange[] = started.map((inA) => {
    let j = pool.findIndex((o) => o.slotId === inA.slotId);
    if (j < 0) j = pool.findIndex((o) => o.player!.eligibleSlots.includes(inA.slotId));
    return { in: inA, out: j >= 0 ? pool.splice(j, 1)[0] : undefined };
  });
  // Anyone benched without a direct replacement still counts as a change.
  pool.forEach((o) => changes.push({ out: o }));
  return changes;
}

function explain(
  current: SlotAssignment[],
  optimal: SlotAssignment[],
  verdicts: Map<number, Verdict>,
): string[] {
  const pts = (a: SlotAssignment) => verdicts.get(a.player!.id)?.points ?? 0;
  const pairs = diffLineups(current, optimal, verdicts).map(
    (c) => [c.in, c.out] as [SlotAssignment | undefined, SlotAssignment | undefined],
  );

  const out: string[] = [];

  for (const [inA, outA] of pairs) {
    if (inA && outA) {
      const v = verdicts.get(inA.player!.id);
      const why = v?.reasons.slice(0, 2).join("; ") || "higher blended projection";
      const delta = pts(inA) - pts(outA);
      const outWhy = verdicts.get(outA.player!.id)?.reasons[0];
      out.push(
        `${inA.slotLabel}: start ${inA.player!.name} over ${outA.player!.name} ` +
        `(${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pts)` +
        `\n      in:  ${why}` +
        (outWhy ? `\n      out: ${outA.player!.name} — ${outWhy}` : ""),
      );
    } else if (inA) {
      const v = verdicts.get(inA.player!.id);
      out.push(
        `${inA.slotLabel}: start ${inA.player!.name} (${pts(inA).toFixed(1)} pts) into an empty slot` +
        (v?.reasons[0] ? ` — ${v.reasons[0]}` : ""),
      );
    } else if (outA) {
      const why = verdicts.get(outA.player!.id)?.reasons[0] ?? "no longer makes the lineup";
      out.push(`Bench ${outA.player!.name} from ${outA.slotLabel} — ${why}`);
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Best achievable starting-lineup total for an arbitrary roster.
 *
 * This is the yardstick for waivers and trades: a player is only worth acquiring
 * to the extent he raises the score you can actually field. Comparing raw
 * projections instead is how people end up with four good RBs and an empty TE slot.
 *
 * `respectLocks` matters for anything scored against THIS week. A starter whose
 * game already kicked off cannot be replaced, so his slot is spoken for — without
 * this, a waiver pickup gets credited for an upgrade he could never actually make.
 * Trades are rest-of-season and should leave it off.
 */
export function bestLineupPoints(
  league: League,
  roster: Player[],
  verdicts: Map<number, Verdict>,
  opts: { respectLocks?: boolean } = {},
): number {
  const slots = startingSlots(league);
  const active = roster.filter((p) => p.lineupSlotId !== SLOT.IR);
  if (!slots.length || !active.length) return 0;

  let openSlots = slots;
  let candidates = active;
  let pinnedTotal = 0;

  if (opts.respectLocks) {
    const remaining = [...slots];
    const free: Player[] = [];

    for (const p of active) {
      const v = verdicts.get(p.id);
      if (!v?.locked) { free.push(p); continue; }

      // A locked starter holds his slot; a locked bench player is simply gone.
      const idx = remaining.indexOf(p.lineupSlotId);
      if (idx >= 0) {
        remaining.splice(idx, 1);
        pinnedTotal += v.points ?? p.espnProjection;
      }
    }
    openSlots = remaining;
    candidates = free;
  }

  if (!openSlots.length || !candidates.length) return round2(pinnedTotal);

  const weights = candidates.map((p) =>
    openSlots.map((slotId) => {
      if (!p.eligibleSlots.includes(slotId)) return -1e6;
      const v = verdicts.get(p.id);
      if (v?.unplayable) return -1e5;
      return v?.points ?? p.espnProjection;
    }),
  );

  const assigned = maximizeAssignment(weights);
  let total = pinnedTotal;
  assigned.forEach((col, row) => {
    if (col >= 0 && weights[row][col] > -1e4) total += weights[row][col];
  });
  return round2(total);
}
