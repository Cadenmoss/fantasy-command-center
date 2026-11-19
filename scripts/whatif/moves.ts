/** Planned moves, written by hand in data/whatif/scenarios.json, resolved to simulator moves. */
import fs from "node:fs";
import path from "node:path";
import { teams, type Move } from "./sim.ts";

/** {"trade":"dak","give":[...],"get":[...]} | {"add":[...],"drop":[...]} — team by name substring. */
export type MoveSpec = { trade: string; give: string[]; get: string[] } | { add?: string[]; drop?: string[] };
export type Scenario = { label: string; moves: MoveSpec[] };

export const SCENARIOS = path.join(process.cwd(), "data", "whatif", "scenarios.json");

export function resolve(specs: MoveSpec[]): Move[] {
  return specs.map((s) => {
    if ("trade" in s) {
      const t = teams.find((x) => x.name.toLowerCase().includes(s.trade.toLowerCase()));
      if (!t) throw new Error(`No team matching "${s.trade}"`);
      return { trade: t.id, give: s.give, get: s.get };
    }
    return { add: s.add, drop: s.drop };
  });
}

export function loadScenarios(): Scenario[] {
  return fs.existsSync(SCENARIOS) ? JSON.parse(fs.readFileSync(SCENARIOS, "utf8")) : [];
}
