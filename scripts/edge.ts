/**
 * The competitive briefing: win probability, playoff odds, opponent weaknesses
 * and the trades that exploit them.
 *   npm run edge
 */
import { loadConfig, configProblems } from "../lib/config.ts";
import { analyzeLeague } from "../lib/engine/run.ts";
import { volatilityOf } from "../lib/engine/matchup.ts";

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", m: "\x1b[35m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const bar = (pct: number, w = 20) => {
  const n = Math.round((pct / 100) * w);
  return `${"█".repeat(Math.max(0, n))}${"░".repeat(Math.max(0, w - n))}`;
};

const cfg = loadConfig();
const problems = configProblems(cfg);
if (problems.length) { problems.forEach((p) => console.log(`${C.r}✗${C.x} ${p}`)); process.exit(1); }

let failed = 0;
for (const lc of cfg.leagues) {
  try {
    const a = await analyzeLeague(cfg, lc);
    console.log(`\n${C.b}══════ ${a.league.name.trim()} ══════${C.x} ${C.d}week ${a.league.week} · ${a.myTeam.name} (${a.myTeam.wins}-${a.myTeam.losses})${C.x}`);

    // ---- this week -------------------------------------------------------
    if (a.matchup) {
      const m = a.matchup;
      const wp = m.winProbability * 100;
      const tone = wp >= 60 ? C.g : wp >= 45 ? C.y : C.r;
      console.log(`\n${C.b}This week vs ${m.opponent.name}${C.x}`);
      console.log(`  ${tone}${bar(wp)} ${wp.toFixed(0)}% to win${C.x}`);
      console.log(`  ${C.d}you ${m.me.mean.toFixed(1)} ±${m.me.sigma.toFixed(1)}  ·  them ${m.them.mean.toFixed(1)} ±${m.them.sigma.toFixed(1)}${C.x}`);
      console.log(`  ${m.advice}`);
      for (const lv of m.leverageMoves) {
        console.log(`    ${C.m}▸${C.x} ${lv.slot}: ${lv.inName} over ${lv.outName} ${C.d}(${lv.pointsDelta >= 0 ? "+" : ""}${lv.pointsDelta} pts, ${lv.winProbDelta >= 0 ? "+" : ""}${lv.winProbDelta}% win)${C.x}`);
        console.log(`       ${C.d}${lv.reason}${C.x}`);
      }
      const vol = m.me.lineup.filter((s) => s.player).map((s) => {
        const v = volatilityOf(s.player!, s.verdict);
        return `${s.player!.name.split(" ").slice(-1)[0]} ${v.label}`;
      });
      console.log(`  ${C.d}lineup profile: ${vol.join(" · ")}${C.x}`);
    }

    // ---- season ----------------------------------------------------------
    if (a.season) {
      const me = a.season.me;
      console.log(`\n${C.b}Season outlook${C.x} ${C.d}(${a.season.simulations.toLocaleString()} sims · ${a.season.weeksLeft} weeks left · top ${a.season.playoffSpots} make playoffs)${C.x}`);
      if (a.season.everyoneQualifies) {
        console.log(`  ${C.d}every team makes the bracket — seeding is the game${C.x}`);
        console.log(`  seed     ${C.y}projected ${me.meanSeed.toFixed(1)} of ${a.season.odds.length}${C.x}`);
        if (a.season.byeSeeds > 0) {
          console.log(`  bye      ${C.g}${bar(me.firstRoundBye)} ${me.firstRoundBye.toFixed(1)}%${C.x} ${C.d}(top ${a.season.byeSeeds} seed${a.season.byeSeeds === 1 ? "" : "s"})${C.x}`);
        }
      } else {
        console.log(`  playoffs ${me.makePlayoffs >= 50 ? C.g : C.y}${bar(me.makePlayoffs)} ${me.makePlayoffs.toFixed(1)}%${C.x}`);
        console.log(`  ${C.d}this week is worth ${C.x}${C.b}${a.season.thisWeekSwing.toFixed(1)}%${C.x}${C.d} of playoff probability (win vs lose)${C.x}`);
      }
      console.log(`  title    ${C.c}${bar(me.winTitle)} ${me.winTitle.toFixed(1)}%${C.x}`);
      console.log(`  ${C.b}${a.season.objective}${C.x}`);
      console.log(`  ${C.d}league order:${C.x}`);
      a.season.odds.slice(0, 5).forEach((o, i) => {
        const tag = o.isMe ? `${C.g} ← you${C.x}` : "";
        console.log(`    ${String(i + 1).padStart(2)}. ${o.name.slice(0, 24).padEnd(25)} ${o.makePlayoffs.toFixed(0).padStart(3)}% playoffs · ${o.winTitle.toFixed(0).padStart(2)}% title · ${o.meanScore.toFixed(0)} pts/wk${tag}`);
      });
    }

    // ---- opponents -------------------------------------------------------
    if (a.weaknesses.length) {
      console.log(`\n${C.b}Where your leaguemates are weak${C.x}`);
      a.weaknesses.slice(0, 4).forEach((w) => {
        console.log(`  ${C.c}${w.team.name}${C.x} ${C.d}(${w.record}, desperation ${w.desperation})${C.x}`);
        console.log(`     ${w.readAloud}`);
      });
    }

    // ---- fleece ----------------------------------------------------------
    if (a.exploits.length) {
      console.log(`\n${C.b}${C.m}Trades that favour you${C.x}`);
      a.exploits.slice(0, 4).forEach((t, i) => {
        console.log(`  ${i + 1}. ${C.c}${t.partner.name}${C.x} ${C.d}[${t.likelihood}]${C.x}`);
        console.log(`     give    ${t.give.map((p) => `${p.name} (${p.position})`).join(", ")}`);
        console.log(`     get     ${t.receive.map((p) => `${p.name} (${p.position})`).join(", ")}`);
        console.log(`     ${C.g}your edge +${t.edge.toFixed(1)}${C.x} ${C.d}· you +${t.myValueGain.toFixed(1)} value/wk · they +${t.theirLineupGain.toFixed(1)} lineup/wk${C.x}`);
        console.log(`     ${C.d}why they accept: ${t.whyTheySayYes}${C.x}`);
        console.log(`     ${C.d}why you want it: ${t.whyItsGoodForMe}${C.x}`);
      });
    }
  } catch (err) {
    failed++;
    console.log(`\n${C.r}✗ ${lc.name}: ${(err as Error).message}${C.x}`);
  }
}
console.log();
process.exit(failed ? 1 : 0);
