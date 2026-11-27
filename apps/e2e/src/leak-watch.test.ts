import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { failOnLeaks, LeakWatch } from "./leak-watch.ts";
import { canaryKey, SeededRandom } from "./leaks/canary.ts";
import type { Recorder } from "./recorder.ts";

// Without Mailpit, check() saves no mail.
delete process.env.FIDANT_E2E_MAILPIT;

// Sources under a temp dir, so a concurrent run's logs and packet capture can't change the result.
const dir = await mkdtemp(join(tmpdir(), "leak-watch-test-"));
after(() => rm(dir, { recursive: true, force: true }));
const sources = [
  { path: join(dir, "server.stdout.log"), read: "lines" },
  { path: join(dir, "coturn.pcap"), read: "binary" },
] as const;

/** A watch whose only recorder logged `key` to the console, under a test name no run uses. */
async function leakyWatch(name: string): Promise<LeakWatch> {
  const key = canaryKey(SeededRandom.fromLabel(name)).text;
  const watch = await LeakWatch.start(`leak-watch-test-${name}`, undefined, sources);
  watch.watchKey("fragment", key);
  const recorder = {
    actor: "default",
    records: async () => [
      { type: "console", time: "2026-11-25T00:00:00.000Z", url: "", text: `key=${key}` },
    ],
  } as unknown as Recorder;
  watch.recorders = new Map([["default", recorder]]);
  return watch;
}

test("the teardown checks, cleans up, then throws the leak report", async () => {
  const steps: string[] = [];
  const watch = await leakyWatch("leak");
  const check = async () => {
    steps.push("check");
    return watch.check();
  };
  await assert.rejects(
    failOnLeaks({ check }, async () => {
      steps.push("clean-up");
    }).finally(() => steps.push("settled")),
    /Leak check failed[\s\S]*K fragment text in observations\/leak-watch-test-leak\/default\.jsonl#1/,
  );
  assert.deepEqual(steps, ["check", "clean-up", "settled"]);
});

test("the leak report wins over a clean-up failure", async () => {
  await assert.rejects(
    failOnLeaks(await leakyWatch("both"), async () => {
      throw new Error("clean-up broke");
    }),
    /Leak check failed/,
  );
});

test("a clean-up failure with no leak still propagates", async () => {
  await assert.rejects(
    failOnLeaks({ check: async () => undefined }, async () => {
      throw new Error("clean-up broke");
    }),
    /clean-up broke/,
  );
});

test("the teardown passes a test that leaks on purpose", async () => {
  const watch = await leakyWatch("expected");
  watch.expectLeaks();
  let cleaned = false;
  await failOnLeaks(watch, async () => {
    cleaned = true;
  });
  assert.equal(cleaned, true);
});
