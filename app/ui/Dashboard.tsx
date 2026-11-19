"use client";

import { useCallback, useEffect, useState } from "react";
import type { LeagueSummary, StatusResp } from "./types.ts";
import { Pill } from "./atoms.tsx";
import { LeagueDetailView } from "./LeagueDetail.tsx";
import { IncomingOffers } from "./Offers.tsx";
import { Scorecards } from "./Scorecard.tsx";
import { LearningCard } from "./Learning.tsx";
import { HealthBanner } from "./Health.tsx";

export function Dashboard({ status }: { status: StatusResp }) {
  const [leagues, setLeagues] = useState<LeagueSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Initial load. Kept inline (rather than calling a shared helper) so the
  // state updates stay inside the async callback, not the effect body.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const j = await fetch("/api/leagues?light=1").then((r) => r.json());
        if (live) setLeagues(j.leagues ?? []);
      } catch {
        if (live) setLeagues([]);
      }
    })();
    return () => { live = false; };
  }, []);

  /** Manual refresh after an apply: clear first so the skeletons show. */
  const load = useCallback(async () => {
    setLeagues(null);
    try {
      const j = await fetch("/api/leagues?light=1").then((r) => r.json());
      setLeagues(j.leagues ?? []);
    } catch {
      setLeagues([]);
    }
  }, []);

  async function runAll(dryRun: boolean) {
    setRunning(true); setRunMsg(null);
    try {
      const r = await fetch("/api/lineup/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const j = await r.json();
      const done = (j.outcomes ?? []).filter((o: { write?: { applied?: boolean } }) => o.write?.applied).length;
      const total = (j.outcomes ?? []).reduce(
        (a: number, o: { gain?: number; write?: { applied?: boolean } }) => a + (o.write?.applied ? (o.gain ?? 0) : 0), 0);
      setRunMsg(
        dryRun
          ? `Dry run complete — ${(j.outcomes ?? []).reduce((a: number, o: { moves?: number }) => a + (o.moves ?? 0), 0)} move(s) would be made`
          : `Applied in ${done} league(s), +${total.toFixed(1)} projected pts`,
      );
      load();
    } catch (e) {
      setRunMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  const totalGain = (leagues ?? []).reduce((a, l) => a + (l.ok ? l.gain : 0), 0);
  const totalMoves = (leagues ?? []).reduce((a, l) => a + (l.ok ? l.moveCount : 0), 0);

  return (
    <div className="space-y-5">
      <HealthBanner />

      <IncomingOffers />

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">Across all leagues</div>
          <div className="text-[20px] font-semibold tabular-nums">
            {totalMoves} pending move{totalMoves === 1 ? "" : "s"}
            {totalGain > 0 && <span className="ml-2 text-[var(--accent)]">+{totalGain.toFixed(1)} pts</span>}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {runMsg && <span className="text-[12px] text-[var(--muted)]">{runMsg}</span>}
          <button
            onClick={() => runAll(true)}
            disabled={running}
            className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[13px] font-medium text-[var(--muted)] transition hover:text-[var(--text)] disabled:opacity-50"
          >
            Dry run
          </button>
          <button
            onClick={() => runAll(false)}
            disabled={running || totalMoves === 0}
            className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-[13px] font-semibold text-[#06210f] transition hover:brightness-110 disabled:opacity-40"
          >
            {running ? "Working…" : "Set all lineups"}
          </button>
        </div>
      </div>

      {leagues === null && (
        <div className="space-y-3">
          {status.leagues.map((l) => (
            <div key={l.id} className="h-24 animate-pulse-soft rounded-xl bg-[var(--panel)]" />
          ))}
        </div>
      )}

      <Scorecards />

      <LearningCard />

      {leagues?.map((l) => (
        <div key={l.id} className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          {!l.ok ? (
            <div className="p-4">
              <div className="font-semibold">{l.label}</div>
              <div className="mt-1 text-[13px] text-[var(--danger)]">{l.error}</div>
            </div>
          ) : (
            <>
              <button
                onClick={() => setOpen(open === l.id ? null : l.id)}
                className="flex w-full flex-wrap items-center gap-3 p-4 text-left transition hover:bg-[var(--panel-2)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold">{l.name}</span>
                    <Pill tone={l.autoLineup ? "accent" : "muted"}>{l.autoLineup ? "auto" : "propose only"}</Pill>
                    <Pill>week {l.week}</Pill>
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--muted)]">
                    {l.teamName} · {l.record} · projected {l.currentProjected.toFixed(1)}
                  </div>
                </div>
                <div className="text-right">
                  {l.moveCount > 0 ? (
                    <>
                      <div className="text-[18px] font-semibold tabular-nums text-[var(--accent)]">+{l.gain.toFixed(1)}</div>
                      <div className="text-[11px] text-[var(--muted)]">{l.moveCount} move{l.moveCount === 1 ? "" : "s"}</div>
                    </>
                  ) : (
                    <div className="text-[13px] text-[var(--muted)]">optimal ✓</div>
                  )}
                </div>
                <span className={`text-[var(--muted)] transition ${open === l.id ? "rotate-90" : ""}`}>›</span>
              </button>
              {open === l.id && (
                <div className="border-t border-[var(--line)] bg-[var(--bg)] p-4">
                  <LeagueDetailView id={l.id} autoLineup={l.autoLineup} />
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
