import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import {
  bodyLimits,
  logCaptures,
  logSlice,
  mailCaptures,
  recordCaptures,
} from "./leaks/captures.ts";
import { allowEmailed } from "./leaks/carriers.ts";
import { buildNeedles } from "./leaks/needles.ts";
import { readRegistry } from "./leaks/registry.ts";
import { formatLeakReport, logViolations } from "./leaks/report.ts";
import { type Capture, type Finding, scan } from "./leaks/scan.ts";
import type { ObservationRecord } from "./observations.ts";
import { observationsDir, runSources, serverStdoutLog } from "./paths.ts";

/**
 * The run-level sweep: every observation file and every run log in `dir`, against every secret
 * any test registered (except tests that registered as leaking on purpose), plus the stdout
 * allowlist over the whole log. Run it once the stack has stopped, so the logs are complete.
 * Returns a failure message or undefined. A file it does not know fails the sweep.
 */
export async function sweepRun(
  registry: string,
  seed?: string,
  dir = observationsDir,
): Promise<string | undefined> {
  const { secrets, exempt } = await readRegistry(registry);
  const stdoutPath = join(dir, "run", basename(serverStdoutLog));
  const stdout = completeLog(await readFile(stdoutPath).catch(() => Buffer.alloc(0)));
  const violations = logViolations(pointIn(dir, stdoutPath), stdout);
  const { captures, limits, unknown } = await allCaptures(dir, exempt);
  const findings = [
    ...limits,
    ...(secrets.length === 0
      ? []
      : allowEmailed(scan(captures, buildNeedles(secrets)), captures, secrets)),
  ];
  const report = formatLeakReport(findings, violations, seed);
  if (unknown.length === 0) {
    return report;
  }
  const lines = [
    `${unknown.length} file(s) in observations/ that no leak check reads. ` +
      "Add each to runSources in src/paths.ts, or to the sweep's per-test rules in src/sweep.ts:",
    ...unknown.map((point) => `  ${point}`),
  ];
  return [...lines, ...(report ? [report] : [])].join("\n");
}

/** A path in `dir` as findings name points, such as `observations/run/server.stdout.log`. */
const pointIn = (dir: string, path: string) => join("observations", relative(dir, path));

/** The whole of a log that is final, including a last line with no newline. */
const completeLog = (log: Buffer) => logSlice(log, 0, { complete: true });

/** How the sweep reads each file directly in run/, by name. */
const runFormats = new Map(runSources.map((source) => [basename(source.path), source.read]));

/** How the sweep reads `<test>/<...rest>`, or undefined for a file it does not know. */
function formatOf(test: string, rest: string[]): string | undefined {
  const name = rest.at(-1) ?? "";
  if (rest.length === 2 && rest[0] === "mail" && name.endsWith(".eml")) {
    return "mail";
  }
  if (rest.length !== 1) {
    return undefined;
  }
  if (test === "run") {
    return runFormats.get(name);
  }
  return name.endsWith(".jsonl") ? "records" : undefined;
}

/**
 * Captures from every file in `dir`: run files by `runSources`, `<test>/<actor>.jsonl` records,
 * and saved mail in `<test>/mail/` and `run/mail/`. Also the `limit` findings for request bodies
 * the browser did not expose (not for exempt tests, whose own check already allowed them), and
 * every other file, as `unknown`.
 */
async function allCaptures(
  dir: string,
  exempt: ReadonlySet<string>,
): Promise<{ captures: Capture[]; limits: Finding[]; unknown: string[] }> {
  const captures: Capture[] = [];
  const limits: Finding[] = [];
  const unknown: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const point = pointIn(dir, path);
    const [test, ...rest] = relative(dir, path).split(sep) as [string, ...string[]];
    const format = formatOf(test, rest);
    if (format === undefined) {
      unknown.push(point);
    } else if (format === "lines") {
      captures.push(...logCaptures(point, completeLog(await readFile(path))));
    } else if (format === "binary") {
      captures.push({ point, bytes: await readFile(path) });
    } else if (format === "mail") {
      captures.push(...mailCaptures(point, await readFile(path)));
    } else if (format === "records") {
      const records = (await readFile(path, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as ObservationRecord);
      captures.push(...recordCaptures(point, records));
      if (!exempt.has(test)) {
        limits.push(...bodyLimits(point, records));
      }
    }
    // "ignored": runSources says why.
  }
  return { captures, limits, unknown };
}
