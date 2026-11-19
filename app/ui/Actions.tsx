"use client";

import { useState } from "react";
import type { LeagueDetail } from "./types.ts";
import { Pill } from "./atoms.tsx";

type Status = { state: "idle" | "working" | "done" | "error" | "blocked"; message?: string };

/**
 * Claim a free agent / place a waiver bid.
 *
 * A drop is irreversible, so the server can refuse one it considers valuable;
 * that refusal comes back as `blocked` and requires a second, explicit override
 * click rather than being silently allowed through.
 */
export function ClaimButton({
  leagueId,
  target,
  waivers,
  roster,
  rosterFull,
  onDone,
}: {
  leagueId: string;
  target: LeagueDetail["waivers"][number];
  waivers: LeagueDetail["league"]["waivers"];
  roster: LeagueDetail["roster"];
  rosterFull: boolean;
  onDone: () => void;
}) {
  // In a FAAB league you bid on every add, whatever ESPN currently calls him:
  // the claim is sealed and resolves against other managers at processing.
  const needsBid = waivers.usesFaab;
  const [bid, setBid] = useState<number>(target.suggestedBid?.amount ?? Math.max(waivers.minimumBid, 1));
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [confirming, setConfirming] = useState(false);
  // Default to the suggested cut, but a full roster means the drop is a real
  // decision — let it be made here rather than guessed.
  const [dropId, setDropId] = useState<number | "">(target.dropCandidate?.player.id ?? "");

  const dropName = roster.find((p) => p.id === dropId)?.name;

  async function send(overrideProtection = false) {
    setStatus({ state: "working" });
    try {
      const r = await fetch("/api/waivers/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leagueId,
          addPlayerId: target.player.id,
          dropPlayerId: dropId === "" ? undefined : dropId,
          bidAmount: waivers.usesFaab ? bid : undefined,
          overrideProtection,
        }),
      });
      const j = await r.json();

      if (j.blocked) {
        setStatus({ state: "blocked", message: j.blocked });
        return;
      }
      if (!j.ok) {
        setStatus({ state: "error", message: j.error ?? "Request failed" });
        return;
      }
      setStatus({
        state: j.result?.verified ? "done" : "error",
        message: j.result?.verifyDetail ?? "Submitted",
      });
      setConfirming(false);
      onDone();
    } catch (e) {
      setStatus({ state: "error", message: (e as Error).message });
    }
  }

  if (status.state === "done") {
    return <div className="text-[12px] text-[var(--accent)]">✓ {status.message}</div>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {needsBid && (
        <label className="flex items-center gap-1 text-[12px] text-[var(--muted)]">
          $
          <input
            type="number"
            min={waivers.minimumBid}
            max={waivers.budget}
            value={bid}
            onChange={(e) => setBid(Number(e.target.value))}
            className="w-16 rounded-md border border-[var(--line)] bg-[var(--bg)] px-1.5 py-1 text-[12px] text-[var(--text)]"
          />
          <span className="opacity-70">of {waivers.budget}</span>
          {target.suggestedBid && (
            <span className="ml-1 text-[var(--accent)]" title={target.suggestedBid.rationale}>
              suggested ${target.suggestedBid.amount} ({target.suggestedBid.tier})
            </span>
          )}
        </label>
      )}

      <label className="flex items-center gap-1 text-[12px] text-[var(--muted)]">
        drop
        <select
          value={dropId}
          onChange={(e) => setDropId(e.target.value === "" ? "" : Number(e.target.value))}
          className="max-w-[190px] rounded-md border border-[var(--line)] bg-[var(--bg)] px-1.5 py-1 text-[12px] text-[var(--text)]"
        >
          {/* A full roster cannot add without dropping — ESPN answers 409. */}
          <option value="">{rosterFull ? "— required —" : "nobody"}</option>
          {roster.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.position})
            </option>
          ))}
        </select>
      </label>

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          disabled={status.state === "working" || (rosterFull && dropId === "")}
          title={rosterFull && dropId === "" ? "Your roster is full — choose someone to drop" : undefined}
          className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1 text-[12px] font-semibold text-[var(--accent)] transition hover:bg-[var(--accent)]/20 disabled:opacity-40"
        >
          {needsBid ? "Place bid" : "Add"}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--warn)]/40 bg-[var(--warn)]/5 px-2 py-1.5">
          <span className="text-[12px] text-[var(--text)]">
            {needsBid ? `Bid $${bid} on` : "Add"}{" "}
            <b>{target.player.name}</b>
            {dropName && (
              <> and drop <b className="text-[var(--danger)]">{dropName}</b></>
            )}?
          </span>
          <button
            onClick={() => send(status.state === "blocked")}
            disabled={status.state === "working"}
            className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-semibold text-[#06210f] disabled:opacity-50"
          >
            {status.state === "working" ? "Sending…" : status.state === "blocked" ? "Override & send" : "Confirm"}
          </button>
          <button
            onClick={() => { setConfirming(false); setStatus({ state: "idle" }); }}
            className="text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            Cancel
          </button>
        </div>
      )}

      {status.message && (
        <span className={`text-[12px] ${status.state === "blocked" ? "text-[var(--warn)]" : "text-[var(--danger)]"}`}>
          {status.message}
        </span>
      )}
    </div>
  );
}

/** Sends a real offer to another manager — always behind an explicit confirm. */
export function TradeButton({
  leagueId,
  trade,
  onDone,
}: {
  leagueId: string;
  trade: LeagueDetail["trades"][number];
  onDone: () => void;
}) {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [confirming, setConfirming] = useState(false);

  async function send() {
    setStatus({ state: "working" });
    try {
      const r = await fetch("/api/trades/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leagueId,
          partnerTeamId: trade.partner.id,
          givePlayerIds: trade.give.map((p) => p.id),
          receivePlayerIds: trade.receive.map((p) => p.id),
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setStatus({ state: "error", message: j.error ?? "Request failed" });
        return;
      }
      setStatus({
        state: j.result?.verified ? "done" : "error",
        message: j.result?.verifyDetail ?? "Sent",
      });
      setConfirming(false);
      onDone();
    } catch (e) {
      setStatus({ state: "error", message: (e as Error).message });
    }
  }

  if (status.state === "done") {
    return <div className="text-[12px] text-[var(--accent)]">✓ {status.message}</div>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="rounded-lg border border-[var(--info)]/40 bg-[var(--info)]/10 px-2.5 py-1 text-[12px] font-semibold text-[var(--info)] transition hover:bg-[var(--info)]/20"
        >
          Send offer
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--info)]/40 bg-[var(--info)]/5 px-2 py-1.5">
          <span className="text-[12px]">
            Send this offer to <b>{trade.partner.name}</b>? They&apos;ll see it in ESPN.
          </span>
          <button
            onClick={send}
            disabled={status.state === "working"}
            className="rounded-md bg-[var(--info)] px-2.5 py-1 text-[12px] font-semibold text-[#04203d] disabled:opacity-50"
          >
            {status.state === "working" ? "Sending…" : "Confirm"}
          </button>
          <button
            onClick={() => { setConfirming(false); setStatus({ state: "idle" }); }}
            className="text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            Cancel
          </button>
        </div>
      )}
      {status.message && (
        <span className="text-[12px] text-[var(--danger)]">{status.message}</span>
      )}
    </div>
  );
}

export function OfferBadge({ rec }: { rec: "accept" | "decline" | "close call" }) {
  return (
    <Pill tone={rec === "accept" ? "accent" : rec === "decline" ? "danger" : "warn"}>
      {rec === "accept" ? "worth accepting" : rec === "decline" ? "decline" : "close call"}
    </Pill>
  );
}
