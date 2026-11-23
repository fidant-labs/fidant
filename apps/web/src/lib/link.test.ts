import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { test } from "node:test";
import { isLinkId } from "@sigill/protocol";
import { decodeBase64url, encodeBase64url } from "./base64url.ts";
import { createLink, isSecret, parseRecipientLocation } from "./link.ts";

test("base64url round trips every length and matches Buffer", () => {
  for (let size = 0; size < 70; size++) {
    const bytes = randomBytes(size);
    const text = encodeBase64url(bytes);
    assert.equal(text, bytes.toString("base64url"), `size ${size}`);
    assert.deepEqual(decodeBase64url(text), new Uint8Array(bytes), `size ${size}`);
  }
});

test("base64url decoding is strict", () => {
  assert.equal(decodeBase64url("A"), undefined, "impossible length");
  assert.equal(decodeBase64url("AA=="), undefined, "padding");
  assert.equal(decodeBase64url("AA+/"), undefined, "standard alphabet");
  assert.equal(decodeBase64url("A A"), undefined, "space");
  assert.equal(decodeBase64url("AB"), undefined, "non-zero trailing bits");
  assert.equal(decodeBase64url("Ä"), undefined, "non-ASCII");
  assert.deepEqual(decodeBase64url(""), new Uint8Array(0));
});

test("createLink makes a fresh ID and secret in the URL", () => {
  const a = createLink("https://192.168.1.5:8443");
  const b = createLink("https://192.168.1.5:8443");
  assert.ok(isLinkId(a.linkId));
  assert.ok(isSecret(a.secret));
  assert.equal(a.url, `https://192.168.1.5:8443/r/${a.linkId}#${a.secret}`);
  assert.notEqual(a.linkId, b.linkId);
  assert.notEqual(a.secret, b.secret);
});

test("parseRecipientLocation reads back a created link", () => {
  const link = createLink("https://localhost:8443");
  const url = new URL(link.url);
  assert.deepEqual(parseRecipientLocation(url), { linkId: link.linkId, secret: link.secret });
  assert.deepEqual(parseRecipientLocation({ pathname: `/r/${link.linkId}/`, hash: url.hash }), {
    linkId: link.linkId,
    secret: link.secret,
  });
});

test("parseRecipientLocation rejects malformed IDs and secrets", () => {
  const { linkId, secret } = createLink("https://localhost");
  const ok = { pathname: `/r/${linkId}`, hash: `#${secret}` };
  assert.ok(parseRecipientLocation(ok));

  const badPaths = [
    "/",
    "/r/",
    `/x/${linkId}`,
    `/r/${linkId.slice(1)}`,
    `/r/${linkId}A`,
    `/r/${linkId.slice(1)}+`,
    `/r/${linkId}/extra`,
    `/r/r/${linkId}`,
  ];
  for (const pathname of badPaths) {
    assert.equal(parseRecipientLocation({ ...ok, pathname }), undefined, pathname);
  }

  // A 43-character string whose last character has non-zero padding bits.
  const nonCanonical = secret.slice(0, 42) + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"[randomInt(32) | 1];
  const badHashes = [
    "",
    "#",
    secret,
    `#${secret.slice(1)}`,
    `#${secret}A`,
    `#${secret.slice(1)}=`,
    `#${secret.slice(1)}/`,
    `#${nonCanonical}`,
    `#${randomBytes(16).toString("base64url")}`,
  ];
  for (const hash of badHashes) {
    assert.equal(parseRecipientLocation({ ...ok, hash }), undefined, hash);
  }
});
