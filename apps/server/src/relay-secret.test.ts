import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { test } from "node:test";
import { sealRelaySecret } from "./relay-secret.ts";

test("sealRelaySecret opens with the private key under OAEP SHA-256", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const secret = "ab".repeat(32);
  const body = sealRelaySecret(
    publicKey.export({ type: "spki", format: "pem" }).toString(),
    secret,
  );
  assert.match(body, /^[A-Za-z0-9+/]+={0,2}$/);
  const opened = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(body, "base64"),
  );
  assert.equal(opened.toString("ascii"), secret);
});

test("sealRelaySecret refuses anything but 64 lowercase hex characters", () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  for (const bad of ["", "AB".repeat(32), "ab".repeat(31), `${"ab".repeat(32)}\n`]) {
    assert.throws(() => sealRelaySecret(pem, bad), TypeError);
  }
});
