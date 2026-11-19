#!/bin/bash
# Installs a macOS launchd job that runs the auto-lineup BEFORE each kickoff
# window. Times are local, and chosen against real NFL kickoffs on the US west
# coast: Thursday night kicks at 5:15pm PT, the Sunday main slate at 10:00am PT,
# London games as early as 6:30am PT, and Monday night at 5:15pm PT.
#
# Every run must land before the games it is trying to optimise: a player's slot
# locks the moment his own game starts, so a run even 15 minutes late simply
# cannot move the players who matter most that window.
#
# If you are not on Pacific time, shift these by the difference — the guard rail
# is "at least an hour before the earliest kickoff in that window".
#
#   bash scripts/install-schedule.sh          # install
#   bash scripts/install-schedule.sh remove   # uninstall
set -euo pipefail

LABEL="com.fantasy.commandcenter.lineup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LEARN_LABEL="com.fantasy.commandcenter.learn"
LEARN_PLIST="$HOME/Library/LaunchAgents/$LEARN_LABEL.plist"
DOC_LABEL="com.fantasy.commandcenter.doctor"
DOC_PLIST="$HOME/Library/LaunchAgents/$DOC_LABEL.plist"
DASH_LABEL="com.fantasy.commandcenter.dashboard"
DASH_PLIST="$HOME/Library/LaunchAgents/$DASH_LABEL.plist"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"

if [ "${1:-}" = "remove" ]; then
  for p in "$PLIST" "$LEARN_PLIST" "$DOC_PLIST" "$DASH_PLIST"; do
    launchctl unload "$p" 2>/dev/null || true
    rm -f "$p"
  done
  echo "Removed $LABEL, $LEARN_LABEL, $DOC_LABEL and $DASH_LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/data/logs"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file-if-exists=.env.local</string>
    <string>scripts/lineup.ts</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <!-- Thu 3:30pm: before the 5:15pm Thursday night kickoff -->
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>15</integer><key>Minute</key><integer>30</integer></dict>
    <!-- Sat 9:00pm: sets a good lineup overnight in case Sunday news is late -->
    <dict><key>Weekday</key><integer>6</integer><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
    <!-- Sun 5:15am: before London kickoffs, which can be 6:30am local -->
    <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>5</integer><key>Minute</key><integer>15</integer></dict>
    <!-- Sun 8:45am: last call before the 10:00am main slate, catches inactives -->
    <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>45</integer></dict>
    <!-- Mon 3:30pm: before the 5:15pm Monday night kickoff -->
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>15</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$PROJECT/data/logs/lineup.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/data/logs/lineup.err.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# Weekly learning pass. Tuesday morning, once Monday night football has settled
# and ESPN has final scores for the week — the model grades its own predictions
# and refits before the next slate.
cat > "$LEARN_PLIST" <<LEARNEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LEARN_LABEL</string>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file-if-exists=.env.local</string>
    <string>scripts/learn.ts</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$PROJECT/data/logs/learn.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/data/logs/learn.err.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
LEARNEOF

launchctl unload "$LEARN_PLIST" 2>/dev/null || true
launchctl load "$LEARN_PLIST"

# Daily health check. The per-run checks only fire when a run happens, so a
# source that breaks on a Tuesday would otherwise go unnoticed until Thursday.
cat > "$DOC_PLIST" <<DOCEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$DOC_LABEL</string>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file-if-exists=.env.local</string>
    <string>scripts/doctor.ts</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$PROJECT/data/logs/doctor.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/data/logs/doctor.err.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
DOCEOF

launchctl unload "$DOC_PLIST" 2>/dev/null || true
launchctl load "$DOC_PLIST"

# The dashboard itself. This is a long-running server, so launchd owns it — the
# .app bundle used to start it with `nohup npm run start &` and clicking the
# icon stopped working reliably, because the app's entire lifetime was one short
# shell script. The bundle is now only a shim that pokes this agent and opens
# the URL.
#
# Built once here rather than inside the agent's program: under KeepAlive, a
# failing build would respawn every ThrottleInterval, forever.
echo "Building the dashboard (once, so the agent never has to)…"
( cd "$PROJECT" && npm run build )

# This agent's logs go to ~/Library/Logs, not data/logs, and that is not a style
# choice. The Desktop is an iCloud-synced, TCC-protected folder, and a launchd
# job gets no access to it by default. Two separate failures come out of that,
# both silent:
#
#   * logs inside the project  -> launchd cannot open them and the job dies with
#     EX_CONFIG (78) before its program runs, with no output anywhere saying so;
#   * /bin/bash as the program -> bash cannot even read its own script
#     ("Operation not permitted") and the job dies with 126.
#
# Both were isolated by bisection. The Homebrew `node` binary does have access,
# which is the only reason the three calendar jobs above can read their scripts
# and write their logs in the project, so this agent uses the same interpreter
# and keeps only its own logs outside. Those three are left alone: they work.
DASH_LOGS="$HOME/Library/Logs/FantasyCommandCenter"
mkdir -p "$DASH_LOGS"

cat > "$DASH_PLIST" <<DASHEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$DASH_LABEL</string>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>scripts/dashboard.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Enough of a gap that a persistent failure cannot hammer the machine. -->
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$DASH_LOGS/app.log</string>
  <key>StandardErrorPath</key><string>$DASH_LOGS/app.err.log</string>
</dict>
</plist>
DASHEOF

launchctl unload "$DASH_PLIST" 2>/dev/null || true
launchctl load "$DASH_PLIST"

echo "Installed $LABEL"
echo "  Thu 3:30pm · Sat 9:00pm · Sun 5:15am · Sun 8:45am · Mon 3:30pm (local time)"
echo "  Each run lands before that window's kickoff, since slots lock at game time."
echo "Installed $LEARN_LABEL"
echo "  Tue 9:00am — grades last week's predictions and refits the model"
echo "Installed $DOC_LABEL"
echo "  Daily 10:00am — checks every data source and alerts if one breaks"
echo "Installed $DASH_LABEL"
echo "  Always on, serving the dashboard at http://127.0.0.1:3000 (loopback only)"
echo "  Logs: data/logs/{lineup,learn,doctor}.log"
echo "        ~/Library/Logs/FantasyCommandCenter/app.log (launchd cannot log into iCloud-synced folders)"
echo "  Remove with: bash scripts/install-schedule.sh remove"
