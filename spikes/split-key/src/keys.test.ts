import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTransferId,
  decodeFragmentHalf,
  deriveContentBits,
  deriveContentKey,
  deriveMetaBits,
  deriveMetaKey,
  encodeFragmentHalf,
  FRAGMENT_HALF_CHARS,
  generateHalves,
} from "./keys.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sequence = (length: number, start: number) =>
  Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);

// Fixed inputs: F = 00..1f, S = 20..3f, transferId = a0..af. Expected outputs
// were computed with node:crypto hkdfSync("sha256", ikm, transferId, info, 32).
const F = sequence(32, 0x00);
const S = sequence(32, 0x20);
const TRANSFER_ID = sequence(16, 0xa0);
const META_HEX = "bcc895ec913722fba399196ae4e1f6e16ad7a6b92fd623a2a7b64101cf540f6e";
const CONTENT_HEX = "bd4f8462ec4684ab2cf1b39f098425f7a1a30156ffd5ec50bc06848ac2868844";

function flipBit(bytes: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[index] = (copy[index] as number) ^ 1;
  return copy;
}

test("meta and content keys match the fixed vector", async () => {
  assert.equal(hex(await deriveMetaBits(F, TRANSFER_ID)), META_HEX);
  assert.equal(hex(await deriveContentBits(F, S, TRANSFER_ID)), CONTENT_HEX);
});

test("meta key differs from content key", async () => {
  assert.notEqual(
    hex(await deriveMetaBits(F, TRANSFER_ID)),
    hex(await deriveContentBits(F, S, TRANSFER_ID)),
  );
});

test("meta key depends on F and transferId", async () => {
  assert.notEqual(hex(await deriveMetaBits(flipBit(F, 31), TRANSFER_ID)), META_HEX);
  assert.notEqual(hex(await deriveMetaBits(F, flipBit(TRANSFER_ID, 0))), META_HEX);
});

test("content key depends on F, S and transferId", async () => {
  assert.notEqual(hex(await deriveContentBits(flipBit(F, 0), S, TRANSFER_ID)), CONTENT_HEX);
  assert.notEqual(hex(await deriveContentBits(F, flipBit(S, 31), TRANSFER_ID)), CONTENT_HEX);
  assert.notEqual(hex(await deriveContentBits(F, S, flipBit(TRANSFER_ID, 15))), CONTENT_HEX);
  // Swapping the halves gives another key, so F and S are not interchangeable.
  assert.notEqual(hex(await deriveContentBits(S, F, TRANSFER_ID)), CONTENT_HEX);
});

test("derived CryptoKeys are non-extractable AES-GCM-256 and round trip", async () => {
  const meta = await deriveMetaKey(F, TRANSFER_ID);
  const content = await deriveContentKey(F, S, TRANSFER_ID);
  for (const key of [meta, content]) {
    assert.equal(key.extractable, false);
    assert.deepEqual(key.algorithm, { name: "AES-GCM", length: 256 });
    assert.deepEqual([...key.usages].sort(), ["decrypt", "encrypt"]);
  }
  const iv = new Uint8Array(12);
  const plaintext = new TextEncoder().encode("hello");
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, content, plaintext);
  const again = await deriveContentKey(F, S, TRANSFER_ID);
  const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, again, sealed);
  assert.deepEqual(new Uint8Array(opened), plaintext);
  await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv }, meta, sealed));
});

test("derivation rejects inputs of the wrong length", async () => {
  await assert.rejects(deriveMetaBits(F.subarray(1), TRANSFER_ID), /fragment half/);
  await assert.rejects(deriveMetaKey(F, TRANSFER_ID.subarray(1)), /transferId/);
  await assert.rejects(deriveContentBits(F, new Uint8Array(33), TRANSFER_ID), /server half/);
  await assert.rejects(deriveContentKey(new Uint8Array(0), S, TRANSFER_ID), /fragment half/);
  await assert.rejects(deriveContentKey(F, S, new Uint8Array(32)), /transferId/);
});

test("fragment half encodes to 43 base64url characters and back", () => {
  const text = encodeFragmentHalf(F);
  assert.equal(text, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  assert.equal(text.length, FRAGMENT_HALF_CHARS);
  assert.deepEqual(decodeFragmentHalf(text), F);
  assert.throws(() => encodeFragmentHalf(new Uint8Array(31)), /fragment half/);
});

test("fragment half decoding rejects malformed text", () => {
  const text = encodeFragmentHalf(F);
  assert.equal(decodeFragmentHalf(text.slice(1)), undefined);
  assert.equal(decodeFragmentHalf(`${text}A`), undefined);
  assert.equal(decodeFragmentHalf(`${text.slice(0, -1)}+`), undefined);
  // The last character carries two unused bits, which must be zero.
  assert.equal(decodeFragmentHalf(`${text.slice(0, -1)}9`), undefined);
});

test("generated halves and transferIds are fresh and the right size", () => {
  const a = generateHalves();
  const b = generateHalves();
  assert.equal(a.fragmentHalf.length, 32);
  assert.equal(a.serverHalf.length, 32);
  assert.notDeepEqual(a.fragmentHalf, a.serverHalf);
  assert.notDeepEqual(a.fragmentHalf, b.fragmentHalf);
  assert.equal(createTransferId().length, 16);
  assert.notDeepEqual(createTransferId(), createTransferId());
});
