"use client";

import { useEffect, useState } from "react";
import type { Scorecard } from "./types.ts";
import { Pill } from "./atoms.tsx";

/**
 * Grades past auto-lineup decisions against real results.
 *
 * Projections are cheap; this is the only view that says whether following them
 * actually worked. Unplayed games stay blank rather than counting as zero.
 */
export function Scorecards() {
  const [cards, setCards] = useState<Scorecard[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const j = await fetch("/api/scorecard").then((r) => r.json());
        if (live) setCards(j.scorecards ?? []);
      } catch {
        if (live) setCards([]);
      }
    })();
    return () => { live = false; };
  }, []);

  if (!cards?.length) return null;

  const settled = cards.filter((c) => c.settled);
  const net = settled.reduce((a, c) => a + c.realizedTotal, 0);
  const graded = cards.reduce((a, c) => a + c.swaps.filter((s) => s.realizedDelta !== null).length, 0);
  const totalSwaps = cards.reduce((a, c) => a + c.swaps.length, 0);

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-3 p-4 text-left transition hover:bg-[var(--panel-2)]"
      >
        <div>
          <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">Did it help?</div>
          <div className="mt-0.5 text-[15px] font-semibold">
            {graded === 0 ? (
              <span className="text-[var(--muted)]">
                {totalSwaps} decision{totalSwaps === 1 ? "" : "s"} awaiting kickoff
              </span>
            ) : (
              <>
                <span className={net >= 0 ? "text-[var(--accent)]" : "text-[var(--danger)]"}>
                  {net >= 0 ? "+" : ""}{net.toFixed(1)} pts
                </span>
                <span className="ml-2 text-[13px] font-normal text-[var(--muted)]">
                  from {graded} graded decision{graded === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
        </div>
        <span className={`ml-auto text-[var(--muted)] transition ${open ? "rotate-90" : ""}`}>›</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-[var(--line)] p-4">
          {cards.map((c) => (
            <div key={`${c.league}-${c.week}`}>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[13px] font-semibold">{c.league.trim()}</span>
                <Pill>week {c.week}</Pill>
                {!c.settled && <Pill tone="warn">in progress</Pill>}
              </div>
              <div className="space-y-1">
                {c.swaps.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                    <span className="w-10 shrink-0 text-[var(--muted)]">{s.slot}</span>
                    <span>
                      {s.inName} <span className="text-[var(--muted)]">over</span> {s.outName}
                    </span>
                    <span className="text-[var(--muted)]">predicted +{s.projectedDelta.toFixed(1)} →</span>
                    {s.realizedDelta === null ? (
                      <span className="text-[var(--muted)]">not played yet</span>
                    ) : (
                      <span className={s.realizedDelta >= 0 ? "text-[var(--accent)]" : "text-[var(--danger)]"}>
                        {s.realizedDelta >= 0 ? "+" : ""}{s.realizedDelta.toFixed(1)}
                        <span className="ml-1 text-[var(--muted)]">
                          ({s.inActual?.toFixed(1)} vs {s.outActual?.toFixed(1)})
                        </span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
