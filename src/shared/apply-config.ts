// Apply achat's per-window Claude Code configuration: the CLAUDE.md announce-loop block and
// the watch-guard Stop hook. Idempotent and safe to re-run.
//
// This is shared on purpose. install.sh applies it on a fresh install, `achat update` applies
// it after pulling (so config changes — a reworded CLAUDE.md block, a new hook — actually
// reach existing installs, which a bare `git pull` does not), and `achat apply-config` exposes
// it directly. One source of truth so the three paths cannot drift.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { appDir } from './paths.ts';

const BEGIN = '<!-- achat:begin -->';
const END = '<!-- achat:end -->';

type Log = (msg: string) => void;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function claudeDir(): string {
  const dir = join(homedir(), '.claude');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The announce-loop instructions every window loads, dropped into the user-level CLAUDE.md
// between markers so a reword refreshes in place instead of appending a second copy.
function applyClaudeMd(log: Log): void {
  const memPath = join(claudeDir(), 'CLAUDE.md');
  const body = readFileSync(join(appDir(), 'config', 'achat-window.md'), 'utf8').replace(/\n$/, '');
  const block = `${BEGIN}\n${body}\n${END}`;

  if (existsSync(memPath)) {
    const cur = readFileSync(memPath, 'utf8');
    if (cur.includes(BEGIN) && cur.includes(END)) {
      const re = new RegExp(escapeRe(BEGIN) + '[\\s\\S]*?' + escapeRe(END));
      // Function replacement, not a string: the block contains characters ($, backticks) that
      // String.replace would otherwise interpret as replacement patterns.
      const next = cur.replace(re, () => block);
      if (next !== cur) {
        writeFileSync(memPath, next);
        log('achat: refreshed the CLAUDE.md announce-loop block');
      } else {
        log('achat: CLAUDE.md announce-loop block already current');
      }
      return;
    }
    writeFileSync(memPath, `${cur}\n${block}\n`);
  } else {
    writeFileSync(memPath, `\n${block}\n`);
  }
  log('achat: installed the CLAUDE.md announce-loop block');
}

// The watch-guard Stop hook, wired into user settings idempotently. The command points at the
// in-repo script so a git pull refreshes the hook itself.
function applyWatchGuardHook(log: Log): void {
  const hook = join(appDir(), 'config', 'hooks', 'achat-watch-guard.sh');
  try {
    chmodSync(hook, 0o755);
  } catch {
    /* best effort; the file is executable in git anyway */
  }

  const settingsPath = join(claudeDir(), 'settings.json');
  let cfg: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8').trim();
    if (raw) {
      try {
        cfg = JSON.parse(raw);
      } catch {
        // Never clobber a settings file we cannot parse — a broken merge is far worse than a
        // missing hook. Leave it and tell the user.
        log(`achat: ${settingsPath} is not valid JSON; skipping the watch-guard hook — add it manually under hooks.Stop`);
        return;
      }
    }
  }

  const hooks = (cfg.hooks ??= {}) as Record<string, unknown>;
  const stop = (hooks.Stop ??= []) as unknown[];
  if (JSON.stringify(stop).includes(hook)) {
    log('achat: watch-guard Stop hook already present');
    return;
  }
  stop.push({ hooks: [{ type: 'command', command: hook }] });
  writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
  log('achat: installed the watch-guard Stop hook (takes effect in new/resumed windows)');
}

export function applyConfig(log: Log = (m) => process.stdout.write(m + '\n')): void {
  applyClaudeMd(log);
  applyWatchGuardHook(log);
  // No GC of the session→userId map here — see paths.ts: deleting a "no-watcher" entry is
  // exactly how you permanently de-guard a deaf window, and orphan entries are inert anyway.
}
