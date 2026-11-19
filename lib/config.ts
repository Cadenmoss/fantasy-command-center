import fs from "node:fs";
import path from "node:path";

export type LeagueConfig = {
  id: string;            // ESPN league id
  name: string;          // your label for it
  teamId: number;        // YOUR team id within this league
  autoLineup: boolean;   // submit start/sit changes without asking
  /** The only goal in this league is not finishing last, so show last-place odds instead of title odds. */
  avoidLast?: boolean;
};

export type AppConfig = {
  season: number;
  swid: string;
  espnS2: string;
  leagues: LeagueConfig[];
  /** Optional FantasyPros API key. Without it we fall back to free expert sources. */
  fantasyProsKey?: string;
};

const CONFIG_PATH = path.join(process.cwd(), "data", "leagues.json");

function envLeagues(): LeagueConfig[] {
  // ESPN_LEAGUES="id:teamId:Name,id:teamId:Name:manual,id:teamId:Name:lastplace"
  // Anything after the name is a flag, in any order: "manual" (propose-only)
  // and "lastplace" (the goal is not finishing last).
  const raw = process.env.ESPN_LEAGUES?.trim();
  if (!raw) return [];
  return raw.split(",").map((chunk) => {
    const [id, teamId, name, ...flags] = chunk.split(":").map((s) => s?.trim());
    return {
      id,
      teamId: Number(teamId),
      name: name || `League ${id}`,
      autoLineup: !flags.includes("manual"),
      avoidLast: flags.includes("lastplace"),
    };
  });
}

export function loadConfig(): AppConfig {
  let fileLeagues: LeagueConfig[] = [];
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fileLeagues = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).leagues ?? [];
    }
  } catch {
    // A malformed config file should not take the whole app down; env can still supply leagues.
  }

  const leagues = fileLeagues.length ? fileLeagues : envLeagues();

  return {
    season: Number(process.env.ESPN_SEASON) || currentSeason(),
    swid: normalizeSwid(process.env.ESPN_SWID ?? ""),
    espnS2: (process.env.ESPN_S2 ?? "").trim(),
    leagues,
    fantasyProsKey: process.env.FANTASYPROS_API_KEY,
  };
}

export function saveLeagues(leagues: LeagueConfig[]) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ leagues }, null, 2));
}

/** ESPN's "season" rolls over in the spring; treat Jan–May as the prior season. */
export function currentSeason(now = new Date()): number {
  return now.getMonth() < 5 ? now.getFullYear() - 1 : now.getFullYear();
}

/** ESPN wants SWID wrapped in braces. Accept it either way. */
export function normalizeSwid(swid: string): string {
  const s = swid.trim();
  if (!s) return "";
  return s.startsWith("{") ? s : `{${s.replace(/^\{|\}$/g, "")}}`;
}

export function configProblems(cfg: AppConfig): string[] {
  const problems: string[] = [];
  if (!cfg.swid) problems.push("ESPN_SWID is not set");
  if (!cfg.espnS2) problems.push("ESPN_S2 is not set");
  if (!cfg.leagues.length) problems.push("No leagues configured");
  cfg.leagues.forEach((l, i) => {
    if (!l.id) problems.push(`League #${i + 1} has no id`);
    if (!Number.isFinite(l.teamId)) problems.push(`League "${l.name}" has no teamId`);
  });

  // Three near-identical entries is the classic copy-paste slip, and it would
  // silently point every league at the same roster.
  const seen = new Map<string, string[]>();
  cfg.leagues.forEach((l) => {
    if (!l.id) return;
    seen.set(l.id, [...(seen.get(l.id) ?? []), l.name]);
  });
  for (const [id, names] of seen) {
    if (names.length > 1) {
      problems.push(`League id ${id} is listed ${names.length} times (${names.join(", ")}) — each league needs its own id`);
    }
  }
  return problems;
}
