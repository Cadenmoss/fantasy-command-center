import { NextResponse } from "next/server";
import { buildScorecards } from "@/lib/engine/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  try {
    return NextResponse.json({ scorecards: await buildScorecards() });
  } catch (err) {
    return NextResponse.json({ scorecards: [], error: (err as Error).message }, { status: 502 });
  }
}
