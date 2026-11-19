import { loadConfig } from "../lib/config.ts";
import { analyzeLeague } from "../lib/engine/run.ts";
import { SLOT_LABEL } from "../lib/espn/constants.ts";
const cfg = loadConfig();
for (const lc of cfg.leagues.filter((l) => !l.avoidLast)) {
  const a = await analyzeLeague(cfg, lc, { includeWaivers: false, includeTrades: false, includeSeason: false, includeExploits: false, includeByes: false });
  console.log(`\n===== ${lc.name} wk${a.league.week} ${a.myTeam.name} ${a.myTeam.wins}-${a.myTeam.losses} slots=${JSON.stringify(a.league.lineupSlotCounts)}`);
  console.log("CURRENT:");
  for (const s of a.lineup.current) console.log(`  ${s.slotLabel.padEnd(6)} ${s.player ? `${s.player.name} (${s.player.position} ${s.player.team}) inj=${s.player.injuryStatus} proj=${s.verdict?.points.toFixed(1)} espn=${s.verdict?.espnPoints.toFixed(1)} locked=${s.locked} bye=${s.verdict?.onBye} unplay=${s.verdict?.unplayable}` : "EMPTY"}`);
  console.log("BENCH/IR:");
  for (const p of a.myTeam.roster.filter((p) => [20, 21].includes(p.lineupSlotId))) {
    const v = a.verdicts.get(p.id);
    console.log(`  ${SLOT_LABEL[p.lineupSlotId]} ${p.name} (${p.position} ${p.team}) inj=${p.injuryStatus} proj=${v?.points.toFixed(1)} espn=${v?.espnProjection?.toFixed?.(1) ?? v?.espnPoints.toFixed(1)} bye=${v?.onBye} unplay=${v?.unplayable} locked=${v?.locked}`);
  }
  console.log("warnings:", a.lineup.warnings, "moves:", a.lineup.moves.length, "matchup:", JSON.stringify(a.matchup)?.slice(0, 400));
}
