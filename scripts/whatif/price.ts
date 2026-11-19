/**
 * Price planned moves in P(last).
 *
 *   node scripts/whatif/price.ts [--runs 40000] [--live win|loss]
 *
 * Reads data/whatif/scenarios.json (see moves.ts for the format) and prints the
 * odds of finishing last for each scenario, plus my weekly projected lineup.
 * Run scripts/whatif/snapshot.ts first. Offline and read-only.
 */
import "./news.ts";
import { apply, pLast, myMeans, snapshot, WEEKS } from "./sim.ts";
import { loadScenarios, resolve, SCENARIOS } from "./moves.ts";

const arg = (flag: string, fallback?: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const runs = Number(arg("--runs", "40000"));
const liveResult = arg("--live") as "win" | "loss" | undefined;

const scenarios = [{ label: "no moves", moves: [] }, ...loadScenarios()];
if (scenarios.length === 1) console.log(`(no scenarios yet — add some to ${SCENARIOS})`);
console.log(`snapshot ${snapshot.takenAt} · weeks ${WEEKS.join(",")}${snapshot.liveWeek ? ` · week ${snapshot.liveWeek} seeded live` : ""}${liveResult ? ` · assuming I ${liveResult} it` : ""}\n`);
for (const s of scenarios) {
  const r = apply(resolve(s.moves));
  const p = pLast(r, { runs, liveResult });
  console.log(`${(p * 100).toFixed(1).padStart(5)}%  ${s.label.padEnd(44)} my lineup ${myMeans(r).map((x) => x.toFixed(0)).join("/")}`);
}
