"use client";

import { useEffect, useState } from "react";

type HealthResponse = {
  lastRunAt: string | null;
  hoursQuiet: number | null;
  problems: { subsystem: string; detail: string; since: string; streak: number }[];
};

const LABEL: Record<string, string> = {
  "espn-auth": "ESPN login",
  "espn-projections": "ESPN projections",
  fantasypros: "Expert consensus",
  sleeper: "Sleeper market data",
  "nfl-schedule": "NFL schedule & lines",
  "lineup-write": "Lineup submission",
  scheduler: "Scheduler",
};

/**
 * Only appears when something is wrong.
 *
 * The app fails open by design — a missing expert feed degrades the blend rather
 * than stopping the lineup — which means a broken source is invisible unless it
 * is surfaced deliberately.
 */
export function HealthBanner() {
  const [h, setH] = useState<HealthResponse | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const j = await fetch("/api/health").then((r) => r.json());
        if (live) setH(j);
      } catch { /* banner just stays hidden */ }
    })();
    return () => { live = false; };
  }, []);

  if (!h) return null;
  const stale = h.hoursQuiet !== null && h.hoursQuiet > 96;
  if (!h.problems.length && !stale) return null;

  return (
    <div className="rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/[0.07] p-4">
      <div className="text-[13px] font-semibold text-[var(--danger)]">Needs your attention</div>
      <div className="mt-2 space-y-1.5">
        {stale && (
          <div className="text-[12px]">
            <span className="font-medium">Scheduler</span>
            <span className="text-[var(--muted)]">
              {" "}— no lineup run in {Math.floor(h.hoursQuiet!)} hours. Check your Mac stayed awake and logged in.
            </span>
          </div>
        )}
        {h.problems.map((p) => (
          <div key={p.subsystem} className="text-[12px]">
            <span className="font-medium">{LABEL[p.subsystem] ?? p.subsystem}</span>
            <span className="text-[var(--muted)]"> — {p.detail}</span>
            {p.streak > 1 && (
              <span className="text-[var(--muted)]"> (failed {p.streak} runs in a row)</span>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 text-[11px] text-[var(--muted)]">
        Run <code>npm run doctor</code> for the full check.
      </div>
    </div>
  );
}
