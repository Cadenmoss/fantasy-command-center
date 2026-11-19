"use client";

import { useEffect, useState } from "react";

type CalibrationResponse = {
  calibration: {
    sampleSize: number; weeksCovered: number; expertWeight: number; vegasStrength: number;
    positionBias: Record<string, number>; baselineMae: number; calibratedMae: number;
    updatedAt: string; notes: string[];
  } | null;
  priors: { expertWeight: number; vegasStrength: number };
  recorded: number;
  awaitingResults: number;
  threshold: number;
};

/**
 * What the model has learned from its own graded predictions.
 *
 * Shown plainly, including when it has learned nothing yet — a tuning panel that
 * implies more intelligence than the data supports would be worse than none.
 */
export function LearningCard() {
  const [d, setD] = useState<CalibrationResponse | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const j = await fetch("/api/calibration").then((r) => r.json());
        if (live) setD(j);
      } catch { /* the panel simply stays hidden */ }
    })();
    return () => { live = false; };
  }, []);

  if (!d) return null;
  const c = d.calibration;
  const learning = (c?.sampleSize ?? 0) >= d.threshold;
  const drift = c ? Math.abs(c.expertWeight - d.priors.expertWeight) : 0;

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-3 p-4 text-left transition hover:bg-[var(--panel-2)]"
      >
        <div>
          <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">Self-calibration</div>
          <div className="mt-0.5 text-[15px] font-semibold">
            {learning ? (
              <>
                <span className="text-[var(--accent)]">Tuned to your leagues</span>
                <span className="ml-2 text-[13px] font-normal text-[var(--muted)]">
                  {c!.sampleSize} graded over {c!.weeksCovered} week{c!.weeksCovered === 1 ? "" : "s"}
                </span>
              </>
            ) : (
              <span className="text-[var(--muted)]">
                Using defaults · {d.awaitingResults} prediction{d.awaitingResults === 1 ? "" : "s"} awaiting results
              </span>
            )}
          </div>
        </div>
        <span className={`ml-auto text-[var(--muted)] transition ${open ? "rotate-90" : ""}`}>›</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-[var(--line)] p-4 text-[12px]">
          <Row
            label="Expert vs ESPN weight"
            value={`${((c?.expertWeight ?? d.priors.expertWeight) * 100).toFixed(0)}% expert`}
            learned={drift >= 0.01}
          />
          <Row
            label="Betting-line strength"
            value={(c?.vegasStrength ?? d.priors.vegasStrength).toFixed(2)}
            learned={!!c && Math.abs(c.vegasStrength - d.priors.vegasStrength) >= 0.01}
          />
          {Object.entries(c?.positionBias ?? {})
            .filter(([, v]) => Math.abs(v - 1) >= 0.01)
            .map(([pos, v]) => (
              <Row
                key={pos}
                label={`${pos} bias`}
                value={`${((v - 1) * 100).toFixed(1)}% ${v > 1 ? "under" : "over"}-projected`}
                learned
              />
            ))}

          {c && c.sampleSize > 0 && (
            <div className="pt-1 text-[var(--muted)]">
              Projection error {c.baselineMae.toFixed(2)} → {c.calibratedMae.toFixed(2)} pts
            </div>
          )}

          <div className="pt-1 leading-relaxed text-[var(--muted)]">
            {learning
              ? `Every projection is written down before kickoff, then graded once the week is settled. Refits automatically each Tuesday.`
              : `It records every projection before kickoff and grades them once the week settles. It needs about ${d.threshold} graded predictions before it changes anything — roughly two more weeks at the current rate.`}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, learned }: { label: string; value: string; learned: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="min-w-[170px] text-[var(--muted)]">{label}</span>
      <span className="font-medium">{value}</span>
      <span className={`text-[11px] ${learned ? "text-[var(--accent)]" : "text-[var(--muted)]"}`}>
        {learned ? "learned" : "default"}
      </span>
    </div>
  );
}
