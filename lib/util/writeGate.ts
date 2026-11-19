import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ESPN's write endpoints are undocumented, so each transaction type must earn
 * its own first supervised success before unattended or bulk use is allowed.
 *
 * Gates are per-type on purpose: a verified ROSTER (lineup) write proves nothing
 * about whether the TRADE_PROPOSAL body is correct, and a trade offer goes to
 * another human.
 */
export type WriteKind = "roster" | "freeagent" | "trade";

const DIR = process.env.VERCEL ? path.join(os.tmpdir(), "ffcc") : path.join(process.cwd(), "data");

function marker(kind: WriteKind) {
  return path.join(DIR, `.write-verified-${kind}`);
}

export function isWriteValidated(kind: WriteKind): boolean {
  if (process.env.FFCC_SKIP_WRITE_GATE === "1") return true;
  try {
    if (fs.existsSync(marker(kind))) return true;
    // Migrate the original single marker, which only ever covered lineups.
    if (kind === "roster" && fs.existsSync(path.join(DIR, ".write-verified"))) return true;
    return false;
  } catch {
    return false;
  }
}

export function markWriteValidated(kind: WriteKind, detail: string) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(marker(kind), `${new Date().toISOString()}\n${detail}\n`);
  } catch {
    // Failing to record the marker just means you validate once more; harmless.
  }
}

const HELP: Record<WriteKind, string> = {
  roster:
    "The lineup write path has not been validated on this machine yet.\n" +
    "  Run one supervised league first:\n" +
    "    npm run lineup -- --league <leagueId> --confirm",
  freeagent:
    "No add/drop has been confirmed on this machine yet. Send a single claim from " +
    "the dashboard and check the result before using bulk actions.",
  trade:
    "No trade offer has been confirmed on this machine yet. Send a single offer from " +
    "the dashboard and check that it appears on ESPN's trade page.",
};

export function writeGateHelp(kind: WriteKind): string {
  return HELP[kind];
}
