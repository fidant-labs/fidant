import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { logCaptures, logSlice, recordCaptures } from "./leaks/captures.ts";
import { buildNeedles } from "./leaks/needles.ts";
import { readRegistry } from "./leaks/registry.ts";
import { formatLeakReport, logViolations } from "./leaks/report.ts";
import { type Capture, scan } from "./leaks/scan.ts";
import type { ObservationRecord } from "./observations.ts";
import { e2eDir, observationsDir, runDir, serverStdoutLog } from "./paths.ts";

/**
 * The run-level sweep: every observation file and every run log, against every secret any test
 * registered (except tests that leak on purpose), plus the stdout allowlist over the whole log.
 * Run it once the stack has stopped, so the logs are complete. Returns a failure message or
 * undefined.
 */
export async function sweepRun(registry: string, seed?: string): Promise<string | undefined> {
  const secrets = await readRegistry(registry);
  const stdout = logSlice(await readFile(serverStdoutLog).catch(() => Buffer.alloc(0)));
  const violations = logViolations(relative(e2eDir, serverStdoutLog), stdout);
  const findings = secrets.length === 0 ? [] : scan(await allCaptures(), buildNeedles(secrets));
  return formatLeakReport(findings, violations, seed);
}

/** Captures from every test's observation files and every log in the run directory. */
async function allCaptures(): Promise<Capture[]> {
  const captures: Capture[] = [];
  for (const entry of await readdir(observationsDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const point = relative(e2eDir, path);
    const bytes = await readFile(path);
    if (entry.parentPath === runDir) {
      captures.push(...logCaptures(point, logSlice(bytes)));
    } else if (entry.name.endsWith(".jsonl")) {
      const records = bytes
        .toString("utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as ObservationRecord);
      captures.push(...recordCaptures(point, records));
    } else {
      // Nothing else is written there today; scan anything new as it is.
      captures.push({ point, bytes });
    }
  }
  return captures;
}
