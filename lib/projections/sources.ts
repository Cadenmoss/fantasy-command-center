import { cached, stale, HOUR, MINUTE } from "../util/cache.ts";
import { matchKeys, nameKey } from "../util/name.ts";

export type ExpertRank = {
  key: string;
  name: string;
  position: string;
  team: string;
  /** Expert consensus rank within position (lower is better). */
  positionRank?: number;
  /** Overall expert consensus rank. */
  overallRank?: number;
  /** Spread between the most and least bullish expert — our uncertainty signal. */
  stdDev?: number;
  /** Expert-sourced point projection, when the source provides one. */
  points?: number;
};

export type SourceResult = {
  source: string;
  ok: boolean;
  ranks: Map<string, ExpertRank>;
  note?: string;
};

const emptyResult = (source: string, note: string): SourceResult => ({
  source, ok: false, ranks: new Map(), note,
});

function index(ranks: ExpertRank[]): Map<string, ExpertRank> {
  const m = new Map<string, ExpertRank>();
  for (const r of ranks) {
    for (const k of matchKeys(r.name)) {
      if (!m.has(k)) m.set(k, r);
    }
  }
  return m;
}

// ------------------------------------------------------------ FantasyPros

/**
 * FantasyPros expert consensus rankings — the "what do the experts say" input.
 * With an API key we use the documented v2 endpoint; without one we read the
 * ecrData blob the public rankings page embeds.
 */
export async function fetchFantasyPros(
  season: number,
  week: number,
  scoring: "PPR" | "HALF" | "STD",
  apiKey?: string,
): Promise<SourceResult> {
  const key = `fp-${season}-w${week}-${scoring}`;
  try {
    const ranks = await cached<ExpertRank[]>(key, 3 * HOUR, async () => {
      if (apiKey) {
        const url =
          `https://api.fantasypros.com/public/v2/json/nfl/${season}/consensus-rankings` +
          `?type=weekly&scoring=${scoring}&position=ALL&week=${week}&experts=available`;
        const res = await fetch(url, { headers: { "x-api-key": apiKey }, cache: "no-store" });
        if (!res.ok) throw new Error(`FantasyPros API ${res.status}`);
        const json = await res.json();
        return (json.players ?? []).map(fromFpApi);
      }
      return await scrapeFantasyPros(scoring, week);
    });
    return { source: "FantasyPros ECR", ok: true, ranks: index(ranks) };
  } catch (err) {
    const fallback = stale<ExpertRank[]>(key);
    if (fallback?.length) {
      return { source: "FantasyPros ECR", ok: true, ranks: index(fallback), note: "using cached ranks" };
    }
    return emptyResult("FantasyPros ECR", (err as Error).message);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function fromFpApi(p: any): ExpertRank {
  return {
    key: nameKey(p.player_name ?? ""),
    name: p.player_name ?? "",
    position: (p.player_position_id ?? "").toUpperCase(),
    team: (p.player_team_id ?? "").toUpperCase(),
    positionRank: num(p.pos_rank?.toString().replace(/\D/g, "")),
    overallRank: num(p.rank_ecr),
    stdDev: num(p.rank_std),
  };
}

const SCORING_SLUG = { PPR: "ppr", HALF: "half-point-ppr", STD: "" } as const;

async function scrapeFantasyPros(scoring: "PPR" | "HALF" | "STD", week: number): Promise<ExpertRank[]> {
  const slug = SCORING_SLUG[scoring];
  const url = `https://www.fantasypros.com/nfl/rankings/${slug ? `${slug}-` : ""}cheatsheets.php?week=${week}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`FantasyPros page ${res.status}`);
  const html = await res.text();

  const m = html.match(/var\s+ecrData\s*=\s*(\{[\s\S]*?\});/);
  if (!m) throw new Error("FantasyPros page layout changed — no ecrData found");

  const data = JSON.parse(m[1]);
  return (data.players ?? []).map((p: any): ExpertRank => ({
    key: nameKey(p.player_name ?? ""),
    name: p.player_name ?? "",
    position: (p.player_position_id ?? "").toUpperCase(),
    team: (p.player_team_id ?? "").toUpperCase(),
    positionRank: num(String(p.pos_rank ?? "").replace(/\D/g, "")),
    overallRank: num(p.rank_ecr),
    stdDev: num(p.rank_std),
  }));
}

// ------------------------------------------------------------ Sleeper

export type TrendingPlayer = { key: string; name: string; position: string; team: string; adds: number };

type SleeperPlayer = {
  full_name?: string; first_name?: string; last_name?: string;
  position?: string; team?: string; injury_status?: string;
  search_rank?: number; fantasy_positions?: string[];
};

/** Sleeper's free player database — our independent injury + market-rank signal. */
async function sleeperPlayers(): Promise<Record<string, SleeperPlayer>> {
  return cached("sleeper-players", 12 * HOUR, async () => {
    const res = await fetch("https://api.sleeper.app/v1/players/nfl", { cache: "no-store" });
    if (!res.ok) throw new Error(`Sleeper ${res.status}`);
    return (await res.json()) as Record<string, SleeperPlayer>;
  });
}

export async function fetchSleeper(): Promise<SourceResult> {
  try {
    const players = await sleeperPlayers();
    const ranks: ExpertRank[] = [];
    for (const p of Object.values(players)) {
      const name = p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(" ");
      if (!name || !p.position) continue;
      if (!["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.position)) continue;
      ranks.push({
        key: nameKey(name),
        name,
        position: p.position === "DEF" ? "D/ST" : p.position,
        team: p.team ?? "FA",
        // search_rank tracks real drafting/roster behavior across Sleeper leagues.
        overallRank: p.search_rank && p.search_rank < 10000 ? p.search_rank : undefined,
      });
    }
    return { source: "Sleeper market", ok: true, ranks: index(ranks) };
  } catch (err) {
    return emptyResult("Sleeper market", (err as Error).message);
  }
}

/** Who the rest of the fantasy world is adding right now — a waiver-wire signal. */
export async function fetchTrendingAdds(limit = 75): Promise<TrendingPlayer[]> {
  try {
    return await cached(`sleeper-trending-${limit}`, 30 * MINUTE, async () => {
      const [trending, players] = await Promise.all([
        fetch(`https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=${limit}`, {
          cache: "no-store",
        }).then((r) => {
          if (!r.ok) throw new Error(`Sleeper trending ${r.status}`);
          return r.json() as Promise<{ player_id: string; count: number }[]>;
        }),
        sleeperPlayers(),
      ]);

      return trending.flatMap(({ player_id, count }) => {
        const p = players[player_id];
        if (!p) return [];
        const name = p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(" ");
        if (!name) return [];
        return [{
          key: nameKey(name),
          name,
          position: p.position === "DEF" ? "D/ST" : (p.position ?? ""),
          team: p.team ?? "FA",
          adds: count,
        }];
      });
    });
  } catch {
    return stale<TrendingPlayer[]>(`sleeper-trending-${limit}`) ?? [];
  }
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
