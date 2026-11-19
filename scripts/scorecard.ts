/**
 * Did the auto-lineup actually help? Grades past decisions against real scores.
 *   npm run scorecard
 */
import { buildScorecards } from "../lib/engine/run.ts";

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };

const cards = await buildScorecards();
if (!cards.length) {
  console.log(`\n${C.d}No decisions recorded yet. The scorecard fills in after the auto-lineup makes its first change.${C.x}\n`);
  process.exit(0);
}

let net = 0;
let settledCount = 0;
console.log(`\n${C.b}Auto-lineup scorecard${C.x}\n`);

for (const c of cards) {
  const tag = c.settled ? "" : ` ${C.y}(in progress)${C.x}`;
  console.log(`${C.b}${c.league}${C.x} ${C.d}week ${c.week}${C.x}${tag}`);
  for (const s of c.swaps) {
    const got = s.realizedDelta;
    const mark = got === null ? `${C.d}not played yet${C.x}` : got >= 0 ? `${C.g}+${got.toFixed(1)}${C.x}` : `${C.r}${got.toFixed(1)}${C.x}`;
    console.log(
      `  ${s.slot.padEnd(5)} ${s.inName} over ${s.outName}  ` +
      `${C.d}predicted +${s.projectedDelta.toFixed(1)}${C.x} → actual ${mark}` +
      (got !== null ? ` ${C.d}(${s.inActual?.toFixed(1)} vs ${s.outActual?.toFixed(1)})${C.x}` : ""),
    );
  }
  if (c.settled) { net += c.realizedTotal; settledCount++; }
  const graded = c.swaps.filter((s) => s.realizedDelta !== null).length;
  const t = c.realizedTotal;
  console.log(
    graded === 0
      ? `  ${C.b}week total:${C.x} predicted +${c.projectedTotal.toFixed(1)} → ${C.d}awaiting kickoff${C.x}\n`
      : `  ${C.b}week total:${C.x} predicted +${c.projectedTotal.toFixed(1)} → actual ${t >= 0 ? `${C.g}+${t.toFixed(1)}${C.x}` : `${C.r}${t.toFixed(1)}${C.x}`}` +
        (graded < c.swaps.length ? ` ${C.d}(${graded}/${c.swaps.length} played)${C.x}` : "") + "\n",
  );
}

if (settledCount) {
  console.log(
    net >= 0
      ? `${C.g}${C.b}Net +${net.toFixed(1)} points across ${settledCount} completed league-week(s).${C.x}\n`
      : `${C.r}${C.b}Net ${net.toFixed(1)} points across ${settledCount} completed league-week(s).${C.x}\n`,
  );
}
