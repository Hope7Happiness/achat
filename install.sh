#!/usr/bin/env bash
# achat one-line installer.
#
#   Host the daemon (run this once, on the machine that will hold the message store):
#     curl -fsSL https://raw.githubusercontent.com/Hope7Happiness/achat/main/install.sh | bash -s -- --host
#
#   Join from any other machine on the tailnet (the --host run prints this exact command):
#     curl -fsSL https://raw.githubusercontent.com/Hope7Happiness/achat/main/install.sh | bash -s -- --server http://<machine>.<tailnet>.ts.net:4360
#
# Afterwards every Claude Code window on the machine has the achat-* tools and knows the
# announce loop, with no per-window setup.

set -euo pipefail

REPO="${ACHAT_REPO:-https://github.com/Hope7Happiness/achat.git}"
APP="${ACHAT_APP:-$HOME/.achat/app}"
PORT="${ACHAT_PORT:-4360}"
MODE=""
SERVER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host)   MODE=host; shift ;;
    --server) MODE=client; SERVER="${2:-}"; shift 2 ;;
    --port)   PORT="${2:-}"; shift 2 ;;
    *) echo "usage: install.sh [--host | --server <url>] [--port N]" >&2; exit 1 ;;
  esac
done
[ -n "$MODE" ] || { echo "achat: pass --host (run the daemon here) or --server <url> (join one)" >&2; exit 1; }

say()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- prerequisites ----------------------------------------------------------

command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "node is required (>= 24 — achat runs TypeScript directly and uses node:sqlite)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 24 ] || die "node >= 24 required, found $(node -v)"
command -v claude >/dev/null || die "the claude CLI is required (https://claude.com/claude-code)"

TS=""
for c in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  command -v "$c" >/dev/null 2>&1 && { TS="$c"; break; }
done

# ---- fetch ------------------------------------------------------------------

if [ -d "$APP/.git" ]; then
  say "updating $APP"
  git -C "$APP" pull --ff-only --quiet
else
  say "cloning achat into $APP"
  mkdir -p "$(dirname "$APP")"
  git clone --quiet --depth 1 "$REPO" "$APP"
fi
say "installing dependencies"
(cd "$APP" && npm install --silent --omit=dev >/dev/null)

# ---- work out the server URL ------------------------------------------------

if [ "$MODE" = host ]; then
  [ -n "$TS" ] || die "tailscale not found — install it, or host the daemon on a machine that has it"
  DNS=$("$TS" status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const n=j.Self&&j.Self.DNSName;if(!n){process.exit(1)}process.stdout.write(n.replace(/\.$/,""))})') \
    || die "tailscale is installed but not logged in — run: tailscale up"
  BIND=$("$TS" ip -4 | head -1)
  SERVER="http://$DNS:$PORT"
  say "this machine will host achat at $SERVER (bound to $BIND, tailnet only)"
else
  [ -n "$SERVER" ] || die "--server needs a URL"
  say "joining achat at $SERVER"
  curl -fsS -m 5 "$SERVER/health" >/dev/null 2>&1 \
    || die "cannot reach $SERVER — is the daemon running there, and is this machine on the same tailnet?"
fi

# ---- host: run the daemon under the OS supervisor ---------------------------

if [ "$MODE" = host ]; then
  # Bind to the tailnet address, not 0.0.0.0: the session secret is a bearer credential, so
  # the daemon must not be listening on a coffee-shop wifi interface.
  if [ "$(uname)" = Darwin ]; then
    PLIST="$HOME/Library/LaunchAgents/com.achat.daemon.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.achat.daemon</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v node)</string>
    <string>$APP/src/cli/achat.ts</string>
    <string>serve</string>
    <string>--host</string><string>$BIND</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.achat/daemon.log</string>
  <key>StandardErrorPath</key><string>$HOME/.achat/daemon.log</string>
</dict></plist>
PLIST_EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    say "daemon installed as a launchd agent (starts at login)"
  else
    UNIT="$HOME/.config/systemd/user/achat.service"
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=achat daemon
After=network-online.target

[Service]
ExecStart=$(command -v node) $APP/src/cli/achat.ts serve --host $BIND --port $PORT
Restart=always

[Install]
WantedBy=default.target
UNIT_EOF
    systemctl --user daemon-reload
    systemctl --user enable --now achat.service
    say "daemon installed as a systemd user service"
  fi

  for _ in $(seq 1 20); do
    curl -fsS -m 2 "$SERVER/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS -m 2 "$SERVER/health" >/dev/null 2>&1 || die "daemon did not come up — see ~/.achat/daemon.log"
fi

# ---- register the MCP server for every Claude Code window on this machine ----

say "registering the achat MCP server with Claude Code (user scope)"
claude mcp remove achat --scope user >/dev/null 2>&1 || true
claude mcp add achat --scope user --env "ACHAT_SERVER=$SERVER" -- node "$APP/src/mcp/server.ts"

# ---- teach every window the announce loop -----------------------------------

# The tools alone are not enough: a window has to know to come online, and to keep a
# background watcher running so that an incoming message can wake it. That is exactly what
# config/achat-agent.md says, so we drop it in as a user-level memory that every session
# loads, regardless of which project the window is opened in.
MEM="$HOME/.claude/CLAUDE.md"
mkdir -p "$(dirname "$MEM")"
BEGIN="<!-- achat:begin -->"
END="<!-- achat:end -->"
if [ -f "$MEM" ] && grep -qF "$BEGIN" "$MEM"; then
  node -e '
    const fs=require("fs");
    const [file,begin,end,body]=process.argv.slice(1);
    const cur=fs.readFileSync(file,"utf8");
    const re=new RegExp(begin.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"[\\s\\S]*?"+end.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"));
    fs.writeFileSync(file,cur.replace(re,begin+"\n"+body+"\n"+end));
  ' "$MEM" "$BEGIN" "$END" "$(cat "$APP/config/achat-window.md")"
else
  { printf '\n%s\n' "$BEGIN"; cat "$APP/config/achat-window.md"; printf '%s\n' "$END"; } >> "$MEM"
fi

cat <<DONE

  achat is installed.

    server        $SERVER
    app           $APP
    tools         achat-start, achat-send, achat-list, achat-history, achat-unread, achat-mark-read
    every window  $MEM  (announce loop, between the achat markers)

  Open a new Claude Code window and say "get on achat as <name>".
DONE

if [ "$MODE" = host ]; then
  cat <<JOIN
  Web UI:  $SERVER

  On any other machine on your tailnet:

    curl -fsSL https://raw.githubusercontent.com/Hope7Happiness/achat/main/install.sh | bash -s -- --server $SERVER

JOIN
fi
