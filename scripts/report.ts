/**
 * Full weekly briefing: lineup, waiver targets, trade ideas — all three leagues.
 *   npm run report
 */
import { loadConfig, configProblems } from "../lib/config.ts";
import { analyzeLeague } from "../lib/engine/run.ts";

let failed = 0;

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };

const cfg = loadConfig();
const problems = configProblems(cfg);
if (problems.length) { problems.forEach((p) => console.log(`${C.r}✗${C.x} ${p}`)); process.exit(1); }

for (const lc of cfg.leagues) {
  try {
    const a = await analyzeLeague(cfg, lc);
    console.log(`\n${C.b}══ ${a.league.name} ══${C.x} ${C.d}week ${a.league.week} · ${a.myTeam.name} (${a.myTeam.wins}-${a.myTeam.losses})${C.x}\n`);

    console.log(`${C.b}Lineup${C.x} ${C.d}${a.lineup.currentProjected.toFixed(1)} → ${a.lineup.optimalProjected.toFixed(1)} pts${C.x}`);
    if (!a.lineup.moves.length) console.log(`  ${C.g}Already optimal.${C.x}`);
    for (const line of a.lineup.rationale) console.log(`  ${C.g}▸${C.x} ${line}`);
    for (const w of a.lineup.warnings) console.log(`  ${C.y}!${C.x} ${w}`);

    if (a.byeRisks.length) {
      console.log(`\n${C.b}Bye-week warnings${C.x}`);
      for (const r of a.byeRisks) {
        const tone = r.severity === "critical" ? C.r : C.y;
        console.log(`  ${tone}week ${r.week}:${C.x} ${r.advice}`);
        console.log(`       ${C.d}off: ${r.out.map((p) => `${p.name} (${p.position})`).join(", ")}${C.x}`);
      }
    }

    if (a.waivers.length) {
      console.log(`\n${C.b}Waiver targets${C.x}`);
      const shown = a.waivers.slice(0, 6);
      shown.forEach((t, i) => {
        const flag = t.worthIt ? `${C.g}net +${t.immediateGain.toFixed(1)}${C.x}` : `${C.y}not worth the drop${C.x}`;
        console.log(`  ${i + 1}. ${C.c}${t.player.name}${C.x} ${C.d}${t.player.position} ${t.player.team} · ${t.player.percentOwned.toFixed(0)}% owned${C.x}  ${flag}`);
        t.reasons.forEach((r) => console.log(`       ${C.d}${r}${C.x}`));
        if (t.suggestedBid) {
          const b = t.suggestedBid;
          console.log(`       ${C.g}bid $${b.amount}${C.x} ${C.d}(${b.percentOfRemaining}% of budget · ${b.tier})${C.x}`);
        }
        // Every add names its casualty — no add is free on a full roster.
        if (t.dropCandidate) {
          const d = t.dropCandidate;
          console.log(`       ${C.y}DROPS ${d.player.name} (${d.player.position})${C.x} ${C.d}— ${d.reason}${C.x}`);
          d.impact?.warnings.forEach((w) => console.log(`         ${C.r}! ${w}${C.x}`));
        } else {
          console.log(`       ${C.d}roster has room — nothing dropped${C.x}`);
        }
      });
    }

    if (a.trades.length) {
      console.log(`\n${C.b}Trade ideas${C.x}`);
      a.trades.slice(0, 5).forEach((t, i) => {
        console.log(`  ${i + 1}. with ${C.c}${t.partner.name}${C.x}`);
        console.log(`       give    ${t.give.map((p) => `${p.name} (${p.position})`).join(", ")}`);
        console.log(`       receive ${t.receive.map((p) => `${p.name} (${p.position})`).join(", ")}`);
        console.log(`       ${C.d}you +${t.myGain.toFixed(1)}/wk · them +${t.theirGain.toFixed(1)}/wk · ${t.likelihood} (${(t.fairness * 100).toFixed(0)}% even)${C.x}`);
      });
    }

    a.dataNotes.forEach((n) => console.log(`\n  ${C.y}note:${C.x} ${C.d}${n}${C.x}`));
  } catch (err) {
    failed++;
    console.log(`\n${C.r}✗ ${lc.name}: ${(err as Error).message}${C.x}`);
  }
}
console.log();
// Non-zero exit so this is safe to wrap in a notification or a cron job.
process.exit(failed ? 1 : 0);
