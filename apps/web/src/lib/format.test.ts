import assert from "node:assert/strict";
import { test } from "node:test";
import { displayName, formatBytes, formatProgress, toHex } from "./format.ts";

test("displayName drops names with nothing visible to show", () => {
  assert.equal(displayName("  Åsa Öberg "), "Åsa Öberg");
  assert.equal(displayName("李"), "李");
  assert.equal(displayName(""), "");
  assert.equal(displayName("   "), "");
  assert.equal(displayName(String.fromCodePoint(0x200b, 0x3164, 0xfeff)), "");
  assert.equal(displayName("!!!"), "");
});

test("toHex pads every byte", () => {
  assert.equal(toHex(new Uint8Array([0, 15, 16, 255])), "000f10ff");
  assert.equal(toHex(new Uint8Array()), "");
});

test("formatBytes uses decimal units", () => {
  assert.equal(formatBytes(0, "en"), "0 bytes");
  assert.equal(formatBytes(1, "en"), "1 byte");
  assert.equal(formatBytes(999, "en"), "999 bytes");
  assert.equal(formatBytes(1000, "en"), "1.0 KB");
  assert.equal(formatBytes(8 * 1024 * 1024, "en"), "8.4 MB");
  assert.equal(formatBytes(999_999, "en"), "1.0 MB");
  assert.equal(formatBytes(123_456_789, "en"), "123 MB");
  assert.equal(formatBytes(1_000_000_000, "en"), "1.0 GB");
});

test("formatProgress rounds down and treats an empty file as done", () => {
  assert.equal(formatProgress(1_100_000, 2_400_000, "en"), "45% · 1.1 MB of 2.4 MB");
  assert.equal(formatProgress(2_399_999, 2_400_000, "en"), "99% · 2.4 MB of 2.4 MB");
  assert.equal(formatProgress(0, 0, "en"), "100% · 0 bytes of 0 bytes");
});

test("formatBytes and formatProgress in Swedish", () => {
  assert.equal(formatBytes(1, "sv"), "1 byte");
  assert.equal(formatBytes(512, "sv"), "512 byte");
  assert.equal(formatBytes(8 * 1024 * 1024, "sv"), "8,4 MB");
  assert.equal(formatBytes(123_456_789, "sv"), "123 MB");
  // Intl puts a no-break space before the Swedish percent sign.
  assert.equal(formatProgress(1_100_000, 2_400_000, "sv"), "45\u00a0% · 1,1 MB av 2,4 MB");
});
