/**
 * Setup check. Confirms your cookies work, lists every team in every league so
 * you can find your own teamId, and reports which expert sources are reachable.
 *
 *   npm run verify
 */
import { loadConfig, configProblems } from "../lib/config.ts";
import { fetchLeague, fetchRawLeague, EspnError } from "../lib/espn/client.ts";
import { fetchWeekSchedule } from "../lib/projections/schedule.ts";
import { fetchFantasyPros, fetchSleeper } from "../lib/projections/sources.ts";

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s: string) => console.log(`${C.g}✓${C.x} ${s}`);
const bad = (s: string) => console.log(`${C.r}✗${C.x} ${s}`);
const warn = (s: string) => console.log(`${C.y}!${C.x} ${s}`);

const cfg = loadConfig();
console.log(`\n${C.b}Fantasy Command Center — setup check${C.x}`);
console.log(`${C.d}season ${cfg.season}${C.x}\n`);

const problems = configProblems(cfg);
if (problems.length) {
  problems.forEach(bad);
  console.log(`\n${C.d}Fill these in .env.local, then rerun: npm run verify${C.x}\n`);
  process.exit(1);
}
ok(`Credentials present (SWID ${cfg.swid.slice(0, 10)}…)`);

let hardFail = false;

for (const lc of cfg.leagues) {
  console.log(`\n${C.b}${lc.name}${C.x} ${C.d}(id ${lc.id})${C.x}`);
  try {
    const league = await fetchLeague(
      { swid: cfg.swid, espnS2: cfg.espnS2 },
      cfg.season, lc.id, lc.teamId,
    );
    ok(`"${league.name}" — week ${league.week}, ${league.teams.length} teams, ${league.scoringType}`);

    const slots = Object.entries(league.lineupSlotCounts)
      .map(([id, n]) => `${n}x${id}`).join(" ");
    console.log(`  ${C.d}starting slots: ${slots}${C.x}`);

    const mine = league.teams.find((t) => t.id === lc.teamId);
    if (mine) {
      ok(`Your team: ${mine.name} (${mine.wins}-${mine.losses}), ${mine.roster.length} players`);
    } else {
      bad(`teamId ${lc.teamId} is NOT in this league. Pick yours from below and fix .env.local:`);
      hardFail = true;
    }
    for (const t of league.teams) {
      const me = t.id === lc.teamId ? `${C.g} ← you${C.x}` : "";
      console.log(`    ${C.d}teamId ${String(t.id).padStart(2)}${C.x}  ${t.name}${me}`);
    }

    // Projections are the foundation of every decision this app makes. If our
    // reading of ESPN's stats array is wrong, every player silently reads 0.0
    // and the "optimal" lineup would be arbitrary. Fail loudly here instead.
    if (mine) {
      const withProj = mine.roster.filter((p) => p.espnProjection > 0);
      if (withProj.length === 0) {
        hardFail = true;
        bad(`Every projection on your roster read 0.0 — ESPN's payload shape has changed.`);
        try {
          const raw = await fetchRawLeague({ swid: cfg.swid, espnS2: cfg.espnS2 }, cfg.season, lc.id, league.week);
          const sample = raw.teams?.find((t) => t.id === lc.teamId)?.roster?.entries?.[0]?.playerPoolEntry?.player;
          console.log(`  ${C.d}Raw stats for ${sample?.fullName ?? "first player"} (week ${league.week}):${C.x}`);
          console.log(`  ${C.d}${JSON.stringify(sample?.stats?.slice(0, 6) ?? [], null, 2).split("\n").join(`\n  `)}${C.x}`);
          console.log(`  ${C.d}Expected an entry with scoringPeriodId=${league.week}, statSourceId=1.${C.x}`);
          console.log(`  ${C.d}Adjust statFor() in lib/espn/client.ts to match.${C.x}`);
        } catch { /* the outer error already told the user enough */ }
      } else {
        const top = [...mine.roster].sort((a, b) => b.espnProjection - a.espnProjection)[0];
        ok(`Projections parsed (${withProj.length}/${mine.roster.length} non-zero; top: ${top.name} ${top.espnProjection})`);
      }
    }
  } catch (err) {
    hardFail = true;
    const e = err as EspnError;
    bad(e.message);
    if (e.status === 401) {
      console.log(`  ${C.d}Re-copy espn_s2 and SWID from your browser — they expire.${C.x}`);
    }
  }
}

console.log(`\n${C.b}Expert data sources${C.x}`);
const [sched, fp, sl] = await Promise.all([
  fetchWeekSchedule(cfg.season, 1).catch(() => null),
  fetchFantasyPros(cfg.season, 1, "PPR", cfg.fantasyProsKey).catch(() => null),
  fetchSleeper().catch(() => null),
]);

if (sched?.ok) ok(`NFL schedule + Vegas lines (${sched.games.size / 2} games)`);
else warn("NFL schedule/odds unreachable — bye + kickoff-lock detection degraded");

if (fp?.ok) ok(`FantasyPros expert consensus (${fp.ranks.size} entries)${fp.note ? ` ${C.d}${fp.note}${C.x}` : ""}`);
else warn(`FantasyPros unreachable${fp?.note ? `: ${fp.note}` : ""} — set FANTASYPROS_API_KEY for a stable feed`);

if (sl?.ok) ok(`Sleeper market data (${sl.ranks.size} players)`);
else warn("Sleeper unreachable");

console.log(
  hardFail
    ? `\n${C.r}Fix the errors above before running the auto-lineup.${C.x}\n`
    : `\n${C.g}All good.${C.x} Next: ${C.b}npm run lineup:dry${C.x}\n`,
);
process.exit(hardFail ? 1 : 0);
