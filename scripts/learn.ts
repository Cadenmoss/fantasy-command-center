/**
 * Weekly learning pass: grade last week's predictions, then refit the model.
 *   npm run learn
 */
import { runLearning } from "../lib/engine/run.ts";
import { PRIORS } from "../lib/learning/calibrate.ts";

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };

const rep = await runLearning();
const c = rep.calibration;

console.log(`\n${C.b}Learning pass${C.x}`);

if (rep.settled.length) {
  console.log(`\n${C.b}Graded${C.x}`);
  rep.settled.forEach((s) => console.log(`  ${s.league} week ${s.week}: ${s.graded} predictions scored`));
} else {
  console.log(`\n${C.d}No new completed weeks to grade.${C.x}`);
}

console.log(`\n${C.b}Model${C.x} ${C.d}${c.sampleSize} graded predictions over ${c.weeksCovered} week(s)${C.x}`);
const arrow = (now: number, prior: number) =>
  Math.abs(now - prior) < 0.005 ? `${C.d}(default)${C.x}` : `${C.g}(learned, default ${prior})${C.x}`;

console.log(`  expert vs ESPN weight   ${(c.expertWeight * 100).toFixed(0)}% expert  ${arrow(c.expertWeight, PRIORS.expertWeight)}`);
console.log(`  betting-line strength   ${c.vegasStrength.toFixed(2)}  ${arrow(c.vegasStrength, PRIORS.vegasStrength)}`);

const biases = Object.entries(c.positionBias).filter(([, v]) => Math.abs(v - 1) >= 0.01);
if (biases.length) {
  console.log(`  position bias:`);
  biases.forEach(([pos, v]) =>
    console.log(`     ${pos.padEnd(5)} ${v > 1 ? C.g : C.y}${((v - 1) * 100).toFixed(1)}%${C.x} ${C.d}${v > 1 ? "under" : "over"}-projected historically${C.x}`));
} else {
  console.log(`  position bias:          ${C.d}none detected yet${C.x}`);
}

const cvs = Object.entries(c.positionCv).filter(([pos, v]) => Math.abs(v - (PRIORS.positionCv[pos] ?? 0.55)) >= 0.01);
if (cvs.length) {
  console.log(`  volatility (learned):`);
  cvs.forEach(([pos, v]) => console.log(`     ${pos.padEnd(5)} ${v.toFixed(2)} ${C.d}(study says ${PRIORS.positionCv[pos] ?? "—"})${C.x}`));
}

if (c.sampleSize > 0) {
  const better = c.baselineMae - c.calibratedMae;
  console.log(`\n${C.b}Accuracy${C.x} ${C.d}mean absolute error on graded predictions${C.x}`);
  console.log(`  as-projected ${c.baselineMae.toFixed(2)} pts → calibrated ${c.calibratedMae.toFixed(2)} pts` +
    (better > 0.01 ? `  ${C.g}(${better.toFixed(2)} better)${C.x}` : `  ${C.d}(no improvement yet)${C.x}`));
}

if (rep.changes.length) {
  console.log(`\n${C.b}Changed this pass${C.x}`);
  rep.changes.forEach((ch) => console.log(`  ${C.c}▸${C.x} ${ch}`));
} else {
  console.log(`\n${C.d}Nothing changed this pass.${C.x}`);
}

c.notes.forEach((n) => console.log(`\n  ${C.y}note:${C.x} ${C.d}${n}${C.x}`));
console.log();
