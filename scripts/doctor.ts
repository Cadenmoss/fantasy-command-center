/**
 * On-demand health check of everything the app depends on.
 *   npm run doctor
 */
import { loadConfig, configProblems } from "../lib/config.ts";
import { fetchLeague } from "../lib/espn/client.ts";
import { fetchWeekSchedule } from "../lib/projections/schedule.ts";
import { fetchFantasyPros, fetchSleeper } from "../lib/projections/sources.ts";
import { recordHealth, currentHealth, type Check } from "../lib/util/health.ts";
import { readCalibration } from "../lib/learning/calibrate.ts";
import { readJournal } from "../lib/learning/journal.ts";

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s: string, d = "") => console.log(`  ${C.g}✓${C.x} ${s}${d ? ` ${C.d}${d}${C.x}` : ""}`);
const bad = (s: string, d = "") => console.log(`  ${C.r}✗${C.x} ${s}${d ? ` ${C.d}${d}${C.x}` : ""}`);
const warn = (s: string, d = "") => console.log(`  ${C.y}!${C.x} ${s}${d ? ` ${C.d}${d}${C.x}` : ""}`);

console.log(`\n${C.b}Fantasy Command Center — health check${C.x}\n`);
const checks: Check[] = [];
const cfg = loadConfig();

const problems = configProblems(cfg);
if (problems.length) { problems.forEach((p) => bad(p)); process.exit(1); }

// --- ESPN -------------------------------------------------------------------
console.log(`${C.b}ESPN${C.x}`);
let authOk = true;
let anyProjections = false;
for (const lc of cfg.leagues) {
  try {
    const l = await fetchLeague({ swid: cfg.swid, espnS2: cfg.espnS2 }, cfg.season, lc.id, lc.teamId);
    const me = l.teams.find((t) => t.id === lc.teamId);
    const nz = me?.roster.filter((p) => p.espnProjection > 0).length ?? 0;
    if (nz > 0) anyProjections = true;
    if (nz === 0) bad(`${l.name.trim()}: every projection read as zero`, "payload shape may have changed");
    else ok(`${l.name.trim()}`, `week ${l.week}, ${nz}/${me?.roster.length} projections`);
  } catch (err) {
    authOk = false;
    bad(`${lc.name}: ${(err as Error).message}`);
  }
}
checks.push({ subsystem: "espn-auth", ok: authOk, detail: authOk ? "authenticated" : "ESPN login expired — re-copy espn_s2", severity: "critical" });
checks.push({ subsystem: "espn-projections", ok: anyProjections, detail: anyProjections ? "parsed" : "all projections zero", severity: "critical" });

// --- data sources -----------------------------------------------------------
console.log(`\n${C.b}Data sources${C.x}`);
const [sched, fp, sl] = await Promise.all([
  fetchWeekSchedule(cfg.season, 3).catch(() => null),
  fetchFantasyPros(cfg.season, 3, "PPR", cfg.fantasyProsKey).catch(() => null),
  fetchSleeper().catch(() => null),
]);

if (sched?.ok) ok("NFL schedule & betting lines", `${sched.games.size / 2} games`);
else warn("NFL schedule/odds unreachable", "byes and kickoff locks degraded");
checks.push({ subsystem: "nfl-schedule", ok: !!sched?.ok, detail: sched?.ok ? "ok" : "unreachable — byes and kickoff locks not detected", severity: "degraded" });

if (fp?.ok) ok("Expert consensus", `${fp.ranks.size} ranked${fp.note ? ` (${fp.note})` : ""}`);
else bad("Expert consensus unavailable", `${fp?.note ?? "unknown"} — lineups would run on ESPN only`);
checks.push({ subsystem: "fantasypros", ok: !!fp?.ok, detail: fp?.ok ? "ok" : `unavailable (${fp?.note ?? "unknown"}) — running on ESPN + market only`, severity: "degraded" });

if (sl?.ok) ok("Sleeper market data", `${sl.ranks.size} players`);
else warn("Sleeper unreachable");
checks.push({ subsystem: "sleeper", ok: !!sl?.ok, detail: sl?.ok ? "ok" : "unreachable", severity: "minor" });

// --- automation -------------------------------------------------------------
console.log(`\n${C.b}Automation${C.x}`);
const h = currentHealth();
if (h.lastRunAt) {
  const hrs = (Date.now() - new Date(h.lastRunAt).getTime()) / 3_600_000;
  if (hrs > 96) bad(`Last lineup run was ${Math.floor(hrs)}h ago`, "scheduler may have stopped");
  else ok(`Last lineup run ${hrs < 1 ? "under an hour" : `${Math.floor(hrs)}h`} ago`);
} else {
  warn("No lineup run recorded yet");
}

// --- learning ---------------------------------------------------------------
console.log(`\n${C.b}Learning${C.x}`);
const cal = readCalibration();
const journal = readJournal();
const pending = journal.filter((r) => r.actual === undefined).length;
if (!cal || cal.sampleSize < 60) {
  ok(`Recording predictions`, `${journal.length} logged, ${pending} awaiting results (needs ~60 graded)`);
} else {
  ok(`Calibrated`, `${cal.sampleSize} graded, error ${cal.baselineMae.toFixed(2)} → ${cal.calibratedMae.toFixed(2)} pts`);
  if (cal.calibratedMae > cal.baselineMae + 0.25) bad("Calibration is not improving accuracy", "a source may have changed");
}

// --- persist and summarise --------------------------------------------------
const { alerts } = await recordHealth(checks);
const failing = checks.filter((c) => !c.ok);
console.log(
  failing.length
    ? `\n${C.r}${failing.length} problem(s) found.${C.x}${alerts.length ? ` ${C.d}Notification sent.${C.x}` : ` ${C.d}(already alerted)${C.x}`}\n`
    : `\n${C.g}Everything healthy.${C.x}\n`,
);
process.exit(failing.some((c) => c.severity === "critical") ? 1 : 0);
