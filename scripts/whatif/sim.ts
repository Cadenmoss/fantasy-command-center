/**
 * What-if last-place simulator over the frozen snapshot (data/whatif/snap.json).
 * A library: imported by search.ts and price.ts, never run directly.
 *
 * Same model as scripts/lastplace.ts — ESPN per-week projections, exact best legal
 * lineup, a contested waiver wire, a persistent ±SHOCK strength error per team and
 * the league's own weekly spread as a floor — plus two things that script lacks:
 *   - a week already in progress is seeded from live scores;
 *   - any roster (mine or anyone else's) can be edited, so trades and pickups can
 *     be priced in P(last) directly, including what they do to the other team.
 */
import fs from "node:fs";
import path from "node:path";
import { maximizeAssignment } from "../../lib/engine/assign.ts";

const SNAP = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "whatif", "snap.json"), "utf8"));
export const snapshot = SNAP;
export const WEEKS: number[] = SNAP.weeks;
export const ME: number = SNAP.me;
export const players: Record<number, any> = SNAP.players;
export const teams: { id: number; name: string; wins: number; losses: number; pf: number; roster: number[] }[] = SNAP.teams;
const SLOTS: number[] = SNAP.startingSlots;
const CV: Record<string, number> = { QB: 0.36, RB: 0.54, WR: 0.58, TE: 0.63, K: 0.45, "D/ST": 0.75 };

/** name → week → points. Sourced disagreements with ESPN live in news.ts. */
export const OVERRIDES: Record<string, Record<number, number>> = {};

export const byName = (n: string) => {
  const p = Object.values(players).find((x: any) => x.name === n);
  if (!p) throw new Error(`No player called "${n}" in the snapshot`);
  return p as any;
};
export const teamId = (re: RegExp) => {
  const t = teams.find((x) => re.test(x.name));
  if (!t) throw new Error(`No team matching ${re}`);
  return t.id;
};
export const teamName = (id: number) => teams.find((t) => t.id === id)!.name;

/** A player's projection after overrides. `raw` ignores overrides (what other managers see). */
export const proj = (id: number, w: number, raw = false) => {
  const p = players[id];
  const o = raw ? undefined : OVERRIDES[p.name]?.[w];
  return o ?? p.proj[w] ?? 0;
};

export type Lineup = { mean: number; sigma: number; used: number[] };
export function bestLineup(ids: number[], w: number, raw = false): Lineup {
  if (!ids.length) return { mean: 0, sigma: 0, used: [] };
  const weights = ids.map((id) => SLOTS.map((s) => (players[id].slots.includes(s) ? proj(id, w, raw) : -1e6)));
  const a = maximizeAssignment(weights);
  const used = ids.filter((_, i) => a[i] >= 0 && a[i] < SLOTS.length);
  const mean = used.reduce((s, id) => s + proj(id, w, raw), 0);
  const v = used.reduce((s, id) => s + ((CV[players[id].pos] ?? 0.55) * proj(id, w, raw)) ** 2, 0);
  return { mean, sigma: Math.sqrt(v), used };
}

export type Rosters = Map<number, number[]>;
export const baseRosters = (): Rosters => new Map(teams.map((t) => [t.id, [...t.roster]]));

export type Strengths = Map<number, Map<number, { mean: number; sigma: number }>>;

/**
 * Weekly strength of every team. The wire is allocated exclusively and by need:
 * the biggest gain any team gets from any streamer is awarded first and that
 * player leaves the pool. `awards` pickups crack a lineup league-wide per week,
 * at most `cap` per team.
 */
export function strengths(rosters: Rosters, awards = 6, cap = 2): Strengths {
  const owned = new Set([...rosters.values()].flat());
  const out: Strengths = new Map(teams.map((t) => [t.id, new Map()]));
  for (const w of WEEKS) {
    const pool: number[] = [];
    for (const pos of ["QB", "RB", "WR", "TE", "K", "D/ST"]) {
      pool.push(...Object.values(players)
        .filter((p: any) => !owned.has(p.id) && p.pos === pos && proj(p.id, w) > 0)
        .sort((a: any, b: any) => proj(b.id, w) - proj(a.id, w))
        .slice(0, 2).map((p: any) => p.id));
    }
    const have = new Map<number, number[]>(teams.map((t) => [t.id, []]));
    const taken = new Set<number>();
    const gain = new Map<number, Map<number, number>>();
    const price = (tid: number) => {
      const base = bestLineup([...rosters.get(tid)!, ...have.get(tid)!], w).mean;
      const m = new Map<number, number>();
      for (const fa of pool) if (!taken.has(fa)) m.set(fa, bestLineup([...rosters.get(tid)!, ...have.get(tid)!, fa], w).mean - base);
      gain.set(tid, m);
    };
    teams.forEach((t) => price(t.id));
    for (let k = 0; k < awards; k++) {
      let best: { tid: number; pid: number; g: number } | null = null;
      for (const t of teams) {
        if (have.get(t.id)!.length >= cap) continue;
        for (const [pid, g] of gain.get(t.id)!) if (!taken.has(pid) && g > 0.5 && (!best || g > best.g)) best = { tid: t.id, pid, g };
      }
      if (!best) break;
      have.get(best.tid)!.push(best.pid);
      taken.add(best.pid);
      price(best.tid);
    }
    for (const t of teams) {
      const l = bestLineup([...rosters.get(t.id)!, ...have.get(t.id)!], w);
      out.get(t.id)!.set(w, { mean: l.mean, sigma: Math.max(l.sigma, SNAP.empSigma) });
    }
  }
  return out;
}

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type SimOpts = { runs?: number; shock?: number; liveResult?: "win" | "loss" };

/** P(each team finishes last in the regular season), ranked by wins then points for. */
export function simulate(S: Strengths, o: SimOpts = {}): Map<number, number> {
  const runs = o.runs ?? 20000, shock = o.shock ?? 6;
  const ids = teams.map((t) => t.id);
  const last = new Map<number, number>(ids.map((id) => [id, 0]));
  for (let r = 0; r < runs; r++) {
    const wins = new Map(teams.map((t) => [t.id, t.wins]));
    const pf = new Map(teams.map((t) => [t.id, t.pf]));
    const sh = new Map(ids.map((id) => [id, gauss() * shock]));
    for (const m of SNAP.schedule) {
      let hs: number, as: number;
      if (m.w === SNAP.liveWeek) {
        const lh = SNAP.live[m.h], la = SNAP.live[m.a];
        hs = lh.act + Math.max(0, lh.rem + gauss() * 0.45 * lh.rem);
        as = la.act + Math.max(0, la.rem + gauss() * 0.45 * la.rem);
        if (o.liveResult && (m.h === ME || m.a === ME)) {
          const meHome = m.h === ME, win = o.liveResult === "win";
          if (meHome === win) hs = Math.max(hs, as + 0.1); else as = Math.max(as, hs + 0.1);
        }
      } else {
        const h = S.get(m.h)!.get(m.w)!, a = S.get(m.a)!.get(m.w)!;
        hs = h.mean + sh.get(m.h)! + gauss() * h.sigma;
        as = a.mean + sh.get(m.a)! + gauss() * a.sigma;
      }
      pf.set(m.h, pf.get(m.h)! + hs);
      pf.set(m.a, pf.get(m.a)! + as);
      if (hs > as) wins.set(m.h, wins.get(m.h)! + 1); else wins.set(m.a, wins.get(m.a)! + 1);
    }
    let worst = ids[0];
    for (const id of ids) {
      const dw = wins.get(id)! - wins.get(worst)!;
      if (dw < 0 || (dw === 0 && pf.get(id)! < pf.get(worst)!)) worst = id;
    }
    last.set(worst, last.get(worst)! + 1);
  }
  return new Map([...last].map(([k, v]) => [k, v / runs]));
}

export type Move =
  | { trade: number; give: string[]; get: string[] }
  | { team?: number; add?: string[]; drop?: string[] };

/** Apply moves to a copy of the rosters. Trades are always from my side. */
export function apply(moves: Move[], base = baseRosters()): Rosters {
  const r: Rosters = new Map([...base].map(([k, v]) => [k, [...v]]));
  for (const m of moves) {
    if ("trade" in m) {
      const g = m.give.map((n) => byName(n).id), q = m.get.map((n) => byName(n).id);
      r.set(ME, [...r.get(ME)!.filter((id) => !g.includes(id)), ...q]);
      r.set(m.trade, [...r.get(m.trade)!.filter((id) => !q.includes(id)), ...g]);
    } else {
      const t = m.team ?? ME;
      const d = (m.drop ?? []).map((n) => byName(n).id), a = (m.add ?? []).map((n) => byName(n).id);
      r.set(t, [...r.get(t)!.filter((id) => !d.includes(id)), ...a]);
    }
  }
  return r;
}

export const myMeans = (r: Rosters) => WEEKS.map((w) => bestLineup(r.get(ME)!, w).mean);
export const pLast = (r: Rosters, o: SimOpts = {}) => simulate(strengths(r), o).get(ME)!;
