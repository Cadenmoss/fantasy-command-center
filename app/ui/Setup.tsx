import { Panel } from "./atoms.tsx";

/** Shown until .env.local is filled in. The cookies must come from the user's own browser. */
export function Setup({ problems, season }: { problems: string[]; season: number }) {
  return (
    <Panel className="p-6">
      <h2 className="text-lg font-semibold">Finish setup</h2>
      <ul className="mt-3 space-y-1">
        {problems.map((p, i) => (
          <li key={i} className="text-[13px] text-[var(--danger)]">· {p}</li>
        ))}
      </ul>

      <ol className="mt-5 space-y-4 text-[13px] leading-relaxed text-[var(--muted)]">
        <li>
          <span className="font-semibold text-[var(--text)]">1. Get your ESPN cookies.</span> In the browser
          where you are logged into ESPN Fantasy, open DevTools → Application → Cookies → <code className="text-[var(--info)]">espn.com</code>.
          Copy the values of <code className="text-[var(--info)]">SWID</code> and <code className="text-[var(--info)]">espn_s2</code>.
          <div className="mt-1 text-[12px]">These are your login. Keep them in <code>.env.local</code>, which is gitignored.</div>
        </li>
        <li>
          <span className="font-semibold text-[var(--text)]">2. Get your league IDs.</span> Open each league on
          ESPN; the URL contains <code className="text-[var(--info)]">leagueId=XXXXXX</code>.
        </li>
        <li>
          <span className="font-semibold text-[var(--text)]">3. Create <code>.env.local</code>:</span>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3 text-[12px] text-[var(--text)]">{`ESPN_SWID={XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}
ESPN_S2=AEB...long...string
ESPN_SEASON=${season}

# id:teamId:Name  — append ":manual" to make a league propose-only
ESPN_LEAGUES=123456:1:Main Money League,234567:4:Work League,345678:8:Dynasty

# optional, more stable expert feed
FANTASYPROS_API_KEY=
CRON_SECRET=pick-any-random-string`}</pre>
        </li>
        <li>
          <span className="font-semibold text-[var(--text)]">4. Find your teamId.</span> Run{" "}
          <code className="text-[var(--accent)]">npm run verify</code> — it lists every team in every league with
          its id, so you can fill in the right one and confirm your cookies work.
        </li>
      </ol>
    </Panel>
  );
}
