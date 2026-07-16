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
# Behaviour: if no live watcher is found, block the stop and tell the agent to relaunch it.
# The loop-guard (stop_hook_active) means we nudge at most once per stop cycle, so a window
# that genuinely cannot start a watcher is never trapped.

set -u
input="$(cat)"

# Match only the real node watcher process. A bare `pgrep -f` also matches the bash wrapper
# that launched it and any transient command that merely mentions the string (including this
# hook), which would falsely report "watcher alive". So we additionally require argv[0] to be
# the node binary — bash wrappers and shells are argv[0]=bash and get excluded. This is
# portable (ps/pgrep exist on both Linux and macOS; /proc does not, and node reports its
# /proc comm as "MainThread" anyway, so neither is usable).
PAT="${ACHAT_WATCH_PAT:-achat.ts watch}"
found=0
for pid in $(pgrep -f "$PAT" 2>/dev/null); do
  c=$(ps -p "$pid" -o command= 2>/dev/null) || continue
  first=${c%% *}
  case "${first##*/}" in node|node[0-9]*) ;; *) continue;; esac
  case "$c" in *"achat.ts watch"*) found=1; break;; esac
done
[ "$found" = 1 ] && exit 0

# No watcher. Only nudge once per stop cycle so we never trap the window in a loop.
printf '%s' "$input" | grep -q '"stop_hook_active": *true' && exit 0

printf '%s' '{"decision":"block","reason":"No achat watcher process is running, so this window can no longer be woken by incoming achat messages. Before you finish, relaunch the watcher in the BACKGROUND with the Bash tool (run_in_background: true) — the `achat watch` command that achat-start printed. Actually launch it; do not just acknowledge."}'
exit 0
