/**
 * Command safety policy.
 *
 * Level 0 — HARD_BLOCK: never executed, agent gets an immediate error.
 * Level 1 — APPROVAL: fine, but requires explicit user Allow (the default for
 *           every command unless auto-approve is switched on in the UI).
 * Level 2 — AUTO: read-only queries the user usually doesn't need to confirm.
 */

const HARD_BLOCK_PATTERNS: RegExp[] = [
  /rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/(\s|$)/, // rm -rf /
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+~(\s|$)/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, // fork bomb
  /mkfs(\.\w+)?\s/,
  /dd\s+.*of=\/dev\/(sd|nvme|disk)/,
  />\s*\/dev\/sd[a-z]/,
  /chmod\s+-R\s+777\s+\//,
  /shutdown|reboot|halt\b/,
  /:\s*>\s*\/dev\/null\s*<\s*\/dev/, // < /dev/... wipe tricks
  /curl[^|]*\|\s*(sudo\s+)?(ba)?sh/,
  /wget[^|]*\|\s*(sudo\s+)?(ba)?sh/,
  /git\s+push\s+.*--force/,
  /git\s+reset\s+--hard\s+origin/i,
  /drop\s+(table|database)\b/i,
];

const AUTO_OK_PATTERNS: RegExp[] = [
  /^\s*git\s+(status|log|diff|branch|show|remote)\b/,
  /^\s*(ls|pwd|cat|head|tail|wc|which|node\s+--version|npm\s+ls|python3?\s+--version|echo)\b/,
];

export type PolicyVerdict = "hard_block" | "approval" | "auto_ok";

export function checkCommand(command: string): PolicyVerdict {
  const cmd = command.trim();
  for (const re of HARD_BLOCK_PATTERNS) {
    if (re.test(cmd)) return "hard_block";
  }
  // Chained commands inherit the strictest verdict of any segment.
  const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  let verdict: PolicyVerdict = "approval";
  let allAutoOk = segments.length > 0;
  for (const seg of segments) {
    if (HARD_BLOCK_PATTERNS.some((re) => re.test(seg))) return "hard_block";
    if (!AUTO_OK_PATTERNS.some((re) => re.test(seg))) allAutoOk = false;
  }
  if (allAutoOk) verdict = "auto_ok";
  return verdict;
}
