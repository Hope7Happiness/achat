#!/usr/bin/env bash
# achat watch-guard — a Claude Code **Stop hook**.
#
# Why this exists: a turn-based agent window can only *receive* an achat message by being
# woken into a new turn, and the only thing that wakes an idle window is a background task
# it started finishing. The `achat watch` process is that task — but it exits every time it
# delivers mail and must be relaunched. If the agent ever finishes a turn without a watcher
# running, the window goes permanently deaf. A hook cannot start the watcher (a hook-spawned
# process is not a harness-tracked task, so its exit would not wake the agent), but a Stop
# hook CAN refuse to let the window go idle without one — turning "the agent must remember"
# into "the harness won't let it forget".
#
# Behaviour: if THIS window has no watcher running, block the stop and tell the agent to
# relaunch it. The loop-guard (stop_hook_active) means we nudge at most once per stop cycle,
# so a window that genuinely cannot start a watcher is never trapped.

set -u
input="$(cat)"

# Which achat identity is THIS window? A window is identified to its hooks by
# CLAUDE_CODE_SESSION_ID (in both the MCP server's env and ours). The MCP server records
# session→userId at achat-start; we read it back. This is what makes the guard correct on a
# multi-window machine: we look for *our own* watcher, not just any watcher — otherwise
# another window's watcher would satisfy this guard and let us go deaf.
#
# If there is no session id, or no mapping (this window never joined achat), there is nothing
# to guard — allow the stop.
#
# KNOWN GAP (fail-open is silent): we cannot distinguish "this window never joined achat" from
# "this window joined but its mapping is missing" — a hook has no other handle on its own achat
# identity. The latter can happen transiently during rollout (new hook installed, but the MCP
# server still runs pre-mapping code until the window restarts) or where CLAUDE_CODE_SESSION_ID
# is absent (non-Claude-Code harness). In those windows the guard degrades to a silent no-op —
# the very failure mode it exists to catch. Blocking instead would wrongly trap genuinely
# non-achat windows, so fail-open is the safe choice; this note is the honest disclosure of it.
CCSID="${CLAUDE_CODE_SESSION_ID:-}"
[ -n "$CCSID" ] || exit 0
MAP="${ACHAT_HOME:-$HOME/.achat}/session-user/$CCSID"
[ -f "$MAP" ] || exit 0
MYUSER="$(cat "$MAP" 2>/dev/null)"
[ -n "$MYUSER" ] || exit 0

# Look for THIS window's watcher: a node process whose command line is `achat.ts watch
# --user <MYUSER>`. Requiring argv[0] to be the node binary excludes the bash wrapper that
# launched it and any transient command that merely mentions the string (this hook included).
# Portable: ps/pgrep exist on Linux and macOS; /proc does not, and node's /proc comm is
# "MainThread" anyway, so neither is usable.
NEEDLE="achat.ts watch --user $MYUSER"
found=0
for pid in $(pgrep -f "$NEEDLE" 2>/dev/null); do
  c=$(ps -p "$pid" -o command= 2>/dev/null) || continue
  first=${c%% *}
  case "${first##*/}" in node|node[0-9]*) ;; *) continue;; esac
  case "$c" in *"$NEEDLE"*) found=1; break;; esac
done
[ "$found" = 1 ] && exit 0

# No watcher for this window. Only nudge once per stop cycle so we never trap it in a loop.
printf '%s' "$input" | grep -q '"stop_hook_active": *true' && exit 0

printf '%s' '{"decision":"block","reason":"No achat watcher is running for this window, so it can no longer be woken by incoming achat messages. Before you finish, relaunch the watcher in the BACKGROUND with the Bash tool (run_in_background: true) — the `achat watch` command that achat-start printed (re-run achat-start if you no longer have it). Actually launch it; do not just acknowledge."}'
exit 0
