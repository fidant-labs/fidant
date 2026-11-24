import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHUNK_BYTES, MAX_FROM_LENGTH, metaFits, paddedLength } from "./frames.ts";
import { DEFAULT_MAX_MESSAGE_SIZE } from "./peer.ts";
import {
  isTextOffer,
  MAX_TEXT_BYTES,
  MAX_TEXT_LENGTH,
  TEXT_NAME,
  TEXT_TYPE,
  textFile,
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
  assert.ok(DEFAULT_MAX_MESSAGE_SIZE - 64 >= MAX_CHUNK_BYTES);
  for (let size = 0; size <= MAX_TEXT_BYTES; size++) {
    assert.equal(paddedLength(size, MAX_CHUNK_BYTES), MAX_CHUNK_BYTES);
    assert.equal(paddedLength(size, MAX_TEXT_BYTES), MAX_TEXT_BYTES);
  }
});

test("a text's META fits with the longest sender name", () => {
  const file = textFile("x");
  assert.ok(file);
  assert.ok(metaFits(file, "€".repeat(MAX_FROM_LENGTH)));
});
