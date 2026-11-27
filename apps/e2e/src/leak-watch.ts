import { readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { CanaryFile, CanaryKey, LargeCanaryFile } from "./leaks/canary.ts";
import {
  bodyLimits,
  type LogSlice,
  logCaptures,
  logSlice,
  mailCaptures,
  recordCaptures,
} from "./leaks/captures.ts";
import { allowEmailed } from "./leaks/carriers.ts";
import {
  type Allowed,
  buildNeedles,
  contentSecrets,
  fileSecrets,
  keySecrets,
  minWindow,
  type Needles,
  type Secret,
  textSecrets,
} from "./leaks/needles.ts";
import { exemptTest, registerSecrets } from "./leaks/registry.ts";
import { formatLeakReport, logViolations } from "./leaks/report.ts";
import { type Capture, type Finding, scan } from "./leaks/scan.ts";
import { saveMail } from "./mail.ts";
import { e2eDir, observationsDir, type RunSource, runSources, serverStdoutLog } from "./paths.ts";
import type { Recorder } from "./recorder.ts";

/** What a test uses to register its secrets and check for leaks. */
export interface Leaks {
  /**
   * Watches a canary file: its bytes (a large file's sampled bytes), their SHA-256, the tokens in
   * its name and type, the SHA-256 of its name, and its size. `label` names it in findings;
   * default `file#1`, `file#2`, …. Returns the file.
   */
  watch<Watched extends CanaryFile | LargeCanaryFile>(file: Watched, label?: string): Watched;
  /**
   * Watches a key: raw bytes, or text such as a fragment secret, searched as text and as every
   * byte value its hex, base64url or base64 decodes to. Each byte value, and each text form of
   * the key (as given, base64url, base64, hex) with and without a leading `#`, is also searched
   * as its SHA-256. `allowed` names where an emailed link's secret, value or token may appear
   * (decision 0012); every SHA-256 stays allowed nowhere.
   */
  watchKey(
    label: string,
    key: Uint8Array | string | CanaryKey,
    cls?: "K" | "S",
    allowed?: Allowed,
  ): void;
  /**
   * Watches text such as a recipient name, which must not appear whole (NFC or NFD UTF-8).
   * `allowed` names where an emailed link's typed name or address may appear (decision 0012).
   */
  watchText(label: string, text: string, allowed?: Allowed): void;
  /** Watches text as content (C), such as a shared text: its UTF-8 bytes and their SHA-256. */
  watchContent(label: string, text: string): void;
  /** Scans everything observed so far in this test. Never throws for a leak. */
  scan(): Promise<Finding[]>;
  /**
   * The report the teardown throws for this test so far (undefined when clean). Call it before
   * `expectLeaks()`: after that it reports only server stdout violations, as the teardown does.
   */
  check(): Promise<string | undefined>;
  /**
   * For a test that leaks on purpose: its teardown does not fail on findings, and the run-level
   * sweep skips its secrets. Server stdout violations still fail it.
   */
  expectLeaks(): void;
}

/** A path relative to apps/e2e, as findings name points. */
const point = (path: string) => relative(e2eDir, path);

/**
 * One test's leak check: its secrets, the recorders whose records it scans, and where the server
 * logs stood when the test began, so it scans only what the server wrote during the test.
 */
export class LeakWatch implements Leaks {
  /** Set by the `_recorders` fixture, which writes and completes the records before `check()`. */
  recorders: ReadonlyMap<string, Recorder> = new Map();
  readonly #test: string;
  readonly #registry: string | undefined;
  readonly #logs: string[];
  readonly #binaries: string[];
  readonly #logStarts: number[];
  readonly #binaryStarts: number[];
  readonly #secrets: Secret[] = [];
  #files = 0;
  #expectLeaks = false;
  #needles: { count: number; needles: Needles } | undefined;

  private constructor(
    test: string,
    registry: string | undefined,
    logs: string[],
    binaries: string[],
    logStarts: number[],
    binaryStarts: number[],
  ) {
    this.#test = test;
    this.#registry = registry;
    this.#logs = logs;
    this.#binaries = binaries;
    this.#logStarts = logStarts;
    this.#binaryStarts = binaryStarts;
  }

  /**
   * `test` is the test's observations directory name. `registry` is the run's registry directory,
   * where secrets are also written for the run-level sweep. `sources` are the run's logs (the one
   * named like server stdout also gets the allowlist check) and binary captures, as `runSources`;
   * some exist only once a test or a run wrote them, and a missing one reads as empty.
   */
  static async start(
    test: string,
    registry: string | undefined,
    sources: readonly RunSource[] = runSources,
  ): Promise<LeakWatch> {
    const logs = sources.flatMap((source) => (source.read === "lines" ? [source.path] : []));
    const binaries = sources.flatMap((source) => (source.read === "binary" ? [source.path] : []));
    return new LeakWatch(
      test,
      registry,
      logs,
      binaries,
      await Promise.all(logs.map(sizeOf)),
      await Promise.all(binaries.map(sizeOf)),
    );
  }

  watch<Watched extends CanaryFile | LargeCanaryFile>(
    file: Watched,
    label = `file#${++this.#files}`,
  ): Watched {
    this.#add(fileSecrets(label, file));
    return file;
  }

  watchKey(
    label: string,
    key: Uint8Array | string | CanaryKey,
    cls: "K" | "S" = "K",
    allowed?: Allowed,
  ): void {
    const value = typeof key === "string" || key instanceof Uint8Array ? key : key.text;
    this.#add(
      keySecrets(label, value, cls).map((secret) =>
        allowed && "bytes" in secret && !secret.label.endsWith(" sha256")
          ? { ...secret, allowed }
          : secret,
      ),
    );
  }

  watchText(label: string, text: string, allowed?: Allowed): void {
    // Shorter text would only fail later, when the needles are built for the scan or the sweep.
    if (Buffer.byteLength(text) < minWindow) {
      throw new Error(`Watched text for ${label} needs at least ${minWindow} bytes.`);
    }
    this.#add(
      textSecrets("M", label, text).map((secret) => (allowed ? { ...secret, allowed } : secret)),
    );
  }

  watchContent(label: string, text: string): void {
    this.#add(contentSecrets(label, Buffer.from(text)));
  }

  expectLeaks(): void {
    this.#expectLeaks = true;
    // Keeps this test's secrets out of the run-level sweep.
    if (this.#registry) {
      exemptTest(this.#registry, this.#test);
    }
  }

  async scan(): Promise<Finding[]> {
    const { captures, limits } = await this.#observe();
    return [...limits, ...this.#found(captures)];
  }

  /** The failure message for this test's findings and stdout violations, or undefined. */
  async check(): Promise<string | undefined> {
    const { captures, limits, stdout } = await this.#observe();
    const findings = this.#expectLeaks ? [] : [...limits, ...this.#found(captures)];
    const violations = logViolations(point(serverStdoutLog), stdout);
    return formatLeakReport(findings, violations, process.env.FIDANT_E2E_SEED);
  }

  #add(secrets: Secret[]): void {
    // Registered first, so the sweep knows the secret even if the worker dies mid-test.
    if (this.#registry) {
      registerSecrets(this.#registry, this.#test, secrets);
    }
    this.#secrets.push(...secrets);
  }

  /** This test's secrets found in `captures`, except where an emailed link may carry them. */
  #found(captures: Capture[]): Finding[] {
    if (this.#secrets.length === 0) {
      return [];
    }
    return allowEmailed(scan(captures, this.#compiled()), captures, this.#secrets);
  }

  #compiled(): Needles {
    if (this.#needles?.count !== this.#secrets.length) {
      this.#needles = { count: this.#secrets.length, needles: buildNeedles(this.#secrets) };
    }
    return this.#needles.needles;
  }

  /**
   * This test's records so far, what the server logged since the test began, and the mail Mailpit
   * caught, which it saves under the test's observations first.
   */
  async #observe(): Promise<{ captures: Capture[]; limits: Finding[]; stdout: LogSlice }> {
    const captures: Capture[] = [];
    const limits: Finding[] = [];
    for (const recorder of this.recorders.values()) {
      const file = point(join(observationsDir, this.#test, `${recorder.actor}.jsonl`));
      const records = await recorder.records();
      captures.push(...recordCaptures(file, records));
      limits.push(...bodyLimits(file, records));
    }
    for (const path of await saveMail(join(observationsDir, this.#test))) {
      captures.push(...mailCaptures(point(path), await readFile(path)));
    }
    const slices = await Promise.all(
      this.#logs.map(async (path, index) =>
        logSlice(await readFile(path).catch(() => Buffer.alloc(0)), this.#logStarts[index]),
      ),
    );
    this.#logs.forEach((path, index) => {
      captures.push(...logCaptures(point(path), slices[index] as LogSlice));
    });
    for (const [index, path] of this.#binaries.entries()) {
      const bytes = await settled(path);
      if (bytes) {
        // Not lines: one capture of what was written since the test began.
        captures.push({ point: point(path), bytes: bytes.subarray(this.#binaryStarts[index]) });
      }
    }
    const stdout = this.#logs.findIndex((path) => basename(path) === basename(serverStdoutLog));
    if (stdout < 0) {
      throw new Error("No log source named like server stdout, so the allowlist check can't run");
    }
    return { captures, limits, stdout: slices[stdout] as LogSlice };
  }
}

/**
 * The leak teardown: runs `watch.check()`, then `cleanUp` (which needs the mail the check saved),
 * then throws the report, if any.
 */
export async function failOnLeaks(
  watch: Pick<LeakWatch, "check">,
  cleanUp: () => Promise<void>,
): Promise<void> {
  const report = await watch.check();
  try {
    await cleanUp();
  } catch (error) {
    // The leak report wins over a clean-up failure.
    if (!report) {
      throw error;
    }
  }
  if (report) {
    throw new Error(report);
  }
}

/**
 * A binary capture, such as coturn's packets, once its size has stopped changing, or undefined
 * when there is none (`pnpm e2e` runs no packet capture). tcpdump writes each packet as it arrives, but packets still on
 * their way through the routers, and the bind mount on Docker Desktop, can lag a little.
 * ponytail: waits for 250 ms without growth, at most 2 s; a relay still busy after that is cut,
 * and the run-level sweep scans the rest.
 */
async function settled(path: string): Promise<Buffer | undefined> {
  let last = -1;
  for (let waited = 0; waited < 2_000; waited += 250) {
    const size = await stat(path).then(
      (stats) => stats.size,
      () => undefined,
    );
    if (size === undefined) {
      return undefined;
    }
    if (size === last) {
      break;
    }
    last = size;
    await setTimeout(250);
  }
  return readFile(path);
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
