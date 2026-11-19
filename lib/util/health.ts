import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { notify } from "./notify.ts";

const DIR = process.env.VERCEL ? path.join(os.tmpdir(), "ffcc") : path.join(process.cwd(), "data");
const FILE = path.join(DIR, "health.json");

export type Subsystem =
  | "espn-auth"
  | "espn-projections"
  | "fantasypros"
  | "sleeper"
  | "nfl-schedule"
  | "lineup-write"
  | "scheduler";

export type Check = {
  subsystem: Subsystem;
  ok: boolean;
  detail: string;
  /** How badly this hurts decisions if it stays broken. */
  severity: "critical" | "degraded" | "minor";
};

type State = {
  /** Consecutive failures, so a single blip does not page you. */
  streak: number;
  ok: boolean;
  /** Whether we have already told the user about the current outage. */
  alerted: boolean;
  since: string;
  lastDetail: string;
};

type HealthFile = {
  states: Record<string, State>;
  lastRunAt?: string;
  lastRunOk?: boolean;
};

function read(): HealthFile {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as HealthFile;
  } catch {
    return { states: {} };
  }
}

function write(h: HealthFile) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(h, null, 2));
  } catch {
    // Health tracking must never break the run it is monitoring.
  }
}

/** How many consecutive failures before we bother you. */
const THRESHOLD: Record<Check["severity"], number> = {
  critical: 1,   // auth and writes are worth knowing about immediately
  degraded: 2,   // a source that blips once is usually just a slow endpoint
  minor: 3,
};

const LABEL: Record<Subsystem, string> = {
  "espn-auth": "ESPN login",
  "espn-projections": "ESPN projections",
  fantasypros: "Expert consensus",
  sleeper: "Sleeper market data",
  "nfl-schedule": "NFL schedule & betting lines",
  "lineup-write": "Lineup submission",
  scheduler: "Scheduler",
};

/**
 * Records the result of each subsystem and alerts on *changes*, not on every run.
 *
 * The failure mode that actually costs you points is silent: expert rankings stop
 * resolving, the app quietly falls back to ESPN-only, and the lineups keep being
 * set — slightly worse — every week without anyone noticing. So a source that
 * goes down raises one alert, stays quiet while it is still down, and raises one
 * more when it recovers. Alerting every run would train you to ignore it.
 */
export async function recordHealth(checks: Check[]): Promise<{ alerts: string[]; recovered: string[] }> {
  const h = read();
  const alerts: string[] = [];
  const recovered: string[] = [];
  const now = new Date().toISOString();

  for (const c of checks) {
    const prev = h.states[c.subsystem] ?? { streak: 0, ok: true, alerted: false, since: now, lastDetail: "" };

    if (c.ok) {
      if (!prev.ok && prev.alerted) {
        recovered.push(`${LABEL[c.subsystem]} is working again`);
      }
      h.states[c.subsystem] = { streak: 0, ok: true, alerted: false, since: now, lastDetail: c.detail };
      continue;
    }

    const streak = prev.streak + 1;
    const shouldAlert = streak >= THRESHOLD[c.severity] && !prev.alerted;
    if (shouldAlert) {
      alerts.push(`${LABEL[c.subsystem]}: ${c.detail}`);
    }
    h.states[c.subsystem] = {
      streak,
      ok: false,
      alerted: prev.alerted || shouldAlert,
      since: prev.ok ? now : prev.since,
      lastDetail: c.detail,
    };
  }

  h.lastRunAt = now;
  h.lastRunOk = checks.every((c) => c.ok || c.severity === "minor");
  write(h);

  // One notification per run, however many things changed.
  if (alerts.length) {
    await notify(
      "Fantasy Command Center",
      alerts.slice(0, 2).join(" · ") + (alerts.length > 2 ? ` (+${alerts.length - 2} more)` : ""),
      alerts.length === 1 ? "Something needs your attention" : `${alerts.length} problems`,
    );
  } else if (recovered.length) {
    await notify("Fantasy Command Center", recovered.join(" · "), "Back to normal");
  }

  return { alerts, recovered };
}

export function currentHealth(): { states: Record<string, State>; lastRunAt?: string } {
  const h = read();
  return { states: h.states, lastRunAt: h.lastRunAt };
}

/**
 * Warns when the scheduler itself has gone quiet.
 *
 * Every other check runs *inside* a run, so none of them can fire if the run
 * never happens — a Mac that slept through Sunday morning looks exactly like a
 * week where nothing needed changing.
 */
export async function checkHeartbeat(maxHoursQuiet = 96): Promise<string | null> {
  const h = read();
  if (!h.lastRunAt) return null;
  const hours = (Date.now() - new Date(h.lastRunAt).getTime()) / 3_600_000;
  if (hours < maxHoursQuiet) return null;

  const msg =
    `No lineup run in ${Math.floor(hours)} hours. Check that your Mac stayed awake ` +
    `and you were logged in.`;
  await notify("Fantasy Command Center", msg, "Scheduler may have stopped");
  return msg;
}
