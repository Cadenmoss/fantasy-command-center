"use client";

import { useState } from "react";
import type { LeagueDetail } from "./types.ts";
import { Pill } from "./atoms.tsx";
import { TradeButton } from "./Actions.tsx";

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <span className="inline-flex h-2 w-full max-w-[220px] overflow-hidden rounded-full bg-[var(--line)]">
      <span className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: tone }} />
    </span>
  );
}

/** This week's win probability, and the swaps that raise it. */
export function MatchupCard({ data }: { data: LeagueDetail }) {
  const m = data.matchup;
  if (!m) return null;
  const wp = m.winProbability * 100;
  const tone = wp >= 60 ? "var(--accent)" : wp >= 45 ? "var(--warn)" : "var(--danger)";

  return (
    <div className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] text-[var(--muted)]">
          vs <span className="font-semibold text-[var(--text)]">{m.opponent.name}</span>
        </span>
        <span className="text-[22px] font-bold tabular-nums" style={{ color: tone }}>
          {wp.toFixed(0)}%
          <span className="ml-1 text-[12px] font-normal text-[var(--muted)]">to win</span>
        </span>
      </div>
      <div className="mt-2"><Bar pct={wp} tone={tone} /></div>
      <div className="mt-2 text-[12px] text-[var(--muted)]">
        you {m.me.mean.toFixed(1)} ±{m.me.sigma.toFixed(1)} · them {m.them.mean.toFixed(1)} ±{m.them.sigma.toFixed(1)}
      </div>
      <div className="mt-2 text-[13px] leading-relaxed">{m.advice}</div>

      {m.leverageMoves.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {m.leverageMoves.map((lv, i) => (
            <div key={i} className="rounded-lg border border-[var(--info)]/30 bg-[var(--info)]/[0.06] p-2.5 text-[12px]">
              <div>
                <span className="font-semibold">{lv.slot}:</span> start {lv.inName} over {lv.outName}{" "}
                <span className="text-[var(--muted)]">
                  ({lv.pointsDelta >= 0 ? "+" : ""}{lv.pointsDelta} pts,{" "}
                  <span className="text-[var(--accent)]">{lv.winProbDelta >= 0 ? "+" : ""}{lv.winProbDelta}% win</span>)
                </span>
              </div>
              <div className="text-[var(--muted)]">{lv.reason}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Playoff and title odds from the season simulation. */
export function SeasonCard({ data }: { data: LeagueDetail }) {
  const s = data.season;
  const avoidLast = data.avoidLast;
  const [open, setOpen] = useState(false);
  if (!s) return null;

  return (
    <div className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {s.everyoneQualifies ? (
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">Projected seed</div>
            <div className="text-[20px] font-bold tabular-nums text-[var(--accent)]">
              {s.me.meanSeed.toFixed(1)}
              <span className="ml-1 text-[12px] font-normal text-[var(--muted)]">of {s.odds.length}</span>
            </div>
            {s.byeSeeds > 0 && (
              <div className="text-[11px] text-[var(--muted)]">
                first-round bye {s.me.firstRoundBye.toFixed(0)}%
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">Playoffs</div>
            <div className="text-[20px] font-bold tabular-nums text-[var(--accent)]">
              {s.me.makePlayoffs.toFixed(1)}%
            </div>
            <Bar pct={s.me.makePlayoffs} tone="var(--accent)" />
          </div>
        )}
        {avoidLast ? (
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">Last place</div>
            <div className="text-[20px] font-bold tabular-nums text-[var(--danger)]">{s.me.finishLast.toFixed(1)}%</div>
            <Bar pct={s.me.finishLast} tone="var(--danger)" />
          </div>
        ) : (
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">Title</div>
            <div className="text-[20px] font-bold tabular-nums text-[var(--info)]">{s.me.winTitle.toFixed(1)}%</div>
            <Bar pct={s.me.winTitle} tone="var(--info)" />
          </div>
        )}
        <div className="min-w-[150px]" hidden={s.everyoneQualifies && !avoidLast}>
          <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">This week is worth</div>
          <div className="text-[20px] font-bold tabular-nums text-[var(--warn)]">
            {(avoidLast ? s.thisWeekLastSwing : s.thisWeekSwing).toFixed(1)}%
          </div>
          <div className="text-[11px] text-[var(--muted)]">
            {avoidLast ? "of last-place odds, lose vs win" : "of playoff odds, win vs lose"}
          </div>
        </div>
      </div>

      <div className="mt-2 text-[12px] leading-relaxed text-[var(--text)]">{s.objective}</div>

      <button
        onClick={() => setOpen(!open)}
        className="mt-3 text-[12px] text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline"
      >
        {open ? "Hide" : "Show"} league table ({s.simulations.toLocaleString()} sims · top {s.playoffSpots} advance)
      </button>

      {open && (
        <div className="mt-2 overflow-hidden rounded-lg border border-[var(--line)]">
          {s.odds.map((o, i) => (
            <div
              key={o.teamId}
              className={`flex items-center gap-2 border-b border-[var(--line)] px-2.5 py-1.5 text-[12px] last:border-0 ${
                o.isMe ? "bg-[var(--accent)]/[0.08]" : ""
              }`}
            >
              <span className="w-5 text-[var(--muted)] tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{o.name}{o.isMe && " ←"}</span>
              <span className="w-14 text-right tabular-nums">{o.makePlayoffs.toFixed(0)}%</span>
              <span className="w-12 text-right tabular-nums text-[var(--muted)]" title={avoidLast ? "last place" : "title"}>
                {(avoidLast ? o.finishLast : o.winTitle).toFixed(0)}%
              </span>
              <span className="w-14 text-right tabular-nums text-[var(--muted)]">{o.meanScore.toFixed(0)}/wk</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Opponent weaknesses and the trades that exploit them. */
export function ExploitTab({ data, onDone }: { data: LeagueDetail; onDone: () => void }) {
  const [copied, setCopied] = useState<number | null>(null);

  return (
    <div className="space-y-4">
      {data.weaknesses.length > 0 && (
        <div>
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            Where your leaguemates are weak
          </h3>
          <div className="space-y-1.5">
            {data.weaknesses.slice(0, 5).map((w) => (
              <div key={w.team.id} className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">{w.team.name}</span>
                  <Pill>{w.record}</Pill>
                  {w.desperation >= 6 && <Pill tone="warn">motivated to deal</Pill>}
                </div>
                <div className="mt-1 text-[12px] text-[var(--muted)]">{w.readAloud}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Trades that favour you
        </h3>
        {!data.exploits.length ? (
          <div className="rounded-xl border border-dashed border-[var(--line)] p-6 text-center text-[13px] text-[var(--muted)]">
            No lopsided trade is available right now. These appear when someone has a hole you can fill
            and a bench asset they can&apos;t use.
          </div>
        ) : (
          <div className="space-y-2">
            {data.exploits.map((t, i) => (
              <div key={i} className="rounded-xl border border-[var(--info)]/30 bg-[var(--panel)] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold">{t.partner.name}</span>
                  <Pill tone={t.likelihood === "likely" ? "accent" : t.likelihood === "plausible" ? "info" : "warn"}>
                    {t.likelihood}
                  </Pill>
                  <span className="ml-auto text-[13px] font-bold tabular-nums text-[var(--accent)]">
                    edge +{t.edge.toFixed(1)}
                  </span>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-[var(--danger)]/25 bg-[var(--danger)]/[0.06] p-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--danger)]">You give</div>
                    {t.give.map((p) => (
                      <div key={p.id} className="text-[13px]">{p.name} <span className="text-[var(--muted)]">{p.position}</span></div>
                    ))}
                  </div>
                  <div className="rounded-lg border border-[var(--accent)]/25 bg-[var(--accent)]/[0.06] p-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">You get</div>
                    {t.receive.map((p) => (
                      <div key={p.id} className="text-[13px]">{p.name} <span className="text-[var(--muted)]">{p.position}</span></div>
                    ))}
                  </div>
                </div>

                <div className="mt-2 space-y-1 text-[12px] text-[var(--muted)]">
                  <div><span className="text-[var(--info)]">Why they accept:</span> {t.whyTheySayYes}</div>
                  <div><span className="text-[var(--accent)]">Why you want it:</span> {t.whyItsGoodForMe}</div>
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <TradeButton
                    leagueId={data.id}
                    trade={{
                      partner: t.partner,
                      give: t.give,
                      receive: t.receive,
                      myGain: t.myValueGain,
                      theirGain: t.theirLineupGain,
                      fairness: 0.5,
                      likelihood: t.likelihood,
                      rationale: [t.whyTheySayYes, t.whyItsGoodForMe],
                    }}
                    onDone={onDone}
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(t.pitch).catch(() => {});
                      setCopied(i);
                      setTimeout(() => setCopied(null), 1500);
                    }}
                    className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-[12px] text-[var(--muted)] transition hover:text-[var(--text)]"
                  >
                    {copied === i ? "Copied" : "Copy message"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
