import { NextResponse } from "next/server";
import { readCalibration, PRIORS } from "@/lib/learning/calibrate";
import { readJournal } from "@/lib/learning/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cal = readCalibration();
  const journal = readJournal();
  const pending = journal.filter((r) => r.actual === undefined).length;

  return NextResponse.json({
    calibration: cal,
    priors: { expertWeight: PRIORS.expertWeight, vegasStrength: PRIORS.vegasStrength },
    recorded: journal.length,
    awaitingResults: pending,
    threshold: 60,
  });
}
