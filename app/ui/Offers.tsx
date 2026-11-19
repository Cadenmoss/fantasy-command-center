"use client";

import { useEffect, useState } from "react";
import type { IncomingOffer } from "./types.ts";
import { OfferBadge } from "./Actions.tsx";

/**
 * Trade offers other managers have sent you, scored on the same rest-of-season
 * basis the trade finder uses. Accepting still happens on ESPN — this tells you
 * whether it is worth accepting.
 */
export function IncomingOffers() {
  const [offers, setOffers] = useState<IncomingOffer[] | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const j = await fetch("/api/offers").then((r) => r.json());
        if (live) setOffers(j.offers ?? []);
      } catch {
        if (live) setOffers([]);
      }
    })();
    return () => { live = false; };
  }, []);

  function removeOffer(id: string) {
    setOffers((prev) => (prev ?? []).filter((o) => o.transactionId !== id));
  }

  if (!offers?.length) return null;

  return (
    <div className="rounded-xl border border-[var(--info)]/35 bg-[var(--info)]/[0.06] p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-[14px] font-semibold">
          {offers.length} trade offer{offers.length === 1 ? "" : "s"} waiting for you
        </h2>
      </div>

      <div className="space-y-2">
        {offers.map((o) => (
          <div key={o.transactionId} className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold">{o.fromTeam}</span>
              <span className="text-[12px] text-[var(--muted)]">in {o.leagueName}</span>
              <OfferBadge rec={o.recommendation} />
              <span
                className={`ml-auto text-[13px] font-semibold tabular-nums ${
                  o.netValue >= 0 ? "text-[var(--accent)]" : "text-[var(--danger)]"
                }`}
              >
                {o.netValue >= 0 ? "+" : ""}{o.netValue.toFixed(1)} pts/wk
              </span>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border border-[var(--danger)]/25 bg-[var(--danger)]/[0.06] p-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--danger)]">
                  You give
                </div>
                {o.youGive.map((p, i) => (
                  <div key={i} className="text-[13px]">
                    {p.name} <span className="text-[var(--muted)]">{p.position} · {p.rosValue.toFixed(1)}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-md border border-[var(--accent)]/25 bg-[var(--accent)]/[0.06] p-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">
                  You get
                </div>
                {o.youGet.map((p, i) => (
                  <div key={i} className="text-[13px]">
                    {p.name} <span className="text-[var(--muted)]">{p.position} · {p.rosValue.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            </div>

            <OfferActions offer={o} onDeclined={() => removeOffer(o.transactionId)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function OfferActions({ offer, onDeclined }: { offer: IncomingOffer; onDeclined: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function decline() {
    setBusy(true); setMsg(null);
    try {
      const j = await fetch("/api/trades/decline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId: offer.leagueId, transactionId: offer.transactionId }),
      }).then((r) => r.json());

      if (j.ok && j.result?.verified) { onDeclined(); return; }
      setMsg(j.error ?? j.result?.verifyDetail ?? "Could not decline");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2">
      {/* Accepting binds another manager and cannot be undone, and ESPN exposes no
          request shape we could copy for it — so that one step stays on ESPN. */}
      <a
        href={offer.espnUrl}
        target="_blank"
        rel="noreferrer"
        className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1 text-[12px] font-semibold text-[var(--accent)] transition hover:bg-[var(--accent)]/20"
      >
        Review on ESPN ↗
      </a>

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-[12px] font-medium text-[var(--muted)] transition hover:text-[var(--text)]"
        >
          Decline
        </button>
      ) : (
        <span className="flex items-center gap-2">
          <span className="text-[12px] text-[var(--muted)]">Decline this offer?</span>
          <button
            onClick={decline}
            disabled={busy}
            className="rounded-md bg-[var(--danger)] px-2.5 py-1 text-[12px] font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Declining…" : "Confirm"}
          </button>
          <button onClick={() => setConfirming(false)} className="text-[12px] text-[var(--muted)] hover:text-[var(--text)]">
            Cancel
          </button>
        </span>
      )}

      {msg && <span className="text-[12px] text-[var(--danger)]">{msg}</span>}
    </div>
  );
}
