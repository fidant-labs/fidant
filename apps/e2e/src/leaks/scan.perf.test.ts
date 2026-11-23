import assert from "node:assert/strict";
import { test } from "node:test";
import { canaryFile, canaryKey, SeededRandom } from "./canary.ts";
import { buildNeedles, fileSecrets, keySecrets } from "./needles.ts";
import { scan } from "./scan.ts";

// Moderate sizes keep `pnpm check` fast. SIGILL_E2E_PERF_FULL=1 measures the 0001 bound instead:
// a 4 MiB canary against a 10 MiB haystack.
const full = process.env.SIGILL_E2E_PERF_FULL === "1";
const MiB = 1024 * 1024;
const canaryBytes = full ? 4 * MiB : 1 * MiB;
const haystackBytes = full ? 10 * MiB : 2 * MiB;

const mib = (bytes: number) => `${(bytes / MiB).toFixed(1)} MiB`;

test("indexes a canary and scans a haystack quickly", (t) => {
  const random = SeededRandom.fromLabel("scan perf");
  const file = canaryFile(random.fork("file"), { size: canaryBytes + 1 });
  const key = canaryKey(random.fork("key"));
  const secrets = [...fileSecrets("file#1", file), ...keySecrets("fragment", key.text)];

  const before = process.memoryUsage();
  let started = performance.now();
  const needles = buildNeedles(secrets);
  const buildMs = performance.now() - started;
  const afterBuild = process.memoryUsage();

  // Random bytes, with one 16-byte window of the canary near the end.
  const haystack = random.fork("haystack").bytes(haystackBytes);
  file.bytes.copy(haystack, haystackBytes - 100, 5000, 5016);
  started = performance.now();
  const rawFindings = scan([{ point: "random", bytes: haystack }], needles);
  const scanMs = performance.now() - started;

  // The same bytes as base64 text, as in a JSON upload body: four decoded views to search.
  const text = Buffer.from(JSON.stringify({ data: haystack.toString("base64") }));
  started = performance.now();
  const base64Findings = scan([{ point: "base64", bytes: text }], needles);
  const base64Ms = performance.now() - started;
  const afterScan = process.memoryUsage();

  t.diagnostic(
    `canary ${mib(canaryBytes)}: index ${buildMs.toFixed(0)} ms, ` +
      `+${mib(afterBuild.rss - before.rss)} rss, ` +
      `+${mib(afterBuild.arrayBuffers - before.arrayBuffers)} array buffers`,
  );
  t.diagnostic(
    `haystack ${mib(haystackBytes)}: raw scan ${scanMs.toFixed(0)} ms, ` +
      `as base64 JSON (${mib(text.length)}) ${base64Ms.toFixed(0)} ms, ` +
      `peak rss ${mib(afterScan.rss)}`,
  );
  assert.deepEqual(
    rawFindings.map((f) => `${f.label} @ ${f.view}`),
    ["file#1 @ raw"],
  );
  assert.deepEqual(
    base64Findings.map((f) => `${f.label} @ ${f.view}`),
    ["file#1 @ raw"],
  );
  // Generous bounds: they catch an accidental quadratic, not a slow machine.
  assert.ok(buildMs < (full ? 20_000 : 5_000), `index took ${buildMs} ms`);
  assert.ok(scanMs + base64Ms < (full ? 30_000 : 5_000), `scan took ${scanMs + base64Ms} ms`);
});
