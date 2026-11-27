import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_RELAY_DATA } from "@fidant/protocol";
import {
  createTransferId,
  deriveFileKey,
  deriveSignalKey,
  MAX_SIGNAL_PAYLOAD,
  openSignal,
  sealSignal,
} from "./keys.ts";
import { createLink } from "./link.ts";

// Two recipient attempt IDs (22 base64url characters, like a link ID, each the canonical
// encoding of 16 bytes).
const A = "A".repeat(22);
const B = `${"B".repeat(21)}A`;
const offer = { kind: "offer", sdp: "fake sdp for tests\r\n".repeat(20) };

test("derived keys are non-extractable AES-GCM-256 keys", async () => {
  const { linkId, secret } = createLink("https://localhost");
  for (const key of [
    await deriveSignalKey(secret, linkId),
    await deriveFileKey(secret, createTransferId(), A),
  ]) {
    assert.equal(key.extractable, false);
    assert.deepEqual(key.algorithm, { name: "AES-GCM", length: 256 });
    assert.deepEqual([...key.usages].sort(), ["decrypt", "encrypt"]);
    await assert.rejects(crypto.subtle.exportKey("raw", key));
  }
});

test("derivation rejects malformed secrets, link IDs, transfer IDs and attempt IDs", async () => {
  const { linkId, secret } = createLink("https://localhost");
  await assert.rejects(deriveSignalKey(secret.slice(1), linkId));
  await assert.rejects(deriveSignalKey(secret, `${linkId}A`));
  await assert.rejects(deriveFileKey(secret, new Uint8Array(15), A));
  await assert.rejects(deriveFileKey(secret, createTransferId(), A.slice(1)), /attempt/);
  await assert.rejects(deriveFileKey(secret, createTransferId(), `${A}=`), /attempt/);
  // Not the canonical encoding of 16 bytes: the last character carries stray bits.
  await assert.rejects(deriveFileKey(secret, createTransferId(), "B".repeat(22)), /attempt/);
});

test("sealSignal round trips and fits the relay limit", async () => {
  const { linkId, secret } = createLink("https://localhost");
  const sender = await deriveSignalKey(secret, linkId);
  const recipient = await deriveSignalKey(secret, linkId);
  const data = await sealSignal(sender, linkId, A, "s", offer);
  assert.match(data, /^[A-Za-z0-9_-]+$/);
  assert.ok(!data.includes("fake sdp"));
  assert.deepEqual(await openSignal(recipient, linkId, A, "s", data), offer);

  // Sealing the same payload twice uses a fresh IV.
  assert.notEqual(await sealSignal(sender, linkId, A, "s", offer), data);
});

test("the largest allowed payload fits MAX_RELAY_DATA; one byte more throws", async () => {
  const { linkId, secret } = createLink("https://localhost");
  const key = await deriveSignalKey(secret, linkId);
  const fits = "x".repeat(MAX_SIGNAL_PAYLOAD - 2); // JSON adds two quotes
  const data = await sealSignal(key, linkId, A, "r", fits);
  assert.ok(data.length <= MAX_RELAY_DATA);
  assert.equal(await openSignal(key, linkId, A, "r", data), fits);
  await assert.rejects(sealSignal(key, linkId, A, "r", `${fits}x`), /too large/);
});

test("openSignal fails with the wrong direction, link ID, attempt or secret", async () => {
  const { linkId, secret } = createLink("https://localhost");
  const key = await deriveSignalKey(secret, linkId);
  const data = await sealSignal(key, linkId, A, "s", offer);

  await assert.rejects(openSignal(key, linkId, A, "r", data), "reflected back");
  await assert.rejects(openSignal(key, linkId, B, "s", data), "replayed into another attempt");

  const other = createLink("https://localhost");
  await assert.rejects(openSignal(key, other.linkId, A, "s", data), "other link ID in AAD");

  const wrongSecret = await deriveSignalKey(other.secret, linkId);
  await assert.rejects(openSignal(wrongSecret, linkId, A, "s", data), "wrong secret");

  // Same secret under another link ID derives a different key.
  const otherSalt = await deriveSignalKey(secret, other.linkId);
  await assert.rejects(openSignal(otherSalt, linkId, A, "s", data), "other salt");
});

test("openSignal fails on tampered or malformed data", async () => {
  const { linkId, secret } = createLink("https://localhost");
  const key = await deriveSignalKey(secret, linkId);
  const data = await sealSignal(key, linkId, A, "r", offer);
  const bytes = Buffer.from(data, "base64url");
  for (const index of [0, 11, 12, bytes.length - 1]) {
    const tampered = Buffer.from(bytes);
    tampered[index] = (tampered[index] as number) ^ 1;
    await assert.rejects(
      openSignal(key, linkId, A, "r", tampered.toString("base64url")),
      `${index}`,
    );
  }
  await assert.rejects(openSignal(key, linkId, A, "r", data.slice(0, 30)));
  await assert.rejects(openSignal(key, linkId, A, "r", ""));
  await assert.rejects(openSignal(key, linkId, A, "r", `${data}=`));
});

test("file keys differ per transferId, per attempt and per secret", async () => {
  const { secret } = createLink("https://localhost");
  const transferId = createTransferId();
  const iv = new Uint8Array(12);
  const plaintext = new Uint8Array([1, 2, 3]);
  const key = await deriveFileKey(secret, transferId, A);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  const same = await deriveFileKey(secret, transferId, A);
  assert.deepEqual(
    new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, same, ciphertext)),
    plaintext,
  );
  for (const other of [
    await deriveFileKey(secret, createTransferId(), A),
    await deriveFileKey(secret, transferId, B),
    await deriveFileKey(createLink("https://localhost").secret, transferId, A),
  ]) {
    await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv }, other, ciphertext));
  }
});
