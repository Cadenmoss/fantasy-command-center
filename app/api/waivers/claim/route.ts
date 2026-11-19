import { NextResponse } from "next/server";
import { submitClaim } from "@/lib/engine/transact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { leagueId, addPlayerId, dropPlayerId, bidAmount, dryRun, overrideProtection } = body;

  if (!leagueId || !addPlayerId) {
    return NextResponse.json({ ok: false, error: "leagueId and addPlayerId are required" }, { status: 400 });
  }

  try {
    const outcome = await submitClaim({
      leagueId, addPlayerId, dropPlayerId, bidAmount, dryRun, overrideProtection,
    });
    // A blocked drop is a deliberate refusal, not a server failure.
    return NextResponse.json(outcome, { status: outcome.blocked ? 409 : outcome.ok ? 200 : 502 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
