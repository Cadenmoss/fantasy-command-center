import { NextResponse } from "next/server";
import { currentHealth } from "@/lib/util/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const h = currentHealth();
  const hoursQuiet = h.lastRunAt
    ? (Date.now() - new Date(h.lastRunAt).getTime()) / 3_600_000
    : null;

  return NextResponse.json({
    lastRunAt: h.lastRunAt ?? null,
    hoursQuiet,
    problems: Object.entries(h.states)
      .filter(([, s]) => !s.ok)
      .map(([subsystem, s]) => ({ subsystem, detail: s.lastDetail, since: s.since, streak: s.streak })),
  });
}
