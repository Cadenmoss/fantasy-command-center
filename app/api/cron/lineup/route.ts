import { NextResponse } from "next/server";
import { runAutoLineup } from "@/lib/engine/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Scheduled auto-lineup. Runs Thu/Sun/Mon before kickoff.
 * Protected by CRON_SECRET so a public URL can't move your lineup.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const qs = new URL(req.url).searchParams.get("secret");
    if (auth !== `Bearer ${secret}` && qs !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const { outcomes, problems } = await runAutoLineup({ dryRun });
  if (problems.length) return NextResponse.json({ problems }, { status: 409 });

  return NextResponse.json({ ranAt: new Date().toISOString(), dryRun, outcomes });
}
