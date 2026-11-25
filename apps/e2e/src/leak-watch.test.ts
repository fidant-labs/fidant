import assert from "node:assert/strict";
import { test } from "node:test";
import { failOnLeaks, LeakWatch } from "./leak-watch.ts";
import { canaryKey, SeededRandom } from "./leaks/canary.ts";
import type { Recorder } from "./recorder.ts";

// Without Mailpit, check() saves no mail.
delete process.env.SIGILL_E2E_MAILPIT;

/** A watch whose only recorder logged `key` to the console, under a test name no run uses. */
async function leakyWatch(name: string): Promise<LeakWatch> {
  const key = canaryKey(SeededRandom.fromLabel(name)).text;
  const watch = await LeakWatch.start(`leak-watch-test-${name}`, undefined);
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

test("the teardown cleans up, then throws the leak report", async () => {
  const steps: string[] = [];
  await assert.rejects(
    failOnLeaks(await leakyWatch("leak"), async () => {
      steps.push("clean-up");
    }).finally(() => steps.push("settled")),
    /Leak check failed[\s\S]*K fragment text in observations\/leak-watch-test-leak\/default\.jsonl#1/,
  );
  assert.deepEqual(steps, ["clean-up", "settled"]);
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
