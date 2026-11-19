import { NextResponse } from "next/server";
import { runAutoLineup } from "@/lib/engine/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Manual "apply now" from the dashboard, and the propose-only approval path. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { leagueId, dryRun } = body as { leagueId?: string; dryRun?: boolean };

  const { outcomes, problems } = await runAutoLineup({
    dryRun: !!dryRun,
    onlyLeagueId: leagueId,
    // An explicit click is approval, so honor it even for propose-only leagues.
    forceApply: true,
    // A click in the dashboard is a supervised, user-initiated write.
    supervised: !!leagueId,
  });

  if (problems.length) return NextResponse.json({ problems }, { status: 400 });
  return NextResponse.json({ outcomes });
}
