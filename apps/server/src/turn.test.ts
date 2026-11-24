import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseIceServers } from "@sigill/protocol";
import { turnCredentials } from "./turn.ts";

test("mints coturn REST credentials that expire in 5 minutes", () => {
  // printf 1700000300 | openssl dgst -sha1 -hmac test-secret -binary | base64
  const fromOpenssl = "vfUuvOythRV/eOwOeQIRXFA7Gn0=";
  assert.deepEqual(turnCredentials("test-secret", 1_700_000_000_123), {
    username: "1700000300",
    credential: fromOpenssl,
  });
});

test("the app box's TURN_URLS, with its IPv6 STUN address, pass the startup check", () => {
  const userData = readFileSync(new URL("../../infra/box/user-data.sh", import.meta.url), "utf8");
  const [, staticUrls = ""] = userData.match(/^turn_urls="([^"]*)"$/m) ?? [];
  const urls = [
    ...staticUrls.replaceAll("@DOMAIN@", "fidant.se").split(","),
    "stun:[2a05:d016:1f3:8a00:1234:5678:9abc:def0]:3478",
  ];
  assert.equal(urls.length, 4);
  assert.ok(parseIceServers([{ urls, username: "", credential: "" }]));
});
