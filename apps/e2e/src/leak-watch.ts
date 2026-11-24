import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { CanaryFile, CanaryKey } from "./leaks/canary.ts";
import {
  bodyLimits,
  type LogSlice,
  logCaptures,
  logSlice,
  recordCaptures,
} from "./leaks/captures.ts";
import {
  buildNeedles,
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
import {
  boxJournal,
  boxSyslog,
  coturnLog,
  coturnPcap,
  e2eDir,
  observationsDir,
  serverStderrLog,
  serverStdoutLog,
} from "./paths.ts";
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
  /** Watches text such as a recipient name, which must not appear whole (NFC or NFD UTF-8). */
  watchText(label: string, text: string): void;
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
 * The run logs, server stdout first. All get the canary scan; stdout also the allowlist check.
 * The box's files exist only once its test wrote them; a missing log reads as empty.
 */
const logs = [serverStdoutLog, serverStderrLog, coturnLog, boxJournal, boxSyslog];

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
  readonly #pcapStart: number;
  readonly #secrets: Secret[] = [];
  #files = 0;
  #expectLeaks = false;
  #needles: { count: number; needles: Needles } | undefined;

  private constructor(
    test: string,
    registry: string | undefined,
    logStarts: number[],
    pcapStart: number,
  ) {
    this.#test = test;
    this.#registry = registry;
    this.#logStarts = logStarts;
    this.#pcapStart = pcapStart;
  }

  /**
   * `test` is the test's observations directory name. `registry` is the run's registry directory,
   * where secrets are also written for the run-level sweep.
   */
  static async start(test: string, registry: string | undefined): Promise<LeakWatch> {
    const sizes = await Promise.all(logs.map(sizeOf));
    return new LeakWatch(test, registry, sizes, await sizeOf(coturnPcap));
  }

  watch(file: CanaryFile, label = `file#${++this.#files}`): CanaryFile {
    this.#add(fileSecrets(label, file));
    return file;
  }

  watchKey(label: string, key: Uint8Array | string | CanaryKey, cls: "K" | "S" = "K"): void {
    const value = typeof key === "string" || key instanceof Uint8Array ? key : key.text;
    this.#add(keySecrets(label, value, cls));
  }

  watchText(label: string, text: string): void {
    // Shorter text would only fail later, when the needles are built for the scan or the sweep.
    if (Buffer.byteLength(text) < minWindow) {
      throw new Error(`Watched text for ${label} needs at least ${minWindow} bytes.`);
    }
    this.#add(textSecrets("M", label, text));
  }

  expectLeaks(): void {
    this.#expectLeaks = true;
    this.exempt();
  }

  /** Keeps this test's secrets out of the run-level sweep. */
  exempt(): void {
    if (this.#registry) {
      exemptTest(this.#registry, this.#test);
    }
  }

  async scan(): Promise<Finding[]> {
    const { captures, limits } = await this.#observe();
    return [...limits, ...(this.#secrets.length === 0 ? [] : scan(captures, this.#compiled()))];
  }

  /** The failure message for this test's findings and stdout violations, or undefined. */
  async check(): Promise<string | undefined> {
    const { captures, limits, stdout } = await this.#observe();
    const findings = this.#expectLeaks
      ? []
      : [...limits, ...(this.#secrets.length === 0 ? [] : scan(captures, this.#compiled()))];
    const violations = logViolations(point(serverStdoutLog), stdout);
    return formatLeakReport(findings, violations, process.env.SIGILL_E2E_SEED);
  }

  #add(secrets: Secret[]): void {
    // Registered first, so the sweep knows the secret even if the worker dies mid-test.
    if (this.#registry) {
      registerSecrets(this.#registry, this.#test, secrets);
    }
    this.#secrets.push(...secrets);
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
      captures.push({ point: point(path), bytes: await readFile(path) });
    }
    const slices = await Promise.all(
      logs.map(async (path, index) =>
        logSlice(await readFile(path).catch(() => Buffer.alloc(0)), this.#logStarts[index]),
      ),
    );
    logs.forEach((path, index) => {
      captures.push(...logCaptures(point(path), slices[index] as LogSlice));
    });
    const pcap = await settledPcap();
    if (pcap) {
      // Binary packets, not lines: one capture of what tcpdump wrote since the test began.
      captures.push({ point: point(coturnPcap), bytes: pcap.subarray(this.#pcapStart) });
    }
    return { captures, limits, stdout: slices[0] as LogSlice };
  }
}

/**
 * The coturn packet capture once its size has stopped changing, or undefined when there is none
 * (`pnpm e2e` runs no capture). tcpdump writes each packet as it arrives, but packets still on
 * their way through the routers, and the bind mount on Docker Desktop, can lag a little.
 * ponytail: waits for 250 ms without growth, at most 2 s; a relay still busy after that is cut,
 * and the run-level sweep scans the rest.
 */
async function settledPcap(): Promise<Buffer | undefined> {
  let last = -1;
  for (let waited = 0; waited < 2_000; waited += 250) {
    const size = await stat(coturnPcap).then(
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
  return readFile(coturnPcap);
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
