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

# Which achat identity is THIS window? We key off CLAUDE_CODE_SESSION_ID and read the
# session→userId map to find our own watcher — so another window's watcher on the same machine
# can't satisfy this guard and let us go deaf.
#
# CRITICAL: that map is written by the WATCHER (`achat watch`), NOT the MCP server. The MCP's
# CLAUDE_CODE_SESSION_ID diverges from ours after --resume/compact (its process is respawned
# with a fresh id); the Bash tools, the watcher they launch, and this hook all keep the
# window's original id. Registering from the MCP keyed the map by an id we never read, so
# resumed windows false-blocked. Writer and reader must be same-source — the watcher is.
#
# If there is no session id, or no mapping (this window has no watcher registered), there is
# nothing we can identify — allow the stop.
#
# KNOWN GAP (fail-open is silent): we cannot distinguish "this window never joined achat" from
# "joined but not yet registered" (e.g. between session start and the first watch launch, or on
# a host with no CLAUDE_CODE_SESSION_ID). There the guard is a silent no-op. Blocking instead
# would wrongly trap genuinely non-achat windows, so fail-open is the safe choice; `achat watch`
# prints a warning when it can't register, which is the audible half of this disclosure.
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
