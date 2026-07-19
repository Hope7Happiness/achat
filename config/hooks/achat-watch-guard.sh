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
# Behaviour, two checks at turn end:
#   1. If THIS window has no watcher running, block and tell the agent to relaunch it (else the
#      window goes deaf).
#   2. If a watcher IS running but there are messages the agent read yet never marked done —
#      the "saw it and forgot" state — block and tell it to handle them (best-effort: skipped
#      if the daemon/CLI can't be reached, since an inbox check must never break the stop).
# The loop-guard (stop_hook_active) means we nudge at most once per stop cycle, so a window is
# never trapped.

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
#
# A running watcher is not enough — it must be one the harness TRACKS, or its exit will never
# wake this window. A watcher launched with a shell `&` (e.g. folded into a compound Bash
# command) is reparented to init when its launching shell returns: pgrep still finds it, but the
# harness fires no task-notification when it exits, so the window is deaf while looking healthy.
# We detect that by PPID == 1 (orphaned to init on both Linux and macOS): a harness-tracked
# watcher has a live parent (PPID != 1). A matching-but-orphaned watcher is recorded separately
# so we can tell the agent WHY (relaunch properly) instead of the generic "no watcher" message.
NEEDLE="achat.ts watch --user $MYUSER"
found=0
orphan_seen=0
for pid in $(pgrep -f "$NEEDLE" 2>/dev/null); do
  c=$(ps -p "$pid" -o command= 2>/dev/null) || continue
  first=${c%% *}
  case "${first##*/}" in node|node[0-9]*) ;; *) continue;; esac
  case "$c" in *"$NEEDLE"*) ;; *) continue;; esac
  ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
  if [ "$ppid" = "1" ]; then orphan_seen=1; continue; fi
  found=1; break
done

# once-per-cycle loop guard: if we already nudged this stop, let the window go (never trap it).
nudged_before() { printf '%s' "$input" | grep -q '"stop_hook_active": *true'; }

if [ "$found" != 1 ]; then
  nudged_before && exit 0
  if [ "$orphan_seen" = 1 ]; then
    printf '%s' '{"decision":"block","reason":"Your achat watcher is an ORPHAN and cannot wake you. It was started with a shell `&` (often by folding `mark-done` and the relaunch into one Bash command), so it was reparented to init and the harness does not track it: it is running, but its exit fires no notification, so incoming messages will never reach you. Kill it, then relaunch the watcher as its OWN Bash call with run_in_background: true — never a shell `&`. Do it now; do not just acknowledge."}'
  else
    printf '%s' '{"decision":"block","reason":"No achat watcher is running for this window, so it can no longer be woken by incoming achat messages. Before you finish, relaunch the watcher in the BACKGROUND with the Bash tool (run_in_background: true) — the `achat watch` command that achat-start printed (re-run achat-start if you no longer have it). Actually launch it; do not just acknowledge."}'
  fi
  exit 0
fi

# Watcher is up. Second check: messages you READ (cleared the badge) but never marked DONE —
# the "saw it and forgot" state. Best-effort: if the CLI or daemon can't be reached, skip it;
# an inbox check must never break the stop. Uses the `achat` shim (it pins node + ACHAT_SERVER).
ACHAT_BIN=""
if [ -x "$HOME/.local/bin/achat" ]; then ACHAT_BIN="$HOME/.local/bin/achat"
elif command -v achat >/dev/null 2>&1; then ACHAT_BIN="$(command -v achat)"; fi
if [ -n "$ACHAT_BIN" ]; then
  # Bound the daemon round-trip so a hung daemon can't stall the stop. macOS has no `timeout`;
  # perl (shipped on macOS) gives us an alarm. Last resort: run unbounded and rely on the CLI's
  # own fast-fail when the daemon is down.
  if command -v timeout >/dev/null 2>&1; then
    undone="$(timeout 2 "$ACHAT_BIN" undone --user "$MYUSER" 2>/dev/null)"
  elif command -v perl >/dev/null 2>&1; then
    undone="$(perl -e 'alarm shift; exec @ARGV' 2 "$ACHAT_BIN" undone --user "$MYUSER" 2>/dev/null)"
  else
    undone="$("$ACHAT_BIN" undone --user "$MYUSER" 2>/dev/null)"
  fi
  case "$undone" in
    *"read but not handled"*)
      nudged_before && exit 0
      # Sanitise before embedding in JSON: a control char (e.g. a newline in a peer's username)
      # inside a JSON string literal is invalid and would silently drop the whole block. Delete
      # the C0 control bytes + DEL, then the two printable chars (" \) that also break a JSON
      # string. Byte-based under LC_ALL=C so it is locale-independent and leaves UTF-8 usernames
      # (e.g. 小明) intact — `tr -cd '[:print:]'` would strip those under a C/POSIX locale.
      safe=$(printf '%s' "$undone" | LC_ALL=C tr -d '\000-\037\177' | tr -d '"\\')
      printf '{"decision":"block","reason":"You have messages you read but never handled (%s). Deal with each (reply / act), then mark the conversation done with achat-mark-done — if one needs no action, still mark it done to clear it. Do not go idle leaving them unhandled."}' "$safe"
      exit 0 ;;
  esac
fi
exit 0
