/**
 * Program for the `com.fantasy.commandcenter.dashboard` launchd agent.
 *
 * The dashboard used to be started by the .app bundle itself, with
 * `nohup npm run start &`. Clicking the icon stopped working: the server would
 * be gone moments later, and repeated clicks did nothing at all. launchd owns
 * long-running processes properly, which is why the lineup, learn and health
 * jobs have run all season without this problem.
 *
 * This is a Node program and not a shell script for a specific reason. The
 * project lives on the Desktop, which is an iCloud-synced, TCC-protected
 * folder, and a launchd job gets no access to it by default: with `/bin/bash`
 * as the agent's program, bash cannot even read this file —
 *
 *   shell-init: getcwd: cannot access parent directories: Operation not permitted
 *   /bin/bash: scripts/dashboard.sh: Operation not permitted
 *
 * — and the job dies with exit 126 before running a line of it. The Homebrew
 * `node` binary does have access, which is the only reason the three existing
 * agents can read their own scripts. So this uses the same interpreter they do.
 * For the same reason the agent's logs go to ~/Library/Logs: launchd cannot
 * open a log file inside the synced folder either, and fails with EX_CONFIG
 * before producing any output at all to say so.
 *
 * Serves on loopback only. The API has unauthenticated write routes — set a
 * lineup, claim a waiver, propose a trade — and a server that is always on must
 * not answer to the rest of the network.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.FFCC_PORT ?? "3000";
const BUILD_ID = path.join(".next", "BUILD_ID");

/** Newest mtime across everything the production build is compiled from. */
function newestSourceMtime(): number {
  const roots = ["app", "lib", "next.config.ts", "package.json"];
  let newest = 0;
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    } else {
      newest = Math.max(newest, st.mtimeMs);
    }
  };
  roots.forEach(walk);
  return newest;
}

function build(why: string): boolean {
  console.log(`[dashboard] ${why} — building`);
  const r = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[dashboard] build failed (exit ${r.status})`);
    return false;
  }
  return true;
}

// Serving a build older than the code is how a fix that is already on disk
// fails to show up in the dashboard, with nothing to indicate why.
if (!fs.existsSync(BUILD_ID)) {
  if (!build("no production build yet")) {
    console.error("[dashboard] refusing to serve without a build — run `npm run build`");
    process.exit(1);
  }
} else if (newestSourceMtime() > fs.statSync(BUILD_ID).mtimeMs) {
  // A failed rebuild keeps the previous build rather than taking the dashboard
  // down: a stale dashboard is worth more than no dashboard.
  if (!build("source is newer than the build")) {
    console.error("[dashboard] keeping the previous build");
  }
}

console.log(`[dashboard] serving http://127.0.0.1:${PORT}`);
const child = spawn("npm", ["run", "start", "--", "--hostname", "127.0.0.1", "--port", PORT], {
  stdio: "inherit",
});

// `launchctl stop` and a machine shutdown both arrive as signals; pass them on
// so Next shuts down rather than being killed out from under launchd.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
