import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CanaryFile, CanaryKey } from "./leaks/canary.ts";
import { type LogSlice, logCaptures, logSlice, recordCaptures } from "./leaks/captures.ts";
import {
  buildNeedles,
  fileSecrets,
  keySecrets,
  type Needles,
  type Secret,
} from "./leaks/needles.ts";
import { exemptTest, registerSecrets } from "./leaks/registry.ts";
import { formatLeakReport, logViolations } from "./leaks/report.ts";
import { type Capture, type Finding, scan } from "./leaks/scan.ts";
import { e2eDir, observationsDir, serverStderrLog, serverStdoutLog } from "./paths.ts";
import type { Recorder } from "./recorder.ts";

/** What a test uses to register its secrets and check for leaks. */
export interface Leaks {
  /**
   * Watches a canary file: its bytes, their SHA-256, the tokens in its name and type, the SHA-256
   * of its name, and its size. `label` names it in findings; default `file#1`, `file#2`, ….
   * Returns the file.
   */
  watch(file: CanaryFile, label?: string): CanaryFile;
  /** Watches a key: raw bytes, or text such as a fragment secret (searched as text and bytes). */
  watchKey(label: string, key: Uint8Array | string | CanaryKey, cls?: "K" | "S"): void;
  /** Scans everything observed so far in this test. Never throws for a leak. */
  scan(): Promise<Finding[]>;
  /**
   * For a test that leaks on purpose: its teardown does not fail on findings, and the run-level
   * sweep skips its secrets. Server stdout violations still fail it.
   */
  expectLeaks(): void;
}

/** A path relative to apps/e2e, as findings name points. */
const point = (path: string) => relative(e2eDir, path);

/** The server logs, stdout first. Both get the canary scan; stdout also the allowlist check. */
const logs = [serverStdoutLog, serverStderrLog];

/**
 * One test's leak check: its secrets, the recorders whose records it scans, and where the server
 * logs stood when the test began, so it scans only what the server wrote during the test.
 */
export class LeakWatch implements Leaks {
  /** Set by the `_recorders` fixture, which writes and completes the records before `check()`. */
  recorders: ReadonlyMap<string, Recorder> = new Map();
  readonly #test: string;
  readonly #registry: string | undefined;
  readonly #logStarts: number[];
  readonly #secrets: Secret[] = [];
  #files = 0;
  #expectLeaks = false;
  #needles: { count: number; needles: Needles } | undefined;

  private constructor(test: string, registry: string | undefined, logStarts: number[]) {
    this.#test = test;
    this.#registry = registry;
    this.#logStarts = logStarts;
  }

  /**
   * `test` is the test's observations directory name. `registry` is the run's registry directory,
   * where secrets are also written for the run-level sweep.
   */
  static async start(test: string, registry: string | undefined): Promise<LeakWatch> {
    const sizes = await Promise.all(logs.map(sizeOf));
    return new LeakWatch(test, registry, sizes);
  }

  watch(file: CanaryFile, label = `file#${++this.#files}`): CanaryFile {
    this.#add(fileSecrets(label, file));
    return file;
  }

  watchKey(label: string, key: Uint8Array | string | CanaryKey, cls: "K" | "S" = "K"): void {
    const value = typeof key === "string" || key instanceof Uint8Array ? key : key.text;
    this.#add(keySecrets(label, value, cls));
  }

  expectLeaks(): void {
    this.#expectLeaks = true;
    this.exempt();
  }

  /** Keeps this test's secrets out of the run-level sweep. */
  exempt(): void {
    if (this.#registry) exemptTest(this.#registry, this.#test);
  }

  async scan(): Promise<Finding[]> {
    if (this.#secrets.length === 0) return [];
    const { captures } = await this.#observe();
    return scan(captures, this.#compiled());
  }

  /** The failure message for this test's findings and stdout violations, or undefined. */
  async check(): Promise<string | undefined> {
    const { captures, stdout } = await this.#observe();
    const findings =
      this.#secrets.length === 0 || this.#expectLeaks ? [] : scan(captures, this.#compiled());
    const violations = logViolations(point(serverStdoutLog), stdout);
    return formatLeakReport(findings, violations, process.env.SIGILL_E2E_SEED);
  }

  #add(secrets: Secret[]): void {
    // Registered first, so the sweep knows the secret even if the worker dies mid-test.
    if (this.#registry) registerSecrets(this.#registry, this.#test, secrets);
    this.#secrets.push(...secrets);
  }

  #compiled(): Needles {
    if (this.#needles?.count !== this.#secrets.length) {
      this.#needles = { count: this.#secrets.length, needles: buildNeedles(this.#secrets) };
    }
    return this.#needles.needles;
  }

  /** This test's records so far, plus what the server logged since the test began. */
  async #observe(): Promise<{ captures: Capture[]; stdout: LogSlice }> {
    const captures: Capture[] = [];
    for (const recorder of this.recorders.values()) {
      const file = point(join(observationsDir, this.#test, `${recorder.actor}.jsonl`));
      captures.push(...recordCaptures(file, await recorder.records()));
    }
    const slices = await Promise.all(
      logs.map(async (path, index) =>
        logSlice(await readFile(path).catch(() => Buffer.alloc(0)), this.#logStarts[index]),
      ),
    );
    logs.forEach((path, index) => {
      captures.push(...logCaptures(point(path), slices[index] as LogSlice));
    });
    return { captures, stdout: slices[0] as LogSlice };
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
