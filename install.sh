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
BACKEND="${ACHAT_BACKEND:-local}"   # how the host is reached: local (default), tailscale, or your own
BIND=""                              # explicit bind address; set by --bind, bypasses the backend

while [ $# -gt 0 ]; do
  case "$1" in
    --host)    MODE=host; shift ;;
    --server)  MODE=client; SERVER="${2:-}"; shift 2 ;;
    --backend) MODE="${MODE:-host}"; BACKEND="${2:-}"; shift 2 ;;
    --bind)    MODE="${MODE:-host}"; BIND="${2:-}"; shift 2 ;;
    --port)    PORT="${2:-}"; shift 2 ;;
    # For a machine with no root, where Tailscale can only run in userspace-networking mode
    # and the OS therefore has no route to the tailnet. See src/shared/proxy.ts.
    --proxy)   PROXY="${2:-}"; shift 2 ;;
    *) echo "usage: install.sh [--host] [--backend <name> | --bind <addr>] [--server <url>] [--port N] [--proxy <url>]" >&2; exit 1 ;;
  esac
done
# Default: host this machine with the 'local' backend. Same-machine achat needs no network,
# no Tailscale — the daemon on loopback and every window here talking to it is the whole setup.
[ -n "$MODE" ] || MODE=host

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

# ---- work out where the daemon binds and how clients reach it ---------------

if [ "$MODE" = host ]; then
  if [ -n "$BIND" ]; then
    # Explicit --bind bypasses the backend entirely: you handed us the address.
    SERVER="${SERVER:-http://$BIND:$PORT}"
    say "this machine will host achat at $SERVER (bound to $BIND)"
  else
    # A backend resolves (BIND, SERVER) for the host — what the daemon binds to, and the url
    # clients use. Built-ins: local (default, loopback) and tailscale. A custom backend is just
    # a script in ~/.achat/backends/<name> printing BIND=/SERVER= (see config/backends/*).
    BE=""
    for d in "${ACHAT_HOME:-$HOME/.achat}/backends" "$APP/config/backends"; do
      [ -f "$d/$BACKEND" ] && { BE="$d/$BACKEND"; break; }
    done
    [ -n "$BE" ] || die "unknown backend '$BACKEND' — looked in ~/.achat/backends and $APP/config/backends"
    say "resolving the host address via the '$BACKEND' backend"
    BE_OUT=$(ACHAT_PORT="$PORT" ACHAT_NODE="$NODE" ACHAT_PROXY="$PROXY" bash "$BE" host) \
      || die "the '$BACKEND' backend could not resolve a host address (its message is above)"
    while IFS='=' read -r k v; do
      case "$k" in BIND) BIND="$v" ;; SERVER) SERVER="$v" ;; PROXY) PROXY="$v" ;; esac
    done <<BE_EOF
$BE_OUT
BE_EOF
    [ -n "$BIND" ] && [ -n "$SERVER" ] || die "the '$BACKEND' backend did not print both BIND= and SERVER="
    say "this machine will host achat at $SERVER (bound to $BIND, via '$BACKEND')"
  fi
  case "$BIND" in
    0.0.0.0|'*')
      say "WARNING: bind $BIND exposes the daemon to every network this machine is on. The session"
      say "         secret is a bearer credential — only do this behind a TLS proxy or trusted network." ;;
  esac
else
  [ -n "$SERVER" ] || die "--server needs a URL"
  say "joining achat at $SERVER${PROXY:+ (through proxy $PROXY)}"
  curl -fsS -m 8 ${PROXY:+--proxy "$PROXY"} "$SERVER/health" >/dev/null 2>&1 \
    || die "cannot reach $SERVER${PROXY:+ through $PROXY} — is the daemon running there, and can this machine reach it?"
fi

# ---- host: run the daemon under the OS supervisor ---------------------------

if [ "$MODE" = host ]; then
  # $BIND was resolved above — loopback for the local backend, a private address for a
  # cross-machine one. Whatever it is, the session secret is a bearer credential, so it must
  # never be a public interface; the backends and the --bind warning enforce that.
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

# ---- an `achat` command -----------------------------------------------------

# A shim, not a symlink: it pins the Node that can actually run this code, and bakes in
# ACHAT_SERVER/ACHAT_PROXY. Without it, using the CLI means typing an absolute path to a
# private Node plus a pile of env vars — which is not something anyone should have to
# remember, least of all to run `achat update`.
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
{
  echo '#!/bin/sh'
  echo "# generated by achat install.sh — re-run the installer to regenerate"
  echo "export ACHAT_SERVER=\"$SERVER\""
  [ -n "$PROXY" ] && echo "export ACHAT_PROXY=\"$PROXY\""
  echo "exec \"$NODE\" \"$APP/src/cli/achat.ts\" \"\$@\""
} > "$BIN/achat"
chmod +x "$BIN/achat"
say "installed the \`achat\` command into $BIN"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "note: $BIN is not on your PATH — add it, or call $BIN/achat directly" ;;
esac

# ---- register the MCP server for every Claude Code window on this machine ----

say "registering the achat MCP server with Claude Code (user scope)"
claude mcp remove achat --scope user >/dev/null 2>&1 || true
claude mcp add achat --scope user \
  --env "ACHAT_SERVER=$SERVER" ${PROXY:+--env "ACHAT_PROXY=$PROXY"} \
  -- "$NODE" "$APP/src/mcp/server.ts"

# ---- apply per-window Claude Code config -------------------------------------
#
# The tools alone are not enough: a window has to know to come online and keep a background
# watcher running so an incoming message can wake it (the CLAUDE.md announce-loop block), and
# it must never go idle without that watcher (the watch-guard Stop hook). Both are wired into
# ~/.claude here. This is the same code `achat update` runs — see src/shared/apply-config.ts —
# so a reworded block or a new hook reaches existing installs too, which a bare git pull does
# not.
"$NODE" "$APP/src/cli/achat.ts" apply-config

cat <<DONE

  achat is installed.

    server        $SERVER
    app           $APP
    command       $BIN/achat        (try: achat version)
    every window  $MEM  (announce loop, between the achat markers)

  Open a new Claude Code window and say "get on achat as <name>".
  To update this machine later:  achat update
DONE

if [ "$MODE" = host ]; then
  cat <<JOIN
  Web UI:  $SERVER

  On any other machine on your tailnet:

    curl -fsSL https://raw.githubusercontent.com/Hope7Happiness/achat/main/install.sh | bash -s -- --server $SERVER

JOIN
fi
