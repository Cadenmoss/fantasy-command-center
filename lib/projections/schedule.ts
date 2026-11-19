import { cached, stale, HOUR } from "../util/cache.ts";

export type GameInfo = {
  team: string;
  opponent: string;
  homeAway: "home" | "away";
  /** Vegas implied team total — the market's view of how much offense to expect. */
  impliedTotal?: number;
  spread?: number;
  kickoff: string;
  started: boolean;
};

export type WeekSchedule = {
  week: number;
  games: Map<string, GameInfo>;
  /** Teams with no game this week are on bye. */
  onBye: Set<string>;
  ok: boolean;
};

const ALL_TEAMS = [
  "ATL","BUF","CHI","CIN","CLE","DAL","DEN","DET","GB","TEN","IND","KC","LV","LAR","MIA",
  "MIN","NE","NO","NYG","NYJ","PHI","ARI","PIT","LAC","SF","SEA","TB","WSH","CAR","JAX","BAL","HOU",
];

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * ESPN's public scoreboard gives us three things the fantasy API doesn't:
 * who is on bye, whether a game has already kicked off (so the slot is locked),
 * and the betting line we use as a matchup signal.
 */
export async function fetchWeekSchedule(season: number, week: number): Promise<WeekSchedule> {
  const key = `sched-${season}-w${week}`;
  const load = async (): Promise<GameInfo[]> => {
    const url =
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` +
      `?dates=${season}&seasontype=2&week=${week}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`NFL scoreboard ${res.status}`);
    const json = await res.json();

    const out: GameInfo[] = [];
    for (const event of json.events ?? []) {
      const comp = event.competitions?.[0];
      if (!comp) continue;

      const odds = comp.odds?.[0];
      const overUnder = Number(odds?.overUnder);
      const spread = Number(odds?.spread); // negative favors the home team
      const started = comp.status?.type?.state !== "pre";
      const kickoff = comp.date ?? event.date ?? "";

      for (const c of comp.competitors ?? []) {
        const team = normalizeAbbrev(c.team?.abbreviation ?? "");
        const other = (comp.competitors ?? []).find((x: any) => x !== c);
        const isHome = c.homeAway === "home";

        // Implied team total = half the O/U, shifted by half the spread.
        let impliedTotal: number | undefined;
        if (Number.isFinite(overUnder) && Number.isFinite(spread)) {
          const margin = isHome ? -spread : spread;
          impliedTotal = overUnder / 2 + margin / 2;
        }

        out.push({
          team,
          opponent: normalizeAbbrev(other?.team?.abbreviation ?? ""),
          homeAway: isHome ? "home" : "away",
          impliedTotal,
          spread: Number.isFinite(spread) ? spread : undefined,
          kickoff,
          started,
        });
      }
    }
    if (!out.length) throw new Error("scoreboard returned no games");
    return out;
  };

  let games: GameInfo[] | null = null;
  let ok = true;
  try {
    // Short TTL: kickoff status and lines both move during the day.
    games = await cached(key, 1 * HOUR, load);
  } catch {
    games = stale<GameInfo[]>(key);
    ok = false;
  }

  const map = new Map((games ?? []).map((g) => [g.team, g]));
  const onBye = new Set(ALL_TEAMS.filter((t) => !map.has(t)));

  return {
    week,
    games: map,
    // If the fetch failed outright we must not claim everyone is on bye.
    onBye: games ? onBye : new Set<string>(),
    ok: ok && !!games,
  };
}

/** ESPN's fantasy side and its news side disagree on a few abbreviations. */
function normalizeAbbrev(a: string): string {
  const up = a.toUpperCase();
  return ({ WSH: "WSH", WAS: "WSH", JAC: "JAX", LA: "LAR", OAK: "LV", SD: "LAC" } as Record<string, string>)[up] ?? up;
}
