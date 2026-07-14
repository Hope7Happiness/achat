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
PROXY="${ACHAT_PROXY:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --host)   MODE=host; shift ;;
    --server) MODE=client; SERVER="${2:-}"; shift 2 ;;
    --port)   PORT="${2:-}"; shift 2 ;;
    # For a machine with no root, where Tailscale can only run in userspace-networking mode
    # and the OS therefore has no route to the tailnet. See src/shared/proxy.ts.
    --proxy)  PROXY="${2:-}"; shift 2 ;;
    *) echo "usage: install.sh [--host | --server <url>] [--port N] [--proxy http://127.0.0.1:1055]" >&2; exit 1 ;;
  esac
done
[ -n "$MODE" ] || { echo "achat: pass --host (run the daemon here) or --server <url> (join one)" >&2; exit 1; }

say()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- prerequisites ----------------------------------------------------------

command -v git >/dev/null || die "git is required"
command -v curl >/dev/null || die "curl is required"
command -v claude >/dev/null || die "the claude CLI is required (https://claude.com/claude-code)"

# achat needs Node >= 24: it runs TypeScript with no build step and uses built-in node:sqlite.
# Rather than ask you to upgrade the machine's Node (which other things depend on), keep a
# private one under ~/.achat/node and refer to it by absolute path everywhere — the MCP
# registration, the service unit, and the watcher command all pin it, so nothing depends on
# what `node` happens to mean in a given shell.
NODE_DIR="$HOME/.achat/node"
NODE=""
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]; then
  NODE="$(command -v node)"
elif [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" -p 'process.versions.node.split(".")[0]')" -ge 24 ]; then
  NODE="$NODE_DIR/bin/node"
  say "using the private Node in $NODE_DIR ($("$NODE" -v))"
else
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux)  OS=linux ;;
    *) die "unsupported platform $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "unsupported architecture $(uname -m)" ;;
  esac
  # index.json is newest-first. Prefer the newest LTS that is new enough — a long-lived
  # daemon host is no place for a bleeding-edge Current release — and only fall back to the
  # newest non-LTS if no LTS >= 24 exists yet.
  INDEX=$(curl -fsSL https://nodejs.org/dist/index.json) || die "cannot reach nodejs.org"
  # Fed by a here-string, not a pipe: returning early from a `while` on the read end of a
  # pipe kills the writer with SIGPIPE, which under `set -o pipefail -e` takes the whole
  # installer down silently.
  ENTRIES=$(printf '%s' "$INDEX" | tr '}' '\n')
  pick() { # $1 = 1 to require an LTS release
    local line v major
    while IFS= read -r line; do
      case "$line" in *'"version":"v'*) ;; *) continue ;; esac
      if [ "$1" = 1 ]; then
        case "$line" in *'"lts":false'*) continue ;; esac
      fi
      v=${line#*\"version\":\"v}
      v=${v%%\"*}
      major=${v%%.*}
      if [ "$major" -ge 24 ] 2>/dev/null; then printf 'v%s' "$v"; return 0; fi
    done <<< "$ENTRIES"
    return 1
  }
  VER=$(pick 1 || true)
  [ -n "$VER" ] || VER=$(pick 0 || true)
  [ -n "$VER" ] || die "could not find a Node >= 24 release on nodejs.org"
  say "system node is $( (node -v 2>/dev/null) || echo missing) — installing a private Node $VER into $NODE_DIR"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  curl -fsSL "https://nodejs.org/dist/$VER/node-$VER-$OS-$ARCH.tar.gz" \
    | tar -xz -C "$NODE_DIR" --strip-components=1 \
    || die "failed to download Node $VER for $OS-$ARCH"
  NODE="$NODE_DIR/bin/node"
  [ -x "$NODE" ] || die "Node install failed"
fi
NPM_CLI="$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js"
run_npm() {
  if [ -f "$NPM_CLI" ]; then "$NODE" "$NPM_CLI" "$@"; else npm "$@"; fi
}

TS=""
for c in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  command -v "$c" >/dev/null 2>&1 && { TS="$c"; break; }
done

# ---- fetch ------------------------------------------------------------------

if [ -d "$APP/.git" ]; then
  say "updating $APP"
  # An older install ran `npm install`, which rewrote package-lock.json and left this
  # deployment permanently dirty — every --ff-only pull after it fails. Put the lockfile back.
  git -C "$APP" checkout --quiet -- package-lock.json 2>/dev/null || true
  git -C "$APP" pull --ff-only --quiet
else
  say "cloning achat into $APP"
  mkdir -p "$(dirname "$APP")"
  git clone --quiet --depth 1 "$REPO" "$APP"
fi
say "installing dependencies"
# `npm ci`, not `npm install`: install *rewrites* package-lock.json, which leaves this
# deployment's working tree permanently dirty and makes every future `git pull --ff-only`
# fail. ci installs exactly the lockfile and touches nothing.
(cd "$APP" && run_npm ci --silent --omit=dev >/dev/null)

# ---- work out the server URL ------------------------------------------------

if [ "$MODE" = host ]; then
  [ -n "$TS" ] || die "tailscale not found — install it, or host the daemon on a machine that has it"
  DNS=$("$TS" status --json | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const n=j.Self&&j.Self.DNSName;if(!n){process.exit(1)}process.stdout.write(n.replace(/\.$/,""))})') \
    || die "tailscale is installed but not logged in — run: tailscale up"
  BIND=$("$TS" ip -4 | head -1)
  SERVER="http://$DNS:$PORT"
  say "this machine will host achat at $SERVER (bound to $BIND, tailnet only)"
else
  [ -n "$SERVER" ] || die "--server needs a URL"
  say "joining achat at $SERVER${PROXY:+ (through proxy $PROXY)}"
  curl -fsS -m 8 ${PROXY:+--proxy "$PROXY"} "$SERVER/health" >/dev/null 2>&1 \
    || die "cannot reach $SERVER${PROXY:+ through $PROXY} — is the daemon running there, and is this machine on the tailnet?"
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
    <string>$NODE</string>
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
ExecStart=$NODE $APP/src/cli/achat.ts serve --host $BIND --port $PORT
Restart=always

[Install]
WantedBy=default.target
UNIT_EOF
    systemctl --user daemon-reload
    systemctl --user enable achat.service
    # restart, not `enable --now`: on a re-run the service is already up, and `--now` is a
    # no-op there — so a re-run would pull new code and then keep serving the old.
    systemctl --user restart achat.service
    # Without lingering, a --user service dies when you log out of SSH — which is exactly
    # what an always-on host must not do.
    loginctl enable-linger "$USER" >/dev/null 2>&1 \
      || say "note: could not enable lingering; run 'sudo loginctl enable-linger $USER' so the daemon survives logout"
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
claude mcp add achat --scope user \
  --env "ACHAT_SERVER=$SERVER" ${PROXY:+--env "ACHAT_PROXY=$PROXY"} \
  -- "$NODE" "$APP/src/mcp/server.ts"

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
  "$NODE" -e '
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
