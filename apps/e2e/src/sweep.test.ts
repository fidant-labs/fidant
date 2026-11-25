import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { canaryKey, SeededRandom } from "./leaks/canary.ts";
import { keySecrets } from "./leaks/needles.ts";
import { exemptTest, registerSecrets } from "./leaks/registry.ts";
import type { ObservationRecord } from "./observations.ts";
import { sweepRun } from "./sweep.ts";

// Every run gets a temp dir of its own; apps/e2e/observations is never touched.
const root = await mkdtemp(join(tmpdir(), "sigill-sweep-test-"));
after(() => rm(root, { recursive: true, force: true }));

const key = canaryKey(SeededRandom.fromLabel("sweep test")).text;
const time = "2026-11-25T00:00:00.000Z";
const jsonl = (...records: ObservationRecord[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");
const leaked = jsonl({ type: "console", time, url: "", text: `key=${key}` });
const listening = `${JSON.stringify({ event: "listening", port: 8443 })}\n`;

/**
 * Writes `files` into a fresh observations dir, registers `key` for test `t`, and sweeps.
 * `exempt` marks `t` as leaking on purpose.
 */
async function sweep(name: string, files: Record<string, string>, exempt = false) {
  const dir = join(root, name, "observations");
  const registry = join(root, name, "registry");
  await mkdir(registry, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  registerSecrets(registry, "t", keySecrets("fragment", key));
  if (exempt) {
    exemptTest(registry, "t");
  }
  return sweepRun(registry, undefined, dir);
}

test("a clean run, server.pid included, passes", async () => {
  const report = await sweep("clean", {
    "run/server.stdout.log": listening,
    "run/server.pid": "1234\n",
    "t/default.jsonl": jsonl({ type: "console", time, url: "", text: "nothing here" }),
  });
  assert.equal(report, undefined);
});

test("reports a key in a test's records and in server stdout, and the stdout violation", async () => {
  const report = await sweep("leak", {
    "run/server.stdout.log": `${listening}${JSON.stringify({ event: "listening", name: key })}\n`,
    "t/default.jsonl": leaked,
  });
  assert.match(report ?? "", /^Leak check failed/);
  assert.match(report ?? "", /K fragment text \[t\] in observations\/t\/default\.jsonl#1 /);
  assert.match(report ?? "", /K fragment text \[t\] in observations\/run\/server\.stdout\.log:2, /);
  assert.match(
    report ?? "",
    /Server stdout violations:\n {2}observations\/run\/server\.stdout\.log:2: key: /,
  );
});

test("skips a test that leaks on purpose, and its missing bodies", async () => {
  const report = await sweep(
    "exempt",
    {
      "t/default.jsonl":
        leaked +
        jsonl({ type: "request", time, method: "POST", url: "", headers: {}, bodyMissing: true }),
    },
    true,
  );
  assert.equal(report, undefined);
});

test("fails on a file no leak check reads, naming it", async () => {
  const report = await sweep("unknown", {
    "run/server.stdout.log": listening,
    "run/new.log": "anything\n",
  });
  assert.equal(
    report,
    "1 file(s) in observations/ that no leak check reads. " +
      "Add each to runSources in src/paths.ts, or to the sweep's per-test rules in src/sweep.ts:\n" +
      "  observations/run/new.log",
  );
});
