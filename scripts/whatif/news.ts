/**
 * Sourced disagreements with ESPN's weekly projections. Imported for its side
 * effect on OVERRIDES. Each entry says why — this is not an optimism knob.
 * Update it from fresh news before every search; stale entries are worse than none.
 */
import { OVERRIDES, WEEKS, players } from "./sim.ts";

const set = (name: string, byWeek: Record<number, number>) => {
  if (!Object.values(players).some((p: any) => p.name === name)) return;
  OVERRIDES[name] = byWeek;
};
const scale = (name: string, k: number) => {
  const p = Object.values(players).find((x: any) => x.name === name) as any;
  if (p) OVERRIDES[name] = Object.fromEntries(WEEKS.map((w) => [w, k * (p.proj[w] ?? 0)]));
};

// As of Nov 8 2026 (research agent, week 9 news):
// A.J. Brown — new knee concern on top of the ankle, out week 10, NE bye week 11,
// long-term doubt (Schefter). Expected value only after that.
set("A.J. Brown", { 10: 0, 11: 0, 12: 5, 13: 5, 14: 5 });
// MarShawn Lloyd — knee, inactive week 9; Kaleb Johnson led GB. GB bye week 11.
set("MarShawn Lloyd", { 10: 0 });
// Saquon Barkley — ~1.7 YPC two weeks running, snaps managed. On Nov 8 this was a
// 0.75× haircut; by Nov 9 ESPN had cut him ~17% itself, so it is off to avoid
// double counting. Re-enable with scale("Saquon Barkley", k) if ESPN lags the news again.
// Sensitivity: BARKLEY_SCALE=0.75 node scripts/whatif/price.ts
if (process.env.BARKLEY_SCALE) scale("Saquon Barkley", Number(process.env.BARKLEY_SCALE));
