export function Pill({
  tone = "muted", children,
}: { tone?: "muted" | "accent" | "warn" | "danger" | "info"; children: React.ReactNode }) {
  const map = {
    muted: "bg-[var(--panel-2)] text-[var(--muted)] border-[var(--line)]",
    accent: "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_35%,transparent)]",
    warn: "bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] text-[var(--warn)] border-[color-mix(in_srgb,var(--warn)_35%,transparent)]",
    danger: "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_35%,transparent)]",
    info: "bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-[var(--info)] border-[color-mix(in_srgb,var(--info)_35%,transparent)]",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${map[tone]}`}>
      {children}
    </span>
  );
}

export function Confidence({ value }: { value: number }) {
  const tone = value >= 0.7 ? "var(--accent)" : value >= 0.45 ? "var(--warn)" : "var(--danger)";
  return (
    <span className="inline-flex items-center gap-1.5" title={`Model confidence ${(value * 100).toFixed(0)}%`}>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-[var(--line)]">
        <span className="block h-full rounded-full" style={{ width: `${value * 100}%`, background: tone }} />
      </span>
      <span className="text-[11px] tabular-nums text-[var(--muted)]">{(value * 100).toFixed(0)}%</span>
    </span>
  );
}

export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-[var(--line)] bg-[var(--panel)] ${className}`}>{children}</div>
  );
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h3 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--muted)]">{children}</h3>
      {right}
    </div>
  );
}

export function injuryTone(status: string): "muted" | "warn" | "danger" {
  const s = (status ?? "").toUpperCase();
  if (["OUT", "INJURY_RESERVE", "SUSPENSION", "DOUBTFUL"].includes(s)) return "danger";
  if (s === "QUESTIONABLE") return "warn";
  return "muted";
}

export function shortInjury(status: string): string | null {
  const s = (status ?? "ACTIVE").toUpperCase();
  if (s === "ACTIVE" || s === "NORMAL" || !s) return null;
  return { INJURY_RESERVE: "IR", QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "OUT", SUSPENSION: "SUSP" }[s] ?? s.slice(0, 3);
}
