import { loadConfig, configProblems } from "@/lib/config";
import { Dashboard } from "./ui/Dashboard.tsx";
import { Setup } from "./ui/Setup.tsx";
import type { StatusResp } from "./ui/types.ts";

export const dynamic = "force-dynamic";

export default function Home() {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  const status: StatusResp = {
    season: cfg.season,
    configured: problems.length === 0,
    problems,
    leagues: cfg.leagues.map((l) => ({ id: l.id, name: l.name, teamId: l.teamId, autoLineup: l.autoLineup })),
    hasFantasyProsKey: !!cfg.fantasyProsKey,
  };

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-[26px] font-bold tracking-tight">Fantasy Command Center</h1>
        <p className="mt-1 text-[13px] text-[var(--muted)]">
          Blended projections from ESPN, expert consensus and the betting market — across all your leagues.
        </p>
      </header>

      {status.configured ? <Dashboard status={status} /> : <Setup problems={problems} season={cfg.season} />}

      <footer className="mt-10 border-t border-[var(--line)] pt-4 text-[11px] text-[var(--muted)]">
        Season {cfg.season} · start/sit runs automatically; waivers and trades are suggestions only.
      </footer>
    </main>
  );
}
