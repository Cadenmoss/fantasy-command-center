import { NextResponse } from "next/server";
import { loadConfig, configProblems } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = loadConfig();
  return NextResponse.json({
    season: cfg.season,
    configured: configProblems(cfg).length === 0,
    problems: configProblems(cfg),
    leagues: cfg.leagues.map((l) => ({
      id: l.id, name: l.name, teamId: l.teamId, autoLineup: l.autoLineup,
    })),
    hasFantasyProsKey: !!cfg.fantasyProsKey,
  });
}
