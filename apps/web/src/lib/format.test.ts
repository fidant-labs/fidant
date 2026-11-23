import assert from "node:assert/strict";
import { test } from "node:test";
import { displayName, formatBytes, formatProgress, toHex } from "./format.ts";

test("displayName drops names with nothing visible to show", () => {
  assert.equal(displayName("  Åsa Öberg "), "Åsa Öberg");
  assert.equal(displayName("李"), "李");
  assert.equal(displayName(""), "");
  assert.equal(displayName("   "), "");
  assert.equal(displayName("​ㅤ﻿"), "");
  assert.equal(displayName("!!!"), "");
});

test("toHex pads every byte", () => {
  assert.equal(toHex(new Uint8Array([0, 15, 16, 255])), "000f10ff");
  assert.equal(toHex(new Uint8Array()), "");
});

test("formatBytes uses decimal units", () => {
  assert.equal(formatBytes(0), "0 bytes");
  assert.equal(formatBytes(1), "1 byte");
  assert.equal(formatBytes(999), "999 bytes");
  assert.equal(formatBytes(1000), "1.0 KB");
  assert.equal(formatBytes(8 * 1024 * 1024), "8.4 MB");
  assert.equal(formatBytes(999_999), "1.0 MB");
  assert.equal(formatBytes(123_456_789), "123 MB");
  assert.equal(formatBytes(1_000_000_000), "1.0 GB");
});

test("formatProgress rounds down and treats an empty file as done", () => {
  assert.equal(formatProgress(1_100_000, 2_400_000), "45% · 1.1 MB of 2.4 MB");
  assert.equal(formatProgress(2_399_999, 2_400_000), "99% · 2.4 MB of 2.4 MB");
  assert.equal(formatProgress(0, 0), "100% · 0 bytes of 0 bytes");
});
