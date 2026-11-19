import { NextResponse } from "next/server";
import { submitTrade } from "@/lib/engine/transact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Sends a real offer to another manager, so it only ever runs on an explicit click. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { leagueId, partnerTeamId, givePlayerIds, receivePlayerIds, dryRun } = body;

  if (!leagueId || partnerTeamId === undefined || !givePlayerIds?.length || !receivePlayerIds?.length) {
    return NextResponse.json(
      { ok: false, error: "leagueId, partnerTeamId, givePlayerIds and receivePlayerIds are required" },
      { status: 400 },
    );
  }

  try {
    const outcome = await submitTrade({ leagueId, partnerTeamId, givePlayerIds, receivePlayerIds, dryRun });
    return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
