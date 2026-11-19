import { NextResponse } from "next/server";
import { fetchIncomingOffers } from "@/lib/engine/transact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Trade offers other managers have sent you, scored by the same engine. */
export async function GET() {
  try {
    return NextResponse.json({ offers: await fetchIncomingOffers() });
  } catch (err) {
    return NextResponse.json({ offers: [], error: (err as Error).message }, { status: 502 });
  }
}
