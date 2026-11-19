import { NextResponse } from "next/server";
import { loadConfig, configProblems } from "@/lib/config";
import { analyzeLeague } from "@/lib/engine/run";
import { rosterCapacity } from "@/lib/engine/protect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) return NextResponse.json({ problems }, { status: 400 });

  const lc = cfg.leagues.find((l) => l.id === id);
  if (!lc) return NextResponse.json({ error: `League ${id} is not configured` }, { status: 404 });

  try {
    const a = await analyzeLeague(cfg, lc);
    return NextResponse.json({
      id: lc.id,
      label: lc.name,
      autoLineup: lc.autoLineup,
      avoidLast: !!lc.avoidLast,
      league: {
        name: a.league.name, week: a.league.week, season: a.league.season,
        scoring: a.league.scoringType, waivers: a.league.waivers,
      },
      myTeam: { id: a.myTeam.id, name: a.myTeam.name, wins: a.myTeam.wins, losses: a.myTeam.losses },
      lineup: a.lineup,
      waivers: a.waivers,
      trades: a.trades,
      byeRisks: a.byeRisks,
      matchup: a.matchup && {
        opponent: { id: a.matchup.opponent.id, name: a.matchup.opponent.name },
        winProbability: a.matchup.winProbability,
        me: { mean: a.matchup.me.mean, sigma: a.matchup.me.sigma },
        them: { mean: a.matchup.them.mean, sigma: a.matchup.them.sigma },
        pointsFirst: a.matchup.pointsFirst,
        winFirst: a.matchup.winFirst,
        leverageMoves: a.matchup.leverageMoves,
        advice: a.matchup.advice,
      },
      season: a.season && {
        me: a.season.me,
        odds: a.season.odds,
        simulations: a.season.simulations,
        weeksLeft: a.season.weeksLeft,
        playoffSpots: a.season.playoffSpots,
        thisWeekSwing: a.season.thisWeekSwing,
        thisWeekLastSwing: a.season.thisWeekLastSwing,
      },
      weaknesses: a.weaknesses.map((w) => ({
        team: { id: w.team.id, name: w.team.name },
        record: w.record,
        desperation: w.desperation,
        readAloud: w.readAloud,
        holes: w.holes,
      })),
      exploits: a.exploits.map((t) => ({
        partner: { id: t.partner.id, name: t.partner.name },
        give: t.give.map((p) => ({ id: p.id, name: p.name, position: p.position, team: p.team })),
        receive: t.receive.map((p) => ({ id: p.id, name: p.name, position: p.position, team: p.team })),
        theirLineupGain: t.theirLineupGain,
        myValueGain: t.myValueGain,
        myLineupGain: t.myLineupGain,
        edge: t.edge,
        likelihood: t.likelihood,
        whyTheySayYes: t.whyTheySayYes,
        whyItsGoodForMe: t.whyItsGoodForMe,
        pitch: t.pitch,
      })),
      roster: a.myTeam.roster
        .map((p) => ({
          id: p.id,
          name: p.name,
          position: p.position,
          team: p.team,
          lineupSlotId: p.lineupSlotId,
          injuryStatus: p.injuryStatus,
          percentOwned: p.percentOwned,
        })),
      rosterFull: a.myTeam.roster.length >= rosterCapacity(a.league.lineupSlotCounts),
      myBudget: {
        spent: a.myTeam.budgetSpent,
        remaining: Math.max(0, a.league.waivers.budget - a.myTeam.budgetSpent),
        waiverRank: a.myTeam.waiverRank,
      },
      dataNotes: a.dataNotes,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
