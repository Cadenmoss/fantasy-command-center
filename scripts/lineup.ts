/**
 * Auto start/sit pass across every configured league.
 *   npm run lineup:dry   — show what it would do, change nothing
 *   npm run lineup       — submit to ESPN and verify
 */
import { runAutoLineup } from "../lib/engine/run.ts";
import { SLOT_LABEL } from "../lib/espn/constants.ts";
import { notify } from "../lib/util/notify.ts";

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const confirm = argv.includes("--confirm");
const leagueArg = argv[argv.indexOf("--league") + 1];
const onlyLeagueId = argv.includes("--league") && leagueArg && !leagueArg.startsWith("--")
  ? leagueArg
  : undefined;

if (confirm && !onlyLeagueId) {
  console.log(`${C.r}--confirm requires --league <leagueId>${C.x}`);
  console.log(`${C.d}The first live write must target a single league so you can check the result.${C.x}`);
  process.exit(1);
}

const mode = dryRun
  ? `${C.y}(dry run — nothing will be submitted)${C.x}`
  : confirm
    ? `${C.g}(live · supervised validation run · league ${onlyLeagueId})${C.x}`
    : `${C.g}(live)${C.x}`;
console.log(`\n${C.b}Auto-lineup${C.x} ${mode}\n`);

const { outcomes, problems } = await runAutoLineup({
  dryRun,
  onlyLeagueId,
  // --confirm is an explicit, supervised, single-league write.
  supervised: confirm,
  forceApply: confirm,
});

if (problems.length) {
  problems.forEach((p) => console.log(`${C.r}✗${C.x} ${p}`));
  // Surfaced loudly: a scheduled run that cannot start looks identical to a
  // quiet week unless it says so.
  await notify("Fantasy Command Center", problems[0], "Setup problem");
  process.exit(1);
}

let failed = false;
for (const o of outcomes) {
  console.log(`${C.b}${o.league}${C.x} ${C.d}week ${o.week}${C.x}`);

  if (o.error) { console.log(`  ${C.r}✗ ${o.error}${C.x}\n`); failed = true; continue; }
  if (o.skipped) { console.log(`  ${C.d}${o.skipped}${C.x}\n`); continue; }

  console.log(`  ${C.g}+${o.gain.toFixed(1)} projected pts${C.x} from ${o.moves} move(s)`);
  for (const line of o.rationale) console.log(`    ${line}`);
  for (const w of o.warnings) console.log(`    ${C.y}! ${w}${C.x}`);

  const wr = o.write;
  if (wr?.dryRun) {
    for (const m of wr.moves) {
      console.log(`    ${C.d}would move ${m.playerName}: ${SLOT_LABEL[m.fromSlot]} → ${SLOT_LABEL[m.toSlot]}${C.x}`);
    }
  } else if (wr?.error) {
    console.log(`  ${C.r}✗ write failed: ${wr.error}${C.x}`); failed = true;
  } else if (wr?.applied) {
    console.log(wr.verified ? `  ${C.g}✓ ${wr.verifyDetail}${C.x}` : `  ${C.r}✗ ${wr.verifyDetail}${C.x}`);
    if (!wr.verified) failed = true;
  }
  console.log();
}
// Tell the user what happened, since scheduled runs have no terminal.
if (!dryRun) {
  const changed = outcomes.filter((o) => o.write?.applied && o.write?.verified);
  const broken = outcomes.filter((o) => o.error || o.write?.error || o.write?.verified === false);

  if (broken.length) {
    const first = broken[0];
    const why = first.error ?? first.write?.error ?? first.write?.verifyDetail ?? "unknown error";
    await notify(
      "Fantasy Command Center",
      /401|cookie|espn_s2|SWID/i.test(why)
        ? "Your ESPN login expired — re-copy espn_s2 and run npm run verify"
        : why,
      `Lineup failed in ${first.league}`,
    );
  } else if (changed.length) {
    const total = changed.reduce((a, o) => a + o.gain, 0);
    const moves = changed.reduce((a, o) => a + o.moves, 0);
    await notify(
      "Fantasy Command Center",
      changed.map((o) => `${o.league.trim()} +${o.gain.toFixed(1)}`).join(" · "),
      `${moves} lineup change${moves === 1 ? "" : "s"}, +${total.toFixed(1)} projected pts`,
    );
  }
}

process.exit(failed ? 1 : 0);
