/**
 * Cross-source player matching. ESPN, FantasyPros and Sleeper all spell names
 * slightly differently ("Kenneth Walker III" / "Ken Walker" / "Kenneth Walker"),
 * so we match on a normalized key plus position and NFL team.
 */
const SUFFIXES = /\b(jr|sr|ii|iii|iv|v)\b/g;

export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'`]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(SUFFIXES, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Patrick Mahomes" -> "p mahomes", to survive first-name abbreviations. */
export function shortKey(name: string): string {
  const parts = nameKey(name).split(" ").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts[0][0]} ${parts[parts.length - 1]}`;
}

export function matchKeys(name: string): string[] {
  return [nameKey(name), shortKey(name)];
}

/** D/ST entries are named by city in ESPN and by team elsewhere. */
export function isDefense(position: string): boolean {
  return position === "D/ST" || position === "DST" || position === "DEF";
}
