import assert from "node:assert/strict";
import { test } from "node:test";
import { logSlice } from "./captures.ts";
import { formatLeakReport, logViolations } from "./report.ts";
import type { Finding } from "./scan.ts";

const finding: Finding = {
  class: "K",
  label: "fragment text",
  point: "observations/t/default.jsonl#3 request.url",
  view: "raw",
  offset: 5,
  length: 43,
  context: "x?k=[[…]]",
};

test("names stdout violations by file and line", () => {
  const log = Buffer.from(
    '{"event":"listening","port":1}\n{"event":"host","name":"x"}\nnot json\n',
  );
  assert.deepEqual(logViolations("run/out.log", logSlice(log, 31)), [
    'run/out.log:2: key: unknown key "name": {"event":"host","name":"x"}',
    "run/out.log:3: json: not JSON: not json",
  ]);
  assert.equal(logViolations("run/out.log", logSlice(log, 0)).length, 2);
});

test("reports nothing when the check is clean", () => {
  assert.equal(formatLeakReport([], []), undefined);
});

test("lists findings, violations and the seed", () => {
  const report = formatLeakReport([finding], ["run/out.log:2: key: …"], "ab12");
  assert.equal(
    report,
    [
      "Leak check failed: 1 finding(s), 1 server stdout violation(s).",
      "Replay the canaries with SIGILL_E2E_SEED=ab12.",
      "Findings:",
      "  K fragment text in observations/t/default.jsonl#3 request.url, view raw, offset 5, " +
        "43 bytes: x?k=[[…]]",
      "Server stdout violations:",
      "  run/out.log:2: key: …",
    ].join("\n"),
  );
});

test("counts what it does not list", () => {
  const report = formatLeakReport(Array(60).fill(finding), []) ?? "";
  assert.equal(report.split("\n").filter((line) => line.startsWith("  K ")).length, 50);
  assert.match(report, /… and 10 more$/);
});
