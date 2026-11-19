import { NextResponse } from "next/server";
import { loadConfig, configProblems } from "@/lib/config";
import { analyzeLeague } from "@/lib/engine/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) return NextResponse.json({ problems, leagues: [] }, { status: 400 });

  const url = new URL(req.url);
  const light = url.searchParams.get("light") === "1";

  const results = await Promise.all(
    cfg.leagues.map(async (lc) => {
      try {
        const a = await analyzeLeague(cfg, lc, {
          includeWaivers: !light,
          includeTrades: !light,
          includeByes: !light,
          includeSeason: !light,
          includeExploits: !light,
        });
        return {
          ok: true as const,
          id: lc.id,
          name: a.league.name,
          label: lc.name,
          week: a.league.week,
          autoLineup: lc.autoLineup,
          record: `${a.myTeam.wins}-${a.myTeam.losses}`,
          teamName: a.myTeam.name,
          gain: a.lineup.gain,
          moveCount: a.lineup.moves.length,
          currentProjected: a.lineup.currentProjected,
          optimalProjected: a.lineup.optimalProjected,
          rationale: a.lineup.rationale,
          warnings: a.lineup.warnings,
          dataNotes: a.dataNotes,
          topWaiver: a.waivers[0]?.player.name,
          waiverCount: a.waivers.length,
          tradeCount: a.trades.length,
        };
      } catch (err) {
        return { ok: false as const, id: lc.id, label: lc.name, error: (err as Error).message };
      }
    }),
  );

  return NextResponse.json({ problems: [], leagues: results });
}
