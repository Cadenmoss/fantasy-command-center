import { NextResponse } from "next/server";
import { declineOffer } from "@/lib/engine/transact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const { leagueId, transactionId } = await req.json().catch(() => ({}));
  if (!leagueId || !transactionId) {
    return NextResponse.json({ ok: false, error: "leagueId and transactionId are required" }, { status: 400 });
  }
  try {
    const outcome = await declineOffer(leagueId, transactionId);
    return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
