import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_RELAY_DATA } from "@sigill/protocol";
import {
  createTransferId,
  deriveFileKey,
  deriveSignalKey,
  MAX_SIGNAL_PAYLOAD,
  openSignal,
  sealSignal,
} from "./keys.ts";
import { createLink } from "./link.ts";

const offer = { kind: "offer", sdp: "fake sdp for tests\r\n".repeat(20) };

test("derived keys are non-extractable AES-GCM-256 keys", async () => {
  const { linkId, secret } = createLink("https://localhost");
  for (const key of [
    await deriveSignalKey(secret, linkId),
    await deriveFileKey(secret, createTransferId()),
  ]) {
    assert.equal(key.extractable, false);
    assert.deepEqual(key.algorithm, { name: "AES-GCM", length: 256 });
    assert.deepEqual([...key.usages].sort(), ["decrypt", "encrypt"]);
    await assert.rejects(crypto.subtle.exportKey("raw", key));
  }
});

test("derivation rejects malformed secrets, link IDs and transfer IDs", async () => {
  const { linkId, secret } = createLink("https://localhost");
  await assert.rejects(deriveSignalKey(secret.slice(1), linkId));
  await assert.rejects(deriveSignalKey(secret, `${linkId}A`));
  await assert.rejects(deriveFileKey(secret, new Uint8Array(15)));
});

test("sealSignal round trips and fits the relay limit", async () => {
  const { linkId, secret } = createLink("https://localhost");
  const sender = await deriveSignalKey(secret, linkId);
  const recipient = await deriveSignalKey(secret, linkId);
  const data = await sealSignal(sender, linkId, "s", offer);
  assert.match(data, /^[A-Za-z0-9_-]+$/);
  assert.ok(!data.includes("fake sdp"));
  assert.deepEqual(await openSignal(recipient, linkId, "s", data), offer);

  // Sealing the same payload twice uses a fresh IV.
  assert.notEqual(await sealSignal(sender, linkId, "s", offer), data);
});

test("the largest allowed payload fits MAX_RELAY_DATA; one byte more throws", async () => {
  const { linkId, secret } = createLink("https://localhost");
  const key = await deriveSignalKey(secret, linkId);
  const fits = "x".repeat(MAX_SIGNAL_PAYLOAD - 2); // JSON adds two quotes
  const data = await sealSignal(key, linkId, "r", fits);
  assert.ok(data.length <= MAX_RELAY_DATA);
  assert.equal(await openSignal(key, linkId, "r", data), fits);
  await assert.rejects(sealSignal(key, linkId, "r", `${fits}x`), /too large/);
});

test("openSignal fails with the wrong direction, link ID or secret", async () => {
  const { linkId, secret } = createLink("https://localhost");
  const key = await deriveSignalKey(secret, linkId);
  const data = await sealSignal(key, linkId, "s", offer);

  await assert.rejects(openSignal(key, linkId, "r", data), "reflected back");

  const other = createLink("https://localhost");
  await assert.rejects(openSignal(key, other.linkId, "s", data), "other link ID in AAD");

  const wrongSecret = await deriveSignalKey(other.secret, linkId);
  await assert.rejects(openSignal(wrongSecret, linkId, "s", data), "wrong secret");

  // Same secret under another link ID derives a different key.
  const otherSalt = await deriveSignalKey(secret, other.linkId);
  await assert.rejects(openSignal(otherSalt, linkId, "s", data), "other salt");
});

test("openSignal fails on tampered or malformed data", async () => {
  const { linkId, secret } = createLink("https://localhost");
  const key = await deriveSignalKey(secret, linkId);
  const data = await sealSignal(key, linkId, "r", offer);
  const bytes = Buffer.from(data, "base64url");
  for (const index of [0, 11, 12, bytes.length - 1]) {
    const tampered = Buffer.from(bytes);
    tampered[index] = (tampered[index] as number) ^ 1;
    await assert.rejects(openSignal(key, linkId, "r", tampered.toString("base64url")), `${index}`);
  }
  await assert.rejects(openSignal(key, linkId, "r", data.slice(0, 30)));
  await assert.rejects(openSignal(key, linkId, "r", ""));
  await assert.rejects(openSignal(key, linkId, "r", `${data}=`));
});

test("file keys differ per transferId and per secret", async () => {
  const { secret } = createLink("https://localhost");
  const transferId = createTransferId();
  const iv = new Uint8Array(12);
  const plaintext = new Uint8Array([1, 2, 3]);
  const key = await deriveFileKey(secret, transferId);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  const same = await deriveFileKey(secret, transferId);
  assert.deepEqual(
    new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, same, ciphertext)),
    plaintext,
  );
  for (const other of [
    await deriveFileKey(secret, createTransferId()),
    await deriveFileKey(createLink("https://localhost").secret, transferId),
  ]) {
    await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv }, other, ciphertext));
  }
});
