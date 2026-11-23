import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes, toHex } from "./format.ts";

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
