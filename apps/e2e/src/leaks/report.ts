import type { LogSlice } from "./captures.ts";
import { type Finding, formatFinding } from "./scan.ts";
import {
  checkServerLog,
  formatLogViolation,
  type LogAllowlist,
  serverLogAllowlist,
} from "./server-log.ts";

/** Violations of the stdout allowlist in a log slice, as `<file>:<line>: <rule>: …` lines. */
export function logViolations(
  file: string,
  slice: LogSlice,
  allowlist: LogAllowlist = serverLogAllowlist,
): string[] {
  return checkServerLog(slice.lines, allowlist).map((violation) =>
    formatLogViolation(violation, `${file}:${slice.firstLine + violation.line - 1}`),
  );
}

/** At most this many findings or violations are listed; the rest are counted. */
const maxListed = 50;

/**
 * A failure message for findings and log violations, or undefined when there are none.
 * `seed` is the run seed (hex), printed so the canaries can be made again.
 */
export function formatLeakReport(
  findings: readonly Finding[],
  violations: readonly string[],
  seed?: string,
): string | undefined {
  if (findings.length === 0 && violations.length === 0) return undefined;
  const parts = [
    `Leak check failed: ${findings.length} finding(s), ` +
      `${violations.length} server stdout violation(s).`,
  ];
  if (seed) parts.push(`Replay the canaries with SIGILL_E2E_SEED=${seed}.`);
  if (findings.length > 0) {
    // The context shows bytes of throwaway test canaries, never of a real secret.
    parts.push("Findings:", ...list(findings.map(formatFinding)));
  }
  if (violations.length > 0) parts.push("Server stdout violations:", ...list(violations));
  return parts.join("\n");
}

function list(lines: readonly string[]): string[] {
  const shown = lines.slice(0, maxListed).map((line) => `  ${line}`);
  if (lines.length > maxListed) shown.push(`  … and ${lines.length - maxListed} more`);
  return shown;
}
