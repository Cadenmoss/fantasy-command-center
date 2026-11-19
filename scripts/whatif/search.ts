/**
 * Screen every 1-for-1, 1-for-2, 2-for-1 and 2-for-2 trade with every team, keep
 * the ones a human would plausibly accept, and price the best in P(last).
 *
 *   node scripts/whatif/search.ts [--min 1.5] [--teams dak,tank] [--after "<scenario label>"] [--top 30]
 *
 * --after starts from a scenario in data/whatif/scenarios.json (e.g. trades already
 * agreed), so a second trade can be searched on top of the first.
 *
 * Three filters, because the best of ~60k trades scored on noisy projections is
 * partly luck:
 *   1. My gain: my best lineup over the remaining weeks, with the top free agent at
 *      each position available as a pickup (so dealing an easily replaced QB or
 *      kicker is priced fairly). Uses news.ts overrides.
 *   2. Their view: their lineup on ESPN's raw projections, without the pickup —
 *      that is how a manager judges an offer — must improve by ≥ 0.5/wk, and the
 *      package they receive must be worth ≥ 90% of what they give on season
 *      average + ESPN rest-of-season, above replacement.
 *   3. Robust: still a gain for me when scored on actual season averages.
 * Offline and read-only.
 */
import "./news.ts";
import { ME, WEEKS, players, teams, teamName, bestLineup, proj, apply, baseRosters, pLast, type Rosters } from "./sim.ts";
import { loadScenarios, resolve } from "./moves.ts";

const arg = (flag: string, fallback?: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const MIN = Number(arg("--min", "1.5"));
const TOP = Number(arg("--top", "30"));
const only = arg("--teams")?.split(",").map((s) => s.trim().toLowerCase());
const after = arg("--after");

let base: Rosters = baseRosters();
if (after) {
  const s = loadScenarios().find((x) => x.label === after);
  if (!s) { console.log(`No scenario labelled "${after}"`); process.exit(1); }
  base = apply(resolve(s.moves));
}

const owned = new Set([...base.values()].flat());
const faSet = new Map<number, number[]>();
for (const w of WEEKS) {
  const ids: number[] = [];
  for (const pos of ["QB", "RB", "WR", "TE", "K", "D/ST"]) {
    const best = Object.values(players).filter((p: any) => !owned.has(p.id) && p.pos === pos)
      .sort((a: any, b: any) => proj(b.id, w) - proj(a.id, w))[0] as any;
    if (best) ids.push(best.id);
  }
  faSet.set(w, ids);
}
const n = WEEKS.length;
const mine = (ids: number[]) => WEEKS.reduce((s, w) => s + bestLineup([...ids, ...faSet.get(w)!], w).mean, 0);
const human = (ids: number[]) => WEEKS.reduce((s, w) => s + bestLineup(ids, w, true).mean, 0);

/** Scored on what the player has actually averaged, on the weeks ESPN says he plays. */
function mineActual(ids: number[]) {
  let total = 0;
  for (const w of WEEKS) {
    const pool = [...ids, ...faSet.get(w)!];
    const saved = new Map<number, number>();
    for (const id of pool) {
      saved.set(id, players[id].proj[w]);
      const plays = proj(id, w) > 0; // after news overrides: injured or on bye → 0
      players[id].proj[w] = plays ? players[id].avg || proj(id, w) : 0;
    }
    total += bestLineup(pool, w, true).mean;
    for (const [id, v] of saved) players[id].proj[w] = v;
  }
  return total;
}

const REPL: Record<string, number> = { QB: 16, RB: 6.5, WR: 7, TE: 6, K: 9, "D/ST": 5 };
const perceived = (id: number) => {
  const p = players[id];
  const plays = WEEKS.filter((w) => proj(id, w, true) > 0);
  const ros = plays.length ? plays.reduce((s, w) => s + proj(id, w, true), 0) / plays.length : 0;
  return Math.max(0, 0.5 * p.avg + 0.5 * ros - (REPL[p.pos] ?? 7)) * (0.4 + 0.6 * plays.length / n);
};
const pkg = (ids: number[]) => {
  const v = ids.map(perceived).sort((a, b) => b - a);
  return v[0] + 0.7 * v.slice(1).reduce((a, b) => a + b, 0);
};
const combos = (xs: number[]) => {
  const out: number[][] = xs.map((x) => [x]);
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]);
  return out;
};

const myRoster = base.get(ME)!;
const myBase = mine(myRoster), myBaseActual = mineActual(myRoster);
type Row = { team: number; give: number[]; get: number[]; myG: number; thG: number; myAlt: number; recv: number; lose: number; p?: number };
const rows: Row[] = [];
for (const t of teams) {
  if (t.id === ME) continue;
  if (only && !only.some((o) => t.name.toLowerCase().includes(o))) continue;
  const theirs = base.get(t.id)!;
  const theirBase = human(theirs);
  for (const give of combos(myRoster)) for (const get of combos(theirs)) {
    const m2 = [...myRoster.filter((x) => !give.includes(x)), ...get];
    const myG = (mine(m2) - myBase) / n;
    if (myG < MIN) continue;
    const thG = (human([...theirs.filter((x) => !get.includes(x)), ...give]) - theirBase) / n;
    if (thG < 0.5) continue;
    const recv = pkg(give), lose = pkg(get);
    if (recv < 0.9 * lose) continue;
    const myAlt = (mineActual(m2) - myBaseActual) / n;
    if (myAlt <= 0) continue;
    rows.push({ team: t.id, give, get, myG, thG, myAlt, recv, lose });
  }
}

const seen = new Set<string>();
const top: Row[] = [];
for (const r of rows.sort((a, b) => b.myG + b.myAlt - (a.myG + a.myAlt))) {
  const k = `${r.team}:${r.get.join(",")}`;
  if (seen.has(k)) continue;
  seen.add(k);
  top.push(r);
  if (top.length >= Math.max(TOP, 40)) break;
}
const p0 = pLast(base);
for (const r of top) {
  const ros: Rosters = new Map([...base].map(([k, v]) => [k, [...v]]));
  ros.set(ME, myRoster.filter((x) => !r.give.includes(x)).concat(r.get));
  ros.set(r.team, ros.get(r.team)!.filter((x) => !r.get.includes(x)).concat(r.give));
  r.p = pLast(ros);
}
top.sort((a, b) => a.p! - b.p!);
const nm = (ids: number[]) => ids.map((x) => `${players[x].name}(${players[x].avg.toFixed(1)})`).join(" + ");
console.log(`${rows.length} trades pass all three filters · starting P(last) ${(p0 * 100).toFixed(1)}%${after ? ` (after "${after}")` : ""}\n`);
console.log("P(last)  partner           you give                                      you get                                       you +/wk (proj/actual)  them +/wk");
for (const r of top.slice(0, TOP)) {
  console.log(`${(r.p! * 100).toFixed(1).padStart(6)}%  ${teamName(r.team).slice(0, 16).padEnd(16)}  ${nm(r.give).padEnd(44)}  ${nm(r.get).padEnd(44)}  +${r.myG.toFixed(1)} / +${r.myAlt.toFixed(1)}`.padEnd(160) + `  +${r.thG.toFixed(1)}`);
}
