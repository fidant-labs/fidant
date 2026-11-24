import { appendFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Allowed, ByteSecret, Secret, SecretClass } from "./needles.ts";

/**
 * The run's registry of secrets, so the run-level sweep can check every secret any test watched.
 *
 * It holds the secrets themselves, so it lives in a temporary directory outside observations/
 * (which CI uploads) and is deleted after the sweep. Workers are separate processes: each appends
 * to a file of its own, and global teardown reads them all.
 */

type Entry =
  | {
      /** The test's observations directory name: the sweep matches exempt tests by it. */
      test: string;
      class: SecretClass;
      label: string;
      bytes: string;
      window?: number;
      caseInsensitive?: true;
      allowed?: Allowed;
    }
  | { test: string; class: "M"; label: string; size: number }
  /** The test registered as leaking on purpose (`leaks.expectLeaks()`): the sweep skips its secrets. */
  | { test: string; exempt: true };

/** Appends one test's secrets. `test` names the test in sweep findings, such as its directory. */
export function registerSecrets(dir: string, test: string, secrets: readonly Secret[]): void {
  const lines = secrets.map((secret) => {
    const entry: Entry =
      "size" in secret
        ? { test, class: secret.class, label: secret.label, size: secret.size }
        : {
            test,
            class: secret.class,
            label: secret.label,
            bytes: Buffer.from(secret.bytes).toString("base64"),
            ...(secret.window !== undefined ? { window: secret.window } : {}),
            ...(secret.caseInsensitive ? { caseInsensitive: true as const } : {}),
            ...(secret.allowed ? { allowed: secret.allowed } : {}),
          };
    return `${JSON.stringify(entry)}\n`;
  });
  append(dir, lines.join(""));
}

/** Keeps a test's secrets out of the sweep, for a test that leaks them on purpose. */
export function exemptTest(dir: string, test: string): void {
  const entry: Entry = { test, exempt: true };
  append(dir, `${JSON.stringify(entry)}\n`);
}

/**
 * Every registered secret of tests that are not exempt, and the names of the exempt tests. Labels
 * gain the test's name in brackets, so a sweep finding says which test's canary leaked.
 */
export async function readRegistry(
  dir: string,
): Promise<{ secrets: Secret[]; exempt: Set<string> }> {
  const entries: Entry[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const text = await readFile(join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (line !== "") {
        entries.push(JSON.parse(line) as Entry);
      }
    }
  }
  const exempt = new Set(entries.filter((entry) => "exempt" in entry).map((entry) => entry.test));
  const secrets: Secret[] = [];
  for (const entry of entries) {
    if ("exempt" in entry || exempt.has(entry.test)) {
      continue;
    }
    const label = `${entry.label} [${entry.test}]`;
    if ("size" in entry) {
      secrets.push({ class: "M", label, size: entry.size });
      continue;
    }
    const secret: ByteSecret = {
      class: entry.class,
      label,
      bytes: Buffer.from(entry.bytes, "base64"),
    };
    if (entry.window !== undefined) {
      secret.window = entry.window;
    }
    if (entry.caseInsensitive) {
      secret.caseInsensitive = true;
    }
    if (entry.allowed) {
      secret.allowed = entry.allowed;
    }
    secrets.push(secret);
  }
  return { secrets, exempt };
}

/** Synchronous, so a secret is on disk before the test can leak it, even if the worker dies. */
function append(dir: string, text: string): void {
  if (text !== "") {
    appendFileSync(join(dir, `${process.pid}.jsonl`), text);
  }
}
