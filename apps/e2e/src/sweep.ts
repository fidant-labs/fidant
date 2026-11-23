import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { bodyLimits, logCaptures, logSlice, recordCaptures } from "./leaks/captures.ts";
import { buildNeedles } from "./leaks/needles.ts";
import { readRegistry } from "./leaks/registry.ts";
import { formatLeakReport, logViolations } from "./leaks/report.ts";
import { type Capture, type Finding, scan } from "./leaks/scan.ts";
import type { ObservationRecord } from "./observations.ts";
import { e2eDir, observationsDir, runDir, serverStdoutLog } from "./paths.ts";

/**
 * The run-level sweep: every observation file and every run log, against every secret any test
 * registered (except tests that registered as leaking on purpose), plus the stdout allowlist over the whole log.
 * Run it once the stack has stopped, so the logs are complete. Returns a failure message or
 * undefined.
 */
export async function sweepRun(registry: string, seed?: string): Promise<string | undefined> {
  const { secrets, exempt } = await readRegistry(registry);
  const stdout = completeLog(await readFile(serverStdoutLog).catch(() => Buffer.alloc(0)));
  const violations = logViolations(relative(e2eDir, serverStdoutLog), stdout);
  const { captures, limits } = await allCaptures(exempt);
  const findings = [
    ...limits,
    ...(secrets.length === 0 ? [] : scan(captures, buildNeedles(secrets))),
  ];
  return formatLeakReport(findings, violations, seed);
}

/** The whole of a log that is final, including a last line with no newline. */
const completeLog = (log: Buffer) => logSlice(log, 0, { complete: true });

/**
 * Captures from every test's observation files and every log in the run directory, plus the
 * `limit` findings for request bodies the browser did not expose (not for exempt tests, whose
 * own check already allowed them).
 */
async function allCaptures(
  exempt: ReadonlySet<string>,
): Promise<{ captures: Capture[]; limits: Finding[] }> {
  const captures: Capture[] = [];
  const limits: Finding[] = [];
  for (const entry of await readdir(observationsDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const point = relative(e2eDir, path);
    const bytes = await readFile(path);
    if (entry.parentPath === runDir) {
      captures.push(...logCaptures(point, completeLog(bytes)));
    } else if (entry.name.endsWith(".jsonl")) {
      const records = bytes
        .toString("utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as ObservationRecord);
      captures.push(...recordCaptures(point, records));
      const test = relative(observationsDir, path).split(sep)[0] as string;
      if (!exempt.has(test)) {
        limits.push(...bodyLimits(point, records));
      }
    } else {
      // Nothing else is written there today; scan anything new as it is.
      captures.push({ point, bytes });
    }
  }
  return { captures, limits };
}
