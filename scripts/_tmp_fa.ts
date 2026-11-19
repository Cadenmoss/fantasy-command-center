import { loadConfig } from "../lib/config.ts";
import { fetchLeague, fetchFreeAgents } from "../lib/espn/client.ts";
import { buildContext, evaluate } from "../lib/projections/blend.ts";
const cfg = loadConfig();
const auth = { swid: cfg.swid, espnS2: cfg.espnS2 };
for (const name of ["Multiple Mossy's", "Meyer Den 2026-2027"]) {
  const lc = cfg.leagues.find((l) => l.name === name)!;
  const league = await fetchLeague(auth, cfg.season, lc.id, lc.teamId);
  const ctx = await buildContext(league);
  const fas = await fetchFreeAgents(auth, cfg.season, lc.id, league.week, 300);
  const me = league.teams.find((t) => t.id === lc.teamId)!;
  const v = evaluate([...league.teams.flatMap((t) => t.roster), ...fas], ctx);
  console.log(`\n=== ${name} week ${league.week} waiverRank=${me.waiverRank} roster=${me.roster.length}`);
  console.log("settings:", JSON.stringify((league as any).waiver ?? (league as any).waivers ?? {}), "keys", Object.keys(league).join(","));
  for (const pos of ["WR", "D/ST", "K", "TE", "RB"]) {
    const rows = fas.filter((p) => p.position === pos).map((p) => ({ p, v: v.get(p.id)! })).filter((r) => r.v && !r.v.onBye && !r.v.unplayable).sort((a, b) => b.v.points - a.v.points).slice(0, 8);
    console.log(` -- ${pos}`);
    for (const { p, v } of rows) console.log(`   ${p.name} ${p.team} ${p.acquisitionStatus} proc=${p.waiverProcessDate ? new Date(p.waiverProcessDate).toISOString() : "-"} own=${p.percentOwned.toFixed(0)}% inj=${p.injuryStatus} proj=${v.points.toFixed(1)} espn=${v.espnPoints.toFixed(1)} ${v.reasons.slice(0,2).join("; ")}`);
  }
}
