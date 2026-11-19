"use client";

import { useCallback, useEffect, useState } from "react";
import type { LeagueDetail } from "./types.ts";
import { Pill, Confidence, SectionTitle, injuryTone, shortInjury } from "./atoms.tsx";
import { ClaimButton, TradeButton } from "./Actions.tsx";
import { MatchupCard, SeasonCard, ExploitTab } from "./Edge.tsx";

type Tab = "lineup" | "waivers" | "trades" | "exploit";

export function LeagueDetailView({ id, autoLineup }: { id: string; autoLineup: boolean }) {
  const [data, setData] = useState<LeagueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("lineup");
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/leagues/${id}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Request failed");
        if (live) setData(j as LeagueDetail);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => { live = false; };
  }, [id]);

  /** Re-pull after a claim or offer so the board reflects the new roster. */
  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/leagues/${id}`);
      if (r.ok) setData((await r.json()) as LeagueDetail);
    } catch {
      // a failed refresh must not clobber what the user is looking at
    }
  }, [id]);

  async function apply() {
    setApplying(true); setApplyMsg(null);
    try {
      const r = await fetch("/api/lineup/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId: id }),
      });
      const j = await r.json();
      const o = j.outcomes?.[0];
      setApplyMsg(
        o?.error ? `Failed: ${o.error}`
        : o?.write?.verified ? `Applied — ${o.write.verifyDetail}`
        : o?.write?.verifyDetail ?? o?.skipped ?? "Nothing to apply",
      );
      const fresh = await fetch(`/api/leagues/${id}`).then((x) => x.json());
      setData(fresh);
    } catch (e) {
      setApplyMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setApplying(false);
    }
  }

  if (error) {
    return <div className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">{error}</div>;
  }
  if (!data) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse-soft rounded-lg bg-[var(--panel-2)]" />)}
      </div>
    );
  }

  const { lineup } = data;
  const tabs: [Tab, string, number][] = [
    ["lineup", "Lineup", lineup.moves.length],
    ["waivers", "Waivers", data.waivers.length],
    ["trades", "Trades", data.trades.length],
    ["exploit", "Exploit", data.exploits?.length ?? 0],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition ${
              tab === key
                ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
                : "border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {label}
            {count > 0 && <span className="ml-1.5 tabular-nums opacity-70">{count}</span>}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {applyMsg && <span className="text-[12px] text-[var(--muted)]">{applyMsg}</span>}
          {lineup.moves.length > 0 && (
            <button
              onClick={apply}
              disabled={applying}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[13px] font-semibold text-[#06210f] transition hover:brightness-110 disabled:opacity-50"
            >
              {applying ? "Applying…" : autoLineup ? "Apply now" : "Approve & apply"}
            </button>
          )}
        </div>
      </div>

      {tab === "lineup" && (
        <>
          <SeasonCard data={data} />
          <MatchupCard data={data} />
          <ByeRisks data={data} />
          <LineupTab data={data} />
        </>
      )}
      {tab === "waivers" && <WaiversTab data={data} onDone={reload} />}
      {tab === "trades" && <TradesTab data={data} onDone={reload} />}
      {tab === "exploit" && <ExploitTab data={data} onDone={reload} />}

      {data.dataNotes.length > 0 && (
        <div className="rounded-lg border border-[var(--warn)]/30 bg-[var(--warn)]/5 p-3">
          {data.dataNotes.map((n, i) => (
            <div key={i} className="text-[12px] text-[var(--warn)]">{n}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ByeRisks({ data }: { data: LeagueDetail }) {
  const risks = data.byeRisks ?? [];
  if (!risks.length) return null;
  return (
    <div className="mb-4 space-y-2">
      {risks.map((r) => (
        <div
          key={r.week}
          className={`rounded-lg border p-3 ${
            r.severity === "critical"
              ? "border-[var(--danger)]/40 bg-[var(--danger)]/[0.07]"
              : "border-[var(--warn)]/35 bg-[var(--warn)]/[0.05]"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={r.severity === "critical" ? "danger" : "warn"}>week {r.week}</Pill>
            <span className="text-[13px] font-medium">{r.advice}</span>
          </div>
          <div className="mt-1 text-[12px] text-[var(--muted)]">
            Off: {r.out.map((p) => `${p.name} (${p.position})`).join(", ")}
          </div>
        </div>
      ))}
    </div>
  );
}

function LineupTab({ data }: { data: LeagueDetail }) {
  const { lineup } = data;
  // Highlight by roster membership, not slot index — a player shifting between
  // two interchangeable WR slots hasn't changed anything.
  const wasStarting = new Set(lineup.current.map((c) => c.player?.id).filter(Boolean));
  const changed = new Set(
    lineup.optimal
      .map((o, i) => (o.player && !wasStarting.has(o.player.id) ? i : -1))
      .filter((i) => i >= 0),
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Current projected" value={lineup.currentProjected.toFixed(1)} />
        <Stat label="Optimal projected" value={lineup.optimalProjected.toFixed(1)} />
        <Stat
          label="Gain"
          value={`${lineup.gain >= 0 ? "+" : ""}${lineup.gain.toFixed(1)}`}
          tone={lineup.gain > 0.1 ? "accent" : "muted"}
        />
      </div>

      {lineup.rationale.length > 0 && (
        <div>
          <SectionTitle>Recommended changes</SectionTitle>
          <div className="space-y-2">
            {lineup.rationale.map((r, i) => (
              <div key={i} className="rounded-lg border border-[var(--accent)]/25 bg-[var(--accent)]/[0.06] p-3 text-[13px] leading-relaxed">
                {r}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionTitle right={<span className="text-[11px] text-[var(--muted)]">blended · ESPN · experts</span>}>
          Optimal lineup
        </SectionTitle>
        <div className="overflow-hidden rounded-xl border border-[var(--line)]">
          {lineup.optimal.map((s, i) => {
            const p = s.player;
            const v = s.verdict;
            const inj = p ? shortInjury(p.injuryStatus) : null;
            return (
              <div
                key={i}
                className={`flex items-center gap-3 border-b border-[var(--line)] px-3 py-2.5 last:border-0 ${
                  changed.has(i) ? "bg-[var(--accent)]/[0.06]" : "bg-[var(--panel)]"
                }`}
              >
                <span className="w-12 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                  {s.slotLabel}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium">{p?.name ?? "—"}</span>
                    {inj && <Pill tone={injuryTone(p!.injuryStatus)}>{inj}</Pill>}
                    {s.locked && <Pill tone="info">locked</Pill>}
                    {changed.has(i) && <Pill tone="accent">new</Pill>}
                  </div>
                  {p && (
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
                      <span>{p.position} · {p.team}</span>
                      {v?.expertRank && <span>ECR #{v.expertRank}</span>}
                      {v && <Confidence value={v.confidence} />}
                    </div>
                  )}
                  {v?.reasons?.[0] && (
                    <div className="mt-1 text-[11px] leading-snug text-[var(--muted)]">{v.reasons[0]}</div>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[15px] font-semibold tabular-nums">{v?.points?.toFixed(1) ?? "—"}</div>
                  <div className="text-[10px] tabular-nums text-[var(--muted)]">
                    espn {v?.espnPoints?.toFixed(1) ?? "—"}
                    {v?.expertPoints !== undefined && ` · exp ${v.expertPoints.toFixed(1)}`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {lineup.warnings.length > 0 && (
        <div className="space-y-1">
          {lineup.warnings.map((w, i) => (
            <div key={i} className="text-[12px] text-[var(--warn)]">! {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function WaiversTab({ data, onDone }: { data: LeagueDetail; onDone: () => void }) {
  if (!data.waivers.length) {
    return <Empty>No free agent is worth a roster spot right now.</Empty>;
  }
  return (
    <div className="space-y-2">
      {data.waivers.map((w, i) => (
        <div key={w.player.id} className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 w-5 shrink-0 text-[13px] font-bold tabular-nums text-[var(--muted)]">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold">{w.player.name}</span>
                <Pill>{w.player.position} · {w.player.team}</Pill>
                <Pill tone="muted">{w.player.percentOwned.toFixed(0)}% owned</Pill>
                {w.immediateGain > 0.5 ? (
                  <Pill tone="accent">net +{w.immediateGain.toFixed(1)} this week</Pill>
                ) : (
                  <Pill tone="warn">not worth the drop</Pill>
                )}
                {w.trendingRank && w.trendingRank <= 25 && (
                  <Pill tone="info">🔥 #{w.trendingRank} most added</Pill>
                )}
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {w.reasons.map((r, j) => (
                  <li key={j} className="text-[12px] leading-snug text-[var(--muted)]">· {r}</li>
                ))}
              </ul>
              {w.dropCandidate ? (
                <div
                  className={`mt-2 rounded-md border px-2 py-1.5 text-[12px] ${
                    w.dropCandidate.impact?.breaksBye
                      ? "border-[var(--danger)]/40 bg-[var(--danger)]/[0.07]"
                      : "border-[var(--warn)]/30 bg-[var(--warn)]/[0.05]"
                  }`}
                >
                  <span className="text-[var(--warn)]">Drops</span>{" "}
                  <span className="font-semibold">{w.dropCandidate.player.name}</span>
                  <span className="text-[var(--muted)]"> ({w.dropCandidate.player.position})</span>
                  <div className="text-[var(--muted)]">{w.dropCandidate.reason}</div>
                  {w.dropCandidate.impact?.warnings.map((warn, k) => (
                    <div key={k} className="text-[var(--danger)]">⚠ {warn}</div>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-[12px] text-[var(--muted)]">
                  Roster has room — nothing gets dropped.
                </div>
              )}
              {w.suggestedBid && (
                <div className="mt-2 text-[12px]">
                  <span className="font-semibold text-[var(--accent)]">Bid ${w.suggestedBid.amount}</span>
                  <span className="text-[var(--muted)]">
                    {" "}({w.suggestedBid.percentOfRemaining}% of remaining · {w.suggestedBid.tier})
                  </span>
                  <div className="text-[var(--muted)]">{w.suggestedBid.rationale}</div>
                </div>
              )}
              <div className="mt-2.5">
                <ClaimButton
                  leagueId={data.id}
                  target={w}
                  waivers={data.league.waivers}
                  roster={data.roster}
                  rosterFull={data.rosterFull}
                  onDone={onDone}
                />
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[15px] font-semibold tabular-nums text-[var(--accent)]">{w.score.toFixed(1)}</div>
              <div className="text-[10px] text-[var(--muted)]">priority</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TradesTab({ data, onDone }: { data: LeagueDetail; onDone: () => void }) {
  if (!data.trades.length) {
    return <Empty>No trade currently improves both rosters. Check back after injuries or bye weeks shake things up.</Empty>;
  }
  return (
    <div className="space-y-2">
      {data.trades.map((t, i) => (
        <div key={i} className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-[var(--muted)]">with</span>
            <span className="text-[14px] font-semibold">{t.partner.name}</span>
            <Pill tone={t.likelihood === "likely" ? "accent" : t.likelihood === "plausible" ? "info" : "warn"}>
              {t.likelihood}
            </Pill>
            <Pill>{(t.fairness * 100).toFixed(0)}% even</Pill>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-[var(--danger)]/25 bg-[var(--danger)]/[0.06] p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--danger)]">You give</div>
              {t.give.map((p, j) => (
                <div key={j} className="text-[13px]">{p.name} <span className="text-[var(--muted)]">{p.position} · {p.team}</span></div>
              ))}
            </div>
            <div className="rounded-lg border border-[var(--accent)]/25 bg-[var(--accent)]/[0.06] p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">You get</div>
              {t.receive.map((p, j) => (
                <div key={j} className="text-[13px]">{p.name} <span className="text-[var(--muted)]">{p.position} · {p.team}</span></div>
              ))}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 text-[12px] text-[var(--muted)]">
            <span>You <span className="text-[var(--accent)]">+{t.myGain.toFixed(1)}</span> pts/wk</span>
            <span>Them <span className="text-[var(--info)]">+{t.theirGain.toFixed(1)}</span> pts/wk</span>
          </div>
          <div className="mt-1.5 text-[12px] leading-snug text-[var(--muted)]">{t.rationale[1]}</div>
          <div className="mt-2.5">
            <TradeButton leagueId={data.id} trade={t} onDone={onDone} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, tone = "muted" }: { label: string; value: string; tone?: "muted" | "accent" }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">{label}</div>
      <div className={`mt-0.5 text-[22px] font-semibold tabular-nums ${tone === "accent" ? "text-[var(--accent)]" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--line)] p-6 text-center text-[13px] text-[var(--muted)]">
      {children}
    </div>
  );
}
