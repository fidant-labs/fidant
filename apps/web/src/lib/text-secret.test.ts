import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHUNK_BYTES, MAX_FROM_LENGTH, metaFits, paddedLength } from "./frames.ts";
import { DEFAULT_MAX_MESSAGE_SIZE } from "./peer.ts";
import { FRAME_OVERHEAD_BYTES } from "./send-file.ts";
import {
  decodeText,
  isTextOffer,
  MAX_TEXT_BYTES,
  MAX_TEXT_LENGTH,
  TEXT_NAME,
  TEXT_TYPE,
  textFile,
  textFitsOneChunk,
} from "./text-secret.ts";

test("textFile keeps the text exactly, under a fixed name and type", async () => {
  const text = "line one\r\nline two\n\tåäö € 😀 李\n";
  const file = textFile(text);
  assert.ok(file);
  assert.equal(file.name, TEXT_NAME);
  assert.equal(file.type, TEXT_TYPE);
  assert.equal(file.size, new TextEncoder().encode(text).byteLength);
  assert.equal(await file.text(), text);
});

test("decodeText keeps a leading byte order mark and marks invalid UTF-8", async () => {
  const text = "\uFEFFline one\r\n\u{1F600}";
  const file = textFile(text);
  assert.ok(file);
  assert.equal(await decodeText(file), text);
  const invalid = new Blob([new Uint8Array([0x61, 0xff, 0x62, 0xe2, 0x82])]);
  assert.equal(await decodeText(invalid), "a\uFFFDb\uFFFD");
});

test("textFile refuses an empty text and one over the length limit", () => {
  assert.equal(textFile(""), undefined);
  assert.equal(textFile("a".repeat(MAX_TEXT_LENGTH + 1)), undefined);
  assert.ok(textFile("a".repeat(MAX_TEXT_LENGTH)));
});

test("the longest text in the worst encoding stays under the byte cap", () => {
  assert.ok(MAX_TEXT_LENGTH * 3 <= MAX_TEXT_BYTES);
  for (const unit of ["€", "\uD800", "😀"]) {
    const text = unit.repeat(MAX_TEXT_LENGTH / unit.length);
    const file = textFile(text);
    assert.ok(file, unit);
    assert.ok(file.size <= MAX_TEXT_BYTES, unit);
  }
  assert.equal(textFile("€".repeat(MAX_TEXT_LENGTH))?.size, 30_000);
});

test("isTextOffer needs the exact type and a size within the cap", () => {
  assert.equal(isTextOffer({ type: TEXT_TYPE, size: 0 }), true);
  assert.equal(isTextOffer({ type: TEXT_TYPE, size: MAX_TEXT_BYTES }), true);
  assert.equal(isTextOffer({ type: TEXT_TYPE, size: MAX_TEXT_BYTES + 1 }), false);
  assert.equal(isTextOffer({ type: "text/plain", size: 10 }), false);
  assert.equal(isTextOffer({ type: `${TEXT_TYPE};charset=utf-8`, size: 10 }), false);
  assert.equal(isTextOffer({ type: "", size: 10 }), false);
});

test("every text size pads to exactly one chunk", () => {
  assert.ok(DEFAULT_MAX_MESSAGE_SIZE - FRAME_OVERHEAD_BYTES >= MAX_CHUNK_BYTES);
  for (let size = 0; size <= MAX_TEXT_BYTES; size++) {
    assert.equal(paddedLength(size, MAX_CHUNK_BYTES), MAX_CHUNK_BYTES);
    assert.equal(paddedLength(size, MAX_TEXT_BYTES), MAX_TEXT_BYTES);
  }
});

test("textFitsOneChunk needs room for a 32 KiB chunk, whatever the text", () => {
  assert.equal(MAX_TEXT_BYTES + FRAME_OVERHEAD_BYTES, 32_832);
  assert.equal(textFitsOneChunk(32_832), true);
  assert.equal(textFitsOneChunk(32_831), false);
  for (const size of [DEFAULT_MAX_MESSAGE_SIZE, 262_144, 1_073_741_823, Infinity]) {
    assert.equal(textFitsOneChunk(size), true, String(size));
  }
  const small = 16_384 - FRAME_OVERHEAD_BYTES;
  assert.equal(textFitsOneChunk(16_384), false);
  assert.equal(paddedLength(30_000, small) / small, 2);
  assert.equal(paddedLength(1, small) / small, 1);
});

test("a text's META fits with the longest sender name", () => {
  const file = textFile("x");
  assert.ok(file);
  assert.ok(metaFits(file, "€".repeat(MAX_FROM_LENGTH)));
});
