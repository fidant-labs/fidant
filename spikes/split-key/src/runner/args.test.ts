import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, parseBytes, runTimeoutMs } from "./args.ts";

const MIB = 1024 * 1024;
const defaults = { outDir: "/out", runsDir: "/runs" };

test("sizes take binary units or plain bytes", () => {
  assert.equal(parseBytes("64MiB"), 64 * MIB);
  assert.equal(parseBytes("48KiB"), 48 * 1024);
  assert.equal(parseBytes("5GiB"), 5 * 1024 * MIB);
  assert.equal(parseBytes("1mb"), MIB);
  assert.equal(parseBytes("4096"), 4096);
  assert.throws(() => parseBytes("64 MB of data"));
  assert.throws(() => parseBytes("0.5B"));
});

test("defaults are the 64 MiB grid on every engine and automatable sink", () => {
  const args = parseArgs([], defaults);
  assert.deepEqual(args.engines, ["chromium", "firefox", "webkit"]);
  assert.deepEqual(args.sizes, [64 * MIB]);
  assert.deepEqual(args.sinks, ["opfs", "fsa-opfs", "blob", "sw"]);
  assert.deepEqual(args.chunks, [256 * 1024, MIB]);
  assert.equal(args.outDir, "/out");
  assert.equal(args.build, true);
});

test("flags take a following value or an inline one", () => {
  const args = parseArgs(
    [
      "--",
      "--engines",
      "webkit",
      "--sizes=1GiB,5GiB",
      "--chunks",
      "48KiB",
      "--micro",
      "0",
      "--no-build",
    ],
    defaults,
  );
  assert.deepEqual(args.engines, ["webkit"]);
  assert.deepEqual(args.sizes, [1024 * MIB, 5 * 1024 * MIB]);
  assert.deepEqual(args.chunks, [48 * 1024]);
  assert.equal(args.microBytes, 0);
  assert.equal(args.build, false);
});

test("rejects what the page cannot run", () => {
  assert.throws(() => parseArgs(["--sinks", "fsa"], defaults), /fsa-opfs/);
  assert.throws(() => parseArgs(["--engines", "safari"], defaults), /unknown safari/);
  assert.throws(() => parseArgs(["--chunks", "64KiB"], defaults), /not one the page offers/);
  assert.throws(() => parseArgs(["--sizes", "1000"], defaults), /whole number of MiB/);
  assert.throws(() => parseArgs(["--seed", "-1"], defaults), /u32/);
  assert.throws(() => parseArgs(["--sizes"], defaults), /needs a value/);
  assert.throws(() => parseArgs(["--fast"], defaults), /unknown flag/);
});

test("run timeouts grow with size", () => {
  assert.equal(runTimeoutMs(64 * MIB), 92_000);
  assert.ok(runTimeoutMs(5 * 1024 * MIB) > 40 * 60_000);
});
