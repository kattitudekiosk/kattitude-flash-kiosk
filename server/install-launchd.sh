#!/bin/sh
# Keep the studio server running on the Mac mini.
#
#   sh server/install-launchd.sh            install / reinstall
#   sh server/install-launchd.sh uninstall  remove both jobs
#
# Installs two per-user LaunchAgents (no admin password, nothing system-wide):
#   com.kattitude.studio-server   starts at login, restarted if it ever exits
#   com.kattitude.studio-backup   snapshots the database every night at 03:30
#   com.kattitude.studio-sync     every 5 min: pull the hosted dashboard's sheets
#                                 from Supabase into KIOSK MEDIA (logs/sync.log)
#
# The server binds to 127.0.0.1 only. Installing this exposes nothing to the
# network; the tunnel is a separate, deliberate step (server/README.md).
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="/opt/homebrew/bin/node"   # Homebrew's stable symlink — survives node upgrades
AGENTS="$HOME/Library/LaunchAgents"
DATA="$HOME/KattitudeData"
UID_NUM="$(id -u)"

unload() {
  for job in com.kattitude.studio-server com.kattitude.studio-backup com.kattitude.studio-sync; do
    launchctl bootout "gui/$UID_NUM/$job" 2>/dev/null || true
    rm -f "$AGENTS/$job.plist"
  done
}

if [ "${1:-}" = "uninstall" ]; then
  unload
  echo "Removed. Data is untouched at $DATA"
  exit 0
fi

[ -x "$NODE" ] || { echo "No node at $NODE"; exit 1; }
mkdir -p "$AGENTS" "$DATA/logs"
unload

cat > "$AGENTS/com.kattitude.studio-server.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kattitude.studio-server</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/server/server.js</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict><key>KT_DATA_DIR</key><string>$DATA</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DATA/logs/server.log</string>
  <key>StandardErrorPath</key><string>$DATA/logs/server.log</string>
</dict></plist>
EOF

cat > "$AGENTS/com.kattitude.studio-sync.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kattitude.studio-sync</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/server/cli.js</string><string>sync-supabase</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict><key>KT_DATA_DIR</key><string>$DATA</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$DATA/logs/sync.log</string>
  <key>StandardErrorPath</key><string>$DATA/logs/sync.log</string>
</dict></plist>
EOF

cat > "$AGENTS/com.kattitude.studio-backup.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kattitude.studio-backup</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/server/cli.js</string><string>backup</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict><key>KT_DATA_DIR</key><string>$DATA</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$DATA/logs/backup.log</string>
  <key>StandardErrorPath</key><string>$DATA/logs/backup.log</string>
</dict></plist>
EOF

plutil -lint "$AGENTS/com.kattitude.studio-server.plist" "$AGENTS/com.kattitude.studio-backup.plist" "$AGENTS/com.kattitude.studio-sync.plist"
launchctl bootstrap "gui/$UID_NUM" "$AGENTS/com.kattitude.studio-server.plist"
launchctl bootstrap "gui/$UID_NUM" "$AGENTS/com.kattitude.studio-backup.plist"
launchctl bootstrap "gui/$UID_NUM" "$AGENTS/com.kattitude.studio-sync.plist"
sleep 2
curl -fsS http://127.0.0.1:8787/healthz && echo && echo "Studio server is running: http://localhost:8787"
